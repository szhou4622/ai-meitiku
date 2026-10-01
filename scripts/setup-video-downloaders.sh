#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
PROJECT_ROOT=${SCRIPT_DIR:h}
PYTHON_BIN=${AI_MEDIA_PYTHON:-python3}
RUNTIME_DIR="$PROJECT_ROOT/.download-runtime"
DOUYIN_ROOT="$PROJECT_ROOT/third_party/video-downloaders/douyin"
XHS_ROOT="$PROJECT_ROOT/third_party/video-downloaders/xhs"

"$PYTHON_BIN" - <<'PY'
import sys
if sys.version_info < (3, 12):
    raise SystemExit("视频下载开发环境需要 Python 3.12 或更高版本")
PY

if [[ ! -x "$RUNTIME_DIR/bin/python" && ! -x "$RUNTIME_DIR/Scripts/python.exe" ]]; then
  "$PYTHON_BIN" -m venv "$RUNTIME_DIR"
fi

if [[ -x "$RUNTIME_DIR/bin/python" ]]; then
  RUNTIME_PYTHON="$RUNTIME_DIR/bin/python"
else
  RUNTIME_PYTHON="$RUNTIME_DIR/Scripts/python.exe"
fi

"$RUNTIME_PYTHON" -m pip install --upgrade pip
"$RUNTIME_PYTHON" -m pip install -r "$DOUYIN_ROOT/requirements.txt"
"$RUNTIME_PYTHON" -m pip install "yt-dlp==2026.8.19"
"$RUNTIME_PYTHON" -m pip install \
  "click==8.4.2" \
  "colorama==0.4.6" \
  "win32-setctime==1.2.0" \
  -e "$XHS_ROOT/packages/xhs-core" \
  -e "$XHS_ROOT/packages/xhs-adapters" \
  -e "$XHS_ROOT/apps/cli"

print "视频下载开发运行时已安装：$RUNTIME_DIR"
print "抖音后端：$DOUYIN_ROOT"
print "小红书后端：$XHS_ROOT"
