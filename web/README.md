# SemIf + FileCrawler static browser application

This directory is the source for the fully static site. Vite bundles it into
`dist/` for Cloudflare Pages. At runtime, Cloudflare serves files only.

The integrated scanner uses Google Identity Services' browser token model and
calls the Google Drive REST API with CORS. It requests one scope based on the
choice made before authorization:

- sharing-only: `drive.metadata.readonly`;
- content: `drive.readonly`.

Permission metadata is always checked first. Content mode downloads or exports
only files with an `anyone` permission. Text extraction and model inference both
run in the browser, with a 20 MB file limit and a 500-word model limit.

`authorize.html` intentionally has popup-compatible COOP headers. After Google
returns a token, it performs a one-navigation, tab-scoped handoff to `index.html`.
The scanner immediately removes the handoff value and keeps the token in memory.
`index.html` is separately cross-origin isolated for the local model runtime.

`lab.html` preserves the independent SemIf/OpenJev model comparison. The
integrated scanner instead uses a dedicated Transformers.js worker with the
mobile GLiNER2.5-Decide q4f16 checkpoint and the benchmark-selected P4 prompt.

## Pins

- wllama: `3.6.1`
- Vue: `3.5.21` (model lab only)
- Transformers.js: `4.3.0`
- GLiNER2.5-Decide mobile ONNX q4f16: revision `880d192` (345 MB)
- Qwen3-0.6B Q8_0: revision `23749fefcc72300e3a2ad315e1317431b06b590a`
- MiniCPM5-2B Q4_K_M: revision `2079a22f3beaa4e306449978533478fe0522f4b3`
- Qwen3.5-4B Q4_K_M: revision `4168f45a16a1290d65a4ec0fa312ae917a4c15d6`

No model weights are committed. The integrated scanner downloads the pinned
mobile GLiNER ONNX model from Hugging Face; the standalone lab downloads its
selected GGUF. Both remain in browser-managed cache.

## Source provenance

The original browser model lab came from `webgpu-demo/` in
[TheoLeeCJ/SemIf-OpenJev](https://github.com/TheoLeeCJ/SemIf-OpenJev) at commit
`23cf1f39fc9534fe81437200959b6dfc7106e45a`. SemIf's original code is MIT
licensed; see `SEMIF_LICENSE`. Other terms are recorded in `THIRD_PARTY.md`.
