// Spartan v6: the fine-tuned sensitivity-scanner-v6 model (GLiNER2.5-small, trained by the team) wired into
// Privacy Scanner. Decision logic is the v6 pipeline from scanner.mjs / rules.mjs (copied unchanged):
//   1. v6 pattern rules on the text → flagged without the model
//   2. 100-word blocks; blocks with no personal signal are skipped
//   3. block score = 1 − P(none); the file is flagged at the first block ≥ spec.threshold
// This module adds what the results page needs: progress events, the flagged block, and readable categories.
import { blockHasSignal, findRules } from "./rules.mjs";
import { Scanner, splitBlocks } from "./scanner.mjs";

export const SPARTAN_MODEL_ID = "spartan-v6";
export const SPARTAN_MODEL_NAME = "Spartan v6";

// Rule names from rules.mjs → the same category wording the built-in pattern check uses.
const RULE_DETAILS = {
  ssn: ["Government ID", "Social Security number"],
  passport_or_visa_id: ["Government ID", "passport or visa number"],
  other_id: ["Government ID", "ID number"],
  dob: ["Government ID", "date of birth"],
  card: ["Financial", "credit card number"],
  bank_account: ["Financial", "bank account number"],
  iban: ["Financial", "IBAN"],
  credential: ["Passwords & secret keys", "password"],
  credential_url: ["Passwords & secret keys", "password in a database URL"],
  api_or_private_key: ["Passwords & secret keys", "API or private key"],
  medical_id: ["Medical / health", "medical ID number"],
  hr_action: ["HR & payroll", "named HR action"],
};

// v6 model labels → readable categories.
const LABEL_NAMES = {
  medical: "Medical / health",
  student_records: "Student records",
  id_numbers: "Government ID",
  financial: "Financial",
  credentials: "Passwords & secret keys",
  legal_hr: "Legal or HR matter",
};

/** "Government ID (Social Security number, date of birth) · Financial (credit card number)" style details. */
export function ruleFlagDetails(rules) {
  const grouped = new Map();
  for (const rule of rules) {
    const [category, detail] = RULE_DETAILS[rule] || ["Sensitive pattern", rule.replaceAll("_", " ")];
    if (!grouped.has(category)) grouped.set(category, []);
    if (!grouped.get(category).includes(detail)) grouped.get(category).push(detail);
  }
  return [...grouped].map(([category, details]) => `${category} (${details.join(", ")})`);
}

/** Labels the model is at least 50% sure of (or its single top label), e.g. "Medical / health (97%)". */
export function modelFlagDetails(probs, threshold = 0.5) {
  const ranked = Object.entries(probs || {})
    .filter(([label]) => label !== "none")
    .sort((a, b) => b[1] - a[1]);
  const confident = ranked.filter(([, p]) => p >= threshold);
  return (confident.length ? confident : ranked.slice(0, 1))
    .map(([label, p]) => `${LABEL_NAMES[label] || label} (${Math.round(p * 100)}%)`);
}

function limitWords(text, wordLimit) {
  if (!Number.isFinite(wordLimit)) return String(text);
  return String(text).split(/\s+/).filter(Boolean).slice(0, wordLimit).join(" ");
}

/** Load tokenizer, spec, and ONNX session from a folder laid out like sensitivity-scanner-v6/model/onnx/. */
export async function loadSpartan({ ort, PreTrainedTokenizer, baseUrl, executionProviders, fetchJson }) {
  const url = (path) => new URL(path, baseUrl).href;
  const [spec, tokenizerJson, tokenizerConfig] = await Promise.all([
    fetchJson(url("scanner_spec.json")),
    fetchJson(url("tokenizer.json")),
    fetchJson(url("tokenizer_config.json")),
  ]);
  const tokenizer = new PreTrainedTokenizer(tokenizerJson, tokenizerConfig);
  const scanner = await Scanner.create({
    ort,
    tokenizer,
    spec,
    modelUrl: url(spec.recommended_file),
    sessionOptions: { executionProviders },
  });
  return scanner;
}

/**
 * Classify one file's text with the v6 pipeline. Returns the fields the results page reads
 * (dangerous, classificationSource, dangerousProbability, flagCategories, flagged block…).
 */
export async function classifyWithSpartan(scanner, text, { wordLimit, onBlock = () => {} } = {}) {
  const { threshold, block_words: blockWords } = scanner.spec;
  const content = limitWords(text, wordLimit);
  const blocks = splitBlocks(content, blockWords);
  const wordCount = content.split(/\s+/).filter(Boolean).length;
  const flagged = (index) => ({
    firstFlaggedBlock: index,
    flaggedText: blocks[index],
    flaggedWordStart: index * blockWords + 1,
    flaggedWordEnd: Math.min(wordCount, (index + 1) * blockWords),
  });

  const rules = findRules(content);
  if (rules.length) {
    // Rules look at the whole text; point at the first block that matches on its own.
    const index = blocks.findIndex((block) => findRules(block).length);
    return {
      dangerous: true,
      classificationSource: "prefilter",
      prefilterMatches: rules,
      flagCategories: ruleFlagDetails(rules),
      ...(index >= 0 ? flagged(index) : { firstFlaggedBlock: null }),
      blockCount: blocks.length,
      wordCount,
    };
  }

  let best = 0;
  let bestProbs = null;
  for (let index = 0; index < blocks.length; index += 1) {
    if (!blockHasSignal(blocks[index])) continue;
    onBlock(index + 1, blocks.length);
    const probs = await scanner.scoreBlock(blocks[index]);
    const score = 1 - probs.none;
    if (score > best) [best, bestProbs] = [score, probs];
    if (score >= threshold) {
      return {
        dangerous: true,
        classificationSource: "model",
        dangerousProbability: score,
        flagCategories: modelFlagDetails(probs),
        labelProbabilities: probs,
        ...flagged(index),
        blockCount: blocks.length,
        wordCount,
      };
    }
  }
  return {
    dangerous: false,
    classificationSource: "model",
    dangerousProbability: best,
    flagCategories: [],
    labelProbabilities: bestProbs,
    firstFlaggedBlock: null,
    blockCount: blocks.length,
    wordCount,
  };
}
