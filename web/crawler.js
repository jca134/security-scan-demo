import { AUTH_CHANNEL, takeAuthorization, validAuthorization } from "./auth-handoff.js";
import { googleClientConfigured } from "./config.js";
import { DriveAuthorizationError, scanDrive, scanFolder } from "./drive.js";

const $ = (selector) => document.querySelector(selector);

const authStatus = $("#auth-status");
const loginLink = $("#login-link");
const logoutLink = $("#logout-link");
const modeInputs = [...document.querySelectorAll('input[name="scan-mode"]')];
const classifier = $("#classifier");
const modelSelect = $("#model-select");
const loadModelButton = $("#load-model");
const modelStatus = $("#model-status");
const classificationPrompt = $("#classification-prompt");
const scanner = $("#scanner");
const scanForm = $("#scan-form");
const scanButton = $("#scan-button");
const folderUrlInput = $("#folder-url");
const folderField = $("#folder-field");
const targetInputs = [...document.querySelectorAll('input[name="scan-target"]')];
const scanStatus = $("#scan-status");
const results = $("#results");
const fileResults = $("#file-results");
const scanBoundary = $("#scan-boundary");
const scopeDescription = $("#scope-description");
const classifierWorker = new Worker(new URL("./classifier-worker.js", import.meta.url), { type: "module" });

/* global __SPARTAN_V6_MODEL_URL__ */
const SPARTAN_AVAILABLE = Boolean(__SPARTAN_V6_MODEL_URL__);

const models = {
  "spartan-v6": {
    name: "Spartan v6",
    size: "about 150 MB",
    notice: "Our team's fine-tuned sensitivity model (GLiNER2.5-small) with its own pattern rules.",
  },
  "gliner2.5-decide-mobile-q4f16": {
    name: "GLiNER2.5-Decide mobile q4f16",
    size: "about 345 MB",
    notice: "Benchmark-selected P4 classifier with deterministic sensitive-data prefiltering.",
  },
};

const modeDetails = {
  sharing: {
    auth: "Sign in with metadata-only access. File contents will remain unread.",
    connected: "Connected in Sharing only mode. File contents won't be read. You can switch to Sharing + content at any time.",
    scanning: "Reading file metadata and sharing permissions from Google Drive…",
    boundary: "The scanner reads metadata and sharing permissions only. It will not download or export file contents.",
    scope: "This session uses drive.metadata.readonly. File contents are never downloaded, exported, displayed, or sent to the local model.",
  },
  content: {
    auth: "Sign in with read-only access to check shared and public files for sensitive content locally.",
    connected: "Connected in content mode. Load a local model before scanning.",
    scanning: "Reading permissions, then reading samples from shared and public files…",
    boundary: "Permissions are checked first. Only files shared with someone else are read (private files never are), and only the amount of each file you chose above is checked by the in-browser model.",
    scope: "This session uses drive.readonly. Restricted and private files remain metadata-only; content is extracted only for files available to anyone.",
  },
};

const riskDetails = {
  DANGEROUS: {
    label: "Sensitive · Public",
    description: "Anyone with the link can open this file, and it was flagged as sensitive",
  },
  DANGEROUS_SHARED: {
    label: "Sensitive · Shared",
    description: "Shared with specific people, and flagged as sensitive",
  },
  RED: { label: "Public", description: "Anyone can access this file" },
  YELLOW: { label: "Shared", description: "Shared with specific people, a group, or a domain" },
  GREEN: { label: "Private", description: "Only the owner has access" },
};

let activeMode = "sharing";
let signedIn = false;
let authorization = null;
let classifierReady = false;
// Model switching: which models the worker has loaded, which one scans use, and which one is loading now.
const loadedModels = new Set();
let activeModelKey = null;
let loadingModelKey = null;
let modelSupported = false;
let scanning = false;
let currentFiles = [];
let classificationProgress = null;
let pendingUpgrade = false;
let scanWordLimit = 500;
let modelRun = null;
let progressStage = null;
let resultFilter = "ALL";
let resultSort = "exposure";
const modelDownloads = new Map();

function selectedMode() {
  return modeInputs.find((input) => input.checked)?.value || "sharing";
}

function setModelStatus(message, kind = "") {
  modelStatus.textContent = message;
  modelStatus.className = `model-status ${kind}`.trim();
}

const SECONDS_PER_FILE = 0.8;
const SECONDS_PER_MODEL_FILE = 1;

const PROGRESS_STAGES = {
  listing: { label: "Finding files" },
  permissions: { label: "Reading sharing settings" },
  content: { label: "Reading samples from shared and public files" },
  classifying: { label: "Checking samples on your device" },
};

function formatRemaining(seconds) {
  if (seconds < 10) return "Almost done";
  if (seconds < 60) return `About ${Math.max(10, Math.round(seconds / 5) * 5)} sec left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `About ${minutes} min left`;
  return `About ${Math.floor(minutes / 60)} hr ${minutes % 60} min left`;
}

/** Show the current scan step, a bar for that step, and a time estimate of 0.8 s per remaining file. */
function setScanProgress(stage, completed = 0, total = 0) {
  const stages = activeMode === "content"
    ? ["listing", "permissions", "content", "classifying"]
    : ["listing", "permissions"];
  if (!progressStage || progressStage.name !== stage) progressStage = { name: stage };
  const bar = $("#scan-progress-bar");
  const eta = $("#scan-progress-eta");
  const step = stages.indexOf(stage) + 1;
  const counts = total > 0 ? ` · ${completed} of ${total}` : completed > 0 ? ` · ${completed} found` : "";
  $("#scan-progress-label").textContent = `Step ${step} of ${stages.length}: ${PROGRESS_STAGES[stage].label}${counts}`;
  $("#scan-progress").hidden = false;

  if (total <= 0) {
    bar.removeAttribute("value"); // indeterminate while the total is unknown
    eta.textContent = "";
    return;
  }
  bar.value = Math.min(1, completed / total);
  eta.textContent = completed >= total ? "" : formatRemaining((total - completed) * SECONDS_PER_FILE);
}

function hideScanProgress() {
  progressStage = null;
  $("#scan-progress").hidden = true;
  $("#model-run").hidden = true;
}

function fileById(fileId) {
  return currentFiles.find((candidate) => candidate.id === fileId);
}

function cardFor(fileId) {
  return [...fileResults.querySelectorAll(".file-card")].find((card) => card.dataset.fileId === fileId);
}

function setBar(id, labelId, label, completed, total) {
  $(`#${labelId}`).textContent = label;
  $(`#${id}`).value = total > 0 ? Math.min(1, completed / total) : 0;
}

/** Live "Going through the model" panel: one bar for files, one for sections of the current file. */
function showModelRun({ fileId = null, completed = 0, total = 0, block = 0, blocks = 0 } = {}) {
  $("#model-run").hidden = false;
  const remaining = Math.max(total - completed, 0);
  $("#model-run-eta").textContent = remaining > 0 ? formatRemaining(remaining * SECONDS_PER_MODEL_FILE) : "";
  setBar("model-run-files", "model-run-files-label", `File ${Math.min(completed + (fileId ? 1 : 0), total)} of ${total}`, completed, total);
  const file = fileId ? fileById(fileId) : null;
  $("#model-run-file").textContent = file
    ? file.name
    : completed > 0 ? "Moving to the next file…" : "Starting the local AI model…";
  setBar(
    "model-run-blocks",
    "model-run-blocks-label",
    blocks ? `Section ${Math.max(block, 1)} of ${blocks} in this file (100 words each)` : "Sections in this file",
    Math.max(block - 1, 0),
    blocks,
  );
}

function markCardInProgress(fileId, block, blocks) {
  const line = cardFor(fileId)?.querySelector(".model-result");
  if (!line) return;
  line.classList.add("is-running");
  line.textContent = blocks > 1
    ? `Going through the model… section ${block} of ${blocks}`
    : "Going through the model…";
}

function setChoicesDisabled(disabled) {
  [...targetInputs, ...modeInputs, $("#word-limit")].forEach((input) => { input.disabled = disabled; });
  // The model picker also stays locked while a model is loading.
  modelSelect.disabled = disabled || Boolean(loadingModelKey);
}

/** Point the worker at a model: switch instantly if it is already loaded, otherwise download it. */
function requestModel(key) {
  loadingModelKey = key;
  classifierReady = false;
  modelSelect.disabled = true;
  loadModelButton.disabled = true;
  syncScanAvailability();
  if (loadedModels.has(key)) {
    loadModelButton.textContent = "Switching…";
    setModelStatus(`Switching to ${models[key].name}…`);
  } else {
    modelDownloads.clear();
    loadModelButton.textContent = "Loading…";
    $("#model-progress-value").textContent = "Starting";
    $("#model-meter-fill").style.width = "0%";
    $("#model-progress-detail").textContent = `${models[key].size} on the first load`;
    setModelStatus("Fetching the model or reading it from browser cache…");
  }
  classifierWorker.postMessage({ type: "load", modelId: key, dtype: "q4f16" });
}

/** Button, status, and scan availability for the model currently chosen in the picker. */
function updateModelControls() {
  const key = modelSelect.value;
  const name = models[key].name;
  if (loadingModelKey) return;
  classifierReady = key === activeModelKey;
  if (classifierReady) {
    loadModelButton.disabled = true;
    loadModelButton.textContent = "Model ready";
    $("#model-progress-value").textContent = "Ready";
    $("#model-meter-fill").style.width = "100%";
    setModelStatus(`${name} is loaded locally and ready to check shared and public files.`, "ok");
  } else {
    loadModelButton.disabled = !modelSupported;
    loadModelButton.textContent = "Download model";
    $("#model-progress-value").textContent = "Not loaded";
    $("#model-meter-fill").style.width = "0%";
    $("#model-progress-detail").textContent = `${models[key].size} on the first load; later loads may use browser cache.`;
    if (activeModelKey) {
      setModelStatus(`Download ${name} to use it, or switch back to ${models[activeModelKey].name}.`);
    }
  }
  syncScanAvailability();
}

/** Words to check per file: a number, or Infinity for the whole document. */
function selectedWordLimit() {
  const value = $("#word-limit").value;
  return value === "all" ? Infinity : Number(value) || 500;
}

function wordLimitText(limit) {
  return Number.isFinite(limit) ? `up to the first ${limit.toLocaleString()} words` : "the whole document";
}

function scanTarget() {
  return targetInputs.find((input) => input.checked)?.value === "drive" ? "drive" : "folder";
}

function updateTargetChoice() {
  const wholeDrive = scanTarget() === "drive";
  folderField.hidden = wholeDrive;
  folderUrlInput.hidden = wholeDrive;
  folderUrlInput.required = !wholeDrive;
  setChoicesDisabled(scanning);
  syncScanAvailability();
}

function syncScanAvailability() {
  const modelRequired = activeMode === "content" && !classifierReady;
  scanButton.disabled = !signedIn || scanning || modelRequired;
  if (!scanning) scanButton.textContent = scanTarget() === "drive" ? "Scan my Drive" : "Scan folder";
  if (signedIn && modelRequired) {
    scanStatus.className = "scan-status";
    scanStatus.textContent = "Load the browser model before scanning in content mode.";
  } else if (!scanning && scanStatus.textContent === "Load the browser model before scanning in content mode.") {
    scanStatus.textContent = "";
  }
}

function applyMode(mode) {
  activeMode = modeDetails[mode] ? mode : "sharing";
  const detail = modeDetails[activeMode];
  loginLink.href = `authorize.html?mode=${encodeURIComponent(activeMode)}`;
  scanBoundary.textContent = detail.boundary;
  scopeDescription.textContent = detail.scope;
  classifier.hidden = activeMode !== "content";
  syncScanAvailability();
}

function updateModeChoice() {
  if (!signedIn) {
    applyMode(selectedMode());
    authStatus.textContent = modeDetails[activeMode].auth;
    return;
  }
  const requested = selectedMode();
  if (requested === activeMode) return;
  // Content access is a superset of metadata access, so only an upgrade to
  // content from a metadata-only token needs Google's consent again.
  if (requested === "content" && authorization?.mode !== "content") {
    requestContentAccess();
    return;
  }
  switchSignedInMode(requested);
}

function checkMode(mode) {
  const input = modeInputs.find((candidate) => candidate.value === mode);
  if (input) input.checked = true;
}

function switchSignedInMode(mode) {
  pendingUpgrade = false;
  checkMode(mode);
  applyMode(mode);
  currentFiles = [];
  results.hidden = true;
  scanStatus.className = "scan-status";
  scanStatus.textContent = "";
  syncScanAvailability();
  authStatus.classList.remove("error-text");
  authStatus.textContent = mode === "sharing"
    ? "Switched to Sharing only. File contents won't be read in this mode."
    : modeDetails.content.connected;
}

function requestContentAccess() {
  const popup = window.open(
    "authorize.html?mode=content&popup=1",
    "privacy-scanner-auth",
    "popup,width=520,height=680",
  );
  if (!popup) {
    checkMode(activeMode);
    authStatus.classList.add("error-text");
    authStatus.textContent = "Your browser blocked the Google sign-in window. Allow popups for this site, then try again.";
    return;
  }
  pendingUpgrade = true;
  authStatus.classList.remove("error-text");
  authStatus.textContent = "Approve file-content access in the Google window that just opened…";
}

function handleAuthMessage({ data }) {
  if (!pendingUpgrade || !signedIn) return;
  if (data?.type === "authorized") {
    const upgraded = validAuthorization(data.authorization);
    if (upgraded?.mode !== "content") return;
    authorization = upgraded;
    switchSignedInMode("content");
  } else if (data?.type === "cancelled") {
    pendingUpgrade = false;
    checkMode(activeMode);
    authStatus.classList.remove("error-text");
    authStatus.textContent = "Content access wasn't granted. You're still in Sharing only mode.";
  }
}

function setSignedIn(nextSignedIn, mode = null) {
  signedIn = nextSignedIn;
  if (signedIn && modeDetails[mode]) {
    checkMode(mode);
    activeMode = mode;
  } else if (!signedIn) {
    activeMode = selectedMode();
  }
  applyMode(activeMode);
  authStatus.classList.remove("error-text");
  authStatus.textContent = signedIn
    ? modeDetails[activeMode].connected
    : modeDetails[activeMode].auth;
  pendingUpgrade = false;
  loginLink.hidden = signedIn;
  logoutLink.hidden = !signedIn;
  scanner.hidden = !signedIn;
  if (!signedIn) {
    authorization = null;
    results.hidden = true;
  }
}

function permissionText(permission) {
  const role = permission.role || "reader";
  switch (permission.type) {
    case "anyone":
      return `Anyone · ${role}`;
    case "domain":
      return `${permission.domain || "Domain"} · ${role}`;
    case "group":
      return `${permission.emailAddress || "Group"} · ${role}`;
    case "user":
      return `${permission.emailAddress || (role === "owner" ? "Owner" : "Google user")} · ${role}`;
    default:
      return `${permission.type || "Unknown permission"} · ${role}`;
  }
}

function renderPermissionList(permissions) {
  const list = document.createElement("ul");
  list.className = "permission-list";
  if (!permissions.length) {
    const item = document.createElement("li");
    item.textContent = "No permission details returned";
    list.append(item);
    return list;
  }
  permissions.forEach((permission) => {
    const item = document.createElement("li");
    item.textContent = permissionText(permission);
    list.append(item);
  });
  return list;
}

function finalRisk(file) {
  if (file.modelResult?.dangerous) {
    if (file.risk === "RED") return "DANGEROUS";
    if (file.risk === "YELLOW") return "DANGEROUS_SHARED";
  }
  return file.risk;
}

function modelResultElement(file) {
  const line = document.createElement("p");
  line.className = "model-result";
  const result = file.modelResult;
  if (file.preview_status !== "ok") {
    line.textContent = file.preview_message
      ? `Not checked: ${file.preview_message.replace(/^./u, (letter) => letter.toLowerCase())}.`
      : "Not checked: readable content wasn't available.";
  } else if (!result) {
    line.textContent = "Waiting for the local check…";
  } else if (result.error) {
    line.textContent = `The local check failed: ${result.error}`;
  } else if (result.classificationSource === "prefilter") {
    // What matched is already listed in the "Flagged as" line above.
    line.textContent = "Found by the pattern check, so the AI model wasn't needed.";
  } else {
    const label = document.createElement("strong");
    label.textContent = result.dangerous ? "Sensitive" : "Not sensitive";
    const probability = Number.isFinite(result.dangerousProbability)
      ? ` · ${Math.round(result.dangerousProbability * 100)}% likely sensitive`
      : "";
    line.append("Local AI model: ", label, probability);
  }
  const flagged = flaggedSectionElement(result);
  if (!flagged) return line;
  const wrapper = document.createElement("div");
  wrapper.append(line, flagged);
  return wrapper;
}

function flaggedSectionElement(result) {
  if (!result?.dangerous || typeof result.flaggedText !== "string" || !result.flaggedText) return null;
  const details = document.createElement("details");
  details.className = "flagged-section";
  const summary = document.createElement("summary");
  summary.textContent = `Show flagged section (words ${result.flaggedWordStart}–${result.flaggedWordEnd})`;
  const quote = document.createElement("blockquote");
  quote.textContent = result.flaggedText;
  const note = document.createElement("p");
  note.className = "flagged-note";
  note.textContent = result.classificationSource === "prefilter"
    ? "Matched a sensitive-data pattern. Later sections were skipped."
    : "The first section the local model flagged. Later sections were skipped.";
  details.append(summary, quote, note);
  return details;
}

function renderFile(file, includeContent) {
  const permissions = Array.isArray(file.permissions) ? file.permissions : [];
  const classification = finalRisk(file);
  const article = document.createElement("article");
  article.className = `file-card risk-${classification.toLowerCase()}`;
  article.dataset.fileId = file.id;

  const heading = document.createElement("div");
  heading.className = "file-heading";
  const title = document.createElement("h3");
  if (file.link) {
    const link = document.createElement("a");
    link.href = file.link;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = file.name;
    title.append(link);
  } else {
    title.textContent = file.name;
  }
  const badge = document.createElement("span");
  badge.className = "risk-badge";
  badge.textContent = riskDetails[classification]?.label || classification;
  heading.append(title, badge);

  const description = document.createElement("p");
  description.className = "risk-description";
  const flagCategories = classification.startsWith("DANGEROUS") ? file.modelResult?.flagCategories : null;
  description.textContent = Array.isArray(flagCategories) && flagCategories.length
    ? `Flagged as: ${flagCategories.join(" · ")}`
    : riskDetails[classification]?.description || "Classification unavailable";

  const owner = document.createElement("p");
  owner.className = "owner-line";
  owner.textContent = `Owner: ${file.owner || "Not returned (common in shared drives)"}`;

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = `${permissions.length} permission${permissions.length === 1 ? "" : "s"}`;
  details.append(summary, renderPermissionList(permissions));

  article.append(heading, description);
  if (includeContent && (file.risk === "RED" || file.risk === "YELLOW")) {
    article.append(modelResultElement(file));
  }
  if (file.folder_path) {
    const location = document.createElement("p");
    location.className = "owner-line folder-line";
    location.textContent = `Folder: ${file.folder_path}`;
    article.append(location);
  }
  article.append(owner, details);
  return article;
}

function renderClassificationProgress(counter, completed, total) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeCompleted = Math.min(safeTotal, Math.max(0, Number(completed) || 0));
  const label = document.createElement("span");
  const progress = document.createElement("progress");

  label.className = "classification-progress-value";
  label.textContent = `${safeCompleted} / ${safeTotal} files`;
  progress.className = "classification-progress-bar";
  progress.max = safeTotal || 1;
  progress.value = safeCompleted;
  progress.textContent = `${safeCompleted} of ${safeTotal} files classified`;

  counter.classList.add("classification-counter");
  counter.replaceChildren(label, progress);
  counter.setAttribute("aria-label", `${safeCompleted} of ${safeTotal} files classified`);
  counter.setAttribute("aria-busy", "true");
}

function renderCount(counter, value) {
  counter.classList.remove("classification-counter");
  counter.textContent = value;
  counter.removeAttribute("aria-label");
  counter.removeAttribute("aria-busy");
}

const EXPOSURE_ORDER = { DANGEROUS: 0, DANGEROUS_SHARED: 1, RED: 2, YELLOW: 3, GREEN: 4 };
const SENSITIVE_KINDS = new Set(["DANGEROUS", "DANGEROUS_SHARED"]);
const filterLabels = {
  ALL: "All",
  SENSITIVE: "Sensitive",
  DANGEROUS: "Sensitive & public",
  DANGEROUS_SHARED: "Sensitive & shared",
  RED: "Public",
  YELLOW: "Shared",
  GREEN: "Private",
};

function matchesFilter(file, filter) {
  const risk = finalRisk(file);
  if (filter === "ALL") return true;
  if (filter === "SENSITIVE") return SENSITIVE_KINDS.has(risk);
  return risk === filter;
}

/**
 * Sort key for sensitive files: the AI model's confidence (0–1). Pattern-check matches have no
 * confidence score, so they get -1 and sort after every model-flagged file.
 */
function sensitiveConfidence(file) {
  if (!SENSITIVE_KINDS.has(finalRisk(file))) return 0;
  const result = file.modelResult;
  if (result?.classificationSource === "prefilter") return -1;
  return Number.isFinite(result?.dangerousProbability) ? result.dangerousProbability : 0;
}

function sortFiles(files) {
  const byName = (left, right) => String(left.name || "").localeCompare(String(right.name || ""), undefined, { numeric: true, sensitivity: "base" });
  const byExposure = (left, right) => EXPOSURE_ORDER[finalRisk(left)] - EXPOSURE_ORDER[finalRisk(right)];
  const byConfidence = (left, right) => sensitiveConfidence(right) - sensitiveConfidence(left);
  const isSensitive = (file) => SENSITIVE_KINDS.has(finalRisk(file));
  const sorted = [...files];
  if (resultSort === "name") return sorted.sort(byName);
  if (resultSort === "exposure-asc") {
    return sorted.sort((left, right) => byExposure(right, left) || byConfidence(right, left) || byName(left, right));
  }
  if (resultSort === "confidence") {
    // All sensitive files first by confidence (public and shared mixed), then everything else by exposure.
    return sorted.sort((left, right) => (isSensitive(right) - isSensitive(left))
      || byConfidence(left, right) || byExposure(left, right) || byName(left, right));
  }
  return sorted.sort((left, right) => byExposure(left, right) || byConfidence(left, right) || byName(left, right));
}

function syncFilterControls() {
  document.querySelectorAll("#results [data-filter]").forEach((control) => {
    const active = control.dataset.filter === resultFilter;
    control.setAttribute("aria-pressed", String(active));
    control.classList.toggle("is-active", active);
  });
}

function setResultFilter(filter) {
  resultFilter = resultFilter === filter && filter !== "ALL" ? "ALL" : filter;
  renderResults({ scroll: false });
}

function renderResults({ scroll = true, classificationTotal = 0 } = {}) {
  const includeContent = activeMode === "content";
  const counts = { DANGEROUS: 0, DANGEROUS_SHARED: 0, RED: 0, YELLOW: 0, GREEN: 0 };
  currentFiles.forEach((file) => { counts[finalRisk(file)] += 1; });
  counts.SENSITIVE = counts.DANGEROUS + counts.DANGEROUS_SHARED;
  const stillChecking = classificationTotal > 0 || (scanning && classificationProgress);
  // While the model runs, the card shows its own progress bar; show the breakdown once it's done.
  $("#sensitive-breakdown").textContent = stillChecking
    ? ""
    : `${counts.DANGEROUS} public · ${counts.DANGEROUS_SHARED} shared`;
  if (classificationTotal > 0) {
    classificationProgress = { completed: 0, total: classificationTotal };
    renderClassificationProgress($("#dangerous-count"), 0, classificationTotal);
  } else if (scanning && classificationProgress) {
    renderClassificationProgress($("#dangerous-count"), classificationProgress.completed, classificationProgress.total);
  } else {
    renderCount($("#dangerous-count"), counts.SENSITIVE);
  }
  renderCount($("#red-count"), counts.RED);
  renderCount($("#yellow-count"), counts.YELLOW);
  renderCount($("#green-count"), counts.GREEN);
  $("#file-total").textContent = `${currentFiles.length} file${currentFiles.length === 1 ? "" : "s"}`;
  document.querySelectorAll("[data-count]").forEach((element) => {
    const key = element.dataset.count;
    element.textContent = key === "ALL" ? currentFiles.length : counts[key];
  });
  // Sharing-only scans never read content, so nothing can be classified as sensitive.
  document.querySelectorAll('#results [data-filter="SENSITIVE"], #results [data-filter^="DANGEROUS"]')
    .forEach((control) => { control.hidden = !includeContent; });
  $("#sensitive-note").hidden = !includeContent;
  const confidenceOption = $('#result-sort option[value="confidence"]');
  confidenceOption.hidden = !includeContent;
  if (!includeContent && resultSort === "confidence") {
    resultSort = "exposure";
    $("#result-sort").value = "exposure";
  }
  $("#word-limit-note").textContent = wordLimitText(scanWordLimit);
  if (!includeContent && (resultFilter === "SENSITIVE" || SENSITIVE_KINDS.has(resultFilter))) resultFilter = "ALL";
  syncFilterControls();
  const visibleFiles = sortFiles(
    currentFiles.filter((file) => matchesFilter(file, resultFilter)),
  );
  fileResults.replaceChildren(...visibleFiles.map((file) => renderFile(file, includeContent)));

  if (!visibleFiles.length) {
    const empty = document.createElement("p");
    empty.className = "empty-result";
    empty.textContent = currentFiles.length
      ? `No ${filterLabels[resultFilter].toLowerCase()} files in this scan.`
      : "No files were found.";
    fileResults.append(empty);
  }
  results.hidden = false;
  if (scroll) results.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setupModelChoices() {
  // Spartan v6 needs a hosted model URL; without one, offer only the built-in model.
  if (!SPARTAN_AVAILABLE) {
    modelSelect.querySelector('option[value="spartan-v6"]').remove();
    document.querySelector('.model-about [data-model="spartan-v6"]')?.remove();
  }
  modelSelect.value = "gliner2.5-decide-mobile-q4f16";
}

function renderSelectedModel() {
  const selected = models[modelSelect.value];
  $("#model-notice").textContent = `${selected.name} · ${selected.size}. ${selected.notice}`;
  // Constant label so the button doesn't resize; the picker options already show each model's size.
  loadModelButton.textContent = "Download model";
  $("#model-progress-detail").textContent = `${selected.size} on the first load; later loads may use browser cache.`;
}

function renderModelProgress(event) {
  if (!event.file) return;
  if (event.status === "progress" && Number.isFinite(event.loaded) && Number.isFinite(event.total)) {
    modelDownloads.set(event.file, { loaded: event.loaded, total: event.total });
  } else if (event.status === "done" && modelDownloads.has(event.file)) {
    const item = modelDownloads.get(event.file);
    modelDownloads.set(event.file, { loaded: item.total, total: item.total });
  }
  const totals = [...modelDownloads.values()].reduce(
    (sum, item) => ({ loaded: sum.loaded + item.loaded, total: sum.total + item.total }),
    { loaded: 0, total: 0 },
  );
  if (totals.total > 0) {
    const percent = Math.min(100, (totals.loaded / totals.total) * 100);
    $("#model-meter-fill").style.width = `${percent}%`;
    $("#model-progress-value").textContent = `${percent.toFixed(0)}%`;
    $("#model-progress-detail").textContent = event.text || "model files and WebGPU runtime";
  } else if (event.status === "initiate") {
    $("#model-progress-value").textContent = "Cache check";
    $("#model-progress-detail").textContent = event.file;
  }
}

function clearContentSamples() {
  currentFiles.forEach((file) => { delete file.content_text; });
}

function finishClassification() {
  scanning = false;
  hideScanProgress();
  setChoicesDisabled(false);
  classificationPrompt.disabled = false;
  clearContentSamples();
  renderResults({ scroll: false });
  const dangerousCount = currentFiles.filter((file) => SENSITIVE_KINDS.has(finalRisk(file))).length;
  scanStatus.className = "scan-status ok";
  scanStatus.textContent = `Scan complete: ${currentFiles.length} file${currentFiles.length === 1 ? "" : "s"} inspected; ${dangerousCount} flagged as sensitive.`;
  syncScanAvailability();
}

function handleWorkerMessage({ data }) {
  switch (data.type) {
    case "progress":
      renderModelProgress(data.event);
      break;
    case "loading":
      setModelStatus(data.message);
      break;
    case "loaded":
      $("#model-meter-fill").style.width = "100%";
      $("#model-progress-value").textContent = modelDownloads.size ? "100%" : "Cached";
      break;
    case "ready":
      if (loadingModelKey) {
        loadedModels.add(loadingModelKey);
        activeModelKey = loadingModelKey;
        loadingModelKey = null;
      }
      modelSelect.disabled = scanning;
      updateModelControls();
        syncScanAvailability();
      break;
    case "classification-start":
      scanStatus.textContent = `Checking ${data.total} shared or public file${data.total === 1 ? "" : "s"} on your device…`;
      classificationProgress = { completed: 0, total: data.total };
      renderClassificationProgress($("#dangerous-count"), 0, data.total);
      setScanProgress("classifying", 0, data.total);
      modelRun = { completed: 0, total: data.total, block: 0, blocks: 0 };
      showModelRun(modelRun);
      break;
    case "classification-file":
      modelRun = { fileId: data.fileId, completed: data.index, total: data.total, block: 0, blocks: data.blocks };
      showModelRun(modelRun);
      markCardInProgress(data.fileId, 1, data.blocks);
      break;
    case "classification-block":
      if (modelRun) {
        modelRun = { ...modelRun, block: data.block, blocks: data.blocks };
        showModelRun(modelRun);
      }
      markCardInProgress(data.fileId, data.block, data.blocks);
      break;
    case "classification-result": {
      const file = fileById(data.fileId);
      if (file) {
        file.modelResult = data;
        // Show this file's result right away instead of waiting for the whole batch.
        const card = cardFor(file.id);
        if (card) card.replaceWith(renderFile(file, true));
      }
      if (modelRun) {
        modelRun = { ...modelRun, block: modelRun.blocks, completed: modelRun.completed + 1, fileId: null };
        showModelRun(modelRun);
        setBar("model-run-blocks", "model-run-blocks-label", "Sections in this file: done", 1, 1);
      }
      break;
    }
    case "classification-progress":
      scanStatus.textContent = `Local check: ${data.completed} of ${data.total} shared or public files done…`;
      classificationProgress = { completed: data.completed, total: data.total };
      renderClassificationProgress($("#dangerous-count"), data.completed, data.total);
      setScanProgress("classifying", data.completed, data.total);
      break;
    case "classification-complete":
      finishClassification();
      break;
    case "error":
      if (scanning) {
        scanning = false;
        hideScanProgress();
        setChoicesDisabled(false);
        classificationPrompt.disabled = false;
        clearContentSamples();
        scanStatus.className = "scan-status error";
        scanStatus.textContent = `Local classification failed: ${data.message}`;
        syncScanAvailability();
      } else {
        loadingModelKey = null;
        classifierReady = modelSelect.value === activeModelKey;
        setModelStatus(data.message, "error");
        loadModelButton.disabled = !modelSupported;
        loadModelButton.textContent = "Retry model load";
        modelSelect.disabled = false;
          }
      break;
  }
}

classifierWorker.addEventListener("message", handleWorkerMessage);
classifierWorker.addEventListener("error", (event) => {
  classifierReady = false;
  loadingModelKey = null;
  loadedModels.clear();
  activeModelKey = null;
  setModelStatus(`Model worker failed: ${event.message}`, "error");
  loadModelButton.disabled = !modelSupported;
  modelSelect.disabled = false;
  if (scanning) {
    scanning = false;
    hideScanProgress();
    setChoicesDisabled(false);
    classificationPrompt.disabled = false;
    scanStatus.className = "scan-status error";
    scanStatus.textContent = "The local model worker stopped before classification completed.";
    syncScanAvailability();
  }
});

/** Show fix-it steps for a WebGPU failure; problem is "no-webgpu", "no-adapter", or null to hide. */
function showGpuHelp(problem) {
  const help = $("#gpu-help");
  help.hidden = !problem;
  help.querySelectorAll("[data-gpu-case]").forEach((item) => {
    item.hidden = item.dataset.gpuCase !== problem;
  });
}

async function checkWebGPU() {
  if (!navigator.gpu) {
    setModelStatus("WebGPU is unavailable. Use a current WebGPU-capable browser over HTTPS or localhost.", "error");
    showGpuHelp("no-webgpu");
    loadModelButton.disabled = true;
    return;
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    setModelStatus("WebGPU exists, but this browser could not provide a GPU adapter.", "error");
    showGpuHelp("no-adapter");
    loadModelButton.disabled = true;
    return;
  }
  modelSupported = true;
  showGpuHelp(null);
  loadModelButton.disabled = false;
  setModelStatus("WebGPU is ready. Choose a model and download it when you are ready.", "ok");
}

function checkSession() {
  if (!googleClientConfigured()) {
    setSignedIn(false);
    authStatus.textContent = "This deployment is missing GOOGLE_CLIENT_ID. Configure it and rebuild the static site.";
    authStatus.classList.add("error-text");
    loginLink.hidden = true;
    return;
  }

  authorization = takeAuthorization();
  setSignedIn(Boolean(authorization), authorization?.mode);
  if (!authorization) authStatus.textContent = modeDetails[activeMode].auth;
}

loadModelButton.addEventListener("click", () => requestModel(modelSelect.value));

modelSelect.addEventListener("change", () => {
  renderSelectedModel();
  // Already downloaded this session: switch to it right away. Otherwise wait for "Download model".
  if (loadedModels.has(modelSelect.value) && modelSelect.value !== activeModelKey) {
    requestModel(modelSelect.value);
  } else {
    updateModelControls();
  }
});
modeInputs.forEach((input) => input.addEventListener("change", updateModeChoice));
if ("BroadcastChannel" in globalThis) {
  new BroadcastChannel(AUTH_CHANNEL).addEventListener("message", handleAuthMessage);
}
targetInputs.forEach((input) => input.addEventListener("change", updateTargetChoice));
document.querySelectorAll("#results [data-filter]").forEach((control) => {
  control.addEventListener("click", () => setResultFilter(control.dataset.filter));
  if (control.getAttribute("role") === "button") {
    control.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setResultFilter(control.dataset.filter);
      }
    });
  }
});
$("#result-sort").addEventListener("change", (event) => {
  resultSort = event.target.value;
  renderResults({ scroll: false });
});

logoutLink.addEventListener("click", () => {
  authorization = null;
  currentFiles = [];
  setSignedIn(false);
  authStatus.textContent = "Disconnected locally. The short-lived Google access token was removed from this page.";
});

scanForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const target = scanTarget();
  const folderUrl = folderUrlInput.value.trim();
  const prompt = classificationPrompt.value.trim();
  if ((target === "folder" && !folderUrl) || scanning) return;
  if (activeMode === "content" && !classifierReady) {
    scanStatus.className = "scan-status error";
    scanStatus.textContent = "Load the browser model before starting a content scan.";
    return;
  }
  if (activeMode === "content" && !prompt) {
    scanStatus.className = "scan-status error";
    scanStatus.textContent = "Enter a classification prompt before scanning.";
    classificationPrompt.focus();
    return;
  }

  scanning = true;
  hideScanProgress();
  setChoicesDisabled(true);
  scanButton.textContent = "Scanning…";
  classificationPrompt.disabled = activeMode === "content";
  syncScanAvailability();
  scanStatus.className = "scan-status";
  scanStatus.textContent = modeDetails[activeMode].scanning;
  results.hidden = true;

  try {
    if (!authorization || authorization.expiresAt <= Date.now()) {
      throw new DriveAuthorizationError();
    }
    scanWordLimit = selectedWordLimit();
    const scanOptions = {
      includeContent: activeMode === "content",
      wordLimit: scanWordLimit,
      onProgress: ({ stage, completed, total }) => {
        setScanProgress(stage, completed, total);
        if (stage === "listing") {
          scanStatus.textContent = target === "drive"
            ? `Listing files you own in My Drive${completed ? `: ${completed} found` : ""}…`
            : `Listing files in the selected folder and its subfolders${completed ? `: ${completed} found` : ""}…`;
        } else if (stage === "permissions") {
          scanStatus.textContent = `Reading sharing permissions: ${completed} of ${total} files…`;
        } else if (stage === "content") {
          scanStatus.textContent = `Reading samples from shared and public files: ${completed} of ${total}…`;
        }
      },
    };
    const files = target === "drive"
      ? await scanDrive(authorization.accessToken, scanOptions)
      : await scanFolder(folderUrl, authorization.accessToken, scanOptions);
    currentFiles = Array.isArray(files) ? files : [];
    let publicFiles = [];
    if (activeMode === "content") {
      publicFiles = currentFiles
        .filter((file) => (file.risk === "RED" || file.risk === "YELLOW") && file.preview_status === "ok" && file.content_text)
        .map((file) => ({
          id: file.id,
          risk: file.risk,
          contentText: file.content_text,
        }));
    }
    renderResults({ classificationTotal: publicFiles.length });
    if (activeMode === "content") {
      if (publicFiles.length) {
        classifierWorker.postMessage({
          type: "classify-files",
          data: { prompt, files: publicFiles, wordLimit: scanWordLimit },
        });
        return;
      }
    }

    scanning = false;
    hideScanProgress();
    setChoicesDisabled(false);
    classificationPrompt.disabled = false;
    clearContentSamples();
    scanStatus.className = "scan-status ok";
    scanStatus.textContent = `Scan complete: ${currentFiles.length} file${currentFiles.length === 1 ? "" : "s"} inspected.`;
    syncScanAvailability();
  } catch (error) {
    scanning = false;
    hideScanProgress();
    setChoicesDisabled(false);
    classificationPrompt.disabled = false;
    clearContentSamples();
    if (error instanceof DriveAuthorizationError) {
      setSignedIn(false);
      authStatus.textContent = error.message;
      authStatus.classList.add("error-text");
    }
    scanStatus.className = "scan-status error";
    scanStatus.textContent = error.message;
    syncScanAvailability();
  }
});

setupModelChoices();
renderSelectedModel();
loadModelButton.disabled = true;
updateModeChoice();
updateTargetChoice();
checkSession();
checkWebGPU().catch((error) => {
  setModelStatus(`WebGPU check failed: ${error.message}`, "error");
  showGpuHelp("no-adapter");
  loadModelButton.disabled = true;
});
