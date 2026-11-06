import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

describe("static deployment architecture", () => {
  it("contains no application-server routes or client secret", () => {
    const main = read("web/crawler.js");
    const authorization = read("web/authorize.js");
    const environment = read(".env.example");
    assert.doesNotMatch(main, /fetch\(["']\/(?:api|auth)\//u);
    assert.equal(`${main}\n${authorization}`.includes("GOOGLE_CLIENT_SECRET"), false);
    assert.equal(environment.includes("CLIENT_SECRET"), false);
  });

  it("uses Google browser authorization and direct Drive REST calls", () => {
    assert.ok(read("web/authorize.html").includes("https://accounts.google.com/gsi/client"));
    assert.ok(read("web/authorize.js").includes("initTokenClient"));
    assert.ok(read("web/authorize.js").includes("new BroadcastChannel(AUTH_CHANNEL)"));
    assert.ok(read("web/crawler.js").includes('"authorize.html?mode=content&popup=1"'));
    assert.ok(read("web/drive.js").includes("https://www.googleapis.com/drive/v3"));
    assert.ok(read("web/drive.js").includes('file.risk === "RED" || file.risk === "YELLOW"'));
  });

  it("publishes and links a privacy policy describing Google user data use", () => {
    const homepage = read("web/index.html");
    const authorization = read("web/authorize.html");
    const policy = read("web/privacy.html");
    const vite = read("vite.config.js");
    assert.ok(homepage.includes('href="privacy.html"'));
    assert.ok(authorization.includes('href="privacy.html"'));
    assert.ok(policy.includes("drive.metadata.readonly"));
    assert.ok(policy.includes("drive.readonly"));
    assert.ok(policy.includes("Storage and retention"));
    assert.ok(policy.includes("Sharing and disclosure"));
    assert.ok(vite.includes('privacy: resolve(webRoot, "privacy.html")'));
  });

  it("separates popup and model isolation headers", () => {
    const headers = read("web/_headers");
    assert.ok(headers.includes("/authorize.html"));
    assert.ok(headers.includes("same-origin-allow-popups"));
    assert.ok(headers.includes("Cross-Origin-Embedder-Policy: require-corp"));
    assert.match(
      headers,
      /\/assets\/\*[\s\S]*Cross-Origin-Embedder-Policy: require-corp/u,
      "generated model workers must receive the isolation header",
    );
  });

  it("keeps the ONNX runtime below Cloudflare Pages' asset limit", () => {
    const vite = read("vite.config.js");
    assert.ok(vite.includes('conditions: ["onnxruntime-web-use-extern-wasm"]'));
  });

  it("keeps the local classifier and pinned browser models", () => {
    const labWorker = read("web/worker.js");
    const classifierWorker = read("web/classifier-worker.js");
    assert.ok(labWorker.includes('import("./vendor/wllama/index.js")'));
    for (const revision of [
      "23749fefcc72300e3a2ad315e1317431b06b590a",
      "2079a22f3beaa4e306449978533478fe0522f4b3",
      "4168f45a16a1290d65a4ec0fa312ae917a4c15d6",
    ]) assert.ok(labWorker.includes(revision));
    assert.ok(classifierWorker.includes('from "@huggingface/transformers"'));
    assert.ok(classifierWorker.includes("onnx-community/GLiNER2.5-Decide-mobile-ONNX"));
    assert.ok(classifierWorker.includes('MODEL_REVISION = "880d192"'));
    assert.ok(classifierWorker.includes('MODEL_DTYPE = "q4f16"'));
    assert.ok(classifierWorker.includes("MODEL_WORD_LIMIT = 500"));
    assert.ok(classifierWorker.includes("BLOCK_WORDS = 100"));
    assert.ok(classifierWorker.includes('file?.risk === "RED" || file?.risk === "YELLOW"'));
    assert.ok(classifierWorker.indexOf("prefilterDangerousText(contentText)") < classifierWorker.indexOf("await decide(states[blockIndex], prompt)"));
    assert.ok(classifierWorker.includes('classificationSource: "prefilter"'));
    assert.ok(read("web/crawler.js").includes('new URL("./classifier-worker.js", import.meta.url)'));
    assert.ok(read("web/crawler.js").includes('classifier.hidden = activeMode !== "content"'));
    assert.ok(read("web/index.html").includes('value="gliner2.5-decide-mobile-q4f16"'));
    assert.ok(read("web/index.html").includes("How much harm could result if this file were shared publicly by mistake?"));
  });

  it("shows file-by-file classification progress in the dangerous summary", () => {
    const crawler = read("web/crawler.js");
    const styles = read("web/crawler.css");
    assert.ok(crawler.includes('document.createElement("progress")'));
    assert.ok(crawler.includes('renderClassificationProgress($("#dangerous-count"), data.completed, data.total)'));
    assert.equal(styles.includes("count-spinner"), false);
    assert.ok(styles.includes("classification-progress-bar"));
  });
});
