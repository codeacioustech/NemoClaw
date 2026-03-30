# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NemoClaw Electron Installer — a cross-platform desktop GUI wizard that replaces the CLI-based `curl | bash` installation of NVIDIA's NemoClaw (open-source reference stack for running OpenClaw AI agents in sandboxed environments).

Full docs: https://docs.nvidia.com/nemoclaw/latest/

## Tech Stack

- **Framework**: Electron (latest), frameless window, dark theme
- **Language**: TypeScript (both main and renderer processes)
- **Build**: Vite via `electron-vite` template (`npm create @quick-start/electron@latest`)
- **Styling**: Vanilla CSS only (no Tailwind, no CSS frameworks)
- **UI**: Vanilla TypeScript + DOM manipulation (no React/Vue/Angular)
- **Packaging**: electron-builder
- **Package Manager**: npm

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Run in dev mode with hot reload
npm run build        # Compile TypeScript via electron-vite
npm run dist         # Package with electron-builder (outputs to dist/)
```

## Architecture

### Process Model (Electron)

```
src/main/           # Main process (Node.js)
  main.ts           # Window creation, IPC handler registration
  preload.ts        # contextBridge — exposes typed ElectronAPI to renderer
  ipc-handlers.ts   # All IPC handler logic (system checks, install, validation)
  system-checks.ts  # OS/platform detection & prerequisite checks

src/renderer/       # Renderer process (browser context)
  index.html        # App shell
  styles.css        # All styling (CSS custom properties, NVIDIA dark theme)
  app.ts            # 6-step wizard logic & UI rendering

src/shared/         # Shared between processes
  types.ts          # TypeScript interfaces (SystemCheckResult, InstallConfig, ElectronAPI, etc.)
```

### IPC Communication

- **Renderer → Main**: `ipcRenderer.invoke` (request-response) for system checks, API key validation, install commands
- **Main → Renderer**: `webContents.send` for streaming events (`install-output` line-by-line, `install-complete`)
- **Security**: `contextIsolation: true`, `nodeIntegration: false`, all APIs exposed via `contextBridge`

### Wizard Steps

1. Welcome — feature overview
2. System Requirements — auto-validates OS, Node.js, npm, Docker, WSL2, disk (20GB), RAM (8GB), cgroup v2
3. Inference Provider — radio card selection (NVIDIA/OpenAI/Anthropic/Gemini) + API key validation
4. Sandbox Config — name input with RFC 1123 validation (`^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$`)
5. Installation Progress — real-time terminal output streaming, progress bar, cancelable
6. Completion — success confirmation, quick action command grid

## Critical Conventions

### Windows WSL Handling
- All shell commands on Windows go through `wsl bash -l -c "command"`
- Write `credentials.json` to WSL filesystem (`~/.nemoclaw/`) via WSL command, NOT Node `fs` (which writes to Windows C:\)
- Check WSL disk with `wsl df -k /`, not Windows disk

### Process Spawning
- Always use `child_process.spawn` (NOT `exec`) for installation commands — `exec` buffers output and breaks real-time terminal streaming
- Set `NEMOCLAW_NON_INTERACTIVE=1` env var when spawning install processes
- Run `nemoclaw onboard --non-interactive --name <sandboxName>`

### API Key Validation
- 5-second timeout per request, retry once before failing
- Specific error mapping: 401/403 → "Invalid API key", 429 → "Rate limited", 5xx → "Service unavailable"

### Install Resilience
- Check if CLI already installed before running `curl | bash` (idempotent)
- Retry curl download up to 3 times
- Docker startup: retry `docker info` every 5 seconds for up to 60 seconds
- Abort if no stdout/stderr for 120 seconds (stale output timeout)

### Design System
- NVIDIA green: `#76b900`, dark backgrounds: `#0a0a0a` / `#141414` / `#1e1e1e`
- Fonts: Inter (UI), JetBrains Mono (terminal) — loaded from Google Fonts
- Glassmorphism cards with backdrop-filter blur, green glow on focus
- Every interactive element needs a unique `id`
