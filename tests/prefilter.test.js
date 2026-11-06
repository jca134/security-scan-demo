import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DANGEROUS_KEYWORDS,
  prefilterCategories,
  prefilterFlagDetails,
  findDangerousPrefilterMatches,
  prefilterDangerousText,
} from "../web/prefilter.js";

describe("dangerous-content pre-filter", () => {
  it("maintains a unique 150-term dangerous keyword bank", () => {
    assert.equal(DANGEROUS_KEYWORDS.length, 150);
    assert.equal(new Set(DANGEROUS_KEYWORDS).size, DANGEROUS_KEYWORDS.length);
  });

  it("matches dangerous keywords without partial-word matches", () => {
    assert.equal(prefilterDangerousText("Production API_KEY = hidden-value").dangerous, true);
    assert.equal(prefilterDangerousText("A compass code points north.").dangerous, false);
  });

  it("matches labels and markings that occur in university files", () => {
    assert.ok(findDangerousPrefilterMatches("DOB: 1982-04-17").includes("keyword: dob"));
    assert.ok(findDangerousPrefilterMatches("EMPLID: 00912345").includes("keyword: emplid"));
    assert.ok(findDangerousPrefilterMatches("CUI//SP-EXPT").includes("keyword: cui"));
  });

  it("matches valid formatted Social Security numbers", () => {
    assert.ok(findDangerousPrefilterMatches("Employee: 123-45-6789").includes("Social Security number pattern"));
    assert.equal(prefilterDangerousText("Invalid example: 000-12-3456").dangerous, false);
  });

  it("requires credit-card candidates to pass the Luhn check", () => {
    assert.ok(findDangerousPrefilterMatches("4111 1111 1111 1111").includes("credit-card number pattern"));
    assert.equal(prefilterDangerousText("4111 1111 1111 1112").dangerous, false);
  });

  it("recognizes common API key and private-key formats", () => {
    assert.ok(findDangerousPrefilterMatches("AKIAIOSFODNN7EXAMPLE").includes("AWS access key pattern"));
    assert.ok(findDangerousPrefilterMatches("-----BEGIN PRIVATE KEY-----").includes("private-key block pattern"));
  });

  it("leaves ordinary content for model classification", () => {
    assert.deepEqual(prefilterDangerousText("Quarterly planning notes and project milestones."), {
      dangerous: false,
      matches: [],
    });
  });
});

describe("pre-filter categories", () => {
  const categoriesFor = (text) => prefilterCategories(prefilterDangerousText(text).matches);

  it("names the kind of sensitive data that matched", () => {
    assert.deepEqual(categoriesFor("Patient ID 4432 with lab results"), ["Medical / health"]);
    assert.deepEqual(categoriesFor("Routing number and account number"), ["Financial"]);
    assert.deepEqual(categoriesFor("SSN 123-45-6789"), ["Government ID"]);
    assert.deepEqual(categoriesFor("AKIAIOSFODNN7EXAMPLE"), ["Passwords & secret keys"]);
    assert.deepEqual(categoriesFor("Attorney client privileged memo"), ["Restricted or legal document"]);
  });

  it("lists each matching category once", () => {
    assert.deepEqual(categoriesFor("Student ID, final grade, and the password"), ["Student records", "Passwords & secret keys"]);
  });
});

describe("pre-filter flag details", () => {
  const detailsFor = (text) => prefilterFlagDetails(prefilterDangerousText(text).matches);

  it("says exactly what was found under each category", () => {
    assert.deepEqual(detailsFor("SSN 123-45-6789"), ["Government ID (“ssn”, Social Security number)"]);
    assert.deepEqual(detailsFor("Patient ID 4432 with lab results"), ["Medical / health (“patient id”, “lab results”)"]);
    assert.deepEqual(detailsFor("AKIAIOSFODNN7EXAMPLE"), ["Passwords & secret keys (AWS access key)"]);
    assert.deepEqual(detailsFor("Card 4111 1111 1111 1111"), ["Financial (credit card number)"]);
  });
});
