import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyWithSpartan, modelFlagDetails, ruleFlagDetails } from "../web/spartan-v6/pipeline.js";

// Stand-in for the v6 Scanner: same spec fields, scoreBlock returns fixed probabilities per block.
function fakeScanner(probsForBlock) {
  const scored = [];
  return {
    scored,
    spec: { threshold: 0.5, block_words: 100 },
    async scoreBlock(block) {
      scored.push(block);
      return probsForBlock(block);
    },
  };
}

const words = (n, word = "update") => Array.from({ length: n }, (_, i) => `${word}${i}`).join(" ");
const harmless = { medical: 0.01, financial: 0.01, none: 0.99 };

describe("Spartan v6 pipeline", () => {
  it("flags pattern-rule matches without running the model and names the category", async () => {
    const scanner = fakeScanner(() => harmless);
    const result = await classifyWithSpartan(scanner, "Employee SSN 532-81-4410 on file.", { wordLimit: 500 });
    assert.equal(result.dangerous, true);
    assert.equal(result.classificationSource, "prefilter");
    assert.deepEqual(result.flagCategories, ["Government ID (Social Security number)"]);
    assert.equal(result.flaggedWordStart, 1);
    assert.equal(scanner.scored.length, 0);
  });

  it("stops at the first block scoring at least the threshold and reports it", async () => {
    // Block 2 mentions a diagnosis; blocks need a personal signal (a name) to be scored at all.
    const text = `${words(100)} Dana Whitfield was diagnosed with bipolar disorder ${words(93)} Dana Whitfield ${words(200)}`;
    const scanner = fakeScanner((block) => (block.includes("diagnosed")
      ? { medical: 0.97, legal_hr: 0.1, none: 0.04 }
      : harmless));
    const result = await classifyWithSpartan(scanner, text, { wordLimit: Infinity });
    assert.equal(result.dangerous, true);
    assert.equal(result.classificationSource, "model");
    assert.equal(result.firstFlaggedBlock, 1);
    assert.equal(result.flaggedWordStart, 101);
    assert.equal(result.flaggedWordEnd, 200);
    assert.ok(Math.abs(result.dangerousProbability - 0.96) < 1e-9);
    assert.deepEqual(result.flagCategories, ["Medical / health (97%)"]);
    assert.ok(scanner.scored.length <= 2, "later blocks are skipped once a block is flagged");
  });

  it("honours the word limit", async () => {
    const text = `${words(150)} Dana Whitfield was diagnosed with bipolar disorder`;
    const scanner = fakeScanner((block) => (block.includes("diagnosed") ? { medical: 0.97, none: 0.04 } : harmless));
    const limited = await classifyWithSpartan(scanner, text, { wordLimit: 100 });
    assert.equal(limited.dangerous, false);
    const whole = await classifyWithSpartan(scanner, text, { wordLimit: Infinity });
    assert.equal(whole.dangerous, true);
  });

  it("formats model categories, falling back to the top label", () => {
    assert.deepEqual(
      modelFlagDetails({ medical: 0.9, student_records: 0.6, financial: 0.2, none: 0.05 }),
      ["Medical / health (90%)", "Student records (60%)"],
    );
    assert.deepEqual(modelFlagDetails({ credentials: 0.34, medical: 0.1, none: 0.4 }), ["Passwords & secret keys (34%)"]);
    assert.deepEqual(
      ruleFlagDetails(["ssn", "dob", "card"]),
      ["Government ID (Social Security number, date of birth)", "Financial (credit card number)"],
    );
  });
});

describe("Spartan v6 rules portability", () => {
  it("avoids regex modifier groups, which break builds on Node 20/22 and older browsers", async () => {
    const { readFileSync } = await import("node:fs");
    const code = readFileSync(new URL("../web/spartan-v6/rules.mjs", import.meta.url), "utf8")
      .split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    assert.equal(/\(\?-?i:/.test(code), false);
  });

  it("keeps the case rules of the rewritten patterns", async () => {
    const { findRules, blockHasSignal } = await import("../web/spartan-v6/rules.mjs");
    // Keyword part ignores case; the secret itself must still mix lower case, upper case, and a digit or symbol.
    assert.ok(findRules("PASSWORD: Hunter2!xyz").includes("credential"));
    assert.ok(findRules("Pin: Qx7!mmmmz").includes("credential"));
    // Login pairs: "USERNAME" matches regardless of case, but an all-lowercase secret is not flagged.
    assert.ok(findRules("USERNAME admin / P4ssw0rd!X").includes("credential"));
    assert.deepEqual(findRules("log-in jdoe / weakpassword"), []);
    assert.equal(blockHasSignal("Patient was DIAGNOSED last week"), true);
    assert.equal(blockHasSignal("no signal here at all"), false);
  });
});
