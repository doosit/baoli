#!/bin/zsh

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PYTHON_BIN="${PYTHON_BIN:-python3}"
TARGET_SCRIPT="$SCRIPT_DIR/baoli_checkin.py"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "未找到 Python: $PYTHON_BIN" >&2
  exit 1
fi

if [ ! -f "$TARGET_SCRIPT" ]; then
  echo "未找到签到脚本: $TARGET_SCRIPT" >&2
  exit 1
fi

exec "$PYTHON_BIN" "$TARGET_SCRIPT" "$@"
