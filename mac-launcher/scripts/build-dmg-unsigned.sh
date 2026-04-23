#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Build a macOS .dmg installer for NemoClaw (UNSIGNED for dev testing).
#
# Usage:
#   cd mac-launcher && bash scripts/build-dmg-unsigned.sh
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

echo "==> Building $APP_NAME $VERSION .dmg (UNSIGNED)"

# Clean previous staging and output
rm -rf "$STAGE_DIR" "$DMG_PATH"
mkdir -p "$STAGE_DIR" "$DIST_DIR"

# Step 1: Build .app with electron-builder (no Ollama, slim deps).
echo "==> Step 1: Building .app bundle (SKIP_OLLAMA=1)..."
rm -rf "$PROJECT_DIR/resources/ollama-mac"
mkdir -p "$PROJECT_DIR/resources/ollama-mac"
touch "$PROJECT_DIR/resources/ollama-mac/.gitkeep"

SKIP_OLLAMA=1 npx electron-builder --mac --dir --config.mac.target=dir

# Locate the built .app
APP_PATH=""
for candidate in "$DIST_DIR/mac-arm64/$APP_NAME.app" "$DIST_DIR/mac/$APP_NAME.app" "$DIST_DIR/mac-universal/$APP_NAME.app"; do
  if [ -d "$candidate" ]; then
    APP_PATH="$candidate"
    break
  fi
done

if [ -z "$APP_PATH" ]; then
  echo "ERROR: Could not find built .app in $DIST_DIR"
  exit 1
fi

echo "==> Found app at: $APP_PATH"

# SKIP Step 1b: No codesigning for the unsigned build.
# We skip codesigning because sandboxed Electron apps require paid Apple
# Developer accounts (for provisioning profiles) to establish Mach port IPC.
echo "==> Skipping codesigning for dev build."

# Step 2: Stage the DMG layout
echo "==> Step 2: Staging DMG contents..."
cp -R "$APP_PATH" "$STAGE_DIR/$APP_NAME.app"
ln -s /Applications "$STAGE_DIR/Applications"

# Step 3: Create a compressed DMG
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
