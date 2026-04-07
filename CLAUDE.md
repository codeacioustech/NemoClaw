# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NemoClaw Electron Installer ("open-coot") — a cross-platform desktop GUI wizard that replaces the CLI-based `curl | bash` installation of NVIDIA's NemoClaw (open-source reference stack for running OpenClaw AI agents in sandboxed environments).

Full docs: https://docs.nvidia.com/nemoclaw/latest/

## Tech Stack

- **Framework**: Electron (latest), frameless window, dark theme
- **Language**: TypeScript (both main and renderer processes)
- **Build**: Vite via `electron-vite` template
- **Styling**: Vanilla CSS only (no Tailwind, no CSS frameworks)
- **UI**: Vanilla TypeScript + DOM manipulation (no React/Vue/Angular)
- **Packaging**: electron-builder
- **Package Manager**: npm

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Run in dev mode with hot reload
npm run build        # Compile TypeScript via electron-vite
npm run dist         # Build + package for current platform (outputs to dist/)
npm run dist:win     # Package for Windows (NSIS installer)
npm run dist:mac     # Package for macOS (DMG)
npm run dist:linux   # Package for Linux (AppImage)
```

No test framework or linter is configured. TypeScript compilation (`npm run build`) is the only validation step.

## Architecture

### Process Model (Electron)

```
src/main/              # Main process (Node.js)
  main.ts              # Window creation, IPC + config handler registration, mac bootstrap trigger
  ipc-handlers.ts      # IPC handlers: system checks, API key validation, install streaming, window controls
  system-checks.ts     # OS/platform detection & prerequisite checks
  config-service.ts    # Persistent AppConfig (JSON in userData dir), first-launch detection
  mac-bootstrap.ts     # macOS-only: silent first-launch bootstrap (Docker, NemoClaw, Ollama, model pull, sandbox)

src/preload/           # Preload script
  preload.ts           # contextBridge — exposes typed ElectronAPI to renderer

src/renderer/          # Renderer process (browser context)
  index.html           # App shell
  styles.css           # All styling (CSS custom properties, NVIDIA dark theme)
  router.ts            # Entry point — routes to wizard (Win/Linux) or bootstrap→onboarding→dashboard (macOS)
  app.ts               # 6-step wizard (Windows/Linux flow)
  bootstrap-view.ts    # macOS first-launch loading screen with progress stages
  onboarding-view.ts   # macOS post-bootstrap onboarding flow
  dashboard-view.ts    # macOS return-launch dashboard

src/shared/
  types.ts             # Shared TypeScript interfaces (SystemCheckResult, InstallConfig, BootstrapEvent, ElectronAPI, etc.)
```

### Platform-Specific UI Flows

The renderer `router.ts` is the entry point for all platforms:

- **Windows/Linux**: Loads the 6-step wizard (`app.ts`) — Welcome → System Check → Provider → Sandbox Config → Install → Complete
- **macOS first launch**: Shows bootstrap loading screen (`bootstrap-view.ts`) while main process silently installs Docker/NemoClaw/Ollama/model, then transitions to onboarding → dashboard
- **macOS return launch**: Skips to dashboard directly (config has `setupComplete: true`)

### IPC Communication

- **Renderer → Main**: `ipcRenderer.invoke` (request-response) for system checks, API key validation, install commands, config read/write
- **Main → Renderer**: `webContents.send` for streaming events (`install-output` line-by-line, `install-complete`, `bootstrap-progress`, `docker-missing`, `bootstrap-complete`)
- **Security**: `contextIsolation: true`, `nodeIntegration: false`, all APIs exposed via `contextBridge`

### TypeScript Configuration

Uses project references (`tsconfig.json` → `tsconfig.main.json`, `tsconfig.preload.json`, `tsconfig.renderer.json`). Each sub-config targets its respective Electron process.

### Renderer Dual-Root Pattern

The renderer has two DOM roots: `#app` (legacy wizard for Windows/Linux) and `#oc-root` (macOS bootstrap/onboarding/dashboard). `router.ts` toggles visibility between them based on platform. When adding new macOS views, mount under `#oc-root`; wizard changes go in `#app`.

### Config Persistence

`config-service.ts` stores `config.json` in Electron's `userData` directory (e.g., `~/Library/Application Support/NemoClaw Installer/` on macOS, `%APPDATA%/NemoClaw Installer/` on Windows). The `setupComplete` flag gates whether macOS shows bootstrap or dashboard on launch.

### Build Output

electron-vite compiles to `out/` (main, preload, renderer subdirs). electron-builder packages from `out/` into `dist/`. Config in `electron-builder.json`.

## Critical Conventions

### Windows WSL Handling
- All shell commands on Windows go through `wsl bash -l -c "command"` (see `getShellCmd` in `ipc-handlers.ts`)
- Write `credentials.json` to WSL filesystem (`~/.nemoclaw/`) via WSL command, NOT Node `fs` (which writes to Windows C:\)
- Check WSL disk with `wsl df -k /`, not Windows disk

### macOS Bootstrap Handling
- On macOS, `mac-bootstrap.ts` runs in the main process and communicates progress via `bootstrap-progress` IPC events
- Uses `bash -l -c` directly (not WSL) with `spawn` for all shell commands
- Ollama startup: tries `ollama serve` (detached) first, falls back to `open -a Ollama`, polls `localhost:11434`
- Model pull happens *before* `nemoclaw onboard` to avoid NemoClaw's 10-minute hardcoded timeout on large models
- Docker: if missing, sends `docker-missing` event to renderer which shows a modal; polls `docker info` every 5s for up to 2 minutes

### Process Spawning
- Always use `child_process.spawn` (NOT `exec`) for installation commands — `exec` buffers output and breaks real-time terminal streaming
- Set `NEMOCLAW_NON_INTERACTIVE=1` env var when spawning install processes
- Run `nemoclaw onboard --non-interactive` (sandbox name is set via `NEMOCLAW_SANDBOX_NAME` env var, not a CLI flag)

### API Key Validation
- 5-second timeout per request, retry once before failing
- Specific error mapping: 401/403 → "Invalid API key", 429 → "Rate limited", 5xx → "Service unavailable"
- Ollama provider skips validation entirely (no API key needed)

### Install Resilience
- Check if CLI already installed before running `curl | bash` (idempotent)
- Pre-install OpenShell via curl to bypass GitHub CLI (`gh auth`) requirement
- Set `npm_config_prefix` to `~/.npm-global` to fix macOS Homebrew EACCES errors
- Stale output timeout: kill process if no stdout/stderr for 180 seconds
- Command timeouts: 10 min per regular command, 15 min for long ops (model pull)

### Design System
- NVIDIA green: `#76b900`, dark backgrounds: `#0a0a0a` / `#141414` / `#1e1e1e`
- Fonts: Inter (UI), JetBrains Mono (terminal) — loaded from Google Fonts
- Glassmorphism cards with backdrop-filter blur, green glow on focus
- Every interactive element needs a unique `id`
- Frameless window with custom title bar (minimize/maximize/close buttons wired via IPC)
