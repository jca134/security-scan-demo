import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

import { defineConfig, loadEnv } from "vite";

const repositoryRoot = resolve(import.meta.dirname);
const webRoot = resolve(repositoryRoot, "web");
const copiedFiles = [
  "_headers",
  "_redirects",
  "README.md",
  "SEMIF_LICENSE",
  "THIRD_PARTY.md",
  "UPSTREAM.md",
  "vendor/wllama/LICENCE",
];

function browserHeaders(request, response, next) {
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.url?.split("?", 1)[0] === "/authorize.html") {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  } else {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  }
  next();
}

function localHeaders() {
  return {
    name: "filecrawler-local-headers",
    configureServer(server) {
      server.middlewares.use(browserHeaders);
    },
    configurePreviewServer(server) {
      server.middlewares.use(browserHeaders);
    },
  };
}

// Spartan v6 (the team's fine-tuned model) is ~150 MB, too large for Cloudflare Pages (25 MiB per file).
// Production loads it from SPARTAN_V6_MODEL_URL (e.g. a Hugging Face repo). During `npm run dev` and
// `npm run preview`, this serves the local sensitivity-scanner-v6/model/onnx folder at /models/spartan-v6/.
const LOCAL_SPARTAN_ROUTE = "/models/spartan-v6/";
// The team's public Hugging Face copy, pinned to a commit so a later upload can't silently change the model.
const DEFAULT_SPARTAN_MODEL_URL =
  "https://huggingface.co/JACA369/sensitivity-scanner-v6/resolve/c3686429e3a2efbab4680dda23c54d33a90e9755/";
const CONTENT_TYPES = { ".json": "application/json", ".onnx": "application/octet-stream" };

function localSpartanModel(modelDir) {
  const serve = (request, response, next) => {
    const path = decodeURIComponent(request.url?.split("?", 1)[0] || "");
    if (!modelDir || !path.startsWith(LOCAL_SPARTAN_ROUTE)) return next();
    const file = resolve(modelDir, path.slice(LOCAL_SPARTAN_ROUTE.length));
    if (!file.startsWith(modelDir + sep) || !existsSync(file) || !statSync(file).isFile()) {
      response.statusCode = 404;
      return response.end("Not found");
    }
    response.setHeader("Content-Type", CONTENT_TYPES[extname(file)] || "application/octet-stream");
    response.setHeader("Content-Length", statSync(file).size);
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    createReadStream(file).pipe(response);
  };
  return {
    name: "filecrawler-local-spartan-model",
    configureServer(server) {
      server.middlewares.use(serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve);
    },
  };
}

function cloudflareFiles() {
  return {
    name: "filecrawler-cloudflare-files",
    generateBundle() {
      for (const relativePath of copiedFiles) {
        this.emitFile({
          type: "asset",
          fileName: relativePath,
          source: readFileSync(resolve(webRoot, relativePath)),
        });
      }
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const environment = loadEnv(mode, repositoryRoot, "");
  const googleClientId = (
    environment.GOOGLE_CLIENT_ID || environment.VITE_GOOGLE_CLIENT_ID || ""
  ).trim();

  const localSpartanDir = resolve(
    repositoryRoot,
    environment.SPARTAN_V6_MODEL_DIR || "../sensitivity-scanner-v6/model/onnx",
  );
  const hasLocalSpartan = existsSync(resolve(localSpartanDir, "scanner_spec.json"));
  // Order: SPARTAN_V6_MODEL_URL if set (an explicitly empty value hides Spartan v6), then the local folder
  // during `npm run dev`, then the pinned Hugging Face copy, which is what deployed builds use.
  const spartanModelUrl = "SPARTAN_V6_MODEL_URL" in environment
    ? environment.SPARTAN_V6_MODEL_URL.trim()
    : command === "serve" && hasLocalSpartan ? LOCAL_SPARTAN_ROUTE : DEFAULT_SPARTAN_MODEL_URL;

  if (command === "build" && !googleClientId) {
    throw new Error(
      "GOOGLE_CLIENT_ID is required. Set it in .env locally or in the Cloudflare Pages build environment.",
    );
  }

  return {
    root: webRoot,
    envDir: repositoryRoot,
    publicDir: false,
    resolve: {
      // Transformers.js configures a version-pinned jsDelivr URL for ONNX
      // Runtime's WASM. Selecting this export keeps the 25.6 MiB runtime out
      // of dist, where it would exceed Cloudflare Pages' 25 MiB file limit.
      conditions: ["onnxruntime-web-use-extern-wasm"],
    },
    define: {
      __GOOGLE_CLIENT_ID__: JSON.stringify(googleClientId),
      __SPARTAN_V6_MODEL_URL__: JSON.stringify(spartanModelUrl),
    },
    plugins: [localHeaders(), localSpartanModel(hasLocalSpartan ? localSpartanDir : null), cloudflareFiles()],
    server: {
      host: "localhost",
      port: 8080,
      strictPort: true,
    },
    preview: {
      host: "localhost",
      port: 8080,
      strictPort: true,
    },
    worker: {
      format: "es",
    },
    build: {
      outDir: resolve(repositoryRoot, "dist"),
      emptyOutDir: true,
      target: "esnext",
      rollupOptions: {
        input: {
          main: resolve(webRoot, "index.html"),
          authorize: resolve(webRoot, "authorize.html"),
          lab: resolve(webRoot, "lab.html"),
          privacy: resolve(webRoot, "privacy.html"),
        },
      },
    },
  };
});
