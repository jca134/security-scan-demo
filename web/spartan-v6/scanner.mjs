// Copied unchanged from sensitivity-scanner-v6/browser/scanner.mjs (commit a56d3d7). Keep in sync.
// Browser sensitivity scanner: pattern rules, then the fine-tuned GLiNER2 classifier (v6) on 100-word blocks.
// Mirrors the recommended pipeline in ../FINETUNE.md and ../python/eval_models.py:
//   1. rules on the whole file -> flagged without the model
//   2. 100-word blocks; skip blocks with no personal signal
//   3. block score = 1 - P(none) = sigmoid(-logit_none); flag the file at the first block >= threshold
//
// Works in Chrome (onnxruntime-web) and Node (onnxruntime-node): pass the runtime and a tokenizer in.
//   import * as ort from "onnxruntime-web";                       // or "onnxruntime-node"
//   import { AutoTokenizer } from "@huggingface/transformers";
//   const scanner = await Scanner.create({ ort, tokenizer, modelUrl, spec });
//   const result = await scanner.scanFile(text);   // { sensitive, reason, rules, blocks, score, ms }
import { blockHasSignal, findRules } from "./rules.mjs";

// Same word splitter as gliner2 (processing/word_splitter.py, WhitespaceTokenSplitter): URL | email | @handle |
// word(-word)* | any other non-space character. The library lower-cases each piece.
const W = String.raw`[\p{L}\p{N}\p{M}_‌‍]`;
const WORD_SPLIT = new RegExp(
  String.raw`(?:https?://\S+|www\.\S+)|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|@[a-z0-9_]+|${W}+(?:[-_]${W}+)*|\S`, "giu");

export function splitWords(text) {
  return text.match(WORD_SPLIT)?.map((w) => w.toLowerCase()) ?? [];
}

// Python's str.split() then " ".join(): blocks of `size` whitespace-separated words.
export function splitBlocks(text, size) {
  const words = text.split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size).join(" "));
  return out.length ? out : [""];
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

export class Scanner {
  static async create({ ort, tokenizer, modelUrl, spec, sessionOptions = {} }) {
    const session = await ort.InferenceSession.create(modelUrl, sessionOptions);
    return new Scanner({ ort, tokenizer, session, spec });
  }

  constructor({ ort, tokenizer, session, spec }) {
    Object.assign(this, { ort, tokenizer, session, spec });
    this.cache = new Map(); // word -> token ids (the library caches the same way)
    this.markers = BigInt64Array.from(spec.marker_positions.map(BigInt));
  }

  encode(block) {
    // gliner2 (processor._normalize_text) ends every text with sentence punctuation before splitting it
    const text = !block ? "." : /[.!?]$/.test(block) ? block : block + ".";
    const ids = [...this.spec.prefix_ids];
    for (const w of splitWords(text)) {
      let t = this.cache.get(w);
      if (!t) {
        t = this.tokenizer.encode(w, { add_special_tokens: false });
        if (this.cache.size < 50000) this.cache.set(w, t);
      }
      for (const id of t) ids.push(id);
    }
    return ids;
  }

  // Every label's probability for one block (multi-label: an independent sigmoid per label).
  async scoreBlock(block) {
    const ids = this.encode(block);
    const n = ids.length;
    const T = this.ort.Tensor;
    const feeds = {
      input_ids: new T("int64", BigInt64Array.from(ids, BigInt), [1, n]),
      attention_mask: new T("int64", new BigInt64Array(n).fill(1n), [1, n]),
      marker_positions: new T("int64", this.markers, [1, this.markers.length]),
    };
    const { logits } = await this.session.run(feeds);
    const probs = {};
    this.spec.labels.forEach((label, i) => (probs[label] = sigmoid(Number(logits.data[i]))));
    return probs;
  }

  async scanFile(text, { threshold = this.spec.threshold, blockWords = this.spec.block_words } = {}) {
    const t0 = performance.now();
    const rules = findRules(text);
    if (rules.length) return { sensitive: true, reason: "rules", rules, blocks: 0, score: null, ms: performance.now() - t0 };
    let read = 0, best = 0, top = null;
    for (const block of splitBlocks(text, blockWords)) {
      if (!blockHasSignal(block)) continue;
      const probs = await this.scoreBlock(block);
      read++;
      const score = 1 - probs.none;
      if (score > best) [best, top] = [score, probs];
      if (score >= threshold) {
        return { sensitive: true, reason: "model", rules, blocks: read, score, labels: probs, block, ms: performance.now() - t0 };
      }
    }
    return { sensitive: false, reason: null, rules, blocks: read, score: best, labels: top, ms: performance.now() - t0 };
  }
}
