#!/bin/bash
set -euo pipefail

# When SKIP_OLLAMA=1, skip the download entirely. Used by the PKG build
# pipeline so the Ollama binary is not bundled — the app downloads it on
# first launch instead, keeping the installer small.
if [ "${SKIP_OLLAMA:-}" = "1" ]; then
  echo "SKIP_OLLAMA=1 — skipping download (app will fetch on first launch)."
  exit 0
fi

OLLAMA_URL="https://github.com/ollama/ollama/releases/latest/download/ollama-darwin.tgz"
DEST="$(cd "$(dirname "$0")/.." && pwd)/resources/ollama-mac"

mkdir -p "$DEST"

if [ -f "$DEST/ollama" ]; then
  echo "Ollama binary already present at $DEST/ollama — skipping download."
  exit 0
fi

echo "Downloading Ollama for macOS (Apple Silicon)..."
curl -L "$OLLAMA_URL" -o "$DEST/ollama-darwin.tgz"

echo "Extracting..."
tar -xzf "$DEST/ollama-darwin.tgz" -C "$DEST"

chmod +x "$DEST/ollama"

rm "$DEST/ollama-darwin.tgz"

echo "Ollama binary ready at $DEST/ollama"
