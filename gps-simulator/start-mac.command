#!/bin/bash
# Double-click launcher for macOS: checks tools, installs bridge deps on first run,
# starts the bridge and opens the control page in your browser.
# (Works with macOS's built-in bash 3.2. Also runs on Linux.)

cd "$(dirname "$0")/server" || exit 1
PORT="${PORT:-8787}"
URL="http://127.0.0.1:${PORT}/"

say() { printf '\n\033[1;32m%s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m%s\033[0m\n' "$*"; }
fail() {
  printf '\n\033[1;31m%s\033[0m\n' "$*"
  echo
  read -r -p "按 Enter 關閉視窗…" _
  exit 1
}

# Homebrew installs to /opt/homebrew (Apple Silicon) or /usr/local (Intel); Finder-launched
# shells may not have them on PATH yet.
for d in /opt/homebrew/bin /usr/local/bin "$HOME/platform-tools" "$HOME/Library/Android/sdk/platform-tools"; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH

if ! command -v node >/dev/null 2>&1; then
  fail "找不到 Node.js。請先安裝：https://nodejs.org/（選 LTS 的 macOS Installer .pkg），或 brew install node"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || fail "Node.js 版本太舊（$(node -v)），需要 18 或以上。"

if ! command -v adb >/dev/null 2>&1; then
  warn "找不到 adb（Android Platform-Tools）。橋接仍會啟動，但無法連接手機。
安裝：brew install --cask android-platform-tools
或下載 https://dl.google.com/android/repository/platform-tools-latest-darwin.zip
解壓到家目錄（~/platform-tools），此腳本會自動找到。"
else
  say "adb：$(adb version | head -1)"
  adb devices -l | sed 1d | grep -q . || warn "未偵測到手機：請用 USB 連接、開啟 USB 偵錯，並在手機上按「允許」。"
fi

if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  say "第一次執行：安裝依賴（npm ci）…"
  npm ci --no-audit --no-fund || fail "npm ci 失敗，請檢查網絡後再試。"
fi

say "啟動橋接：${URL}  （關閉此視窗或按 Ctrl+C 停止）"
( sleep 1.5; command -v open >/dev/null 2>&1 && open "$URL" ) &
exec node src/server.js
