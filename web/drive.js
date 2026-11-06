import { unzipSync } from "fflate";

export const CONTENT_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const METADATA_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const MAX_CONTENT_BYTES = 20 * 1024 * 1024;
const MAX_EXPANDED_DOCUMENT_BYTES = 64 * 1024 * 1024;
const MODEL_WORD_LIMIT = 500;
const PREVIEW_WORD_LIMIT = 10;
const REQUEST_CONCURRENCY = 5;

const FILE_LIST_FIELDS = [
  "nextPageToken",
  "files(id,name,mimeType,size,webViewLink,owners(displayName,emailAddress),capabilities(canDownload))",
].join(",");
const OWNED_FILE_LIST_FIELDS = [
  "nextPageToken",
  "files(id,name,mimeType,size,parents,webViewLink,owners(displayName,emailAddress),capabilities(canDownload),permissions(type,role,emailAddress,domain,allowFileDiscovery))",
].join(",");
const PERMISSION_FIELDS = [
  "nextPageToken",
  "permissions(type,role,emailAddress,domain,allowFileDiscovery)",
].join(",");

const GOOGLE_EXPORT_MIME_TYPES = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.drawing": "image/svg+xml",
  "application/vnd.google-apps.script": "application/vnd.google-apps.script+json",
};

const TEXT_MIME_TYPES = new Set([
  "application/csv",
  "application/javascript",
  "application/json",
  "application/ld+json",
  "application/rtf",
  "application/sql",
  "application/vnd.google-apps.script+json",
  "application/xml",
  "application/x-httpd-php",
  "application/x-javascript",
  "application/x-sh",
  "image/svg+xml",
]);

const OPEN_DOCUMENT_MIME_TYPES = new Set([
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.text",
]);

const OFFICE_MIME_TYPES = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

export class DriveApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "DriveApiError";
    this.status = status;
  }
}

export class DriveAuthorizationError extends DriveApiError {
  constructor(message = "Your Google authorization expired. Authorize again.") {
    super(message, 401);
    this.name = "DriveAuthorizationError";
  }
}

export function getFolderId(value) {
  const match = String(value).match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (!match) throw new Error("Enter a valid Google Drive folder URL.");
  return match[1];
}

export function classifyFileRisk(permissions) {
  let shared = false;
  for (const permission of permissions) {
    if (permission.type === "anyone") return "RED";
    if (["domain", "group"].includes(permission.type)) shared = true;
    if (permission.type === "user" && permission.role !== "owner") shared = true;
  }
  return shared ? "YELLOW" : "GREEN";
}

export function firstWords(text, limit = PREVIEW_WORD_LIMIT) {
  return (String(text).match(/\S+/gu) || []).slice(0, limit).join(" ");
}

function decodeText(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view[0] === 0xff && view[1] === 0xfe) return new TextDecoder("utf-16le").decode(view);
  if (view[0] === 0xfe && view[1] === 0xff) return new TextDecoder("utf-16be").decode(view);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(view);
  } catch {
    return new TextDecoder("windows-1252").decode(view);
  }
}

function parseXml(xml) {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.querySelector("parsererror")) throw new Error("The document contains invalid XML.");
  return document;
}

function textNodes(document, localName = "t") {
  return [...document.getElementsByTagNameNS("*", localName)]
    .map((node) => node.textContent || "")
    .filter(Boolean);
}

function allText(root) {
  const document = root.ownerDocument || root;
  const walker = document.createTreeWalker(root, 4);
  const parts = [];
  while (walker.nextNode()) {
    if (walker.currentNode.nodeValue) parts.push(walker.currentNode.nodeValue);
  }
  return parts.join(" ");
}

function naturalPathSort(left, right) {
  return left.localeCompare(right, undefined, { numeric: true });
}

function unzipDocument(bytes) {
  const archive = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  assertSafeZip(archive);
  try {
    return unzipSync(archive);
  } catch {
    throw new Error("The document is not a valid ZIP-based office file.");
  }
}

function assertSafeZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumOffset = Math.max(0, bytes.byteLength - 65_557);
  let endOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("The document is not a valid ZIP-based office file.");

  const entryCount = view.getUint16(endOffset + 10, true);
  const directorySize = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error("ZIP64 office files are not supported for browser previews.");
  }
  if (directoryOffset + directorySize > bytes.byteLength) {
    throw new Error("The office file has an invalid ZIP directory.");
  }

  let offset = directoryOffset;
  let expandedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("The office file has an invalid ZIP directory.");
    }
    const uncompressedSize = view.getUint32(offset + 24, true);
    if (uncompressedSize === 0xffffffff) {
      throw new Error("ZIP64 office files are not supported for browser previews.");
    }
    expandedBytes += uncompressedSize;
    if (expandedBytes > MAX_EXPANDED_DOCUMENT_BYTES) {
      throw new Error("The expanded office document exceeds the 64 MB safety limit.");
    }
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
}

function decodeEntry(entries, path) {
  const entry = entries[path];
  return entry ? decodeText(entry) : null;
}

function extractDocx(entries) {
  const paths = Object.keys(entries)
    .filter((path) => /^word\/(document|header\d+|footer\d+|comments)\.xml$/u.test(path))
    .sort(naturalPathSort);
  return paths.flatMap((path) => textNodes(parseXml(decodeEntry(entries, path)))).join(" ");
}

function extractPptx(entries) {
  const paths = Object.keys(entries)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/u.test(path))
    .sort(naturalPathSort);
  return paths.flatMap((path) => textNodes(parseXml(decodeEntry(entries, path)))).join(" ");
}

function extractXlsx(entries) {
  const sharedXml = decodeEntry(entries, "xl/sharedStrings.xml");
  const sharedStrings = [];
  if (sharedXml) {
    const sharedDocument = parseXml(sharedXml);
    sharedStrings.push(
      ...[...sharedDocument.getElementsByTagNameNS("*", "si")]
        .map((item) => textNodes(item, "t").join("")),
    );
  }

  const sheetPaths = Object.keys(entries)
    .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(path))
    .sort(naturalPathSort);
  const values = [];
  for (const path of sheetPaths) {
    const sheet = parseXml(decodeEntry(entries, path));
    for (const cell of sheet.getElementsByTagNameNS("*", "c")) {
      const type = cell.getAttribute("t");
      if (type === "inlineStr") {
        values.push(textNodes(cell, "t").join(""));
        continue;
      }
      const raw = cell.getElementsByTagNameNS("*", "v")[0]?.textContent;
      if (raw == null) continue;
      values.push(type === "s" ? (sharedStrings[Number(raw)] || "") : raw);
    }
  }
  return values.join(" ");
}

function extractOpenDocument(entries) {
  const xml = decodeEntry(entries, "content.xml");
  if (!xml) throw new Error("The OpenDocument file has no content.xml entry.");
  return allText(parseXml(xml).documentElement);
}

export async function extractText(bytes, mimeType, wordLimit = MODEL_WORD_LIMIT) {
  if (mimeType.startsWith("text/")) {
    const text = decodeText(bytes);
    if (mimeType !== "text/html") return text;
    const document = new DOMParser().parseFromString(text, "text/html");
    document.querySelectorAll("script, style, template, noscript").forEach((node) => node.remove());
    return document.body ? allText(document.body) : "";
  }
  if (TEXT_MIME_TYPES.has(mimeType)) {
    const text = decodeText(bytes);
    if (mimeType !== "image/svg+xml") return text;
    return allText(parseXml(text).documentElement);
  }
  if (mimeType === "application/pdf") {
    const { extractPdf } = await import("./pdf-extract.js");
    return extractPdf(bytes, wordLimit);
  }
  if (OFFICE_MIME_TYPES[mimeType]) {
    const entries = unzipDocument(bytes);
    if (OFFICE_MIME_TYPES[mimeType] === "docx") return extractDocx(entries);
    if (OFFICE_MIME_TYPES[mimeType] === "pptx") return extractPptx(entries);
    return extractXlsx(entries);
  }
  if (OPEN_DOCUMENT_MIME_TYPES.has(mimeType)) return extractOpenDocument(unzipDocument(bytes));
  throw new Error(`Text extraction is not supported for ${mimeType || "this file type"}.`);
}

async function driveFetch(path, accessToken, init = {}) {
  const { accept = "application/json", ...requestInit } = init;
  const response = await fetch(`${DRIVE_API}${path}`, {
    ...requestInit,
    headers: {
      Accept: accept,
      Authorization: `Bearer ${accessToken}`,
      ...requestInit.headers,
    },
    referrerPolicy: "no-referrer",
  });
  if (response.ok) return response;

  let message = `Google Drive request failed (${response.status}).`;
  try {
    const payload = await response.json();
    message = payload?.error?.message || message;
  } catch {
    // Google occasionally returns an empty/non-JSON error response.
  }
  if (response.status === 401) throw new DriveAuthorizationError();
  throw new DriveApiError(message, response.status);
}

async function driveJson(path, accessToken) {
  return (await driveFetch(path, accessToken)).json();
}

async function listFolderFiles(folderId, accessToken) {
  const files = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: FILE_LIST_FIELDS,
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const payload = await driveJson(`/files?${params}`, accessToken);
    files.push(...(payload.files || []));
    pageToken = payload.nextPageToken || "";
  } while (pageToken);
  return files;
}

async function listPermissions(fileId, accessToken) {
  const permissions = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({ fields: PERMISSION_FIELDS, supportsAllDrives: "true" });
    if (pageToken) params.set("pageToken", pageToken);
    const payload = await driveJson(
      `/files/${encodeURIComponent(fileId)}/permissions?${params}`,
      accessToken,
    );
    permissions.push(...(payload.permissions || []));
    pageToken = payload.nextPageToken || "";
  } while (pageToken);
  return permissions;
}

async function mapWithConcurrency(items, limit, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await callback(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function responseBytes(response) {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_CONTENT_BYTES) throw new Error("File is larger than the 20 MB preview limit.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_CONTENT_BYTES) throw new Error("File is larger than the 20 MB preview limit.");
  return bytes;
}

// wordLimit is a word count, or Infinity to read the whole document.
async function contentPreview(file, accessToken, wordLimit = MODEL_WORD_LIMIT) {
  const mimeType = file.mimeType || "";
  if (mimeType === "application/vnd.google-apps.folder") {
    return { content_preview: null, preview_status: "unsupported", preview_message: "Folder — no file content" };
  }
  if (file.capabilities?.canDownload === false) {
    return { content_preview: null, preview_status: "unavailable", preview_message: "The owner disabled downloading" };
  }
  if (Number(file.size || 0) > MAX_CONTENT_BYTES) {
    return { content_preview: null, preview_status: "too_large", preview_message: "File is larger than the 20 MB preview limit" };
  }

  const exportMimeType = GOOGLE_EXPORT_MIME_TYPES[mimeType];
  if (mimeType.startsWith("application/vnd.google-apps.") && !exportMimeType) {
    return { content_preview: null, preview_status: "unsupported", preview_message: "This Google file type cannot be exported as readable text" };
  }

  try {
    const params = new URLSearchParams();
    let extractionMimeType = mimeType;
    let path;
    if (exportMimeType) {
      params.set("mimeType", exportMimeType);
      extractionMimeType = exportMimeType;
      path = `/files/${encodeURIComponent(file.id)}/export?${params}`;
    } else {
      params.set("alt", "media");
      params.set("supportsAllDrives", "true");
      path = `/files/${encodeURIComponent(file.id)}?${params}`;
    }
    const response = await driveFetch(path, accessToken, { accept: "*/*" });
    const modelText = firstWords(await extractText(await responseBytes(response), extractionMimeType, wordLimit), wordLimit);
    if (!modelText) {
      return { content_preview: null, preview_status: "empty", preview_message: "No readable words found" };
    }
    return {
      content_preview: firstWords(modelText),
      content_text: modelText,
      content_word_count: (modelText.match(/\S+/gu) || []).length,
      preview_status: "ok",
      preview_message: Number.isFinite(wordLimit)
        ? `Up to ${wordLimit} words ready for local classification`
        : "Whole document ready for local classification",
    };
  } catch (error) {
    if (error instanceof DriveAuthorizationError) throw error;
    const unavailable = error instanceof DriveApiError && [401, 403].includes(error.status);
    return {
      content_preview: null,
      preview_status: unavailable ? "unavailable" : "unsupported",
      preview_message: unavailable ? "Google did not allow this file to be downloaded" : error.message,
    };
  }
}

async function listOwnedDriveFiles(accessToken, onProgress) {
  const files = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: "'me' in owners and trashed = false",
      fields: OWNED_FILE_LIST_FIELDS,
      pageSize: "1000",
      spaces: "drive",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const payload = await driveJson(`/files?${params}`, accessToken);
    files.push(...(payload.files || []));
    onProgress({ stage: "listing", completed: files.length, total: 0 });
    pageToken = payload.nextPageToken || "";
  } while (pageToken);
  return files;
}

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

/**
 * List a folder's files and everything in its subfolders at every depth. Each file gets
 * `_folderPath` ("" at the top level, "Reports / 2024" deeper down). Folders reached twice (Drive items can
 * have several parents) are listed once, and shortcuts are not followed, so the walk can't loop or leave
 * the chosen folder.
 */
async function listFolderTree(rootId, accessToken, { onProgress }) {
  const files = [];
  const visited = new Set([rootId]);
  let level = [{ id: rootId, path: "" }];
  while (level.length) {
    const next = [];
    await mapWithConcurrency(level, REQUEST_CONCURRENCY, async (folder) => {
      for (const file of await listFolderFiles(folder.id, accessToken)) {
        files.push({ ...file, _folderPath: folder.path });
        if (file.mimeType === FOLDER_MIME_TYPE && !visited.has(file.id)) {
          visited.add(file.id);
          next.push({ id: file.id, path: folder.path ? `${folder.path} / ${file.name}` : file.name });
        }
      }
      onProgress({ stage: "listing", completed: files.length, total: 0 });
    });
    level = next;
  }
  return files;
}

export async function scanFolder(folderUrl, accessToken, options = {}) {
  const folderId = getFolderId(folderUrl);
  const { onProgress = () => {} } = options;
  onProgress({ stage: "listing", completed: 0, total: 0 });
  const files = await listFolderTree(folderId, accessToken, { onProgress });
  return inspectFiles(files, accessToken, options);
}

/**
 * Give each file its folder path ("Reports / 2024") from the parents of the listed files themselves.
 * Paths stop at folders that weren't listed (My Drive's root, or folders someone else owns).
 */
function addFolderPaths(files) {
  const folders = new Map(files.filter((f) => f.mimeType === FOLDER_MIME_TYPE).map((f) => [f.id, f]));
  const cache = new Map();
  const pathOf = (folderId, seen = new Set()) => {
    if (!folders.has(folderId) || seen.has(folderId)) return "";
    if (cache.has(folderId)) return cache.get(folderId);
    seen.add(folderId);
    const folder = folders.get(folderId);
    const parentPath = pathOf(folder.parents?.[0], seen);
    const path = parentPath ? `${parentPath} / ${folder.name}` : folder.name;
    cache.set(folderId, path);
    return path;
  };
  return files.map((file) => ({ ...file, _folderPath: pathOf(file.parents?.[0]) }));
}

/** Scan every non-trashed file the signed-in user owns in My Drive, in every folder. */
export async function scanDrive(accessToken, options = {}) {
  const { onProgress = () => {} } = options;
  onProgress({ stage: "listing", completed: 0, total: 0 });
  const files = addFolderPaths(await listOwnedDriveFiles(accessToken, onProgress));
  return inspectFiles(files, accessToken, options);
}

async function inspectFiles(files, accessToken, { includeContent = false, wordLimit = MODEL_WORD_LIMIT, onProgress = () => {} } = {}) {
  let permissionsComplete = 0;
  const results = await mapWithConcurrency(files, REQUEST_CONCURRENCY, async (file) => {
    // Owners receive permissions inline from files.list; fall back to a request otherwise.
    const permissions = Array.isArray(file.permissions)
      ? file.permissions
      : await listPermissions(file.id, accessToken);
    permissionsComplete += 1;
    onProgress({ stage: "permissions", completed: permissionsComplete, total: files.length });
    const owners = file.owners || [];
    return {
      name: file.name,
      id: file.id,
      mime_type: file.mimeType,
      risk: classifyFileRisk(permissions),
      permissions,
      owner: owners[0]?.emailAddress || owners[0]?.displayName || null,
      link: file.webViewLink || null,
      folder_path: file._folderPath || "",
      _metadata: file,
    };
  });

  // Content is read only from files someone else can open; private (GREEN) files are never read.
  const sharedFiles = includeContent ? results.filter((file) => file.risk === "RED" || file.risk === "YELLOW") : [];
  let contentComplete = 0;
  await mapWithConcurrency(sharedFiles, 2, async (file) => {
    Object.assign(file, await contentPreview(file._metadata, accessToken, wordLimit));
    contentComplete += 1;
    onProgress({ stage: "content", completed: contentComplete, total: sharedFiles.length });
  });
  results.forEach((file) => { delete file._metadata; });
  return results;
}
