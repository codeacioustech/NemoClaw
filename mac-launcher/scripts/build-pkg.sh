#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Build a macOS .pkg installer for NemoClaw.
#
# The PKG is intentionally slim (~350-400 MB):
#   - Ollama binary is NOT bundled (downloaded on first app launch)
#   - Heavy unused node_modules are excluded by afterPack.js
#   - The Gemma 4 model is pulled on first launch via the splash screen
#
# Usage:
#   cd mac-launcher && bash scripts/build-pkg.sh
#
# Output:
#   dist/NemoClaw-<version>.pkg

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG_SCRIPTS="$SCRIPT_DIR/pkg-scripts"

cd "$PROJECT_DIR"

# Read version from package.json
VERSION=$(node -e "console.log(require('./package.json').version)")
APP_NAME="NemoClaw"
PKG_ID="com.nemoclaw.launcher"

BUILD_DIR="$PROJECT_DIR/pkg-build"
DIST_DIR="$PROJECT_DIR/dist"

echo "==> Building $APP_NAME $VERSION .pkg"

# Clean previous builds
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR" "$DIST_DIR"

# Step 1: Build .app with electron-builder (no Ollama, slim deps)
echo "==> Step 1: Building .app bundle (SKIP_OLLAMA=1)..."
# Ensure resources/ollama-mac is empty so it doesn't get bundled by electron-builder
rm -rf "$PROJECT_DIR/resources/ollama-mac"
mkdir -p "$PROJECT_DIR/resources/ollama-mac"
touch "$PROJECT_DIR/resources/ollama-mac/.gitkeep"

SKIP_OLLAMA=1 npx electron-builder --mac --dir --config.mac.target=dir

# Find the built .app — electron-builder puts it in dist/mac-arm64/ or dist/mac/
APP_PATH=""
for candidate in "$DIST_DIR/mac-arm64/$APP_NAME.app" "$DIST_DIR/mac/$APP_NAME.app" "$DIST_DIR/mac-universal/$APP_NAME.app"; do
  if [ -d "$candidate" ]; then
    APP_PATH="$candidate"
    break
  fi
done

if [ -z "$APP_PATH" ]; then
  echo "ERROR: Could not find built .app in $DIST_DIR"
  ls -la "$DIST_DIR/" 2>/dev/null || true
  exit 1
fi

echo "==> Found app at: $APP_PATH"

# Step 2: Create component package
echo "==> Step 2: Creating component package..."
pkgbuild \
  --root "$APP_PATH" \
  --identifier "$PKG_ID" \
  --version "$VERSION" \
  --install-location "/Applications/$APP_NAME.app" \
  --scripts "$PKG_SCRIPTS" \
  "$BUILD_DIR/$APP_NAME-component.pkg"

# Step 3: Create product archive with installer UI
echo "==> Step 3: Creating product archive..."
productbuild \
  --distribution "$PKG_SCRIPTS/distribution.xml" \
  --package-path "$BUILD_DIR" \
  --resources "$PKG_SCRIPTS/resources" \
  "$DIST_DIR/$APP_NAME-$VERSION.pkg"

# Cleanup intermediate build artifacts
rm -rf "$BUILD_DIR"

PKG_SIZE=$(du -sh "$DIST_DIR/$APP_NAME-$VERSION.pkg" | cut -f1)
echo ""
echo "==> Done! Built: $DIST_DIR/$APP_NAME-$VERSION.pkg ($PKG_SIZE)"
echo "    Ollama will be downloaded on first app launch."
echo "    Gemma 4 model will be pulled on first app launch."
