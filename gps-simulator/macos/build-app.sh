#!/bin/bash
# Builds "Pikmin GPS.app" (macOS only: needs osacompile/codesign/ditto).
# The app bundles the bridge, the web UI and official Node.js binaries for arm64 + x64,
# so the user needs nothing else installed for Android. Output: <out>/PikminGPS-mac.zip
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/dist}"
NODE_MAJOR="${NODE_MAJOR:-22}"
APP="$OUT/Pikmin GPS.app"
TMP="$OUT/tmp"

rm -rf "$OUT"
mkdir -p "$TMP"

echo "==> AppleScript launcher"
osacompile -o "$APP" "$ROOT/macos/launcher.applescript"
RES="$APP/Contents/Resources"
PLIST="$APP/Contents/Info.plist"
plutil -replace CFBundleName -string "Pikmin GPS" "$PLIST"
plutil -replace CFBundleIdentifier -string "com.pikminbridge.gpssim" "$PLIST"
plutil -replace CFBundleShortVersionString -string "${APP_VERSION:-0.3.0}" "$PLIST"

echo "==> Bridge + web UI"
mkdir -p "$RES/app/server" "$RES/app/ios"
cp -R "$ROOT/web" "$RES/app/web"
cp -R "$ROOT/server/src" "$ROOT/server/package.json" "$ROOT/server/package-lock.json" "$RES/app/server/"
(cd "$RES/app/server" && npm ci --omit=dev --no-audit --no-fund)
cp "$ROOT/ios/ios_bridge.py" "$RES/app/ios/"

echo "==> Node.js v$NODE_MAJOR (official, checksum-verified)"
BASE="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
for arch in arm64 x64; do
  f="$(grep -oE "node-v[0-9.]+-darwin-$arch\.tar\.gz" "$TMP/SHASUMS256.txt" | head -1)"
  [ -n "$f" ] || { echo "no darwin-$arch build listed"; exit 1; }
  curl -fsSL "$BASE/$f" -o "$TMP/$f"
  (cd "$TMP" && grep " $f\$" SHASUMS256.txt | shasum -a 256 -c -)
  tar -xzf "$TMP/$f" -C "$TMP"
  mkdir -p "$RES/node-$arch"
  cp "$TMP/${f%.tar.gz}/bin/node" "$RES/node-$arch/node"
  cp "$TMP/${f%.tar.gz}/LICENSE" "$RES/node-$arch/LICENSE"
  echo "    $f"
done

echo "==> Ad-hoc sign the bundle (Node binaries keep their own Node.js signature)"
codesign --force --sign - "$APP"
codesign --verify --verbose=2 "$APP"

echo "==> Zip"
(cd "$OUT" && ditto -c -k --keepParent "Pikmin GPS.app" PikminGPS-mac.zip)
rm -rf "$TMP"
du -sh "$APP" "$OUT/PikminGPS-mac.zip"
