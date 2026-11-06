# Upstream source

The contents of this directory were copied from the `webgpu-demo/` directory
in [TheoLeeCJ/SemIf-OpenJev](https://github.com/TheoLeeCJ/SemIf-OpenJev) at
commit `23cf1f39fc9534fe81437200959b6dfc7106e45a`.

SemIf's original code is MIT licensed; see `SEMIF_LICENSE`. The vendored
wllama runtime retains its own license in `vendor/wllama/LICENCE`, and other
third-party/model terms are documented in `THIRD_PARTY.md`.

No model weights are committed here. The integrated scanner downloads the
revision-pinned mobile GLiNER ONNX classifier, while the standalone model lab
downloads its selected revision-pinned GGUF. The browser stores weights in
browser-managed storage.
