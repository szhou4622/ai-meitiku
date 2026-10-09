# Third-party notices

## Douyin Downloader

- Project: <https://github.com/jiji262/douyin-downloader>
- Pinned source commit: `848bcaf7bf5c5bebbe028e8ccec76e30ad1bef6b`
- License: MIT
- Vendored path: `third_party/video-downloaders/douyin`

Copyright (c) 2026 jiji262. The complete license text is retained at
`third_party/video-downloaders/douyin/LICENSE`.

## xhs-downloader

- Project: <https://github.com/Andy-SoulShell/xhs-downloader>
- Pinned source commit: `cc2bb34036acb12f5a722c95af7bad53ec696d03`
- License: MIT
- Vendored path: `third_party/video-downloaders/xhs`

The complete license text is retained at
`third_party/video-downloaders/xhs/LICENSE`.

## yt-dlp

- Project: <https://github.com/yt-dlp/yt-dlp>
- Runtime version: `2026.8.19`
- License: The Unlicense

yt-dlp is used as the Douyin single-work downloader so the client can reuse
cookies from an installed local browser when Douyin requires fresh session
cookies. Cookies are read locally and are sent only to the platform request;
they are not sent to the application's own servers.

These projects are used only by the local video-download subsystem. Platform
downloaded media and task history remain on the user's computer. Platform
cookies are never uploaded to the application's own servers.

## CLIP ViT-B/32 ONNX model

- Project: <https://huggingface.co/Xenova/clip-vit-base-patch32>
- Pinned revision: `d15189d7028b43f1d3e65039190477f6af591c2a`
- Runtime: Transformers.js `3.8.1`
- Packaged files: tokenizer and preprocessor configuration plus the quantized
  text and vision ONNX models required by the local visual classifier

The packaged ONNX repository is a Transformers.js-compatible conversion of
OpenAI's `clip-vit-base-patch32` model. Model files are checksum-verified before
they are included in an installer.

## Alibaba Cloud SDK (subtitle removal)

- `@alicloud/videoenhan20200320` 4.0.0 — Apache-2.0
- `@alicloud/sts20150401` 1.2.0 — Apache-2.0
- `@alicloud/tea-util` 1.4.11 — Apache-2.0
- `@alicloud/openapi-client` 0.4.15 — ISC

These SDKs are used by the isolated Aliyun subtitle-removal integration.
Their package license files accompany the runtime dependencies. Videos are
uploaded directly to Alibaba Cloud through its official advance SDK method;
AccessKeys are stored locally using Electron safeStorage.

## Local speech recognition

- whisper.cpp 1.9.1: https://github.com/ggml-org/whisper.cpp, MIT; license bundled at `electron/whisper-LICENSE`. Native binaries and shared libraries are bundled for macOS arm64/x64 and Windows x64, with SHA-256 recorded in `local-asr-manifest.json`.
- OpenAI Whisper multilingual large-v3-turbo model (GGML Q5_0, `ggml-large-v3-turbo-q5_0.bin`): https://github.com/openai/whisper, MIT. Stored under `bundled-models/whisper`, copied into application resources by the existing model packaging rule.
- OpenCC Traditional-to-Simplified dictionary: https://github.com/BYVoid/OpenCC, Apache-2.0. Dictionary provenance and commit are embedded in `electron/text-conversion/t2s-map.json`; license bundled beside the dictionary. Conversion runs offline and preserves English, numbers and timestamps.
