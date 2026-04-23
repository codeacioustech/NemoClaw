#!/usr/bin/env bash
# Cut a NemoClaw release.
#
# Usage:
#   ./release/release.sh <version> <artifacts-dir>
#
# Example:
#   ./release/release.sh 0.1.0 ./build/v0.1.0
#
# Requires:
#   - gh CLI (`brew install gh`) logged in with release rights on REPO
#   - shasum (macOS default)
#
# ─── SIGNING DISABLED (DEV MODE) ────────────────────────────────────────────
# The signing step is COMMENTED OUT below. To re-enable:
#   1. Uncomment the SK argument handling below.
#   2. Uncomment the `openssl pkeyutl -sign ...` line.
#   3. Add "$MANIFEST.sig" back to the `gh release create` upload list.
#   4. Paste the matching base64 public key into BUNDLED_PUBLIC_KEY_B64 in
#      mac-launcher/lib/update-check.js and uncomment the verify block there.
# ────────────────────────────────────────────────────────────────────────────

set -euxo pipefail

VERSION="${1:-}"
ARTIFACTS="${2:-}"
REPO="${NEMOCLAW_RELEASE_REPO:-codeacioustech/NemoClaw}"

# SIGNING DISABLED (DEV MODE) — private-key argument
# SK="${2:-}"
# ARTIFACTS="${3:-}"
# if [[ -z "$SK" ]]; then echo "usage: $0 <version> <sk.pem> <artifacts-dir>"; exit 2; fi
# [[ -f "$SK" ]] || { echo "no key: $SK"; exit 1; }

if [[ -z "$VERSION" || -z "$ARTIFACTS" ]]; then
  echo "usage: $0 <version> <artifacts-dir>"
  exit 2
fi
[[ -d "$ARTIFACTS" ]] || { echo "no dir: $ARTIFACTS"; exit 1; }

# refuse to run if gh isn't logged in
gh auth status >/dev/null

LOG="$ARTIFACTS/release.log"
exec > >(tee -a "$LOG") 2>&1

MANIFEST="$ARTIFACTS/manifest.json"
BASE_URL="https://github.com/$REPO/releases/download/v$VERSION"

{
  echo '{'
  echo "  \"version\": \"$VERSION\","
  echo "  \"releasedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo '  "ollamaModel": "qwen2.5:3b",'
  echo '  "components": ['
  first=1
  for f in "$ARTIFACTS"/*; do
    n=$(basename "$f")
    [[ "$n" == "manifest.json" || "$n" == "manifest.json.sig" || "$n" == "release.log" ]] && continue
    sha=$(shasum -a 256 "$f" | awk '{print $1}')
    size=$(stat -f%z "$f")
    [[ $first -eq 0 ]] && echo ","
    first=0
    printf '    {"name":"%s","kind":"artifact","sha256":"%s","size":%s,"url":"%s/%s"}' \
      "${n%%.*}" "$sha" "$size" "$BASE_URL" "$n"
  done
  echo
  echo '  ]'
  echo '}'
} > "$MANIFEST"

# SIGNING DISABLED (DEV MODE) — generate detached signature
# openssl pkeyutl -sign -inkey "$SK" -rawin -in "$MANIFEST" | base64 > "$MANIFEST.sig"

gh release create "v$VERSION" \
  --repo "$REPO" \
  --title "v$VERSION" \
  --notes "v$VERSION" \
  "$MANIFEST" \
  $(find "$ARTIFACTS" -maxdepth 1 -type f \
      ! -name manifest.json ! -name manifest.json.sig ! -name release.log)
# SIGNING DISABLED (DEV MODE) — to re-enable, add "$MANIFEST.sig" \ above the find line.

echo "Published v$VERSION to https://github.com/$REPO/releases/tag/v$VERSION"
