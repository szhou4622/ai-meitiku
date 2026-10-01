#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
PROJECT_ROOT=${SCRIPT_DIR:h}
cd "$PROJECT_ROOT"

TARGET=${1:-all}
case "$TARGET" in
  arm64|x64|universal) ARCHES=("$TARGET") ;;
  all) ARCHES=(arm64 x64 universal) ;;
  check) ARCHES=() ;;
  *)
    print -u2 "用法：$0 [arm64|x64|universal|all|check]"
    exit 2
    ;;
esac

CERT_ZIP=${APPLE_CERT_ZIP:-"$HOME/Downloads/苹果证书.zip"}
NOTARY_PROFILE=${APPLE_NOTARY_PROFILE:-"AI媒体库公证"}
TIMESTAMP_SERVER=${APPLE_TIMESTAMP_SERVER:-}
NOTARIZED_DIR="$PROJECT_ROOT/release/notarized"
NOTARY_LOG_DIR="$PROJECT_ROOT/release/notary-logs"
TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/ai-media-notarize.XXXXXX")
MOUNT_POINT=""
SIGNING_KEYCHAIN=""
ORIGINAL_KEYCHAINS=()

cleanup() {
  unset CSC_LINK CSC_KEY_PASSWORD CSC_IDENTITY_AUTO_DISCOVERY
  if (( ${#ORIGINAL_KEYCHAINS[@]} > 0 )); then
    security list-keychains -d user -s "${ORIGINAL_KEYCHAINS[@]}" >/dev/null 2>&1 || true
  fi
  if [[ -n "$SIGNING_KEYCHAIN" ]]; then
    security delete-keychain "$SIGNING_KEYCHAIN" >/dev/null 2>&1 || true
  fi
  if [[ -n "$MOUNT_POINT" ]] && mount | grep -Fq "on $MOUNT_POINT "; then
    hdiutil detach "$MOUNT_POINT" -quiet || true
  fi
  find "$TEMP_ROOT" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for command_name in node curl ditto security codesign hdiutil openssl spctl shasum xcrun; do
  command -v "$command_name" >/dev/null || {
    print -u2 "缺少构建命令：$command_name"
    exit 1
  }
done

if command -v npm >/dev/null; then
  run_package_script() { npm run "$1"; }
elif [[ -x "$PROJECT_ROOT/node_modules/.bin/vinext" ]]; then
  run_package_script() {
    case "$1" in
      desktop:icon) zsh "$PROJECT_ROOT/scripts/build-macos-icon.sh" ;;
      build) "$PROJECT_ROOT/node_modules/.bin/vinext" build ;;
      *) print -u2 "不支持的构建脚本：$1"; return 2 ;;
    esac
  }
else
  print -u2 "缺少 npm 和本地 vinext，无法运行构建脚本。"
  exit 1
fi

[[ -f "$CERT_ZIP" ]] || {
  print -u2 "未找到 Apple 证书包：$CERT_ZIP"
  print -u2 "可通过 APPLE_CERT_ZIP 指定证书 ZIP 路径。"
  exit 1
}

[[ -x "$PROJECT_ROOT/node_modules/.bin/electron-builder" ]] || {
  print -u2 "依赖尚未安装，请先运行 npm ci。"
  exit 1
}

node "$PROJECT_ROOT/scripts/verify-electron-runtime-imports.mjs"

print "[1/7] 验证 Apple 公证凭据"
xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" --output-format json >/dev/null

# The leaf certificate in the supplied P12 is issued by Apple's Developer ID
# G2 intermediate. Import the public intermediate only when this Mac lacks it.
DEVID_G2_SHA256="F16CD3C54C7F83CEA4BF1A3E6A0819C8AAA8E4A1528FD144715F350643D2DF3A"
LOGIN_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
if ! security find-certificate -c "Developer ID Certification Authority" -a -Z "$LOGIN_KEYCHAIN" 2>/dev/null | grep -Fq "$DEVID_G2_SHA256"; then
  print "[2/7] 安装 Apple Developer ID G2 中间证书"
  curl -fsSL "https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer" -o "$TEMP_ROOT/DeveloperIDG2CA.cer"
  ACTUAL_SHA256=$(openssl x509 -inform DER -in "$TEMP_ROOT/DeveloperIDG2CA.cer" -outform DER | shasum -a 256 | awk '{print toupper($1)}')
  [[ "$ACTUAL_SHA256" == "$DEVID_G2_SHA256" ]] || {
    print -u2 "Apple 中间证书指纹不匹配，已终止。"
    exit 1
  }
  security import "$TEMP_ROOT/DeveloperIDG2CA.cer" -k "$LOGIN_KEYCHAIN" >/dev/null
else
  print "[2/7] Apple Developer ID G2 中间证书已就绪"
fi

print "[3/7] 安全读取 Developer ID 证书"
ditto -x -k "$CERT_ZIP" "$TEMP_ROOT/certificate"
P12_FILE=$(find "$TEMP_ROOT/certificate" -type f -name '*.p12' ! -path '*/__MACOSX/*' -print -quit)
PASSWORD_FILE=$(find "$TEMP_ROOT/certificate" -type f -name '*.md' ! -path '*/__MACOSX/*' -print -quit)
[[ -n "$P12_FILE" && -n "$PASSWORD_FILE" ]] || {
  print -u2 "证书 ZIP 中必须包含一个 .p12 和密码 .md 文件。"
  exit 1
}
chmod 600 "$P12_FILE" "$PASSWORD_FILE"
export CSC_LINK="$P12_FILE"
export CSC_KEY_PASSWORD=$(tr -d '\r\n' < "$PASSWORD_FILE")
export CSC_IDENTITY_AUTO_DISCOVERY=true

CERTIFICATE_SUBJECT=$(openssl pkcs12 -in "$P12_FILE" -passin env:CSC_KEY_PASSWORD -clcerts -nokeys 2>/dev/null | openssl x509 -noout -subject)
[[ "$CERTIFICATE_SUBJECT" == *"Developer ID Application:"* ]] || {
  print -u2 "P12 不是 Developer ID Application 签名证书。"
  exit 1
}
unset CERTIFICATE_SUBJECT

# electron-builder signs the application bundle, but its DMG container is not
# guaranteed to receive a usable Developer ID signature. Keep a temporary
# keychain for explicitly signing every DMG before it is submitted to Apple.
ORIGINAL_KEYCHAINS=(${(f)"$(security list-keychains -d user | sed 's/^[[:space:]]*"//; s/"$//')"})
SIGNING_KEYCHAIN="$TEMP_ROOT/dmg-signing.keychain-db"
SIGNING_KEYCHAIN_PASSWORD=$(openssl rand -hex 24)
security create-keychain -p "$SIGNING_KEYCHAIN_PASSWORD" "$SIGNING_KEYCHAIN"
security unlock-keychain -p "$SIGNING_KEYCHAIN_PASSWORD" "$SIGNING_KEYCHAIN"
security set-keychain-settings -lut 21600 "$SIGNING_KEYCHAIN"
security import "$P12_FILE" -k "$SIGNING_KEYCHAIN" -P "$CSC_KEY_PASSWORD" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$SIGNING_KEYCHAIN_PASSWORD" "$SIGNING_KEYCHAIN" >/dev/null
security list-keychains -d user -s "$SIGNING_KEYCHAIN" "${ORIGINAL_KEYCHAINS[@]}"
DMG_SIGNING_IDENTITY=$(security find-identity -v -p codesigning "$SIGNING_KEYCHAIN" | awk '/Developer ID Application:/ {print $2; exit}')
[[ -n "$DMG_SIGNING_IDENTITY" ]] || {
  print -u2 "临时钥匙串中未找到 Developer ID Application 签名身份。"
  exit 1
}

if [[ "$TARGET" == "check" ]]; then
  print "证书、公证凭据和 Apple 信任链检查通过；未执行构建。"
  exit 0
fi

print "[4/7] 构建网页资源和应用图标"
node "$PROJECT_ROOT/scripts/prepare-local-visual-model.mjs"
run_package_script desktop:icon
run_package_script build

mkdir -p "$NOTARIZED_DIR" "$NOTARY_LOG_DIR"
PRODUCT_NAME=$(node -p "JSON.parse(require('fs').readFileSync('package.json', 'utf8')).build.productName")
VERSION=$(node -p "JSON.parse(require('fs').readFileSync('package.json', 'utf8')).version")

app_path_for_arch() {
  case "$1" in
    arm64) print "$PROJECT_ROOT/release/mac-arm64/$PRODUCT_NAME.app" ;;
    x64) print "$PROJECT_ROOT/release/mac/$PRODUCT_NAME.app" ;;
    universal) print "$PROJECT_ROOT/release/mac-universal/$PRODUCT_NAME.app" ;;
  esac
}

notarize_one() {
  local arch=$1
  local dmg="$PROJECT_ROOT/release/$PRODUCT_NAME-$VERSION-mac-$arch-安装程序.dmg"
  local app_path
  local result_json="$NOTARY_LOG_DIR/$arch-result.json"
  local submission_id
  local notary_status
  local -a electron_dist_args=()
  local -a timestamp_args=()
  local -a dmg_timestamp_args=(--timestamp)
  app_path=$(app_path_for_arch "$arch")

  if [[ -n "$TIMESTAMP_SERVER" ]]; then
    timestamp_args=("--config.mac.timestamp=$TIMESTAMP_SERVER")
    dmg_timestamp_args=("--timestamp=$TIMESTAMP_SERVER")
  fi

  print "[5/7] 检查 $arch 视频下载运行时"
  node "$PROJECT_ROOT/scripts/verify-video-downloader-assets.mjs" "darwin-$arch"
  if [[ -n "${ELECTRON_DIST_ARCHIVE_DIR:-}" ]]; then
    local electron_version electron_zip_name electron_zip expected_sha actual_sha
    electron_version=$(node -p "require('electron/package.json').version")
    electron_zip_name="electron-v$electron_version-darwin-$arch.zip"
    electron_zip="$ELECTRON_DIST_ARCHIVE_DIR/$electron_zip_name"
    [[ -f "$electron_zip" ]] || {
      print -u2 "本机 Electron 缓存包不存在：$electron_zip"
      exit 1
    }
    expected_sha=$(node -e 'const value=require("./node_modules/electron/checksums.json")[process.argv[1]]; if (!value) process.exit(1); process.stdout.write(value)' "$electron_zip_name")
    actual_sha=$(shasum -a 256 "$electron_zip" | awk '{print $1}')
    [[ "$actual_sha" == "$expected_sha" ]] || {
      print -u2 "$arch Electron 缓存包 SHA-256 不匹配，已终止。"
      exit 1
    }
    electron_dist_args=("--config.electronDist=$electron_zip")
    print "[5/7] 使用已校验的本机 Electron $arch 缓存包"
  fi
  print "[5/7] 构建并签名 $arch 安装包"
  "$PROJECT_ROOT/node_modules/.bin/electron-builder" --mac dmg --"$arch" --publish never "${electron_dist_args[@]}" "${timestamp_args[@]}"
  [[ -f "$dmg" && -d "$app_path" ]] || {
    print -u2 "$arch 构建产物缺失。"
    exit 1
  }
  codesign --verify --deep --strict --verbose=2 "$app_path"
  print "[5/7] 使用 Developer ID 签名 $arch DMG 外层"
  codesign --force --sign "$DMG_SIGNING_IDENTITY" --keychain "$SIGNING_KEYCHAIN" "${dmg_timestamp_args[@]}" "$dmg"
  codesign --verify --strict --verbose=2 "$dmg"

  print "[6/7] 提交 $arch 到 Apple 公证服务"
  local submit_attempt
  for submit_attempt in 1 2 3; do
    if xcrun notarytool submit "$dmg" \
      --keychain-profile "$NOTARY_PROFILE" \
      --no-s3-acceleration \
      --wait \
      --output-format json > "$result_json"; then
      break
    fi
    if (( submit_attempt == 3 )); then
      print -u2 "$arch 公证上传连续失败 3 次。"
      exit 1
    fi
    print -u2 "$arch 公证上传失败，5 秒后重试（$submit_attempt/3）。"
    sleep 5
  done

  notary_status=$(node -e 'const f=require("fs"); const d=JSON.parse(f.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(d.status||""));' "$result_json")
  submission_id=$(node -e 'const f=require("fs"); const d=JSON.parse(f.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(d.id||""));' "$result_json")
  if [[ "$notary_status" != "Accepted" ]]; then
    [[ -n "$submission_id" ]] && xcrun notarytool log "$submission_id" --keychain-profile "$NOTARY_PROFILE" > "$NOTARY_LOG_DIR/$arch-log.json" || true
    print -u2 "$arch 公证未通过（状态：${notary_status:-未知}），详见 $NOTARY_LOG_DIR。"
    exit 1
  fi

  print "[7/7] 装订票据并执行 Gatekeeper 验证：$arch"
  local staple_attempt
  for staple_attempt in 1 2 3; do
    if xcrun stapler staple "$dmg"; then
      break
    fi
    if (( staple_attempt == 3 )); then
      print -u2 "$arch 公证票据装订连续失败 3 次。"
      exit 1
    fi
    print -u2 "$arch 公证票据装订失败，5 秒后重试（$staple_attempt/3）。"
    sleep 5
  done
  local validate_attempt
  for validate_attempt in 1 2 3; do
    if xcrun stapler validate "$dmg"; then
      break
    fi
    if (( validate_attempt == 3 )); then
      print -u2 "$arch 公证票据验证连续失败 3 次。"
      exit 1
    fi
    print -u2 "$arch 公证票据验证失败，5 秒后重试（$validate_attempt/3）。"
    sleep 5
  done
  hdiutil verify "$dmg" >/dev/null
  spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg"

  MOUNT_POINT=$(mktemp -d "${TMPDIR:-/tmp}/ai-media-mounted.XXXXXX")
  hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT_POINT" "$dmg" >/dev/null
  local mounted_app="$MOUNT_POINT/$PRODUCT_NAME.app"
  codesign --verify --deep --strict --verbose=2 "$mounted_app"
  spctl --assess --type execute --verbose=4 "$mounted_app"
  hdiutil detach "$MOUNT_POINT" -quiet
  rmdir "$MOUNT_POINT"
  MOUNT_POINT=""

  cp -p "$dmg" "$NOTARIZED_DIR/"
  print "已输出：$NOTARIZED_DIR/${dmg:t}"
}

for arch in "${ARCHES[@]}"; do
  notarize_one "$arch"
done

(
  cd "$NOTARIZED_DIR"
  shasum -a 256 *.dmg > SHA256SUMS.txt
)

print "完成：所有输出均已通过 Apple 公证、stapler 和 Gatekeeper 验证。"
print "目录：$NOTARIZED_DIR"
