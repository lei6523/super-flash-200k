#!/bin/bash
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$REPO_DIR/super-flash-200k"
DEST="$DSH_HOME/.agent-presets/super-flash-200k"

if [ ! -f "$SRC/agent.cordis.yml" ]; then
  echo "错误：找不到 $SRC/agent.cordis.yml" >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"

if [ -e "$DEST" ]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  BACKUP="$DEST.bak-$STAMP"
  echo "已存在 $DEST，备份到 $BACKUP"
  mv "$DEST" "$BACKUP"
fi

cp -R "$SRC" "$DEST"
echo "已安装到 $DEST"
echo "请重启 dsh web，然后选择 super-flash-200k preset。"
