#!/bin/zsh
set -euo pipefail

PROJECT_DIR="${0:A:h:h}"
BUILD_DIR="$PROJECT_DIR/build"
ICONSET_DIR="$BUILD_DIR/icon.iconset"
SOURCE_SVG="$BUILD_DIR/app-icon.svg"
PREVIEW_PNG="$BUILD_DIR/app-icon.svg.png"

mkdir -p "$ICONSET_DIR"
qlmanage -t -s 1024 -o "$BUILD_DIR" "$SOURCE_SVG" >/dev/null 2>&1

sips -z 16 16 "$PREVIEW_PNG" --out "$ICONSET_DIR/icon_16x16.png" >/dev/null
sips -z 32 32 "$PREVIEW_PNG" --out "$ICONSET_DIR/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$PREVIEW_PNG" --out "$ICONSET_DIR/icon_32x32.png" >/dev/null
sips -z 64 64 "$PREVIEW_PNG" --out "$ICONSET_DIR/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$PREVIEW_PNG" --out "$ICONSET_DIR/icon_128x128.png" >/dev/null
sips -z 256 256 "$PREVIEW_PNG" --out "$ICONSET_DIR/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$PREVIEW_PNG" --out "$ICONSET_DIR/icon_256x256.png" >/dev/null
sips -z 512 512 "$PREVIEW_PNG" --out "$ICONSET_DIR/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$PREVIEW_PNG" --out "$ICONSET_DIR/icon_512x512.png" >/dev/null
cp "$PREVIEW_PNG" "$ICONSET_DIR/icon_512x512@2x.png"

iconutil -c icns "$ICONSET_DIR" -o "$BUILD_DIR/icon.icns"
rm -rf "$ICONSET_DIR" "$PREVIEW_PNG"
