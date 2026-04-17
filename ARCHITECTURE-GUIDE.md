# NVIDIA NemoClaw — Complete Architectural Analysis

## 1. High-Level Architecture

### What This Project Does

NemoClaw is an **open-source reference stack** by NVIDIA that runs [OpenClaw](https://openclaw.ai) AI agents inside [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) sandboxes. Think of it as a **secure harness** around an autonomous AI assistant:

```
┌──────────────────────────────────────────────────────────────────┐
│                        User's Machine                            │
│                                                                  │
│  ┌──────────────┐    ┌─────────────────────────────────────────┐ │
│  │  nemoclaw CLI │───▶│          NVIDIA OpenShell               │ │
│  │  (TypeScript) │    │  ┌───────────────────────────────────┐  │ │
│  └──────────────┘    │  │    Sandboxed Container (k3s)      │  │ │
│                       │  │  ┌─────────────┐ ┌─────────────┐ │  │ │
│                       │  │  │  OpenClaw    │ │  NemoClaw   │ │  │ │
│                       │  │  │  Gateway     │ │  Plugin     │ │  │ │
│                       │  │  │  (Agent AI)  │ │  (Security) │ │  │ │
│                       │  │  └──────┬──────┘ └─────────────┘ │  │ │
│                       │  │         │                         │  │ │
│                       │  │  ┌──────▼──────┐                 │  │ │
│                       │  │  │  L7 Proxy   │◀─ Network       │  │ │
│                       │  │  │  (Egress)   │   Policies      │  │ │
│                       │  │  └─────────────┘                 │  │ │
│                       │  └───────────────────────────────────┘  │ │
│                       └─────────────────────────────────────────┘ │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  Inference (one of):                                         │ │
│  │  • NVIDIA Build API (cloud)   • Ollama (local)               │ │
│  │  • OpenAI / Anthropic / Gemini (cloud)                       │ │
│  │  • NIM container (local GPU)  • vLLM (local GPU)             │ │
│  └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

**Purpose in the AI agent ecosystem**: Autonomous AI agents (like OpenClaw) need to run continuously, use tools, access the internet, and execute code. This is dangerous. NemoClaw provides the **security and orchestration layer** — it sandboxes the agent in a container with Landlock filesystem policies, network egress controls, credential isolation, and process limits. It's the difference between running an AI agent on your bare machine vs. running it in a locked-down vault.

### How Components Interact

| Component | Role | Communicates With |
|-----------|------|-------------------|
| **nemoclaw CLI** (`bin/nemoclaw.js`) | User-facing commands: onboard, start, stop, status, debug | OpenShell CLI, Docker, local filesystem |
| **OpenShell** (external) | Container runtime with security policies | k3s cluster, Docker, NemoClaw CLI |
| **NemoClaw Plugin** (`nemoclaw/src/index.ts`) | Runs *inside* the sandbox as an OpenClaw extension | OpenClaw gateway, blueprint state |
| **Blueprint** (`nemoclaw-blueprint/`) | Declarative sandbox definition (YAML) | Read by CLI during onboard, validated by plugin |
| **Inference providers** | Model API endpoints | Accessed through OpenShell's L7 proxy |
| **mac-launcher** (`mac-launcher/`) | Electron desktop app for macOS | Embeds Ollama + OpenClaw gateway locally |

### Runtime Flow (Installation to Execution)

```
install.sh → scripts/install.sh → npm install nemoclaw
    │
    ▼
nemoclaw onboard (interactive wizard)
    │
    ├── 1. Preflight: check Docker, memory, ports
    ├── 2. Host assessment: detect platform, GPU
    ├── 3. Select inference provider (cloud/local)
    ├── 4. Enter & validate credentials
    ├── 5. Select model
    ├── 6. Build sandbox image + OpenShell bootstrap
    ├── 7. Start NIM container (if local GPU)
    └── 8. Agent-specific setup → Gateway running on :18789
```

---

## 2. Execution Flow (Step-by-Step)

### What happens when `install.sh` runs

1. **Bootstrap detection** — `install.sh` (lines 1-30) checks for `NEMOCLAW_VERSIONED_INSTALLER_PAYLOAD` marker. If absent, it clones the repo at the specified git tag and re-executes `scripts/install.sh`.

2. **Environment validation** — `scripts/install.sh` checks:
   - Node.js >= 22.16, npm >= 10
   - Docker running and accessible
   - Sufficient disk space and RAM

3. **Dependency installation** — Installs OpenShell via `scripts/install-openshell.sh`, then `npm install -g nemoclaw`.

4. **Onboarding launch** — Automatically runs `nemoclaw onboard`.

### How Onboarding Works

The onboarding wizard lives in `src/lib/onboard.ts` (~1000 lines). It's a **resumable, session-tracked 8-step pipeline**:

**Session tracking** (`src/lib/onboard-session.ts`): Each step's state is persisted to `~/.nemoclaw/onboard-session.json` with file-based locking (atomic `mkdir`). If the process crashes at step 5, `nemoclaw onboard --resume` picks up from there.

| Step | What happens | Key file |
|------|-------------|----------|
| 1 | Port availability (18789, 8080) | `src/lib/preflight.ts` |
| 2 | Host assessment: Docker, memory, swap, platform | `src/lib/preflight.ts`, `src/lib/platform.ts` |
| 3 | Inference provider selection (interactive menu) | `src/lib/inference-config.ts` |
| 4 | Credential entry + API key validation | `src/lib/credentials.ts`, `src/lib/validation.ts` |
| 5 | Model selection from provider catalog | `src/lib/model-prompts.ts` |
| 6 | Sandbox image build via OpenShell | `Dockerfile`, `Dockerfile.base` |
| 7 | NIM container start (if GPU detected) | `src/lib/nim.ts` |
| 8 | Agent setup: write config, health probe, gateway start | `src/lib/agent-onboard.ts` |

### How the CLI Initializes

`bin/nemoclaw.js` is a 7-line shim:

```javascript
#!/usr/bin/env node
require("../dist/nemoclaw");
```

This loads the compiled `src/nemoclaw.ts` (1634 lines), which:

1. Parses `process.argv` to extract the command
2. Divides commands into **global** (`onboard`, `list`, `deploy`, `start`, `stop`, `status`, `debug`, `credentials`) and **sandbox-scoped** (`connect`, `status`, `logs`, `policy-add`, `policy-list`, `destroy`, `skill`)
3. For sandbox-scoped commands, recovers registry state from live OpenShell if needed
4. Dispatches to the appropriate handler function

### How Model Inference Is Triggered

Inference doesn't happen in NemoClaw directly — it's **configured** by NemoClaw and **executed** by OpenClaw:

1. During onboard, NemoClaw writes the inference profile into the OpenClaw config (`nemoclaw-blueprint/blueprint.yaml`, lines 38-69)
2. The NemoClaw plugin (`nemoclaw/src/index.ts`) registers as an inference provider with OpenClaw
3. OpenClaw routes model calls through the configured endpoint (NVIDIA Build API, Ollama, etc.)
4. Network policies in the sandbox control which inference endpoints the agent can reach

---

## 3. Folder-by-Folder Explanation

### `bin/` — CLI Launcher Layer

**Language**: CommonJS JavaScript
**Purpose**: Stable entry point + shim layer that bridges to compiled TypeScript

| File | Role |
|------|------|
| `bin/nemoclaw.js` | `#!/usr/bin/env node` — the `nemoclaw` command. Just `require("../dist/nemoclaw")` |
| `bin/lib/agent-defs.js` | Re-exports from `dist/lib/agent-defs` |
| `bin/lib/credentials.js` | Re-exports with dynamic getters for `CREDS_DIR`/`CREDS_FILE` |
| `bin/lib/ports.js` | Port constants with env-var overrides |
| `bin/lib/nim-images.json` | Hardcoded NIM model catalog (5 NVIDIA models with GPU memory requirements) |
| `bin/lib/usage-notice.js` | Third-party software notice (can run standalone) |

**Why CommonJS?** The launcher must be a stable, synchronous `require()` chain. ESM's async `import()` adds startup latency and complicates the shebang entry point.

### `src/` — Core CLI Logic

**Language**: TypeScript (compiles to `dist/` via `tsconfig.src.json`)
**Purpose**: All CLI business logic — onboarding, credentials, inference, policies, runner

79 TypeScript files organized by concern:

| Module Group | Files | Purpose |
|-------------|-------|---------|
| **Onboarding** | `onboard.ts`, `onboard-command.ts`, `onboard-session.ts`, `onboard-types.ts` | The 8-step wizard, session persistence, CLI flag parsing |
| **Credentials** | `credentials.ts`, `secret-patterns.ts` | `~/.nemoclaw/credentials.json` (0o600 perms), redaction patterns |
| **Inference** | `inference-config.ts`, `local-inference.ts`, `model-prompts.ts`, `provider-models.ts` | Provider configs (NVIDIA, OpenAI, Anthropic, Gemini, Ollama, vLLM) |
| **Policies** | `policies.ts`, `tiers.ts` | Read YAML presets, apply via OpenShell |
| **Validation** | `validation.ts`, `validation-recovery.ts`, `preflight.ts` | Error classification, host checks, retry strategies |
| **Registry** | `registry.ts`, `runtime-recovery.ts` | `~/.nemoclaw/sandboxes.json` tracking, live state sync |
| **Agent** | `agent-defs.ts`, `agent-runtime.ts`, `agent-onboard.ts` | Multi-agent support (OpenClaw + Hermes) |
| **Infrastructure** | `runner.ts`, `platform.ts`, `ports.ts`, `resolve-openshell.ts`, `openshell.ts` | Shell execution with redaction, platform detection, port config |
| **Services** | `services.ts`, `services-command.ts`, `skill-install.ts` | Telegram bridge, tunnels, skill deployment |
| **Diagnostics** | `debug.ts`, `debug-command.ts`, `version.ts` | Debug tarball generation, version resolution |

### `nemoclaw/` — OpenClaw Plugin

**Language**: TypeScript (separate npm project with its own `package.json`)
**Purpose**: Runs **inside** the sandbox as an OpenClaw extension

This is the part that lives within the sandboxed agent. It has 3 subsystems:

#### `nemoclaw/src/blueprint/` — Sandbox Lifecycle

| File | Purpose |
|------|---------|
| `runner.ts` | Orchestrates plan → apply → status → rollback lifecycle |
| `snapshot.ts` | Captures host OpenClaw config, strips credentials, creates tar archives |
| `ssrf.ts` | Validates endpoint URLs against private network ranges (IPv4 + IPv6) |
| `state.ts` | Persists deployment state to `~/.nemoclaw/state/nemoclaw.json` |

#### `nemoclaw/src/commands/` — Chat Commands

| File | Purpose |
|------|---------|
| `slash.ts` | `/nemoclaw status`, `/nemoclaw eject`, `/nemoclaw onboard` in chat |
| `migration-state.ts` | 917-line module handling host detection and migration snapshots |

#### `nemoclaw/src/onboard/` — Plugin Config

| File | Purpose |
|------|---------|
| `config.ts` | `~/.nemoclaw/config.json` — stores endpoint type, model, credentials |

#### `nemoclaw/src/security/` — Secret Scanner

| File | Purpose |
|------|---------|
| `secret-scanner.ts` | 15 regex patterns detecting API keys; blocks writes to memory paths |

#### `nemoclaw/src/index.ts` — Plugin Registration

Registers with OpenClaw:

1. `/nemoclaw` slash command
2. NVIDIA NIM inference provider
3. Before-tool-call hook that scans for leaked secrets

### `nemoclaw-blueprint/` — Blueprint Definition

**Language**: YAML + Python (for docs tooling)
**Purpose**: Declarative sandbox specification

| Path | Purpose |
|------|---------|
| `blueprint.yaml` | Master definition: version pins, inference profiles, sandbox image digest |
| `policies/openclaw-sandbox.yaml` | Base security policy (filesystem, network, process) |
| `policies/tiers.yaml` | 3 tiers: `restricted`, `balanced`, `open` |
| `policies/presets/` | Per-service policies: slack.yaml, discord.yaml, npm.yaml, brave.yaml, etc. |

### `agents/` — Agent Definitions

**Language**: YAML manifests + Dockerfiles
**Purpose**: Pluggable agent runtimes beyond just OpenClaw

| Agent | Language | Health Probe | Port |
|-------|----------|-------------|------|
| `agents/openclaw/` | Node.js | `:18789/` | 18789 |
| `agents/hermes/` | Python | `:8642/health` | 8642 |

Each agent has a `manifest.yaml` declaring: install method, health check, config paths, state directories, messaging platforms, inference config.

### `mac-launcher/` — macOS Desktop App

**Language**: JavaScript (Electron 37)
**Purpose**: One-click macOS experience — bundles Ollama + OpenClaw in an Electron app

| File | Purpose |
|------|---------|
| `index.js` | 523-line main process: splash screen → bootstrap 7-step startup |
| `lib/ollama-proxy.js` | HTTP proxy on :11435 that filters tools and injects system prompts for small models |
| `lib/config-seeder.js` | Seeds openclaw.json on first run |
| `lib/gateway.js` | Spawns OpenClaw gateway process |
| `lib/paths.js` | Resolves bundled binary locations (dev vs. packaged) |
| `lib/cleanup.js` | Graceful shutdown: SIGTERM → 5s → SIGKILL |

### `scripts/` — Automation and Helpers

**Language**: Bash, JavaScript, TypeScript
**Purpose**: Install, setup, testing, CI helpers

| Script | Purpose |
|--------|---------|
| `scripts/install.sh` | Main versioned installer (3-step: env check → deps → setup) |
| `scripts/nemoclaw-start.sh` | **Container entrypoint** — the most security-critical script (~400 lines) |
| `scripts/install-openshell.sh` | OpenShell binary installer |
| `scripts/start-services.sh` | Cloudflared tunnel + auxiliary services |
| `scripts/lib/runtime.sh` | Shared utilities: Docker socket detection, port validation |
| `scripts/test-inference.sh` | Inference validation |

### `docs/` — User Documentation

**Language**: Markdown (MyST/Sphinx)
**Purpose**: Published to docs.nvidia.com/nemoclaw

Sections: `about/`, `get-started/`, `inference/`, `network-policy/`, `deployment/`, `monitoring/`, `reference/`, `security/`, `workspace/`

### `k8s/` — Kubernetes Deployment

**Language**: YAML
**Purpose**: Deploy NemoClaw in a Kubernetes cluster with Docker-in-Docker

`k8s/nemoclaw-k8s.yaml` creates a pod with: DinD sidecar (privileged), workspace container (runs installer), init container (cgroup v2 config), socat bridge for cross-cluster inference.

### `schemas/` — JSON Schema Validation

**Language**: JSON Schema
**Purpose**: Validates YAML/JSON config files at build and runtime

Schemas for: `blueprint.schema.json`, `sandbox-policy.schema.json`, `onboard-config.schema.json`, `openclaw-plugin.schema.json`, `policy-preset.schema.json`

---

## 4. Entry Points

| Entry Point | File | What It Does |
|-------------|------|-------------|
| **CLI command** | `bin/nemoclaw.js` → `src/nemoclaw.ts` | Main user-facing entry. Dispatches all `nemoclaw <command>` invocations |
| **Installer** | `install.sh` → `scripts/install.sh` | `curl \| bash` bootstrap that installs everything |
| **Container entrypoint** | `scripts/nemoclaw-start.sh` | Runs inside sandbox: hardens environment, starts gateway |
| **Plugin registration** | `nemoclaw/src/index.ts` | Called by OpenClaw when loading the NemoClaw plugin |
| **macOS app** | `mac-launcher/index.js` | Electron `main` process |
| **Build** | `npm run build:cli` → `tsc -p tsconfig.src.json` | Compiles `src/` → `dist/` |

**Bootstrap chain**: `bin/nemoclaw.js` → `require("../dist/nemoclaw")` → `src/nemoclaw.ts` which imports 20+ modules from `src/lib/` and dispatches based on `process.argv`.

---

## 5. Language Responsibilities

### TypeScript Handles

- **All CLI logic** — `src/` compiles to `dist/` (CommonJS, ES2022 target)
- **The OpenClaw plugin** — `nemoclaw/src/` (ESM)
- **Blueprint orchestration** — plan, apply, rollback, snapshot
- **Security** — SSRF validation, secret scanning, credential sanitization
- **State management** — registry, session, config I/O

### Python Handles

- **Documentation build** — Sphinx/MyST (`pyproject.toml` declares `nemoclaw-docs`)
- **Inline scripts in Dockerfile** — Config generation uses Python because direct ARG interpolation in shell is a code injection vector (security decision C-2)
- **Docs-to-skills generation** — `scripts/docs-to-skills.py`

### Bash Handles

- **Installation** — `install.sh`, `scripts/install.sh`
- **Container entrypoint** — `scripts/nemoclaw-start.sh` (security hardening)
- **Runtime utilities** — `scripts/lib/runtime.sh` (Docker detection, port checks)
- **E2E tests** — `test/e2e/` (16,000+ line test suites)

### How They Communicate

```
TypeScript CLI ──execFileSync──▶ Bash scripts (install, start)
TypeScript CLI ──execFileSync──▶ openshell CLI (sandbox management)
TypeScript CLI ──execFileSync──▶ docker CLI (NIM container management)
Bash entrypoint ──exec──▶ openclaw gateway run (Node.js process)
OpenClaw gateway ──import──▶ NemoClaw plugin (TypeScript, in-process)
Dockerfile ──python3 -c──▶ Inline Python (config generation)
```

There's no HTTP/RPC between TS and Python — they're in separate build stages. The TS↔Bash communication is all via child process exec.

---

## 6. Model Orchestration

### How LLMs Are Selected

**Provider selection** happens during onboarding in `src/lib/inference-config.ts`:

```typescript
// The 7 supported providers:
DEFAULT_CLOUD_MODEL = "nvidia/nemotron-3-super-120b-a12b"
DEFAULT_OLLAMA_MODEL = "nemotron-3-nano:30b"

// Provider configs for: Build, OpenAI, Anthropic, Gemini, vLLM, Ollama
getProviderSelectionConfig(provider, model) → ProviderSelectionConfig
```

The user picks a provider interactively (or via `--non-interactive` flags), and NemoClaw writes the selection into the blueprint profile.

### How Inference Routing Works

**Inside the sandbox**, OpenClaw reaches the model via an **internal route URL**:

```
INFERENCE_ROUTE_URL = "https://inference.local/v1"  (container-internal)
```

OpenShell's L7 proxy intercepts this and routes it to the actual endpoint based on the blueprint profile:

| Profile | Actual Endpoint | How It Gets There |
|---------|----------------|-------------------|
| `default` | `https://integrate.api.nvidia.com/v1` | L7 proxy → internet |
| `ncp` | Dynamic NVIDIA Cloud Partner endpoint | L7 proxy → internet |
| `nim-local` | `http://nim-service.local:8000/v1` | L7 proxy → host NIM container |
| `vllm` | `http://localhost:8000/v1` | L7 proxy → host vLLM server |
| `ollama` | `http://127.0.0.1:11434` | Direct (mac-launcher only) |

### Where Configuration Decisions Happen

1. **Blueprint** (`nemoclaw-blueprint/blueprint.yaml`) — pins model, endpoint, provider type per profile
2. **Onboard config** (`~/.nemoclaw/config.json`) — user's chosen provider/model
3. **Plugin config** (`nemoclaw/openclaw.plugin.json`) — default blueprint registry, sandbox name
4. **Runtime overrides** (env vars in container): `NEMOCLAW_MODEL_OVERRIDE`, `NEMOCLAW_INFERENCE_API_OVERRIDE`

### Local vs Remote Models

| Local | Remote |
|-------|--------|
| **NIM**: Docker container with NVIDIA GPU, auto-detected via `nvidia-smi`. Managed by `src/lib/nim.ts`. Models from `bin/lib/nim-images.json` | **NVIDIA Build**: `integrate.api.nvidia.com/v1` with `nvapi-` API key |
| **Ollama**: Pre-installed or installed by `scripts/install.sh`. Health-checked via `src/lib/local-inference.ts` | **OpenAI/Anthropic/Gemini**: Standard API endpoints with user-provided keys |
| **vLLM**: User-managed, NemoClaw just configures the endpoint | |

GPU detection (`src/lib/nim.ts`):

```typescript
detectGpu() → { available: boolean, memoryMB: number, devices: string[] }
// Uses nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits
```

---

## 7. Security Architecture

This is where NemoClaw's core value proposition lives. Security is layered at 5 levels:

### Layer 1: Container Isolation (Dockerfile)

`Dockerfile` and `Dockerfile.base` build a hardened image:

- **Privilege separation**: `gateway` user (nologin) runs the gateway; `sandbox` user runs the agent
- **Immutable config**: `openclaw.json` hash-verified at startup, `chattr +i` flag, root-owned
- **Compiler removal**: gcc, g++, cpp, make stripped from production image
- **Dangerous tool removal**: netcat removed to prevent reverse shells

### Layer 2: Process and Capability Hardening (`scripts/nemoclaw-start.sh`)

The container entrypoint drops capabilities and limits processes:

```bash
# Fork bomb protection
ulimit -u 512

# Drop dangerous Linux capabilities
capsh --drop=cap_net_raw,cap_dac_override,cap_sys_chroot,cap_fsetid,
       cap_setfcap,cap_mknod,cap_audit_write,cap_net_bind_service
```

PATH is locked to system directories. Tool caches (npm, pip, git) are redirected to `/tmp/` to prevent persistent state pollution.

### Layer 3: Filesystem Isolation (Landlock + DAC)

Defined in `nemoclaw-blueprint/policies/openclaw-sandbox.yaml`:

```yaml
filesystem_policy:
  read_only:
    - /sandbox/.openclaw      # Immutable gateway config
    - /usr, /lib, /proc       # System directories
  read_write:
    - /tmp                    # Scratch space
    - /sandbox/.openclaw-data # Agent writable state
    - /sandbox/.nemoclaw      # Plugin state (sticky bit protected)
```

Landlock (Linux kernel MAC) enforces this at the kernel level. DAC (chmod/chown) provides defense-in-depth.

### Layer 4: Network Egress Control

OpenShell provides an L7 (HTTP-level) proxy. NemoClaw configures what the agent can reach:

**Tiers** (`nemoclaw-blueprint/policies/tiers.yaml`):

- `restricted` — Only inference endpoint + OpenClaw telemetry
- `balanced` — + npm, PyPI, HuggingFace, Brave search, GitHub
- `open` — + Slack, Discord, Telegram, Jira, Outlook

**Presets** (`nemoclaw-blueprint/policies/presets/`): Granular per-service policies with HTTP method/path restrictions:

```yaml
# Example: Brave search preset allows only search queries
endpoints:
  - host: api.search.brave.com
    port: 443
    rules: [allow GET /res/v1/web/search**]
```

### Layer 5: Secret Protection (Plugin-Level)

The NemoClaw plugin's before-tool-call hook (`nemoclaw/src/security/secret-scanner.ts`) scans every write operation:

- 15 regex patterns (NVIDIA, OpenAI, GitHub, AWS, Slack, Discord, Telegram tokens...)
- Blocks writes to persistent memory paths (`.openclaw-data/memory/`, `.openclaw-data/credentials/`, etc.)
- Redacted snippet shown: first 4 + last 4 characters

Host-side, `src/lib/secret-patterns.ts` and `src/lib/runner.ts` redact secrets from all CLI output.

### SSRF Protection

`nemoclaw/src/blueprint/ssrf.ts` validates user-provided inference endpoints:

- DNS-resolves hostname
- Checks all resolved addresses against private ranges (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, etc.)
- Covers IPv4-mapped IPv6 (`::ffff:x.x.x.x`)
- Only allows `http://` and `https://` schemes

---

## 8. Configuration System

### Where Configs Live

| Config | Location | Format | Purpose |
|--------|----------|--------|---------|
| Blueprint | `nemoclaw-blueprint/blueprint.yaml` | YAML | Sandbox definition: image, profiles, policies |
| Sandbox policy | `nemoclaw-blueprint/policies/` | YAML | Filesystem + network + process rules |
| Plugin manifest | `nemoclaw/openclaw.plugin.json` | JSON | Plugin metadata + config schema |
| User credentials | `~/.nemoclaw/credentials.json` | JSON (0o600) | API keys per provider |
| Onboard session | `~/.nemoclaw/onboard-session.json` | JSON (locked) | Step-by-step progress tracking |
| Sandbox registry | `~/.nemoclaw/sandboxes.json` | JSON (locked) | Tracks created sandboxes |
| Onboard config | `~/.nemoclaw/config.json` | JSON | User's provider/model selection |
| Deployment state | `~/.nemoclaw/state/nemoclaw.json` | JSON | Last run ID, action, snapshot |
| Agent manifests | `agents/*/manifest.yaml` | YAML | Per-agent definitions |
| NIM catalog | `bin/lib/nim-images.json` | JSON | NVIDIA model images + GPU requirements |
| Port config | `src/lib/ports.ts` | TS (env override) | Dashboard=18789, Gateway=8080, vLLM=8000, Ollama=11434 |

### How Configs Are Loaded

1. **Blueprint** — `nemoclaw/src/blueprint/runner.ts` `loadBlueprint()` reads from `NEMOCLAW_BLUEPRINT_PATH` env var or current directory
2. **Credentials** — `src/lib/credentials.ts` `loadCredentials()` checks env vars first, falls back to disk
3. **Agent defs** — `src/lib/agent-defs.ts` `loadAgent(name)` reads `agents/<name>/manifest.yaml`
4. **Policies** — `src/lib/policies.ts` `listPresets()` enumerates `nemoclaw-blueprint/policies/presets/*.yaml`
5. **Tiers** — `src/lib/tiers.ts` `getTier(name)` reads `nemoclaw-blueprint/policies/tiers.yaml`

### Runtime Behavior Changes

**Environment variable overrides** (inside container):

| Variable | Effect |
|----------|--------|
| `NEMOCLAW_MODEL_OVERRIDE` | Switch model without rebuild |
| `NEMOCLAW_INFERENCE_API_OVERRIDE` | Switch API type (openai-completions, anthropic-messages) |
| `NEMOCLAW_CONTEXT_WINDOW` | Model context window size |
| `NEMOCLAW_MAX_TOKENS` | Max output tokens |
| `NEMOCLAW_CORS_ORIGIN` | Add browser origin for CORS |
| `NEMOCLAW_DASHBOARD_PORT` | Override default 18789 |

All overrides are validated for injection; the config hash is recomputed after applying them.

---

## 9. Real Execution Trace

Here's exactly what happens when a user runs NemoClaw for the first time:

### Phase 1: Install

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

1. `install.sh` downloads the repo at the latest tag
2. `scripts/install.sh` checks Node.js, npm, Docker
3. Installs OpenShell: `scripts/install-openshell.sh` → downloads binary to `/usr/local/bin/openshell`
4. `npm install -g nemoclaw` → creates `nemoclaw` in PATH
5. Auto-triggers `nemoclaw onboard`

### Phase 2: Onboard

```
nemoclaw onboard
```

6. `src/lib/onboard-command.ts` parses flags, creates onboard session
7. `src/lib/usage-notice.ts` shows third-party software notice, requires acceptance
8. **Step 1**: `src/lib/preflight.ts` probes ports 18789, 8080 — exits if in use
9. **Step 2**: Detects Docker (socket location via `src/lib/platform.ts`), checks RAM (>=8GB), checks swap
10. **Step 3**: Interactive prompt: "Choose inference provider" → user picks NVIDIA Build
11. **Step 4**: Prompts for `nvapi-XXXX` API key → validates prefix → saves to `~/.nemoclaw/credentials.json` (mode 0o600)
12. **Step 5**: Shows model list → user picks `nvidia/nemotron-3-super-120b-a12b`
13. **Step 6**: Builds sandbox image:
    - `openshell gateway start` (creates k3s cluster)
    - Docker builds `Dockerfile.base` (Node 22, Python 3.11, OpenClaw, gosu)
    - Docker builds `Dockerfile` (NemoClaw plugin, blueprint, config generation)
    - `openshell sandbox create` pushes image to cluster
14. **Step 7**: No GPU detected → skips NIM
15. **Step 8**: Writes OpenClaw config, starts gateway, health-probes `:18789/`

### Phase 3: Configure (inside container)

```
# Inside the sandbox (automatic):
scripts/nemoclaw-start.sh
```

16. `scripts/nemoclaw-start.sh` runs as PID 1:
    - `ulimit -u 512` (fork bomb protection)
    - Drops 8 Linux capabilities
    - Locks PATH
    - Redirects tool caches to `/tmp/`
    - Verifies `openclaw.json` SHA-256 hash
    - Writes auth profile with API key
    - Sets `chattr +i` on immutable dirs
    - Starts auto-pairing daemon

### Phase 4: Launch

17. `gosu gateway openclaw gateway run` starts the OpenClaw gateway as the `gateway` user
18. OpenClaw loads the NemoClaw plugin from `openclaw.plugin.json`
19. Plugin registers: `/nemoclaw` command, NVIDIA inference provider, secret-scanning hook
20. Gateway binds to `:18789`, prints dashboard URL

### Phase 5: Run Agent

21. User visits `http://localhost:18789` (or pairs via CLI)
22. User sends a message → OpenClaw routes to the configured model (NVIDIA Build API)
23. Every tool call (file writes, code execution) passes through the NemoClaw secret scanner
24. Every network request passes through OpenShell's L7 proxy, checked against active policies

---

## 10. Developer Mental Model

Think of NemoClaw as **three concentric rings**:

```
┌─────────────────────────────────────────────────────┐
│  RING 3: HOST MACHINE                               │
│  ┌──────────────────────────────────────────────┐   │
│  │  nemoclaw CLI (TypeScript)                   │   │
│  │  • Onboarding wizard                         │   │
│  │  • Sandbox lifecycle (create/start/stop)      │   │
│  │  • Credential management                      │   │
│  │  • State: ~/.nemoclaw/                        │   │
│  │                                               │   │
│  │  RING 2: OPENSHELL (k3s + L7 proxy)          │   │
│  │  ┌───────────────────────────────────────┐    │   │
│  │  │  Network policies, port forwarding,   │    │   │
│  │  │  container orchestration              │    │   │
│  │  │                                       │    │   │
│  │  │  RING 1: SANDBOX CONTAINER            │    │   │
│  │  │  ┌───────────────────────────────┐    │    │   │
│  │  │  │  OpenClaw + NemoClaw Plugin   │    │    │   │
│  │  │  │  Landlock + capability drops  │    │    │   │
│  │  │  │  Immutable config             │    │    │   │
│  │  │  │  Secret scanning              │    │    │   │
│  │  │  └───────────────────────────────┘    │    │   │
│  │  └───────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### When Contributing, Think:

**"Which ring am I modifying?"**

- **Ring 3 (CLI/Host)**: Edit `src/lib/`. Test with `npm test`. Build with `npm run build:cli`. Your code runs on the user's machine — never leak secrets in output (`src/lib/runner.ts` redacts automatically).

- **Ring 2 (Policies/Blueprint)**: Edit `nemoclaw-blueprint/`. Validate against `schemas/`. Changes here control what the agent can access — security-critical.

- **Ring 1 (Plugin/Sandbox)**: Edit `nemoclaw/src/`. Build with `cd nemoclaw && npm run build`. Test with `cd nemoclaw && npm test`. This code runs inside the container — it only sees what Landlock allows.

### Key Invariants to Never Break

1. **Credentials never leave `~/.nemoclaw/`** — env vars preferred over disk, 0o600 perms enforced
2. **Runner always redacts** — every shell exec goes through `src/lib/runner.ts` which masks secrets
3. **Config hash integrity** — openclaw.json has a SHA-256 hash checked at startup; tampering = refuse to start
4. **Blueprint digest pins the image** — `blueprint.yaml` line 14 and line 33 must match; prevents supply-chain attacks
5. **SSRF check before any user-provided URL** — `ssrf.ts` validates before configuring endpoints
6. **File-based locking** — registry and session files use `mkdir`-based advisory locks with stale PID detection

### Development Workflow

```bash
# Full environment setup
npm install && cd nemoclaw && npm install && npm run build && cd ..

# Build CLI after editing src/
npm run build:cli

# Build plugin after editing nemoclaw/src/
cd nemoclaw && npm run build

# Run all tests
npm test

# Run plugin tests only
cd nemoclaw && npm test

# Type-check everything
npm run typecheck:cli

# Lint + format
make check
make format
```

### Where to Look When Debugging

| Symptom | Start Here |
|---------|-----------|
| Onboarding fails | `src/lib/onboard.ts`, `~/.nemoclaw/onboard-session.json` |
| Sandbox won't start | `scripts/nemoclaw-start.sh`, `nemoclaw debug` |
| Network blocked | `nemoclaw-blueprint/policies/`, `nemoclaw <sandbox> policy-list` |
| Model errors | `src/lib/inference-config.ts`, `src/lib/validation.ts` |
| Secret leaked | `src/lib/secret-patterns.ts`, `nemoclaw/src/security/secret-scanner.ts` |
| Plugin not loading | `nemoclaw/src/index.ts`, `nemoclaw/openclaw.plugin.json` |
| Mac app issues | `mac-launcher/index.js`, `mac-launcher/lib/ollama-proxy.js` |
| Registry corruption | `src/lib/registry.ts`, `~/.nemoclaw/sandboxes.json` |
