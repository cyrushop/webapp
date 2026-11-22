#!/bin/bash
# iPhone launcher for macOS: sets up a private Python env with pymobiledevice3 (first run only),
# then starts the bridge with the iPhone link enabled. No sudo needed (userspace tunnel).

ROOT="$(cd "$(dirname "$0")" && pwd)"
VENV="$ROOT/ios/.venv"

say() { printf '\n\033[1;32m%s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m%s\033[0m\n' "$*"; }
fail() {
  printf '\n\033[1;31m%s\033[0m\n' "$*"
  echo
  read -r -p "按 Enter 關閉視窗…" _
  exit 1
}

for d in /opt/homebrew/bin /usr/local/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
export PATH

# Prefer a recent Python (3.13+ uses TCP tunnels; older needs extra native deps).
PY=""
for c in python3.14 python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null 2>&1; then
    if "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      PY="$(command -v "$c")"
      break
    fi
  fi
done
[ -n "$PY" ] || fail "需要 Python 3.10 或以上（建議 3.13）。安裝：brew install python@3.13 或 https://www.python.org/downloads/macos/"
say "Python：$("$PY" --version)"

if [ ! -x "$VENV/bin/python" ]; then
  say "第一次執行：建立 Python 環境…"
  "$PY" -m venv "$VENV" || fail "建立 venv 失敗"
fi
if ! "$VENV/bin/python" -c 'import pymobiledevice3' 2>/dev/null || [ "${UPDATE:-0}" = "1" ]; then
  say "安裝 / 更新 pymobiledevice3（約 1–3 分鐘）…"
  "$VENV/bin/python" -m pip install --upgrade pip >/dev/null
  "$VENV/bin/python" -m pip install --upgrade pymobiledevice3 || fail "安裝 pymobiledevice3 失敗，請檢查網絡"
fi
say "pymobiledevice3：$("$VENV/bin/python" -m pip show pymobiledevice3 2>/dev/null | awk '/^Version/{print $2}')"

warn "請確認 iPhone：① 用 USB 線連接 ② 已解鎖 ③ 按「信任此電腦」④ 已開「開發者模式」
（如「設定 → 私隱與安全性」入面見唔到「開發者模式」，下面會嘗試令佢顯示）"
"$VENV/bin/python" -m pymobiledevice3 amfi reveal-developer-mode >/dev/null 2>&1 \
  && echo "已要求 iPhone 顯示「開發者模式」選項（如已開啟可忽略）。" \
  || echo "（未能自動顯示開發者模式選項：如 iPhone 未連接或未信任，可稍後再試）"

export IOS=1
export IOS_PYTHON="$VENV/bin/python"
exec /bin/bash "$ROOT/start-mac.command"
