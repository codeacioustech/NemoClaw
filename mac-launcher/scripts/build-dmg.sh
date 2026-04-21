#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Build a macOS .dmg installer for NemoClaw.
#
# Mirrors build-pkg.sh's slimming strategy so the DMG ends up the same size
# (~350-400 MB) as the PKG it replaces:
#   - Ollama binary is NOT bundled (downloaded on first app launch)
#   - Heavy unused node_modules are excluded by afterPack.js
#   - The Gemma 4 model is pulled on first launch via the splash screen
#
# Drag-to-install model: user mounts the DMG and drags NemoClaw.app to
# /Applications. No postinstall script runs — the app self-initialises on
# first launch (creates ~/.nemoclaw with 700 perms via writeLauncherConfig,
# downloads Ollama, pulls Gemma 4, warms up the model).
#
# Usage:
#   cd mac-launcher && bash scripts/build-dmg.sh
#
# Output:
#   dist/NemoClaw-<version>.dmg

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

# Read version from package.json
VERSION=$(node -e "console.log(require('./package.json').version)")
APP_NAME="NemoClaw"
VOL_NAME="$APP_NAME $VERSION"

DIST_DIR="$PROJECT_DIR/dist"
STAGE_DIR="$PROJECT_DIR/dmg-stage"
DMG_PATH="$DIST_DIR/$APP_NAME-$VERSION.dmg"

echo "==> Building $APP_NAME $VERSION .dmg"

# Clean previous staging and output
rm -rf "$STAGE_DIR" "$DMG_PATH"
mkdir -p "$STAGE_DIR" "$DIST_DIR"

# Step 1: Build .app with electron-builder (no Ollama, slim deps).
# Identical invocation to build-pkg.sh so the .app contents are byte-equivalent.
echo "==> Step 1: Building .app bundle (SKIP_OLLAMA=1)..."
rm -rf "$PROJECT_DIR/resources/ollama-mac"
mkdir -p "$PROJECT_DIR/resources/ollama-mac"
touch "$PROJECT_DIR/resources/ollama-mac/.gitkeep"

SKIP_OLLAMA=1 npx electron-builder --mac --dir --config.mac.target=dir

# Locate the built .app (electron-builder output dir varies by arch)
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

# Step 2: Stage the DMG layout — the .app and an /Applications symlink so
# the user can drag-to-install without opening Finder twice.
echo "==> Step 2: Staging DMG contents..."
cp -R "$APP_PATH" "$STAGE_DIR/$APP_NAME.app"
ln -s /Applications "$STAGE_DIR/Applications"

# Step 3: Create a compressed DMG (UDZO = zlib, same compression family the
# PKG payload uses, so final size tracks the PKG closely).
echo "==> Step 3: Creating DMG (UDZO)..."
hdiutil create \
  -volname "$VOL_NAME" \
  -srcfolder "$STAGE_DIR" \
  -ov \
  -format UDZO \
  -imagekey zlib-level=9 \
  "$DMG_PATH"

# Step 4: Sanity-check the image
echo "==> Step 4: Verifying DMG..."
hdiutil verify "$DMG_PATH"

# Cleanup staging
rm -rf "$STAGE_DIR"

DMG_SIZE=$(du -sh "$DMG_PATH" | cut -f1)
echo ""
echo "==> Done! Built: $DMG_PATH ($DMG_SIZE)"
echo "    Drag NemoClaw.app to Applications to install."
echo "    Ollama will be downloaded on first app launch."
echo "    Gemma 4 model will be pulled on first app launch."
