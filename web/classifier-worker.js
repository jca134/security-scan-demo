import {
  AutoConfig,
  AutoModel,
  AutoTokenizer,
  PreTrainedTokenizer,
  Tensor,
} from "@huggingface/transformers";
// Same ONNX Runtime instance Transformers.js uses (it imports "onnxruntime-web/webgpu" too).
import * as ort from "onnxruntime-web/webgpu";
import {
  SPARTAN_MODEL_ID,
  SPARTAN_MODEL_NAME,
  classifyWithSpartan,
  loadSpartan,
} from "./spartan-v6/pipeline.js";
import { prefilterDangerousText, prefilterFlagDetails } from "./prefilter.js";

const MODEL_ID = "onnx-community/GLiNER2.5-Decide-mobile-ONNX";
const MODEL_REVISION = "880d192";
const MODEL_DTYPE = "q4f16";
const MODEL_WORD_LIMIT = 500;
const BLOCK_WORDS = 100;
const MAX_LENGTH = 1_024;
const MAX_STATE_TOKENS = 896;
const OPTIONS = ["public", "internal", "personal", "severe"];
const SENSITIVE_OPTIONS = new Set(["personal", "severe"]);
const DESCRIPTIONS = {
  public: "No harm: public or general information",
  internal: "Minor: internal but impersonal (plans, budgets, schedules)",
  personal: "Moderate: private details about an identifiable person",
  severe: "Severe: health, ID numbers, financial accounts, credentials, or legal records",
};
const WORD_PATTERN =
  /(?:https?:\/\/[^\s]+|www\.[^\s]+)|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|@[a-z0-9_]+|[\p{L}\p{M}\p{N}_]+(?:[-_][\p{L}\p{M}\p{N}_]+)*|\S/giu;

let model;
let tokenizer;
let markers;

function send(type, data = {}) {
  self.postMessage({ type, ...data });
}

function modelRuntime() {
  return { model: MODEL_ID, format: "onnx", backend: "webgpu", dtype: MODEL_DTYPE };
}

function tensor(values) {
  return new Tensor("int64", BigInt64Array.from(values, BigInt), [1, values.length]);
}

function encode(text) {
  const { input_ids: inputIds } = tokenizer(text, { add_special_tokens: false });
  return Array.from(inputIds.data, Number);
}

function encodeSingle(text) {
  const ids = encode(text);
  if (ids.length !== 1) throw new Error(`Tokenizer does not know GLiNER marker ${text}.`);
  return ids[0];
}

function prepareMarkers() {
  markers = {
    p: encodeSingle("[P]"),
    l: encodeSingle("[L]"),
    sepText: encodeSingle("[SEP_TEXT]"),
    open: encode("("),
    close: encode(")"),
  };
}

function tokenizeState(value) {
  let text = String(value || "").trim();
  text = text === "" ? "." : /[.!?]$/u.test(text) ? text : `${text}.`;
  const words = text.match(WORD_PATTERN) || [];
  return words.flatMap((word) => encode(word.toLowerCase()));
}

function encodeDecision(state, prompt) {
  let instructions = prompt;
  for (const option of OPTIONS) {
    instructions += ` [DESCRIPTION] ${option}: ${DESCRIPTIONS[option]}`;
  }
  const optionTokens = OPTIONS.map((option) => encode(option));
  const inputIds = [...markers.open, markers.p, ...encode(instructions), ...markers.open];
  const markerPositions = [];
  for (const option of optionTokens) {
    markerPositions.push(inputIds.length);
    inputIds.push(markers.l, ...option);
  }
  inputIds.push(...markers.close, ...markers.close, markers.sepText);

  const stateTokens = tokenizeState(state);
  const available = MAX_LENGTH - inputIds.length;
  if (available < 0) throw new Error(`The classification prompt exceeds GLiNER's ${MAX_LENGTH}-token context.`);
  inputIds.push(...stateTokens.slice(0, Math.min(MAX_STATE_TOKENS, available)));
  return { inputIds, markerPositions, inputTokens: inputIds.length };
}

function softmax(values) {
  const maximum = Math.max(...values);
  const exponents = values.map((value) => Math.exp(value - maximum));
  const total = exponents.reduce((sum, value) => sum + value, 0);
  return exponents.map((value) => value / total);
}

async function decide(state, prompt) {
  const encoded = encodeDecision(state, prompt);
  const started = performance.now();
  const output = await model({
    input_ids: tensor(encoded.inputIds),
    attention_mask: tensor(encoded.inputIds.map(() => 1)),
    marker_positions: tensor(encoded.markerPositions),
  });
  const logits = Array.from(output.logits.to("float32").data, Number);
  if (logits.length < OPTIONS.length || logits.slice(0, OPTIONS.length).some((value) => !Number.isFinite(value))) {
    throw new Error("GLiNER returned invalid option logits.");
  }
  const probabilities = softmax(logits.slice(0, OPTIONS.length));
  return {
    probabilities: Object.fromEntries(OPTIONS.map((option, index) => [option, probabilities[index]])),
    inputTokens: encoded.inputTokens,
    totalMs: performance.now() - started,
  };
}

function sendGlinerReady(warmupMs = 0) {
  send("ready", {
    modelId: "gliner2.5-decide-q4",
    modelName: "GLiNER2.5-Decide mobile q4f16",
    modelRuntime: modelRuntime(),
    warmupMs,
  });
}

async function load() {
  // Already loaded (switching back to it): confirm immediately.
  if (model) return sendGlinerReady();
  send("loading", { message: "Fetching the mobile GLiNER2.5-Decide q4 model or reading it from browser cache…" });
  const loadStarted = performance.now();
  const config = await AutoConfig.from_pretrained(MODEL_ID, { revision: MODEL_REVISION });
  tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, { revision: MODEL_REVISION });
  prepareMarkers();
  model = await AutoModel.from_pretrained(MODEL_ID, {
    config,
    revision: MODEL_REVISION,
    device: "webgpu",
    dtype: MODEL_DTYPE,
    progress_callback: (event) => {
      if (event?.status !== "progress_total") return;
      const loaded = Number(event.loaded) || 0;
      const total = Number(event.total) || 0;
      send("progress", {
        event: {
          status: "progress",
          file: event.file || MODEL_ID,
          loaded,
          total,
          text: total ? `${(loaded / total * 100).toFixed(0)}% downloaded or read from cache` : "loading model",
        },
      });
    },
  });
  send("loaded", { loadMs: performance.now() - loadStarted });
  send("loading", { message: "Mobile GLiNER q4 loaded on WebGPU. Compiling a warmup pass…" });
  const warmupStarted = performance.now();
  await decide("An ordinary public project status update.", "How much harm could result if this file were shared publicly by mistake?");
  sendGlinerReady(performance.now() - warmupStarted);
}

async function classifyFiles(data) {
  if (!model) throw new Error("Load GLiNER before classifying files.");
  const prompt = String(data?.prompt || "").trim();
  if (!prompt) throw new Error("Enter a classification prompt.");
  const files = Array.isArray(data?.files)
    ? data.files.filter((file) => (file?.risk === "RED" || file?.risk === "YELLOW") && file?.contentText)
    : [];

  // A positive word count, or Infinity for whole documents; defaults to MODEL_WORD_LIMIT.
  const wordLimit = Number(data?.wordLimit) > 0 ? Number(data.wordLimit) : MODEL_WORD_LIMIT;
  send("classification-start", { total: files.length });
  let completed = 0;
  for (const file of files) {
    try {
      const words = String(file.contentText).trim().split(/\s+/u).filter(Boolean).slice(0, wordLimit);
      const contentText = words.join(" ");
      const states = Array.from(
        { length: Math.max(1, Math.ceil(words.length / BLOCK_WORDS)) },
        (_, index) => words.slice(index * BLOCK_WORDS, (index + 1) * BLOCK_WORDS).join(" "),
      );
      // Describe a flagged block so the page can show the user exactly what was flagged.
      const flaggedBlock = (blockIndex) => ({
        firstFlaggedBlock: blockIndex,
        flaggedText: states[blockIndex],
        flaggedWordStart: blockIndex * BLOCK_WORDS + 1,
        flaggedWordEnd: Math.min(words.length, (blockIndex + 1) * BLOCK_WORDS),
      });
      // Let the page show which file is being checked and how many sections it has.
      send("classification-file", { fileId: file.id, index: completed, total: files.length, blocks: states.length });
      const prefilter = prefilterDangerousText(contentText);
      if (prefilter.dangerous) {
        // The pre-filter scans all words at once; locate the first block that matches on its own.
        const matchingBlock = states.findIndex((state) => prefilterDangerousText(state).dangerous);
        send("classification-result", {
          fileId: file.id,
          dangerous: true,
          classificationSource: "prefilter",
          prefilterMatches: prefilter.matches,
          flagCategories: prefilterFlagDetails(prefilter.matches),
          ...(matchingBlock >= 0 ? flaggedBlock(matchingBlock) : { firstFlaggedBlock: null }),
          wordCount: words.length,
          modelRuntime: modelRuntime(),
        });
      } else {
        let dangerousProbability = 0;
        let inputTokens = 0;
        let totalMs = 0;
        let firstFlaggedBlock = null;
        let flagCategories = [];
        for (let blockIndex = 0; blockIndex < states.length; blockIndex += 1) {
          send("classification-block", { fileId: file.id, block: blockIndex + 1, blocks: states.length });
          const result = await decide(states[blockIndex], prompt);
          const probability = [...SENSITIVE_OPTIONS]
            .reduce((sum, option) => sum + result.probabilities[option], 0);
          dangerousProbability = Math.max(dangerousProbability, probability);
          inputTokens += result.inputTokens;
          totalMs += result.totalMs;
          if (probability >= 0.5) {
            firstFlaggedBlock = blockIndex;
            // The model's fixed options only distinguish personal details from severe records.
            flagCategories = [result.probabilities.severe >= result.probabilities.personal
              ? "Highly sensitive record (health, ID, financial, credential, or legal)"
              : "Personal information about an identifiable person"];
            break;
          }
        }
        send("classification-result", {
          fileId: file.id,
          dangerous: firstFlaggedBlock !== null,
          classificationSource: "model",
          dangerousProbability,
          flagCategories,
          ...(firstFlaggedBlock !== null ? flaggedBlock(firstFlaggedBlock) : { firstFlaggedBlock: null }),
          wordCount: words.length,
          inputTokens,
          totalMs,
          modelRuntime: modelRuntime(),
        });
      }
    } catch (error) {
      send("classification-result", { fileId: file?.id, error: error?.message ?? String(error) });
    }
    completed += 1;
    send("classification-progress", { completed, total: files.length });
  }
  send("classification-complete", { total: files.length });
}

/* global __SPARTAN_V6_MODEL_URL__ */
let spartan;

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status}).`);
  return response.json();
}

function sendSpartanReady() {
  send("ready", {
    modelId: SPARTAN_MODEL_ID,
    modelName: SPARTAN_MODEL_NAME,
    modelRuntime: { model: SPARTAN_MODEL_ID, format: "onnx", backend: "webgpu", dtype: "fp16" },
    warmupMs: 0,
  });
}

async function loadSpartanModel() {
  // Already loaded (switching back to it): confirm immediately.
  if (spartan) return sendSpartanReady();
  const baseUrl = __SPARTAN_V6_MODEL_URL__;
  if (!baseUrl) throw new Error("Spartan v6 isn't set up on this site yet (SPARTAN_V6_MODEL_URL is empty).");
  send("loading", { message: "Fetching Spartan v6 (about 150 MB) or reading it from browser cache…" });
  const started = performance.now();
  spartan = await loadSpartan({
    ort,
    PreTrainedTokenizer,
    baseUrl: new URL(baseUrl, self.location.href).href,
    executionProviders: ["webgpu", "wasm"],
    fetchJson,
  });
  send("loaded", { loadMs: performance.now() - started });
  await classifyWithSpartan(spartan, "Warmup: Dana was diagnosed with asthma.", { wordLimit: 100 });
  sendSpartanReady();
}

async function classifyFilesWithSpartan(data) {
  if (!spartan) throw new Error("Load Spartan v6 before classifying files.");
  const files = Array.isArray(data?.files)
    ? data.files.filter((file) => (file?.risk === "RED" || file?.risk === "YELLOW") && file?.contentText)
    : [];
  const wordLimit = Number(data?.wordLimit) > 0 ? Number(data.wordLimit) : MODEL_WORD_LIMIT;
  send("classification-start", { total: files.length });
  let completed = 0;
  for (const file of files) {
    try {
      const blocks = Math.max(1, Math.ceil(Math.min(
        String(file.contentText).split(/\s+/).filter(Boolean).length, wordLimit,
      ) / spartan.spec.block_words));
      send("classification-file", { fileId: file.id, index: completed, total: files.length, blocks });
      const result = await classifyWithSpartan(spartan, file.contentText, {
        wordLimit,
        onBlock: (block, blockCount) => send("classification-block", { fileId: file.id, block, blocks: blockCount }),
      });
      send("classification-result", { fileId: file.id, ...result, modelRuntime: { model: SPARTAN_MODEL_ID } });
    } catch (error) {
      send("classification-result", { fileId: file?.id, error: error?.message ?? String(error) });
    }
    completed += 1;
    send("classification-progress", { completed, total: files.length });
  }
  send("classification-complete", { total: files.length });
}

let activeModel = null;

self.addEventListener("message", async ({ data }) => {
  try {
    if (data.type === "load") {
      activeModel = data.modelId === SPARTAN_MODEL_ID ? SPARTAN_MODEL_ID : "gliner";
      if (activeModel === SPARTAN_MODEL_ID) await loadSpartanModel();
      else await load();
    }
    if (data.type === "classify-files") {
      if (activeModel === SPARTAN_MODEL_ID) await classifyFilesWithSpartan(data.data);
      else await classifyFiles(data.data);
    }
  } catch (error) {
    console.error(error);
    send("error", { message: error?.message ?? String(error) });
  }
});

send("worker-initialized");
