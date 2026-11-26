#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/launcher.log"
mkdir -p "$LOG_DIR"

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.local/share/mise/shims:$HOME/.asdf/shims:$PATH"
if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST_NVM="$(ls -1d "$HOME"/.nvm/versions/node/v* 2>/dev/null | sort -V | tail -n 1)"
  [ -n "$LATEST_NVM" ] && export PATH="$LATEST_NVM/bin:$PATH"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Slizm Gateway 启动失败：未找到 Node.js 20 或更高版本。"
  echo "请从 https://nodejs.org/ 安装或使用 brew install node 后重试。"
  read -r -p "按回车键关闭窗口..."
  exit 1
fi

cd "$ROOT" || exit 1
node "$ROOT/scripts/gw.js" up 2>&1 | tee "$LOG_FILE"
STATUS=${PIPESTATUS[0]}

if [ "$STATUS" -ne 0 ]; then
  echo ""
  echo "启动失败 (退出码 $STATUS)，日志位于: $LOG_FILE"
  read -r -p "按回车键关闭窗口..."
  exit "$STATUS"
fi
