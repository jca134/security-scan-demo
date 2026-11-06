// Keywords grouped by the kind of sensitive data they indicate.
export const DANGEROUS_KEYWORD_GROUPS = Object.freeze({
  // Identity and government-record labels.
  "Government ID": Object.freeze([
    "ssn",
    "social security number",
    "social security no",
    "last four of ssn",
    "last 4 of ssn",
    "tin",
    "tax id",
    "taxpayer id",
    "itin",
    "ein",
    "passport number",
    "passport no",
    "driver's license number",
    "driver license number",
    "driver license no",
    "state id number",
    "date of birth",
    "dob",
    "mother's maiden name",
    "alien registration number",
  ]),
  // Labels and identifiers commonly used by student-information systems.
  "Student records": Object.freeze([
    "student id",
    "student id number",
    "student number",
    "sid",
    "emplid",
    "banner id",
    "peoplesoft id",
    "netid",
    "university id",
    "campus id",
    "student email",
    "grade roster",
    "final grade",
    "final grades",
    "academic transcript",
    "unofficial transcript",
    "disciplinary record",
    "student conduct",
    "ferpa",
    "financial aid id",
  ]),
  // Banking and payment labels.
  "Financial": Object.freeze([
    "bank account number",
    "account number",
    "routing number",
    "aba routing number",
    "aba number",
    "iban",
    "swift code",
    "credit card number",
    "debit card number",
    "card number",
    "cvv",
    "cvc",
    "card security code",
    "pin",
    "direct deposit",
    "wire instructions",
    "beneficiary account",
    "payment card",
    "billing account",
    "bank statement",
  ]),
  // Credential and cryptographic-secret labels and markers.
  "Passwords & secret keys": Object.freeze([
    "api key",
    "apikey",
    "access token",
    "oauth token",
    "refresh token",
    "auth token",
    "bearer token",
    "authorization bearer",
    "client secret",
    "secret key",
    "password",
    "passwd",
    "pwd",
    "database password",
    "db password",
    "connection string",
    "private key",
    "begin private key",
    "begin rsa private key",
    "begin openssh private key",
    "ssh private key",
    "pgp private key",
    "service account key",
    "recovery code",
    "seed phrase",
  ]),
  // Health-record field labels.
  "Medical / health": Object.freeze([
    "mrn",
    "medical record number",
    "patient id",
    "patient identifier",
    "member id",
    "insurance id",
    "policy number",
    "subscriber id",
    "health plan id",
    "diagnosis code",
    "icd-10",
    "prescription number",
    "rx number",
    "lab results",
    "phi",
  ]),
  // HR, payroll, and tax-form labels.
  "HR & payroll": Object.freeze([
    "employee id",
    "employee number",
    "personnel number",
    "payroll id",
    "payroll record",
    "direct deposit form",
    "salary",
    "annual salary",
    "hourly rate",
    "w-2",
    "w-4",
    "i-9",
    "1099",
    "background check",
    "termination date",
  ]),
  // Human-subject research labels.
  "Research participant data": Object.freeze([
    "participant id",
    "subject id",
    "study id",
    "protocol number",
    "irb number",
    "irb protocol",
    "informed consent",
    "hipaa authorization",
    "research participant",
    "human subject",
    "participant name",
    "participant email",
    "participant phone",
    "re-identification key",
    "linkage key",
  ]),
  // Markings that actually appear on restricted or privileged documents.
  "Restricted or legal document": Object.freeze([
    "cui",
    "controlled unclassified information",
    "cui category",
    "cui basic",
    "cui specified",
    "controlled by",
    "cui poc",
    "limited dissemination control",
    "noforn",
    "fed only",
    "fedcon",
    "nocon",
    "dl only",
    "itar",
    "export controlled",
    "attorney client privileged",
    "attorney work product",
    "confidential informant",
    "victim identity",
    "witness identity",
  ]),
});

export const DANGEROUS_KEYWORDS = Object.freeze(Object.values(DANGEROUS_KEYWORD_GROUPS).flat());

const API_KEY_PATTERNS = [
  { label: "private-key block", pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/i },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "GitHub token", pattern: /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,255}\b/ },
  { label: "OpenAI-style API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { label: "Stripe secret key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { label: "Slack token", pattern: /\bxox(?:b|p|a|r|s)-[A-Za-z0-9-]{16,}\b/ },
  {
    label: "assigned secret",
    pattern: /\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i,
  },
];

const SSN_PATTERN = /\b(?!000|666|9\d{2})\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/;
const CARD_CANDIDATE_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;

function normalizedWords(text) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2010-\u2015_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function containsKeyword(text, keyword) {
  const normalizedKeyword = normalizedWords(keyword);
  const escaped = normalizedKeyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

function passesLuhn(number) {
  let sum = 0;
  let doubleDigit = false;
  for (let index = number.length - 1; index >= 0; index -= 1) {
    let digit = Number(number[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function containsCreditCardNumber(text) {
  for (const match of text.matchAll(CARD_CANDIDATE_PATTERN)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && !/^(\d)\1+$/.test(digits) && passesLuhn(digits)) {
      return true;
    }
  }
  return false;
}

export function findDangerousPrefilterMatches(value) {
  const text = String(value || "");
  if (!text) return [];
  const words = normalizedWords(text);
  const matches = [];

  for (const keyword of DANGEROUS_KEYWORDS) {
    if (containsKeyword(words, keyword)) matches.push(`keyword: ${keyword}`);
  }
  if (SSN_PATTERN.test(text)) matches.push("Social Security number pattern");
  if (containsCreditCardNumber(text)) matches.push("credit-card number pattern");
  for (const { label, pattern } of API_KEY_PATTERNS) {
    if (pattern.test(text)) matches.push(`${label} pattern`);
  }

  return [...new Set(matches)];
}

export function prefilterDangerousText(value) {
  const matches = findDangerousPrefilterMatches(value);
  return { dangerous: matches.length > 0, matches };
}

const KEYWORD_CATEGORY = new Map(
  Object.entries(DANGEROUS_KEYWORD_GROUPS).flatMap(([category, keywords]) => keywords.map((keyword) => [keyword, category])),
);

function describeMatch(match) {
  if (match.startsWith("keyword: ")) {
    const keyword = match.slice("keyword: ".length);
    return { category: KEYWORD_CATEGORY.get(keyword) || "Sensitive keyword", detail: `“${keyword}”` };
  }
  if (match === "Social Security number pattern") return { category: "Government ID", detail: "Social Security number" };
  if (match === "credit-card number pattern") return { category: "Financial", detail: "credit card number" };
  // API-key, token, and private-key patterns, e.g. "AWS access key pattern".
  return { category: "Passwords & secret keys", detail: match.replace(/ pattern$/u, "") };
}

/**
 * Group pre-filter matches by category with what was found, e.g.
 * "Government ID (Social Security number)" or "Medical / health (“patient id”)".
 */
export function prefilterFlagDetails(matches) {
  const grouped = new Map();
  for (const match of matches || []) {
    const { category, detail } = describeMatch(match);
    if (!grouped.has(category)) grouped.set(category, []);
    if (!grouped.get(category).includes(detail)) grouped.get(category).push(detail);
  }
  return [...grouped].map(([category, details]) => `${category} (${details.join(", ")})`);
}

/** Map pre-filter match labels to human-readable categories such as "Medical / health". */
export function prefilterCategories(matches) {
  return [...new Set((matches || []).map((match) => describeMatch(match).category))];
}
