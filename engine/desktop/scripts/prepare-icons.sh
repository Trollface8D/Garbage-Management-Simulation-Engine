#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSETS_DIR="$ROOT_DIR/assets"
SRC_PNG="$ASSETS_DIR/icon.png"
DST_ICNS="$ASSETS_DIR/icon.icns"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[icons] Non-macOS environment. Skipping .icns generation."
  exit 0
fi

if [[ ! -f "$SRC_PNG" ]]; then
  echo "[icons] Missing $SRC_PNG. Cannot generate .icns." >&2
  exit 1
fi

if ! command -v sips >/dev/null 2>&1 || ! command -v iconutil >/dev/null 2>&1; then
  echo "[icons] macOS tools 'sips' and 'iconutil' are required." >&2
  exit 1
fi

ICONSET_DIR="$ASSETS_DIR/icon.iconset"
rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

# Generate all required iconset sizes from a single source image.
sips -z 16 16 "$SRC_PNG" --out "$ICONSET_DIR/icon_16x16.png" >/dev/null
sips -z 32 32 "$SRC_PNG" --out "$ICONSET_DIR/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$SRC_PNG" --out "$ICONSET_DIR/icon_32x32.png" >/dev/null
sips -z 64 64 "$SRC_PNG" --out "$ICONSET_DIR/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$SRC_PNG" --out "$ICONSET_DIR/icon_128x128.png" >/dev/null
sips -z 256 256 "$SRC_PNG" --out "$ICONSET_DIR/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$SRC_PNG" --out "$ICONSET_DIR/icon_256x256.png" >/dev/null
sips -z 512 512 "$SRC_PNG" --out "$ICONSET_DIR/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$SRC_PNG" --out "$ICONSET_DIR/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$SRC_PNG" --out "$ICONSET_DIR/icon_512x512@2x.png" >/dev/null

iconutil -c icns "$ICONSET_DIR" -o "$DST_ICNS"
rm -rf "$ICONSET_DIR"

echo "[icons] Generated $DST_ICNS"
