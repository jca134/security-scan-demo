// Copied from sensitivity-scanner-v6/browser/rules.mjs (commit a56d3d7). Keep in sync.
// One change: the three patterns that used regex modifier groups (case-insensitive sub-groups, which need
// Chrome 125+ / Node 23+) are rewritten as equivalent patterns built with ci(), so the file parses in every
// browser and in the Node versions Cloudflare Pages builds with. tests/spartan-v6.test.js checks this.
// JavaScript port of ../python/sensitive_rules.py (keep the two in step; check.mjs compares them on every test file).
// Fast pattern rules for data with a fixed shape: IDs, card numbers, keys, credentials, named HR actions.
//
//   import { findRules, blockHasSignal } from "./rules.mjs";
//   findRules(text)  // -> ["ssn", "credential", ...]

const PLACEHOLDER_SSNS = new Set(["123-45-6789", "078-05-1120", "219-09-9999"]);
const TEST_CARDS = new Set(["4242424242424242", "4111111111111111", "4000000000000002", "5555555555554444",
  "378282246310005", "6011111111111117"]);
const PLACEHOLDER_WORDS = /your[-_ ]?|<|example|placeholder|xxx|\*\*\*|change[-_ ]?me|here/i;

// Make a regex source case-insensitive without the i flag: letters become [xX] (inside [...] both cases are
// added). Escapes like \b, \s, \w, \d, \n are left alone. Used where only part of a pattern ignores case.
function ci(source) {
  let out = "";
  let inClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (c === "\\") { out += c + source[i + 1]; i += 1; continue; }
    if (inClass) {
      if (c === "]") inClass = false;
      out += /[a-z]/i.test(c) ? c.toLowerCase() + c.toUpperCase() : c;
      continue;
    }
    if (c === "[") { inClass = true; out += c; continue; }
    out += /[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c;
  }
  return out;
}

const SSN = /\b(?!000|666)(\d{3})-(?!00)\d{2}-(?!0000)\d{4}\b/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const AWS_KEY = /\bAKIA[0-9A-Z]{12,}\b/;
const STRIPE_KEY = /\bsk_live_[0-9A-Za-z_]{8,}/;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const SECRET_ASSIGN = /(?<![a-z0-9])(?:[a-z0-9]+_)*(?:password|passwd|pwd|pw|secret|api[_-]?key|token|secret_access_key)\b\s*[:=]\s*["']?([^\s"']{6,})/gi;
const SECRET_INLINE = /\b(?:pw|passwd|password|passphrase)\s+(?=\S*\d)(?=\S*[a-z])(?=\S*[^\w\s])(\S{6,})/gi;
const REFERENCE = /^(?:[A-Z][A-Z_]*[,);]*|(?:os\.environ|os\.getenv|process\.env|getenv|ENV\[|\$\{?|%\(|\{\{).*)$/;
const DB_URL = /\b[a-z]+:\/\/[^\s:/]+:([^\s@/]{4,})@/g;
const ROUTING = /\brouting\b[^\d\n]{0,20}\d{9}\b/i;
const ACCOUNT = /\b(?:account|acct)\b[^\d\n]{0,20}\d{6,17}\b/i;
const DOB = /\b(?:DOB|date of birth)\b[:\s]*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/i;
const PASSPORT = /\bpassport\b[^\n]{0,25}\b[A-Z]{1,2}\d{6,8}\b/i;
const SEVIS = /\bN\d{10}\b/;
const SECRET_GAP = new RegExp(
  ci(String.raw`\b(?:password|passcode|passphrase|passwd|pw|pwd)\b[^\n:=]{0,30}?[:=]?\s*["']?`)
  + String.raw`(?=\S*[a-zA-Z])(?=\S*\d)(?=\S*[A-Z!#$%&*?@^~>-])(?![@/])([^\s"',;/]{8,64})(?![/:@\w])`,
  "g",
);
const TOKENS = /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/;
const IBAN = /\b([A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30})\b/g;
const IBAN_LABELED = /\bIBAN\b[:\s]{0,3}[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9][ ]?){10,30}/i;
const NINO = /\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/;
const ID_LABELED = /\b(?:national insurance|NINO|SIN|social insurance|driver'?s licen[cs]e|licen[cs]e (?:no|number|#)|DL|ITIN|EIN|tax ID|TIN|state ID|green card|alien (?:no|number|registration)|A-number)\b[^\n\d]{0,20}([A-Z]{0,3}[\d][\d .-]{5,18}\d[A-Z]?)/i;
const MBI = /\b[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d[AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d[AC-HJKMNP-RT-Y]{2}\d{2}\b/;
const MEDICAL_ID = /\b(?:MRN|medical record (?:no|number|#)|(?:insurance|member|policy|medicaid|medicare) (?:ID|no|number|#))[:#\s]{0,4}[A-Z]{0,3}\d{6,}/i;
// Case-sensitive on purpose: a secret needs a lowercase letter, an uppercase letter, and a digit or symbol.
const SECRET = String.raw`(?=[^\s/]*[a-z])(?=[^\s/]*[A-Z])(?=[^\s/]*[\d!#$%&*?@^~])([^\s"',;/()]{8,64})(?![\w/:@.])`;
const PASS_LABELED = new RegExp(ci(String.raw`\b(?:pass|pw|pwd|pin)\s*[:=]\s*["']?`) + SECRET, "g");
const LOGIN_PAIR = new RegExp(ci(String.raw`\b(?:wi-?fi|wireless|ssid|network|log-?in|logon|sign-?in|credentials?|username|user ?name|account)\b[^\n]{0,60}?\S\s*/\s*`) + SECRET, "g");
const HR_ACTION = /\b[A-Z][a-z]+(?: [A-Z]\.)? [A-Z][A-Za-z'-]+ (?:was|has been|is being|will be|is) (?:placed on (?:administrative|paid|unpaid|investigative|disciplinary) leave|terminated for|issued a (?:written|final|formal) warning|placed on a performance improvement plan|under (?:investigation|disciplinary review) for)/;

// Block pre-filter: a block with none of these is very unlikely to hold personal data, so the model skips it.
const SIGNAL = new RegExp(
  String.raw`\d{3,}|@|\b[A-Z][a-z]+ [A-Z][a-z]+\b|\b(?:Mr|Ms|Mrs|Dr|Prof)\.?\s+[A-Z]|`
  + ci(String.raw`\b(?:patient|diagnos\w*|medication|therapy|counsel\w*|hospital\w*|disab\w*|pregnan\w*|cancer|suicid\w*|grade|gpa|probation|disciplin\w*|conduct|salary|payroll|bank|account|password|secret|key|ssn|social security|passport|visa|sevis|immigration|lawsuit|attorney|counsel|harass\w*|complaint|arrest|criminal|confidential|private|dob|birth|address|phone)\b`),
);

export function blockHasSignal(text) {
  return SIGNAL.test(text);
}

function luhn(digits) {
  let total = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) d = d > 4 ? d * 2 - 9 : d * 2;
    total += d;
    alt = !alt;
  }
  return total % 10 === 0;
}

function ibanOk(raw) {
  const s = raw.replaceAll(" ", "");
  if (s.length < 15 || s.length > 34) return false;
  let rem = 0;
  for (const c of s.slice(4) + s.slice(0, 4)) {
    for (const d of String(parseInt(c, 36))) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

// A symbol, or a digit between letters plus two case changes (passwords, not CamelCase2 names).
function randomSecret(s) {
  if (/[!#$%&*?@^~]/.test(s)) return true;
  let changes = 0;
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1], b = s[i];
    if (/\p{L}/u.test(a) && /\p{L}/u.test(b) && /\p{Lu}/u.test(a) !== /\p{Lu}/u.test(b)) changes++;
  }
  return changes >= 2 && /[A-Za-z]\d+[A-Za-z]/.test(s);
}

const all = (re, text) => [...text.matchAll(re)];

export function findRules(text) {
  const hits = [];
  if (all(SSN, text).some((m) => !PLACEHOLDER_SSNS.has(m[0]))) hits.push("ssn");
  for (const m of text.matchAll(CARD)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && !TEST_CARDS.has(digits) && luhn(digits)) {
      hits.push("card");
      break;
    }
  }
  if (AWS_KEY.test(text) || STRIPE_KEY.test(text) || PRIVATE_KEY.test(text)) hits.push("api_or_private_key");
  if ([...all(SECRET_ASSIGN, text), ...all(SECRET_INLINE, text)].some((m) => !PLACEHOLDER_WORDS.test(m[1]) && !REFERENCE.test(m[1])))
    hits.push("credential");
  if (all(DB_URL, text).some((m) => !PLACEHOLDER_WORDS.test(m[1]) && !REFERENCE.test(m[1]))) hits.push("credential_url");
  if (ROUTING.test(text) || ACCOUNT.test(text)) hits.push("bank_account");
  if (DOB.test(text)) hits.push("dob");
  if (PASSPORT.test(text) || SEVIS.test(text)) hits.push("passport_or_visa_id");
  if (!hits.includes("credential") && all(SECRET_GAP, text).some((m) => !PLACEHOLDER_WORDS.test(m[1]))) hits.push("credential");
  if (TOKENS.test(text) && !hits.includes("api_or_private_key")) hits.push("api_or_private_key");
  if (IBAN_LABELED.test(text) || all(IBAN, text).some((m) => ibanOk(m[1]))) hits.push("iban");
  if (NINO.test(text) || ID_LABELED.test(text)) hits.push("other_id");
  if (MEDICAL_ID.test(text) || MBI.test(text)) hits.push("medical_id");
  if (!hits.includes("credential") && (
    all(PASS_LABELED, text).some((m) => !PLACEHOLDER_WORDS.test(m[1])) ||
    all(LOGIN_PAIR, text).some((m) => randomSecret(m[1]) && !PLACEHOLDER_WORDS.test(m[1])))) hits.push("credential");
  if (HR_ACTION.test(text)) hits.push("hr_action");
  return hits;
}
