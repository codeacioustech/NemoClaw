#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Build a signed .app + DMG for the Swift NemoClaw launcher.
#
# Requirements (host machine): macOS 14+, Xcode 15+, valid Apple Developer cert,
# a universal `node` binary placed at resources/node, and an optional OpenClaw
# JS payload at resources/openclaw/openclaw.mjs + node_modules/.
#
# Usage: bash scripts/build-app.sh [--notarize]
#
# Output: dist/NemoClaw-<version>.dmg

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

APP_NAME="NemoClaw"
VERSION="0.1.0"
IDENTITY="Apple Development: sanket@hr.codeacious.tech (AN98B8AJMS)"
ENT_MAIN="$PROJECT_DIR/Resources/entitlements.mac.plist"
ENT_INHERIT="$PROJECT_DIR/Resources/entitlements.mac.inherit.plist"
BUILD_DIR="$PROJECT_DIR/.build/release"
STAGE_DIR="$PROJECT_DIR/dmg-stage"
DIST_DIR="$PROJECT_DIR/dist"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"
DMG_PATH="$DIST_DIR/$APP_NAME-$VERSION.dmg"

NOTARIZE=0
[[ "${1:-}" == "--notarize" ]] && NOTARIZE=1

rm -rf "$APP_BUNDLE" "$DMG_PATH" "$STAGE_DIR"
mkdir -p "$DIST_DIR" "$STAGE_DIR"

echo "==> Step 1: Build Swift binary (release, universal)"
swift build -c release --arch arm64 --arch x86_64

echo "==> Step 2: Assemble .app bundle"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"
mkdir -p "$APP_BUNDLE/Contents/Frameworks"

cp "$BUILD_DIR/NemoClaw" "$APP_BUNDLE/Contents/MacOS/NemoClaw"
cp "$PROJECT_DIR/Resources/Info.plist" "$APP_BUNDLE/Contents/Info.plist"

# Bundled node for OpenClaw gateway subprocess.
if [ -f "$PROJECT_DIR/Resources/node" ]; then
  cp "$PROJECT_DIR/Resources/node" "$APP_BUNDLE/Contents/Frameworks/node"
  chmod +x "$APP_BUNDLE/Contents/Frameworks/node"
else
  echo "WARN: Resources/node not found — gateway subprocess will fail to start."
fi

# Optional: bundled OpenClaw JS payload.
if [ -d "$PROJECT_DIR/Resources/openclaw" ]; then
  cp -R "$PROJECT_DIR/Resources/openclaw" "$APP_BUNDLE/Contents/Resources/openclaw"
fi

# Optional: bundled Ollama (skip to keep DMG slim; app falls back to cached/system).
if [ -d "$PROJECT_DIR/Resources/ollama-mac" ]; then
  cp -R "$PROJECT_DIR/Resources/ollama-mac" "$APP_BUNDLE/Contents/Resources/ollama-mac"
fi

echo "==> Step 3: Sign helpers with inherit entitlements"
# Sign bundled node first so it has JIT-allowed entitlements inherited from the sandbox.
if [ -f "$APP_BUNDLE/Contents/Frameworks/node" ]; then
  codesign --force --options runtime --sign "$IDENTITY" \
    --entitlements "$ENT_INHERIT" \
    "$APP_BUNDLE/Contents/Frameworks/node"
fi

# Sign Ollama if bundled.
if [ -f "$APP_BUNDLE/Contents/Resources/ollama-mac/ollama" ]; then
  codesign --force --options runtime --sign "$IDENTITY" \
    --entitlements "$ENT_INHERIT" \
    "$APP_BUNDLE/Contents/Resources/ollama-mac/ollama"
fi

echo "==> Step 4: Sign the main app (hardened runtime)"
codesign --force --options runtime --sign "$IDENTITY" \
  --entitlements "$ENT_MAIN" \
  --deep "$APP_BUNDLE"

echo "==> Step 5: Verify signature"
codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"

if [ "$NOTARIZE" = "1" ]; then
  echo "==> Step 6: Notarize"
  ZIP="$DIST_DIR/$APP_NAME.zip"
  ditto -c -k --sequesterRsrc --keepParent "$APP_BUNDLE" "$ZIP"
  xcrun notarytool submit "$ZIP" --keychain-profile "NemoClawNotary" --wait
  xcrun stapler staple "$APP_BUNDLE"
  rm -f "$ZIP"
fi

echo "==> Step 7: Stage + create DMG"
cp -R "$APP_BUNDLE" "$STAGE_DIR/$APP_NAME.app"
ln -s /Applications "$STAGE_DIR/Applications"

hdiutil create \
  -volname "$APP_NAME $VERSION" \
  -srcfolder "$STAGE_DIR" \
  -ov -format UDZO -imagekey zlib-level=9 \
  "$DMG_PATH"

hdiutil verify "$DMG_PATH"
rm -rf "$STAGE_DIR"

echo ""
echo "Built: $DMG_PATH"
du -sh "$DMG_PATH"
