import { strToU8, zipSync } from "fflate";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { JSDOM } from "jsdom";

import {
  classifyFileRisk,
  extractText,
  firstWords,
  getFolderId,
  scanDrive,
  scanFolder,
} from "../web/drive.js";

const SAMPLE_WORDS = "one two three four five six seven eight nine ten eleven twelve";
const browser = new JSDOM("", { url: "https://filecrawler.test/" });
globalThis.DOMParser = browser.window.DOMParser;
let originalFetch = globalThis.fetch;

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => payload,
  };
}

function byteResponse(value, status = 200) {
  const bytes = new TextEncoder().encode(value);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === "content-length" ? String(bytes.byteLength) : null },
    json: async () => ({}),
    arrayBuffer: async () => bytes.buffer,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Drive helpers", () => {
  it("parses Drive folder URLs", () => {
    assert.equal(
      getFolderId("https://drive.google.com/drive/folders/abc_123-XYZ?usp=sharing"),
      "abc_123-XYZ",
    );
    assert.throws(
      () => getFolderId("https://drive.google.com/file/d/not-a-folder"),
      /valid Google Drive folder URL/u,
    );
  });

  it("classifies sharing metadata", () => {
    const cases = [
      [[{ type: "anyone", role: "reader" }], "RED"],
      [[{ type: "domain", role: "reader" }], "YELLOW"],
      [[{ type: "group", role: "reader" }], "YELLOW"],
      [[{ type: "user", role: "writer" }], "YELLOW"],
      [[{ type: "user", role: "owner" }], "GREEN"],
    ];
    for (const [permissions, expected] of cases) {
      assert.equal(classifyFileRisk(permissions), expected);
    }
  });

  it("bounds extracted words", () => {
    assert.equal(firstWords(SAMPLE_WORDS), "one two three four five six seven eight nine ten");
    assert.equal(firstWords(SAMPLE_WORDS, 3), "one two three");
  });

  it("extracts visible HTML and ZIP-based Office text locally", async () => {
    const html = new TextEncoder().encode(
      "<style>hidden css</style><h1>Visible heading</h1><script>hidden js</script><p>and body words</p>",
    );
    assert.equal(firstWords(await extractText(html, "text/html")), "Visible heading and body words");

    const docx = zipSync({
      "word/document.xml": strToU8(
        `<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>${SAMPLE_WORDS}</w:t></w:r></w:p></w:body></w:document>`,
      ),
    });
    assert.equal(
      firstWords(await extractText(
        docx,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      )),
      "one two three four five six seven eight nine ten",
    );

    const oversizedArchive = docx.slice();
    const archiveView = new DataView(
      oversizedArchive.buffer,
      oversizedArchive.byteOffset,
      oversizedArchive.byteLength,
    );
    for (let offset = 0; offset <= oversizedArchive.byteLength - 46; offset += 1) {
      if (archiveView.getUint32(offset, true) === 0x02014b50) {
        archiveView.setUint32(offset + 24, 65 * 1024 * 1024, true);
        break;
      }
    }
    await assert.rejects(
      extractText(
        oversizedArchive,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
      /64 MB safety limit/u,
    );
  });
});

describe("browser-only folder scan", () => {
  function installDriveMock() {
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      const parsed = new URL(url);
      if (parsed.pathname === "/drive/v3/files") {
        return jsonResponse({
          files: [
            {
              id: "public-file",
              name: "public.txt",
              mimeType: "text/plain",
              size: "64",
              webViewLink: "https://drive.google.com/public",
              owners: [{ emailAddress: "owner@example.com" }],
              capabilities: { canDownload: true },
            },
            {
              id: "private-file",
              name: "private.txt",
              mimeType: "text/plain",
              size: "64",
              owners: [{ emailAddress: "owner@example.com" }],
              capabilities: { canDownload: true },
            },
          ],
        });
      }
      if (parsed.pathname.endsWith("/public-file/permissions")) {
        return jsonResponse({ permissions: [{ type: "anyone", role: "reader" }] });
      }
      if (parsed.pathname.endsWith("/private-file/permissions")) {
        return jsonResponse({ permissions: [{ type: "user", role: "owner" }] });
      }
      if (parsed.pathname.endsWith("/public-file") && parsed.searchParams.get("alt") === "media") {
        return byteResponse(SAMPLE_WORDS);
      }
      throw new Error(`Unexpected Drive request: ${url}`);
    };
    return requests;
  }

  it("downloads content only for world-accessible files", async () => {
    const requests = installDriveMock();
    const files = await scanFolder(
      "https://drive.google.com/drive/folders/folder-id",
      "access-token",
      { includeContent: true },
    );

    assert.deepEqual(files.map((file) => file.risk), ["RED", "GREEN"]);
    assert.equal(files[0].content_preview, "one two three four five six seven eight nine ten");
    assert.equal(files[0].content_word_count, 12);
    assert.equal(files[1].content_text, undefined);
    assert.equal(requests.some(({ url }) => url.includes("private-file?alt=media")), false);
    assert.equal(requests.every(({ init }) => init.headers.Authorization === "Bearer access-token"), true);
  });

  it("never downloads content in metadata-only mode", async () => {
    const requests = installDriveMock();
    const files = await scanFolder(
      "https://drive.google.com/drive/folders/folder-id",
      "access-token",
      { includeContent: false },
    );

    assert.equal(files[0].risk, "RED");
    assert.equal(files[0].content_text, undefined);
    assert.equal(requests.some(({ url }) => url.includes("alt=media")), false);
  });
});

describe("browser-only whole-Drive scan", () => {
  function installOwnedDriveMock() {
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      const parsed = new URL(url);
      if (parsed.pathname === "/drive/v3/files") {
        const page = parsed.searchParams.get("pageToken");
        if (!page) {
          return jsonResponse({
            nextPageToken: "page-2",
            files: [{
              id: "public-file",
              name: "public.txt",
              mimeType: "text/plain",
              size: "64",
              owners: [{ emailAddress: "me@example.com" }],
              capabilities: { canDownload: true },
              permissions: [{ type: "user", role: "owner" }, { type: "anyone", role: "reader" }],
            }],
          });
        }
        return jsonResponse({
          files: [{
            id: "shared-file",
            name: "shared.txt",
            mimeType: "text/plain",
            size: "64",
            owners: [{ emailAddress: "me@example.com" }],
            capabilities: { canDownload: true },
            permissions: [{ type: "user", role: "owner" }, { type: "user", role: "writer", emailAddress: "a@example.com" }],
          }],
        });
      }
      if ((parsed.pathname.endsWith("/public-file") || parsed.pathname.endsWith("/shared-file"))
        && parsed.searchParams.get("alt") === "media") {
        return byteResponse(SAMPLE_WORDS);
      }
      throw new Error(`Unexpected Drive request: ${url}`);
    };
    return requests;
  }

  it("lists every owned file across pages and uses inline permissions", async () => {
    const requests = installOwnedDriveMock();
    const files = await scanDrive("access-token", { includeContent: false });

    assert.deepEqual(files.map((file) => [file.id, file.risk]), [["public-file", "RED"], ["shared-file", "YELLOW"]]);
    const listing = requests.filter(({ url }) => new URL(url).pathname === "/drive/v3/files");
    assert.equal(listing.length, 2);
    assert.equal(new URL(listing[0].url).searchParams.get("q"), "'me' in owners and trashed = false");
    assert.equal(requests.some(({ url }) => url.includes("/permissions")), false);
    assert.equal(requests.some(({ url }) => url.includes("alt=media")), false);
  });

  it("honours the chosen word limit, including whole documents", async () => {
    installOwnedDriveMock();
    const limited = await scanDrive("access-token", { includeContent: true, wordLimit: 5 });
    assert.equal(limited[0].content_word_count, 5);
    assert.equal(limited[0].content_text, "one two three four five");

    installOwnedDriveMock();
    const whole = await scanDrive("access-token", { includeContent: true, wordLimit: Infinity });
    assert.equal(whole[0].content_word_count, 12);
    assert.equal(whole[0].preview_message, "Whole document ready for local classification");
  });

  it("reads content from public and shared files", async () => {
    const requests = installOwnedDriveMock();
    const files = await scanDrive("access-token", { includeContent: true });

    assert.equal(files[0].content_word_count, 12);
    assert.equal(files[1].content_word_count, 12);
    assert.equal(requests.some(({ url }) => url.includes("shared-file?alt=media")), true);
  });
});

describe("folder scans with subfolders", () => {
  // root ─ top.txt, Reports/ ─ q1.txt, Archive/ ─ old.txt ; Reports also lists root as a child (a loop)
  const tree = {
    root: [
      { id: "top", name: "top.txt", mimeType: "text/plain" },
      { id: "reports", name: "Reports", mimeType: "application/vnd.google-apps.folder" },
    ],
    reports: [
      { id: "q1", name: "q1.txt", mimeType: "text/plain" },
      { id: "archive", name: "Archive", mimeType: "application/vnd.google-apps.folder" },
      { id: "root", name: "Loop back", mimeType: "application/vnd.google-apps.folder" },
    ],
    archive: [{ id: "old", name: "old.txt", mimeType: "text/plain" }],
  };

  function installTreeMock() {
    const listed = [];
    globalThis.fetch = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/drive/v3/files") {
        const parent = parsed.searchParams.get("q").match(/'([^']+)' in parents/)[1];
        listed.push(parent);
        return jsonResponse({ files: (tree[parent] || []).map((f) => ({ ...f, owners: [{ emailAddress: "me@example.com" }] })) });
      }
      if (parsed.pathname.endsWith("/permissions")) return jsonResponse({ permissions: [{ type: "user", role: "owner" }] });
      throw new Error(`Unexpected Drive request: ${url}`);
    };
    return listed;
  }

  it("always includes files in subfolders at every depth, with their folder path", async () => {
    const listed = installTreeMock();
    const files = await scanFolder("https://drive.google.com/drive/folders/root", "access-token");
    const byId = Object.fromEntries(files.map((f) => [f.id, f.folder_path]));
    assert.equal(byId.top, "");
    assert.equal(byId.q1, "Reports");
    assert.equal(byId.old, "Reports / Archive");
    assert.deepEqual(listed.sort(), ["archive", "reports", "root"], "each folder is listed once, even with a loop");
  });

});

describe("whole-Drive scans across folders", () => {
  it("includes files at every depth and labels their folder path", async () => {
    const owned = [
      { id: "rootfile", name: "notes.txt", mimeType: "text/plain", parents: ["myDriveRoot"] },
      { id: "reports", name: "Reports", mimeType: "application/vnd.google-apps.folder", parents: ["myDriveRoot"] },
      { id: "y2024", name: "2024", mimeType: "application/vnd.google-apps.folder", parents: ["reports"] },
      { id: "deep", name: "grades.csv", mimeType: "text/csv", parents: ["y2024"] },
      { id: "inShared", name: "draft.txt", mimeType: "text/plain", parents: ["someoneElsesFolder"] },
    ].map((f) => ({ ...f, owners: [{ emailAddress: "me@example.com" }], permissions: [{ type: "user", role: "owner" }] }));
    globalThis.fetch = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/drive/v3/files") {
        assert.match(parsed.searchParams.get("fields"), /parents/);
        return jsonResponse({ files: owned });
      }
      throw new Error(`Unexpected Drive request: ${url}`);
    };
    const files = await scanDrive("access-token");
    const byId = Object.fromEntries(files.map((f) => [f.id, f.folder_path]));
    assert.equal(byId.rootfile, "");
    assert.equal(byId.y2024, "Reports");
    assert.equal(byId.deep, "Reports / 2024");
    assert.equal(byId.inShared, "", "folders that weren't listed end the path");
  });
});
