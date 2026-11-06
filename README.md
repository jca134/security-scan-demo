# FileCrawler

FileCrawler (shown on the site as Privacy Scanner) audits the files in a Google
Drive folder and its subfolders, or every file you own in My Drive. Sharing mode
reads metadata only. Content mode additionally extracts text from files shared
with someone else and checks it with a local browser model.

The deployed application is fully static:

```text
Cloudflare Pages → HTML, CSS, JavaScript, WASM
Browser → Google OAuth and Drive REST API
Browser → document extraction and local model inference
```

There is no application server, Cloudflare Function, Worker, database, client
secret, session cookie, or backend API. Drive data travels from Google directly
to the authorized browser tab. Restricted and private file contents are never
downloaded.

## Requirements

- Node.js 20 or newer
- A current WebGPU-capable browser
- A Google Cloud OAuth web client with the Google Drive API enabled

## Google Cloud setup

Create an OAuth client with application type **Web application** and add these
Authorized JavaScript origins:

```text
http://localhost:8080
https://your-project.pages.dev
https://your-custom-domain.example
```

The popup token flow does not use an authorized redirect URI. Cloudflare preview
deployments have distinct origins; Google login works only on origins registered
on the OAuth client.

Declare both scopes on the OAuth consent screen:

- `https://www.googleapis.com/auth/drive.metadata.readonly`
- `https://www.googleapis.com/auth/drive.readonly`

Both are restricted Drive scopes. A public application must satisfy Google's
OAuth verification requirements.

## Local development

Install dependencies and configure the public client ID:

```bash
npm install
cp .env.example .env
```

Set `GOOGLE_CLIENT_ID` in `.env`; do not add a client secret. Then run:

```bash
npm run dev
```

Open [http://localhost:8080](http://localhost:8080). Vite is only a local
development server. It is not part of the deployed runtime.

## Spartan v6 model (optional)

The model picker offers **Spartan v6**, the team's fine-tuned model from the
`sensitivity-scanner-v6` project, next to the default GLiNER2.5-Decide model.
It runs the v6 pipeline in the browser: v6 pattern rules first, then the model
on 100-word blocks (`web/spartan-v6/`, copied from
`sensitivity-scanner-v6/browser/`).

- **Local:** `npm run dev` serves `../sensitivity-scanner-v6/model/onnx/` at
  `/models/spartan-v6/`, so Spartan v6 works with no setup. Set
  `SPARTAN_V6_MODEL_DIR` if the folder lives elsewhere.
- **Deployed:** the model is about 150 MB, over Cloudflare Pages' 25 MiB file
  limit, so builds load it from the team's public Hugging Face repo
  ([JACA369/sensitivity-scanner-v6](https://huggingface.co/JACA369/sensitivity-scanner-v6)),
  pinned to a commit in `vite.config.js`. No Cloudflare setting is needed. To
  use a different copy, set `SPARTAN_V6_MODEL_URL` to a folder URL ending in
  `/`; set it to an empty value to hide Spartan v6. After uploading a new
  model version, update the pinned commit.

## Cloudflare Pages deployment

Connect the GitHub repository to Cloudflare Pages and configure:

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Build output directory | `dist` |
| Environment variable | `GOOGLE_CLIENT_ID=<your public OAuth client ID>` |

No Functions directory, Worker script, runtime secret, or server process is
needed. The build injects only the public OAuth client ID. `_headers` gives the
scanner the cross-origin isolation used by the model runtime, while the separate
authorization page uses popup-compatible headers.

## Scan modes

**Sharing permissions** requests `drive.metadata.readonly`. It lists file
metadata, owners, and sharing permissions without reading file contents.

**File content** requests `drive.readonly`. Permissions are checked first. Only
files with an `anyone` permission are downloaded or exported, with a 20 MB input
limit and a 500-word model limit. Supported formats include Google Docs, Sheets,
Slides and Drawings, text and common structured text, PDF, DOCX, XLSX, PPTX, and
OpenDocument files.

The content scanner uses the benchmark-selected P4 risk prompt with the
345 MB mobile GLiNER2.5-Decide q4f16 model. A deterministic prefilter runs
first; unmatched content is scored in 100-word blocks as `PUBLIC`, `INTERNAL`,
`PERSONAL`, or `SEVERE`. The latter two classifications are flagged as
`DANGEROUS`. Model output is advisory and must be reviewed by a person.
Transformers.js loads its version-pinned ONNX Runtime WASM from jsDelivr so no
single generated asset exceeds Cloudflare Pages' 25 MiB upload limit.

## Authorization design

Google Identity Services returns a short-lived access token to
`authorize.html`. That page places the token in tab-scoped session storage only
long enough to navigate back to the scanner. The scanner reads and immediately
deletes it, then keeps it in JavaScript memory. Reloading or closing the tab
requires authorization again.

This split also keeps Google popup communication separate from the scanner's
cross-origin-isolated WebGPU document.

## Commands

```bash
npm test          # unit and architecture tests
npm run build     # production static bundle in dist/
npm run preview   # preview the production bundle locally
```

## Project layout

```text
FileCrawler/
├── package.json
├── vite.config.js
├── tests/                     # browser logic and architecture tests
└── web/
    ├── index.html             # integrated Drive scanner
    ├── authorize.html         # Google popup authorization handoff
    ├── crawler.js             # UI and model orchestration
    ├── drive.js               # Drive REST client and local extraction
    ├── classifier-worker.js   # GLiNER q4f16 content classifier
    ├── worker.js              # standalone model-lab worker
    ├── lab.html               # original SemIf model lab
    ├── _headers               # Cloudflare Pages response headers
    └── vendor/wllama/         # pinned browser inference runtime
```

SemIf/OpenJev provenance, model pins, and third-party license information are
kept in [`web/`](web/).

## Security notes

- The OAuth client ID is public by design. Never add a Google client secret.
- Access tokens are neither committed nor placed in URLs, cookies, localStorage,
  IndexedDB, logs, analytics, or application servers.
- Extracted text is removed from the UI's file objects after classification.
- A deterministic local pre-filter checks dangerous keywords, formatted Social
  Security numbers, Luhn-valid payment-card numbers, and common API-key or
  private-key formats. A match is marked DANGEROUS without model inference;
  unmatched public files continue to the local model.
- `.env`, historical Google credential files, authorization tokens, model
  weights, dependencies, and build outputs are excluded by `.gitignore`.
- Before publishing this repository, rotate any OAuth credential previously
  committed in `credentials.json` and remove that file from public Git history.
