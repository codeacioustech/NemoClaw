#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

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
