#!/usr/bin/env bash
set -euo pipefail

OLLAMA_URL="https://github.com/ollama/ollama/releases/latest/download/ollama-darwin.tgz"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RESOURCES_DIR="${SCRIPT_DIR}/resources"
TARGET_DIR="${RESOURCES_DIR}/ollama-mac"

mkdir -p "${TARGET_DIR}"

echo "Downloading Ollama for macOS..."
curl -L "${OLLAMA_URL}" -o "${RESOURCES_DIR}/ollama-darwin.tgz"

echo "Extracting..."
tar -xzf "${RESOURCES_DIR}/ollama-darwin.tgz" -C "${TARGET_DIR}"

chmod +x "${TARGET_DIR}/ollama"

rm "${RESOURCES_DIR}/ollama-darwin.tgz"

echo "Ollama binaries ready at ${TARGET_DIR}"
ls -la "${TARGET_DIR}"
