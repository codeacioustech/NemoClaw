# NemoClaw Electron Installer — Claude Code Prompt

> **Copy everything below the line and paste it into Claude Code.**

---

## THE PROMPT

Build a cross-platform **Electron desktop installer** for **NVIDIA NemoClaw** in the directory `c:\Users\rrahu\Desktop\nemoclaw\` using **TypeScript** for both main and renderer processes. NemoClaw is NVIDIA's open-source reference stack that runs OpenClaw AI agents securely inside sandboxed environments. Currently it's installed via `curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash` — we're replacing that with a polished GUI wizard.

Full docs: https://docs.nvidia.com/nemoclaw/latest/

---

### TECH STACK

- **Framework**: Electron (latest)
- **Language**: TypeScript (both main process and renderer)
- **Build tool**: Vite (with `electron-vite` or manual config)
- **Styling**: Vanilla CSS (no Tailwind, no CSS frameworks)
- **UI**: No React/Vue/Angular — vanilla TS + DOM manipulation
- **Packaging**: electron-builder

---

### PROJECT SETUP

1. The EASIEST way to scaffold this is to run `npm create @quick-start/electron@latest .` and select **Vanilla** and **TypeScript**. This gives you a perfect `electron-vite` setup out of the box with the correct folder structure (`src/main`, `src/preload`, `src/renderer`).
2. Project structure (if using the template, adapt your code to it):

```
nemoclaw/
├── package.json
├── tsconfig.json                  # Root TS config
├── tsconfig.main.json             # Main process TS config (target: ES2022, module: CommonJS)
├── tsconfig.renderer.json         # Renderer TS config (target: ES2022, module: ESNext)
├── electron-builder.json
├── vite.config.ts
├── src/
│   ├── main/
│   │   ├── main.ts                # Electron main process entry
│   │   ├── preload.ts             # contextBridge for secure IPC
│   │   ├── ipc-handlers.ts        # All IPC handler logic
│   │   └── system-checks.ts       # OS/platform detection & prerequisite checks
│   ├── renderer/
│   │   ├── index.html             # App shell
│   │   ├── styles.css             # All styling
│   │   └── app.ts                 # Wizard logic & UI rendering
│   └── shared/
│       └── types.ts               # Shared TypeScript interfaces
├── assets/
│   └── icon.png                   # Placeholder (512x512 green square with "NC")
├── out/                           # electron-vite compiled output (gitignored)
└── dist/                          # electron-builder packaged app output (gitignored)
```

---

### SHARED TYPES (`src/shared/types.ts`)

Define these TypeScript interfaces used by both main and renderer:

```typescript
// System check result for each prerequisite
export interface SystemCheckResult {
  id: string;
  name: string;
  status: 'pass' | 'fail' | 'warn';
  value: string;
  message: string;
  fixUrl?: string;
  fixCommand?: string;
}

// Full system check response
export interface SystemCheckResponse {
  platform: NodeJS.Platform;
  checks: SystemCheckResult[];
  allPassed: boolean;
}

// User's install configuration from the wizard
export interface InstallConfig {
  provider: 'nvidia' | 'openai' | 'anthropic' | 'gemini';
  providerLabel: string;
  apiKey: string;
  sandboxName: string;
  modelName: string;
}

// Install progress event
export interface InstallOutputEvent {
  line: string;
  type: 'stdout' | 'stderr' | 'info' | 'error' | 'success';
}

// Install completion event
export interface InstallCompleteEvent {
  success: boolean;
  code: number | null;
  message: string;
}

// Exposed Electron API (for renderer)
export interface ElectronAPI {
  checkSystemRequirements: () => Promise<SystemCheckResponse>;
  validateApiKey: (provider: string, apiKey: string) => Promise<{valid: boolean, message?: string}>;
  runInstall: (config: InstallConfig) => Promise<void>;
  cancelInstall: () => Promise<void>;
  onInstallOutput: (callback: (event: InstallOutputEvent) => void) => void;
  onInstallComplete: (callback: (event: InstallCompleteEvent) => void) => void;
  removeInstallListeners: () => void;  // Clean up ipcRenderer.on listeners to prevent duplicates
  openExternalLink: (url: string) => Promise<void>;
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  closeWindow: () => void;
  getPlatform: () => string;
}

// Augment Window to include our API
declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
```

---

### MAIN PROCESS (`src/main/`)

#### `main.ts`
- Create a single BrowserWindow: **1000x700**, **frameless** (`frame: false`), **dark background** (`#0a0a0a`), `resizable: true`, `minWidth: 800`, `minHeight: 600`.
- Load the renderer's `index.html`.
- Use `preload.ts` for context isolation.
- Set `webPreferences`: `contextIsolation: true`, `nodeIntegration: false`.
- Register IPC handlers from `ipc-handlers.ts`.
- Handle window controls via IPC.

#### `preload.ts`
- Use `contextBridge.exposeInMainWorld('electronAPI', { ... })` to expose typed methods matching the `ElectronAPI` interface.
- Use `ipcRenderer.invoke` for request-response calls.
- Use `ipcRenderer.on` for streamed events (install output/complete).

#### `system-checks.ts`
Export `async function runSystemChecks(): Promise<SystemCheckResponse>` that checks:

| Check ID | Name | Detection | Pass Condition |
|----------|------|-----------|----------------|
| `os` | Operating System | `process.platform`, `os.release()` | Informational (always pass) |
| `nodejs` | Node.js | `node --version` shell exec | ≥ 20.0.0 |
| `npm` | npm | `npm --version` shell exec | ≥ 10.0.0 |
| `runtime` | Container Runtime | `docker info` retry | Check `docker info` (or `colima status`). Retry every 5 seconds for up to 60 seconds before failing, because Docker Desktop has a cold-start delay. *Podman on macOS is NOT supported.* |
| `wsl` | WSL2 (Win only) | `wsl --status` shell exec | WSL2 present with a distro |
| `cgroup` | cgroup v2 config | `docker info --format '{{.CgroupDriver}}'` | For WSL2/Ubuntu 24.04, Docker must have `default-cgroupns-mode: host` |
| `disk` | Disk Space | `df -h` or `wsl df -k /` | ≥ 20 GB free. **CRITICAL**: On Windows, you MUST execute `wsl df -k /` to check the actual WSL Linux disk, NOT the C:\ drive. |
| `ram` | System Memory | `os.totalmem()` | ≥ 8 GB |

Each returns a `SystemCheckResult`. For Windows WSL failures, include `fixCommand: 'wsl --install'` and `fixUrl`.
*Note: The `curl | bash` installation script handles installing OpenShell automatically, so you don't need a pre-installation check for it.*

#### `ipc-handlers.ts`
Register these via `ipcMain.handle` / `ipcMain.on`:

1. **`check-system-requirements`** → Runs `runSystemChecks()` and returns the result.
2. **`validate-api-key`** → Validates the provided API key before onboarding.
   - NVIDIA: GET `https://integrate.api.nvidia.com/v1/models` with Bearer token.
   - OpenAI: GET `https://api.openai.com/v1/models` with Bearer token.
   - Anthropic: Send a minimal messages request to `https://api.anthropic.com/v1/messages` with `x-api-key`.
   - Gemini: GET `https://generativelanguage.googleapis.com/v1beta/models?key=<apiKey>`
   - **TIMEOUT & RETRY**: Abort validation if a request takes longer than 5 seconds. Retry the request once before failing completely.
   - Return `{ valid: boolean, message?: string }` matching these specific error cases:
     - `401`/`403` → "Invalid API key"
     - `429` → "Rate limited or quota exceeded"
     - `5xx` → "Provider service temporarily unavailable"
     - `timeout` → "Network timeout while contacting provider"
3. **`run-install`** → The main installation handler. Details:
   - **IMPORTANT**: Use `child_process.spawn` (NOT `exec`) for all shell commands so that stdout/stderr stream line-by-line to the renderer. `exec` buffers the entire output and only returns it on completion, which breaks the real-time terminal UI in Step 5.
   - **SKIP IF ALREADY INSTALLED**: Before running the `curl | bash` installer, check if the CLI is already present:
     - Linux/macOS: `bash -l -c "nemoclaw --version"`
     - Windows: `wsl bash -l -c "nemoclaw --version"`
     If it succeeds, skip the CLI install step and go directly to `nemoclaw onboard`. This makes the installer idempotent and avoids `npm install -g` conflicts.
   - Commands to run (CLI install):
     - Linux/macOS: `bash -l -c "curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash"`
     - Windows: `wsl bash -l -c "curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash"`
   - **PATH REFRESH**: After CLI installation completes, re-check availability using a fresh login shell (e.g., `wsl bash -l -c "nemoclaw --version"`). Otherwise, the onboarding step might fail if the shell PATH wasn't automatically refreshed.
   - **NETWORK RETRY**: Retry the `curl` download up to 3 times before failing the installation. Network failures are common, especially on slower connections.
   - **STALE OUTPUT TIMEOUT**: Abort the installation if no stdout/stderr output is received for 120 seconds. This prevents the installer from hanging silently on DNS failures, mirror issues, or WSL networking problems.
   - **CRITICAL - NON-INTERACTIVE MODE**: After the CLI is installed, you must run `nemoclaw onboard`. This script is interactive by default. To make it work in an Electron child process, you MUST run it with the `--non-interactive` flag and pass the sandbox name:
     - Linux/macOS: `nemoclaw onboard --non-interactive --name <sandboxName>`
     - Windows: `wsl bash -l -c "nemoclaw onboard --non-interactive --name <sandboxName>"`
   - **CRITICAL - ENV VARIABLES**: You MUST also set the `NEMOCLAW_NON_INTERACTIVE=1` environment variable when spawning the process as a fallback.
   - **CRITICAL WSL FILESYSTEM GOTCHA**: On Windows, do NOT write `credentials.json` using Node's `fs.writeFileSync(os.homedir() + ...)` — that writes to the Windows `C:\Users\...` drive! You MUST write it to the WSL Linux filesystem inside `~/.nemoclaw/`. Do this by executing a command like `wsl bash -c "mkdir -p ~/.nemoclaw && cat > ~/.nemoclaw/credentials.json << 'EOF'
{"provider":"<provider>","api_key":"<apiKey>","model":"<modelName>"}
EOF"` *before* you run `nemoclaw onboard`.
   - **`credentials.json` SCHEMA**: The file must contain exactly this structure:
     ```json
     {
       "provider": "<provider>",
       "api_key": "<apiKey>",
       "model": "<modelName>"
     }
     ```
     Where `provider` is one of: `nvidia`, `openai`, `anthropic`, `gemini`. Do NOT invent additional fields.
   - **INSTALL LOG PERSISTENCE**: Write the full stdout/stderr installation output to `~/.nemoclaw/install.log` to help with debugging user machines later. On Windows, use a WSL command to write this.
   - Stream stdout/stderr line-by-line to renderer via `webContents.send('install-output', event: InstallOutputEvent)`.
   - On exit: send `webContents.send('install-complete', event: InstallCompleteEvent)`.
4. **`cancel-install`** → Kills the running child process.
5. **`open-external`** → `shell.openExternal(url)`.
6. **`window-minimize`**, **`window-maximize`**, **`window-close`** → Window controls.
7. **`remove-install-listeners`** → Removes all `install-output` and `install-complete` listeners from `webContents` to prevent duplicate events when re-running installation.

---

### RENDERER (`src/renderer/`)

#### Design System — `styles.css`

**Theme**: Premium dark mode, NVIDIA branding.

```
CSS Custom Properties:
  --nv-green: #76b900
  --nv-green-dark: #5a8f00
  --nv-green-light: #8fd400
  --bg-primary: #0a0a0a
  --bg-secondary: #141414
  --bg-tertiary: #1e1e1e
  --text-primary: #f0f0f0
  --text-secondary: #888888
  --text-muted: #555555
  --border: #2a2a2a
  --danger: #ff4444
  --warning: #ffaa00
  --success: #76b900

Typography:
  Font: 'Inter' from Google Fonts (fallback: system-ui, sans-serif)
  Monospace: 'JetBrains Mono' (for terminal output)

Visual Effects:
  - Glassmorphism cards: background rgba(20,20,20,0.8), backdrop-filter blur(20px), border 1px solid rgba(118,185,0,0.1)
  - Green glow on focus: box-shadow 0 0 0 2px rgba(118,185,0,0.3)
  - Transitions: all 0.3s cubic-bezier(0.4, 0, 0.2, 1)
  - Step transitions: slide + fade animations
```

**Custom Title Bar**: 40px height, draggable, min/max/close buttons on right. Close button red on hover.

**Step Progress Bar**: Horizontal stepper — 6 numbered circles connected by lines. Green filled = current/done, gray outline = future. Animated.

#### Wizard — `app.ts`

TypeScript class-based wizard with 6 steps. Use an enum for steps and a render method per step. Animate transitions.

---

**STEP 1: Welcome**
- Large NemoClaw heading with NVIDIA green accent
- Subtitle: "Secure AI Agent Deployment"
- Description paragraph about NemoClaw
- 4 feature bullets with green dot icons: Sandboxed execution, NVIDIA endpoint inference, Declarative network policy, Blueprint lifecycle management
- Large green "Get Started →" button with hover scale animation
- Footer: `v0.1.0-alpha · Docs · GitHub` (Docs → `https://docs.nvidia.com/nemoclaw/latest/`, GitHub → `https://github.com/NVIDIA/NemoClaw`, links open external)

---

**STEP 2: System Requirements Check**
- Auto-runs checks on entry, shows loading spinner
- Vertical list of check cards, each with: status icon (✅/⚠️/❌), name, detected value, message
- Failed items show "Fix" button (opens fixUrl or copies fixCommand)
- Bottom: green "Continue →" (disabled if any fail), "Re-check" button, small "Skip Checks" text link

---

**STEP 3: Inference Provider Config**
- Radio-card selection (green border when selected):
  - ◉ NVIDIA Endpoints (Recommended) — "nvidia/nemotron-3-super-120b-a12b via build.nvidia.com"
  - ○ OpenAI — "GPT models"
  - ○ Anthropic — "Claude models"
  - ○ Google Gemini — "Gemini models"
- API Key password input with show/hide toggle
- "Get API Key →" link (changes URL per provider)
- Note: "Your key is stored locally at ~/.nemoclaw/credentials.json"
- Back + Continue buttons (Continue triggers `validate-api-key` check with a spinner).
  - If validation fails, show the exact error message in red and replace "Continue" with "Retry". Do NOT clear the API key input.

---

**STEP 4: Sandbox Configuration**
- Sandbox name input with placeholder "my-assistant"
- Live RFC 1123 validation using this regex: `^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$` (lowercase alphanumeric + hyphens, must start/end with alphanumeric, max 63 chars). Auto-lowercase input.
- Green inline ✓ or red error message
- Summary card showing: Provider, Model, Sandbox Name, Security (Landlock + seccomp + netns)
- Back + "Begin Installation →" button

---

**STEP 5: Installation Progress**
- Animated gradient green progress bar with percentage
- "Current:" status text parsed from output
- Terminal output area: dark bg (#0e0e0e), monospace, auto-scroll, colored lines (green = success, red = error, white = normal)
- New lines fade in
- Elapsed timer (updates every second)
- "Cancel" button (confirms via dialog)
- Progress estimation from keywords:
  - "Installing Node" → 10%, "Installing OpenShell" → 30%, "Creating sandbox" → 50%, "Configuring inference" → 70%, "Applying policies" → 85%, "complete" → 100%
- Auto-advances to Step 6 on success. Shows "Retry" on error.

---

**STEP 6: Complete**
- Green checkmark animation (scale-in + pulse)
- "Installation Complete!" heading
- Summary card: Sandbox name, Model, Security, Status: Running
- Quick action grid (2×2):
  - 🔗 Connect → copies `nemoclaw <name> connect` to clipboard
  - 📊 Status → copies `nemoclaw <name> status`
  - 📋 Logs → copies `nemoclaw <name> logs --follow`
  - 📖 Docs → opens docs in browser
- Show tooltip "Copied to clipboard!" on click
- Command reference in monospace code blocks
- "Close Installer" button

---

### BUILD CONFIG

#### `electron-builder.json`
```json
{
  "appId": "com.nvidia.nemoclaw-installer",
  "productName": "NemoClaw Installer",
  "directories": { "buildResources": "build", "output": "dist" },
  "files": [
    "out/**/*"
  ],
  "extraResources": [
    "assets/**/*"
  ],
  "win": { "target": "nsis", "icon": "assets/icon.png" },
  "mac": { "target": "dmg", "icon": "assets/icon.png", "category": "public.app-category.developer-tools" },
  "linux": { "target": "AppImage", "icon": "assets/icon.png", "category": "Development" },
  "nsis": { "oneClick": true, "allowToChangeInstallationDirectory": false }
}
```

---

### CRITICAL RULES

1. **TypeScript everywhere** — main process AND renderer. Proper types, no `any`.
2. **No UI frameworks** — vanilla TS + DOM. Create elements via `document.createElement` or template literals with `innerHTML`.
3. **All styling in one `styles.css`** with CSS custom properties.
4. **Import Google Fonts** (Inter + JetBrains Mono) in `index.html`.
5. **Every interactive element needs a unique `id`** for testing.
6. **Premium look** — gradients, glassmorphism, smooth animations, micro-interactions. NOT barebones.
7. **Error handling** — every async call has try/catch with friendly messages.
8. **Terminal area** — real terminal feel: dark bg, green text for success, red for errors, white for normal.
9. **Shared types** — import from `../shared/types` in both main and renderer.
10. **Test by running `npm run dev`** after building everything.

---

### AFTER SETUP, RUN:

```bash
cd c:\Users\rrahu\Desktop\nemoclaw
npm install
npm run dev
```

Build everything in one go. Start with configs (package.json, tsconfigs, vite), then shared types, then main process, then renderer (CSS first, then HTML, then TS). Make sure `npm run dev` launches the Electron window successfully.
