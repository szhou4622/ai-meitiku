#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
PROJECT_ROOT=${SCRIPT_DIR:h:h}
cd "$PROJECT_ROOT"

TARGET=${1:-all}
case "$TARGET" in
  arm64|x64) ARCHES=("$TARGET") ;;
  all) ARCHES=(arm64 x64) ;;
  *) print -u2 "用法：$0 [arm64|x64|all]"; exit 2 ;;
esac

NOTARY_PROFILE=${APPLE_NOTARY_PROFILE:-"AI媒体库公证"}
OUTPUT_DIR="$PROJECT_ROOT/release/device-diagnostic"
LOG_DIR="$OUTPUT_DIR/notary-logs"
mkdir -p "$OUTPUT_DIR" "$LOG_DIR"

for command_name in node security codesign xcrun hdiutil spctl shasum; do
  command -v "$command_name" >/dev/null || { print -u2 "缺少构建命令：$command_name"; exit 1; }
done

SIGNING_IDENTITY=$(security find-identity -v -p codesigning | awk '/Developer ID Application:/ {print $2; exit}')
[[ -n "$SIGNING_IDENTITY" ]] || { print -u2 "未找到 Developer ID Application 签名证书。"; exit 1; }
xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" --output-format json >/dev/null
node "$SCRIPT_DIR/prepare-app.mjs"

VERSION=$(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version")
PRODUCT_NAME="AI媒体库设备核验工具"
ELECTRON_VERSION=$(node -p "require('electron/package.json').version")

for arch in "${ARCHES[@]}"; do
  electron_zip_name="electron-v$ELECTRON_VERSION-darwin-$arch.zip"
  electron_zip=""
  expected_sha=$(node -e 'const value=require("electron/checksums.json")[process.argv[1]];if(!value)process.exit(1);process.stdout.write(value)' "$electron_zip_name")
  for cache_root in \
    "${ELECTRON_DIST_ARCHIVE_DIR:-}" \
    "$HOME/Library/Caches/electron-builder/downloads" \
    "$HOME/Library/Caches/electron"; do
    [[ -n "$cache_root" && -d "$cache_root" ]] || continue
    candidate=$(find "$cache_root" -type f -name "$electron_zip_name" -print -quit 2>/dev/null)
    [[ -n "$candidate" ]] || continue
    actual_sha=$(shasum -a 256 "$candidate" | awk '{print $1}')
    if [[ "$actual_sha" == "$expected_sha" ]]; then
      electron_zip="$candidate"
      break
    fi
  done
  [[ -n "$electron_zip" ]] || {
    print -u2 "未找到 SHA-256 校验通过的 $electron_zip_name 本地缓存。"
    print -u2 "请先下载官方 Electron 归档，或通过 ELECTRON_DIST_ARCHIVE_DIR 指定目录。"
    exit 1
  }
  print "构建并签名 $arch 设备核验工具"
  "$PROJECT_ROOT/node_modules/.bin/electron-builder" \
    --config scripts/license-diagnostic-app/electron-builder.json \
    --config.electronDist="$electron_zip" \
    --mac dmg --"$arch" --publish never
  dmg="$OUTPUT_DIR/$PRODUCT_NAME-$VERSION-mac-$arch.dmg"
  [[ -f "$dmg" ]] || { print -u2 "未找到构建产物：$dmg"; exit 1; }
  codesign --force --sign "$SIGNING_IDENTITY" --timestamp "$dmg"
  codesign --verify --strict --verbose=2 "$dmg"

  result="$LOG_DIR/$arch-result.json"
  xcrun notarytool submit "$dmg" \
    --keychain-profile "$NOTARY_PROFILE" --no-s3-acceleration --wait --output-format json > "$result"
  notary_status=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(d.status||""))' "$result")
  [[ "$notary_status" == "Accepted" ]] || { print -u2 "$arch 公证未通过：${notary_status:-未知}"; exit 1; }
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  hdiutil verify "$dmg" >/dev/null
  spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg"
done

(
  cd "$OUTPUT_DIR"
  shasum -a 256 ./*.dmg > SHA256SUMS.txt
)
print "设备核验工具 macOS 双架构已签名、公证并装订：$OUTPUT_DIR"
