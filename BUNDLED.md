# Bundled runtime recovery

`bundled-classifier/`, `bundled-downloaders/`, and `bundled-tools/` are required
for installer builds but are intentionally excluded from Git. Their exact file
and directory hashes are recorded in `bundled-manifest.json`.

## Security rule

Never put `bundled-classifier/.env`, API keys, Apple certificates, license
credentials, or local authorization caches in Git or in a shared runtime
archive. After restoring `bundled-classifier`, create its `.env` locally and
obtain the current secret from the approved secret-management channel.

## Preferred recovery: private archive

Keep a private archive of all three directories in the team drive. On a new
machine, extract it into the repository root so these paths exist:

```text
bundled-classifier/
bundled-downloaders/
bundled-tools/
```

Do not include `bundled-classifier/.env` in that archive. Compare the restored
files with `bundled-manifest.json`; the bundle tree-hash definition is recorded
at the top of that file.

## Public-source recovery

The following artifacts have stable, versioned public download locations and
can be restored with SHA-256 verification:

- yt-dlp 2026.08.19 for macOS Universal and Windows x64.
- FFmpeg 7.1 for macOS arm64 and x64, extracted from the pinned
  `imageio-ffmpeg` 0.6.0 wheels.

Run one of:

```bash
node scripts/fetch-bundled.mjs --target darwin-arm64
node scripts/fetch-bundled.mjs --target darwin-x64
node scripts/fetch-bundled.mjs --target win32-x64
node scripts/fetch-bundled.mjs --all
```

The script refuses unknown output paths, verifies the downloaded archive when
applicable, verifies the final installed file, and writes only beneath the
three ignored bundle directories. Extracting an FFmpeg wheel requires the
system `unzip` command; this path is only used for the macOS targets.

This script does **not** restore:

- The private classifier snapshots.
- The PyInstaller-built xhs-downloader executables or the embedded Windows
  Python runtime.
- The exact historical Windows FFmpeg build
  `N-92722-gf22fcd4483`, whose original public URL is not documented.
- Classifier configuration, templates, icons, or documentation.

Restore those items from the private archive. Do not substitute a different
binary while retaining the manifest's hash.

## Rebuilding when the private archive is unavailable

macOS classifier builds can be recreated from `mac-classifier-engine/` using
the pinned Python requirements and the build steps in
`.github/workflows/build-installers.yml`. The vendored xhs source is under
`third_party/video-downloaders/xhs/` at commit
`cc2bb34036acb12f5a722c95af7bad53ec696d03`; its application version is
3.0.0. `scripts/setup-video-downloaders.sh` creates a development runtime, but
release executables still have to be built separately on each target platform.

After any rebuild, update the relevant version, source URL, SHA-256, and path
in `bundled-manifest.json`. A rebuilt artifact is not identical to the current
snapshot until its hash has been reviewed and the manifest intentionally
updated.

## Historical classifier bytecode risk

The 15 business modules under
`mac-classifier-engine/src/xiaoguan_classifier/` survive only as CPython 3.12
`.pyc` bytecode. Their corresponding `.py` source files are not present in this
project, its parent media-library directory, the slim-edition copy, the build
and release copies, or the available source ZIP archives. The readable
`mac-classifier-engine/engine_entry.py` is only the launcher; it does not
replace the missing business-module source.

This is an at-risk historical artifact rather than maintainable source code.
The bytecode magic and the bundled runtime identify it as CPython 3.12. A
future Python runtime upgrade can make these modules unloadable, so the 3.12
runtime must remain pinned until the modules have been reconstructed and
validated.

`decompyle3` and `uncompyle6` are not a dependable recovery route for these
files: their current decompilation support does not cover CPython 3.12 bytecode
with production-level fidelity. They may help with disassembly or isolated
fragments, but they should not be expected to recreate trustworthy source. No
decompilation has been run as part of this baseline.

## Vendored third-party video downloaders

The directories below are imported external code, not first-party media-library
source. Local fixes must remain traceable to their upstream project and license.
Because this checkout had no Git history before the baseline, the introduction
time below is the local directory creation time, not an upstream release date.

| Component | Local path | Upstream source | Recorded version | Pinned revision | Introduced locally | License |
| --- | --- | --- | --- | --- | --- | --- |
| douyin-downloader | `third_party/video-downloaders/douyin/` | `https://github.com/jiji262/douyin-downloader` | 2.0.0 | `848bcaf7bf5c5bebbe028e8ccec76e30ad1bef6b` | 2026-08-21 16:10:13 +0900 | MIT |
| xhs-downloader | `third_party/video-downloaders/xhs/` | `https://github.com/Andy-SoulShell/xhs-downloader` | 3.0.0 | `cc2bb34036acb12f5a722c95af7bad53ec696d03` | 2026-08-21 16:10:17 +0900 | MIT |

yt-dlp is also an external dependency of the video-download subsystem, but its
source tree is not vendored under `third_party/video-downloaders/`. Its pinned
runtime version, official release URL, and binary hashes are recorded in
`THIRD_PARTY_NOTICES.md` and `bundled-manifest.json`.
