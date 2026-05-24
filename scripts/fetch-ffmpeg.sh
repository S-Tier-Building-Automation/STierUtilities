#!/usr/bin/env bash
# Downloads FFmpeg + ffprobe Windows builds for Tauri sidecars (run on Windows or CI).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/src-tauri/binaries"
mkdir -p "$BIN_DIR"

TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
if [[ -z "$TRIPLE" ]]; then
  echo "Failed to determine rustc host triple" >&2
  exit 1
fi

ZIP_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading FFmpeg..."
curl -fsSL "$ZIP_URL" -o "$TMP_DIR/ffmpeg.zip"
unzip -q "$TMP_DIR/ffmpeg.zip" -d "$TMP_DIR/extract"

FFMPEG_SRC="$(find "$TMP_DIR/extract" -name ffmpeg.exe | head -n1)"
FFPROBE_SRC="$(find "$TMP_DIR/extract" -name ffprobe.exe | head -n1)"
if [[ -z "$FFMPEG_SRC" || -z "$FFPROBE_SRC" ]]; then
  echo "ffmpeg.exe or ffprobe.exe not found in archive" >&2
  exit 1
fi

cp -f "$FFMPEG_SRC" "$BIN_DIR/ffmpeg-$TRIPLE.exe"
cp -f "$FFPROBE_SRC" "$BIN_DIR/ffprobe-$TRIPLE.exe"

echo "Installed:"
echo "  $BIN_DIR/ffmpeg-$TRIPLE.exe"
echo "  $BIN_DIR/ffprobe-$TRIPLE.exe"
