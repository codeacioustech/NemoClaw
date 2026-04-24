# NemoClaw — Swift launcher

Native Swift rewrite of `../mac-launcher` (Electron). Lives alongside the
Electron build during migration; the Electron app stays shippable until the
Swift build reaches full parity.

## Layout

- `Sources/NemoClaw/` — SwiftUI app + native shims
  - `Bootstrap/` — first-run config seeding, boot sequence
  - `Config/` — paths, `launcher_config.json` schema
  - `Security/` — security-scoped bookmarks, Keychain credentials
  - `Process/` — Ollama + bundled-node (OpenClaw gateway) supervisor
  - `Net/` — inference proxy (11435), connector proxy (11437), gateway WS client
  - `Storage/` — GRDB-backed chat and workflow stores (shared DB file with Electron build)
  - `UI/` — splash, onboarding wizard, main split view, chat, workflows, folders
- `Resources/` — Info.plist, entitlements.mac.plist, entitlements.mac.inherit.plist
- `scripts/build-app.sh` — build + codesign + optional notarize + DMG
- `Resources/node` — **drop in** a universal macOS node binary here before building
  (see <https://nodejs.org/en/download> — used to run OpenClaw gateway as subprocess)
- `Resources/openclaw/` — **drop in** the OpenClaw JS payload here

## Building

Requires macOS 14+, Xcode 15+. On Linux this repo is source-only.

```bash
swift build                    # dev build
bash scripts/build-app.sh      # release + signed .app + DMG
bash scripts/build-app.sh --notarize   # also notarize + staple
```

## Install compatibility with Electron build

The Swift build is designed to coexist with an installed Electron NemoClaw:

- Bundle identifier `com.nemoclaw.launcher` and app-group
  `F94354ST5N.com.nemoclaw.launcher` are unchanged, so sandbox container and
  app-group Keychain items are shared.
- SQLite file at `~/Library/Application Support/NemoClaw/chat_history.db` is
  opened with the same schema (chat + workflow tables in one file).
- `~/.nemoclaw/launcher_config.json` schema v3 is read/written byte-compatibly.
- Security-scoped bookmarks persist through the switch (resolved via `URL(resolvingBookmarkData:)`).
- Plaintext entries in `~/.nemoclaw/credentials.json` are migrated to Keychain
  on first Swift launch. safeStorage-encrypted entries cannot be decrypted
  from native code (the key lives in Chromium's osCrypt namespace) — users
  must re-enter those credentials.
