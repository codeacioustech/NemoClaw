import { ipcMain, shell, BrowserWindow } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { runSystemChecks } from './system-checks'
import type { InstallConfig, InstallOutputEvent, InstallCompleteEvent } from '../shared/types'
import * as https from 'https'
import * as http from 'http'

let installProcess: ChildProcess | null = null

function httpRequest(
  url: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: string
    timeoutMs?: number
  }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const isHttps = parsedUrl.protocol === 'https:'
    const lib = isHttps ? https : http

    const req = lib.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: options.timeoutMs || 5000
      },
      (res) => {
        let data = ''
        res.on('data', (chunk: Buffer) => { data += chunk.toString() })
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, body: data })
        })
      }
    )

    req.on('timeout', () => {
      req.destroy()
      reject(new Error('timeout'))
    })
    req.on('error', (err) => reject(err))

    if (options.body) {
      req.write(options.body)
    }
    req.end()
  })
}

async function validateWithRetry(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<{ valid: boolean; message?: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await httpRequest(url, { ...options, timeoutMs: 5000 })

      if (res.status >= 200 && res.status < 300) {
        return { valid: true }
      }
      if (res.status === 401 || res.status === 403) {
        return { valid: false, message: 'Invalid API key' }
      }
      if (res.status === 429) {
        return { valid: false, message: 'Rate limited or quota exceeded' }
      }
      if (res.status >= 500) {
        if (attempt === 0) continue
        return { valid: false, message: 'Provider service temporarily unavailable' }
      }
      return { valid: false, message: `Validation failed (HTTP ${res.status})` }
    } catch (err) {
      if (attempt === 0) continue
      const msg = (err as Error).message
      if (msg === 'timeout') {
        return { valid: false, message: 'Network timeout while contacting provider' }
      }
      return { valid: false, message: `Network error: ${msg}` }
    }
  }
  return { valid: false, message: 'Validation failed after retries' }
}

function getShellCmd(cmd: string): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: 'wsl', args: ['bash', '-l', '-c', cmd] }
  }
  // IMPORTANT: Force bash for install commands on macOS/Linux.
  // nvm installs to .bashrc, and zsh login shells may not source it.
  // We still source nvm.sh directly in every command, but bash ensures
  // consistent behavior with the official install.sh.
  return { command: 'bash', args: ['-l', '-c', cmd] }
}

function sendOutput(win: BrowserWindow, line: string, type: InstallOutputEvent['type']): void {
  win.webContents.send('install-output', { line, type } as InstallOutputEvent)
}

function sendDebug(_win: BrowserWindow, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23) // HH:mm:ss.SSS
  console.log(`[DEBUG ${ts}] ${msg}`)
}

function spawnStreaming(
  win: BrowserWindow,
  cmd: string,
  wslEnv?: Record<string, string>
): Promise<number> {
  return new Promise((resolve, reject) => {
    // Export env vars inside the shell so they survive WSL bash nesting
    let fullCmd = cmd
    if (wslEnv && Object.keys(wslEnv).length > 0) {
      const exports = Object.entries(wslEnv)
        .map(([k, v]) => `export ${k}="${v.replace(/"/g, '\\"')}"`) 
        .join(' && ')
      fullCmd = `${exports} && ${cmd}`
    }
    const { command, args } = getShellCmd(fullCmd)
    sendDebug(win, `Spawning: ${command} ${args.map(a => a.length > 60 ? a.substring(0, 60) + '…' : a).join(' ')}`)
    const proc = spawn(command, args, {
      shell: false
    })

    installProcess = proc
    sendDebug(win, `Process PID: ${proc.pid ?? 'unknown'}`)

    // Close stdin so the process can't hang waiting for interactive input
    proc.stdin?.end()

    let staleTimer: ReturnType<typeof setTimeout> | null = null

    const resetStaleTimer = (): void => {
      if (staleTimer) clearTimeout(staleTimer)
      staleTimer = setTimeout(() => {
        sendOutput(win, 'Installation timed out — no output for 120 seconds', 'error')
        proc.kill()
      }, 120000)
    }

    resetStaleTimer()

    proc.stdout?.on('data', (data: Buffer) => {
      resetStaleTimer()
      const lines = data.toString().split('\n')
      for (const line of lines) {
        if (line.trim()) sendOutput(win, line, 'stdout')
      }
    })

    proc.stderr?.on('data', (data: Buffer) => {
      resetStaleTimer()
      const lines = data.toString().split('\n')
      for (const line of lines) {
        if (line.trim()) sendOutput(win, line, 'stderr')
      }
    })

    proc.on('close', (code) => {
      if (staleTimer) clearTimeout(staleTimer)
      sendDebug(win, `Process PID ${proc.pid} closed with code ${code}`)
      installProcess = null
      resolve(code ?? 1)
    })

    proc.on('error', (err) => {
      if (staleTimer) clearTimeout(staleTimer)
      sendDebug(win, `Process PID ${proc.pid} error: ${err.message}`)
      installProcess = null
      reject(err)
    })
  })
}

export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('check-system-requirements', async () => {
    return await runSystemChecks()
  })

  ipcMain.handle('validate-api-key', async (_event, provider: string, apiKey: string) => {
    switch (provider) {
      case 'nvidia':
        // Test an actual chat completion to verify the key works for inference
        return validateWithRetry('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'nvidia/nemotron-3-super-120b-a12b',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1
          })
        })
      case 'openai':
        return validateWithRetry('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` }
        })
      case 'anthropic':
        return validateWithRetry('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-3-5-haiku-20241022',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }]
          })
        })
      case 'gemini':
        return validateWithRetry(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
          {}
        )
      default:
        return { valid: false, message: 'Unknown provider' }
    }
  })

  ipcMain.handle('run-install', async (_event, config: InstallConfig) => {
    const win = getMainWindow()
    if (!win) return

    // Map provider to the env var the CLI expects for the API key
    const providerKeyEnv: Record<string, string> = {
      nvidia: 'NVIDIA_API_KEY',
      openai: 'OPENAI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      gemini: 'GOOGLE_API_KEY'
    }

    // Map internal provider IDs → NemoClaw CLI provider values
    const cliProviderMap: Record<string, string> = {
      nvidia: 'cloud',
      openai: 'openai',
      anthropic: 'anthropic',
      gemini: 'gemini',
      ollama: 'ollama'
    }
    const cliProvider = cliProviderMap[config.provider] || config.provider
    const isOllama = config.provider === 'ollama'

    // Environment variables for the install process
    const env: Record<string, string> = {
      NEMOCLAW_NON_INTERACTIVE: '1',
      NEMOCLAW_PROVIDER: cliProvider,
      NEMOCLAW_SANDBOX_NAME: config.sandboxName,
      NEMOCLAW_MODEL: config.modelName,
      NEMOCLAW_POLICY_MODE: 'suggested'
    }

    // Only set API key env for cloud providers (Ollama needs no key)
    if (!isOllama) {
      const keyEnvName = providerKeyEnv[config.provider] || 'NVIDIA_API_KEY'
      env[keyEnvName] = config.apiKey
    }

    // Helper to abort with an error event
    const fail = (msg: string, code = 1): void => {
      sendDebug(win, `FAIL: ${msg}`)
      sendOutput(win, `Error: ${msg}`, 'error')
      win.webContents.send('install-complete', { success: false, code, message: msg } as InstallCompleteEvent)
    }

    // nvm loader — must be sourced in every shell so nemoclaw/openshell are on PATH
    const nvmLoad = 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'
    const pathSetup = 'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"'
    const TOTAL_STEPS = isOllama ? 8 : 7

    try {
      sendDebug(win, `Platform: ${process.platform}, Node: ${process.version}, Arch: ${process.arch}`)
      sendDebug(win, `Provider: ${cliProvider}, Model: ${config.modelName}, Sandbox: ${config.sandboxName}`)
      sendDebug(win, `Env: provider=${cliProvider}, isOllama=${isOllama}`)

      // ── Step 1: Write credentials (skip for Ollama) ────────────────
      if (isOllama) {
        sendOutput(win, `[1/${TOTAL_STEPS}] Ollama selected — no credentials needed, skipping...`, 'info')
      } else {
        sendOutput(win, `[1/${TOTAL_STEPS}] Writing credentials...`, 'info')
        const credJson = JSON.stringify({
          provider: cliProvider,
          api_key: config.apiKey,
          model: config.modelName
        })
        const escapedJson = credJson.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        const writeCredCmd = `mkdir -p ~/.nemoclaw && printf '%s' "${escapedJson}" > ~/.nemoclaw/credentials.json`
        sendDebug(win, `CMD: ${writeCredCmd.substring(0, 120)}...`)
        const credCode = await spawnStreaming(win, writeCredCmd)
        sendDebug(win, `Credentials write exited with code ${credCode}`)
        if (credCode !== 0) {
          sendOutput(win, 'Warning: Could not write credentials file', 'error')
        }
      }

      // ── Step 2: Install Node.js 22 via nvm ────────────────────────
      sendOutput(win, `[2/${TOTAL_STEPS}] Ensuring Node.js >= 22.16.0 via nvm...`, 'info')

      // Self-heal: remove any custom npm prefix BEFORE touching nvm.
      // A stale "prefix" in ~/.npmrc causes nvm to silently exit 1.
      const npmFixCmd = `npm config delete prefix 2>/dev/null; true`
      sendDebug(win, `CMD (npm heal): ${npmFixCmd}`)
      await spawnStreaming(win, npmFixCmd)

      // Check if nvm exists
      const nvmCheckCmd = `${nvmLoad} && nvm --version`
      sendDebug(win, `CMD: ${nvmCheckCmd}`)
      const nvmCheckCode = await spawnStreaming(win, nvmCheckCmd)
      sendDebug(win, `nvm check exited with code ${nvmCheckCode}`)

      if (nvmCheckCode !== 0) {
        // Install nvm with SHA-256 verification (matching official script)
        sendOutput(win, 'Installing nvm...', 'info')
        const nvmInstallCmd = [
          'NVM_SHA256="4b7412c49960c7d31e8df72da90c1fb5b8cccb419ac99537b737028d497aba4f"',
          'NVM_TMP=$(mktemp)',
          'curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh" -o "$NVM_TMP"',
          'if command -v sha256sum >/dev/null 2>&1; then ACTUAL=$(sha256sum "$NVM_TMP" | awk \'{print $1}\'); elif command -v shasum >/dev/null 2>&1; then ACTUAL=$(shasum -a 256 "$NVM_TMP" | awk \'{print $1}\'); else ACTUAL="$NVM_SHA256"; fi',
          'if [ "$ACTUAL" != "$NVM_SHA256" ]; then rm -f "$NVM_TMP"; echo "ERROR: nvm integrity check failed"; exit 1; fi',
          'echo "nvm installer integrity verified"',
          'bash "$NVM_TMP"',
          'rm -f "$NVM_TMP"'
        ].join(' && ')
        sendDebug(win, `CMD: nvm install with SHA verification`)
        const nvmInstallCode = await spawnStreaming(win, nvmInstallCmd)
        sendDebug(win, `nvm install exited with code ${nvmInstallCode}`)
        if (nvmInstallCode !== 0) {
          fail('Failed to install nvm — cannot proceed without Node.js 22')
          return
        }
      }

      // Install Node 22 via nvm
      const nodeInstallCmd = `${nvmLoad} && nvm install 22 && nvm use 22 && nvm alias default 22 2>/dev/null || true && node --version && npm --version`
      sendDebug(win, `CMD: ${nodeInstallCmd}`)
      const nodeInstallCode = await spawnStreaming(win, nodeInstallCmd)
      sendDebug(win, `Node.js install exited with code ${nodeInstallCode}`)
      if (nodeInstallCode !== 0) {
        fail('Failed to install Node.js 22 via nvm')
        return
      }

      // ── Step 3: Fix npm permissions (matches official install.sh) ──
      sendOutput(win, `[3/${TOTAL_STEPS}] Fixing npm permissions...`, 'info')
      const npmPermFixCmd = [
        `${nvmLoad}`,
        'NPM_PREFIX=$(npm config get prefix 2>/dev/null || true)',
        'if [ -n "$NPM_PREFIX" ] && [ ! -w "$NPM_PREFIX" ] && [ ! -w "$NPM_PREFIX/lib" ]; then',
        '  echo "npm prefix not writable — configuring user-local installs"',
        '  mkdir -p "$HOME/.npm-global"',
        '  npm config set prefix "$HOME/.npm-global"',
        '  echo "npm configured for ~/.npm-global"',
        'else',
        '  echo "npm permissions OK"',
        'fi'
      ].join('\n')
      sendDebug(win, 'CMD: fix npm permissions')
      await spawnStreaming(win, npmPermFixCmd)

      // ── Step 4: Check if CLI already installed, else clone + build ─
      sendOutput(win, `[4/${TOTAL_STEPS}] Installing NemoClaw CLI...`, 'info')
      const checkCmd = `${nvmLoad} && ${pathSetup} && nemoclaw --version`
      sendDebug(win, `CMD: ${checkCmd}`)
      const { command: chkCmd, args: chkArgs } = getShellCmd(checkCmd)
      const checkResult = await new Promise<number>((resolve) => {
        const proc = spawn(chkCmd, chkArgs, { shell: false })
        proc.on('close', (code) => resolve(code ?? 1))
        proc.on('error', () => resolve(1))
      })
      sendDebug(win, `CLI check exited with code ${checkResult}`)

      if (checkResult !== 0) {
        // Resolve latest release tag from GitHub API
        sendOutput(win, 'Fetching latest NemoClaw release...', 'info')
        const tagCmd = `curl -fsSL --max-time 10 https://api.github.com/repos/NVIDIA/NemoClaw/releases/latest 2>/dev/null | grep '"tag_name"' | head -1 | sed -E 's/.*"tag_name":[[:space:]]*"([^"]+)".*/\\1/'`
        sendDebug(win, `CMD: resolve release tag`)
        const { command: tagC, args: tagA } = getShellCmd(tagCmd)
        let releaseTag = ''
        const tagCode = await new Promise<number>((resolve) => {
          const proc = spawn(tagC, tagA, { shell: false })
          proc.stdout?.on('data', (d: Buffer) => { releaseTag += d.toString().trim() })
          proc.on('close', (code) => resolve(code ?? 1))
          proc.on('error', () => resolve(1))
        })
        sendDebug(win, `Release tag: "${releaseTag}", code: ${tagCode}`)
        // Validate tag looks legit (starts with 'v' + digit, or fallback to main)
        const branch = (releaseTag && /^v[0-9]/.test(releaseTag)) ? releaseTag : 'main'

        // Step 4a: Clone
        const cloneCmd = `${nvmLoad} && ${pathSetup} && rm -rf ~/.nemoclaw/source && mkdir -p ~/.nemoclaw && git clone --depth 1 --branch ${branch} https://github.com/NVIDIA/NemoClaw.git ~/.nemoclaw/source`
        sendDebug(win, `CMD (clone): ${cloneCmd.substring(0, 120)}...`)
        sendOutput(win, `Cloning NemoClaw (${branch})...`, 'info')
        const cloneCode = await spawnStreaming(win, cloneCmd, env)
        sendDebug(win, `Clone exited with code ${cloneCode}`)
        if (cloneCode !== 0) {
          fail('Failed to clone NemoClaw repository')
          return
        }

        // Step 4b: Pre-extract OpenClaw (GH-503 workaround — matches official install.sh)
        sendOutput(win, 'Preparing OpenClaw package (GH-503 workaround)...', 'info')
        const preExtractCmd = [
          `${nvmLoad}`,
          'cd ~/.nemoclaw/source',
          'OPENCLAW_VER=$(node -e "console.log(require(\'./package.json\').dependencies.openclaw)" 2>/dev/null || echo "")',
          'if [ -n "$OPENCLAW_VER" ]; then',
          '  TMPD=$(mktemp -d)',
          '  if npm pack "openclaw@${OPENCLAW_VER}" --pack-destination "$TMPD" >/dev/null 2>&1; then',
          '    TGZ=$(find "$TMPD" -maxdepth 1 -name "openclaw-*.tgz" -print -quit)',
          '    if [ -n "$TGZ" ] && [ -f "$TGZ" ]; then',
          '      mkdir -p node_modules/openclaw',
          '      tar xzf "$TGZ" -C node_modules/openclaw --strip-components=1',
          '      echo "openclaw pre-extracted successfully"',
          '    fi',
          '  fi',
          '  rm -rf "$TMPD"',
          'else',
          '  echo "Could not determine openclaw version — skipping pre-extraction"',
          'fi'
        ].join('\n')
        sendDebug(win, 'CMD: pre-extract openclaw')
        await spawnStreaming(win, preExtractCmd)

        // Step 4c: Install dependencies
        sendOutput(win, 'Installing NemoClaw dependencies...', 'info')
        const depsCmd = `${nvmLoad} && cd ~/.nemoclaw/source && npm install --ignore-scripts`
        sendDebug(win, `CMD: ${depsCmd}`)
        const depsCode = await spawnStreaming(win, depsCmd, env)
        sendDebug(win, `Dependencies install exited with code ${depsCode}`)
        if (depsCode !== 0) {
          fail('Failed to install NemoClaw dependencies')
          return
        }

        // Step 4d: Build NemoClaw plugin (CRITICAL — matches official install.sh)
        sendOutput(win, 'Building NemoClaw plugin...', 'info')
        const buildCmd = `${nvmLoad} && cd ~/.nemoclaw/source/nemoclaw && npm install --ignore-scripts && npm run build`
        sendDebug(win, `CMD: ${buildCmd}`)
        const buildCode = await spawnStreaming(win, buildCmd, env)
        sendDebug(win, `Plugin build exited with code ${buildCode}`)
        if (buildCode !== 0) {
          fail('Failed to build NemoClaw plugin')
          return
        }

        // Step 4e: Link CLI
        sendOutput(win, 'Linking NemoClaw CLI...', 'info')
        const linkCmd = `${nvmLoad} && ${pathSetup} && cd ~/.nemoclaw/source && npm link`
        sendDebug(win, `CMD: ${linkCmd}`)
        const linkCode = await spawnStreaming(win, linkCmd, env)
        sendDebug(win, `npm link exited with code ${linkCode}`)
        if (linkCode !== 0) {
          fail('Failed to link NemoClaw CLI')
          return
        }

        // Verify CLI is on PATH
        sendOutput(win, 'Verifying CLI installation...', 'info')
        const verifyCmd = `${nvmLoad} && ${pathSetup} && nemoclaw --version`
        sendDebug(win, `CMD: ${verifyCmd}`)
        const verifyCode = await spawnStreaming(win, verifyCmd, env)
        sendDebug(win, `CLI verify exited with code ${verifyCode}`)
        if (verifyCode !== 0) {
          // Try creating a shim as fallback (matches official ensure_nemoclaw_shim)
          sendOutput(win, 'CLI not on PATH — creating shim...', 'info')
          const shimCmd = [
            `${nvmLoad}`,
            'NPM_BIN=$(npm config get prefix 2>/dev/null)/bin',
            'mkdir -p ~/.local/bin',
            'if [ -x "$NPM_BIN/nemoclaw" ]; then',
            '  ln -sfn "$NPM_BIN/nemoclaw" ~/.local/bin/nemoclaw',
            '  echo "Shim created at ~/.local/bin/nemoclaw"',
            'else',
            '  NEMOCLAW_BIN=$(find ~/.nemoclaw/source -name "nemoclaw.js" -path "*/bin/*" 2>/dev/null | head -1)',
            '  if [ -n "$NEMOCLAW_BIN" ]; then',
            '    printf \'#!/bin/bash\\nexec node "%s" "$@"\\n\' "$NEMOCLAW_BIN" > ~/.local/bin/nemoclaw',
            '    chmod +x ~/.local/bin/nemoclaw',
            '    echo "Script shim created"',
            '  else',
            '    echo "Cannot find nemoclaw binary"',
            '    exit 1',
            '  fi',
            'fi'
          ].join('\n')
          const shimCode = await spawnStreaming(win, shimCmd)
          sendDebug(win, `Shim creation exited with code ${shimCode}`)
          if (shimCode !== 0) {
            fail('CLI installation failed — nemoclaw binary not found after install')
            return
          }
        }
      } else {
        sendOutput(win, 'NemoClaw CLI already installed, skipping download', 'success')
      }

      // ── Step 5: Install OpenShell ─────────────────────────────────
      sendOutput(win, `[5/${TOTAL_STEPS}] Checking OpenShell...`, 'info')
      const osCheckCmd = `${nvmLoad} && ${pathSetup} && openshell --version`
      sendDebug(win, `CMD: ${osCheckCmd}`)
      const osCheckCode = await spawnStreaming(win, osCheckCmd)
      sendDebug(win, `OpenShell check exited with code ${osCheckCode}`)

      if (osCheckCode !== 0) {
        sendOutput(win, 'Installing OpenShell...', 'info')
        const osInstallCmd = `curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh`
        sendDebug(win, `CMD: ${osInstallCmd}`)
        const osInstallCode = await spawnStreaming(win, osInstallCmd)
        sendDebug(win, `OpenShell install exited with code ${osInstallCode}`)
        if (osInstallCode !== 0) {
          fail('Failed to install OpenShell')
          return
        }

        // Verify
        const osVerifyCmd = `${pathSetup} && openshell --version`
        const osVerifyCode = await spawnStreaming(win, osVerifyCmd)
        sendDebug(win, `OpenShell verify exited with code ${osVerifyCode}`)
        if (osVerifyCode !== 0) {
          fail('OpenShell binary not found after install')
          return
        }
      } else {
        sendOutput(win, 'OpenShell already installed', 'success')
      }

      // ── Step 6 (Ollama only): Pull model ──────────────────────────
      if (isOllama) {
        sendOutput(win, `[6/${TOTAL_STEPS}] Pulling Ollama model...`, 'info')

        // First check if Ollama is running
        const ollamaCheckCmd = `ollama --version && curl -sf http://localhost:11434 >/dev/null 2>&1`
        sendDebug(win, `CMD: ollama serve check`)
        const ollamaCheckCode = await spawnStreaming(win, ollamaCheckCmd)

        if (ollamaCheckCode !== 0) {
          // Try to start Ollama in background
          sendOutput(win, 'Starting Ollama serve...', 'info')
          const ollamaStartCmd = `ollama serve &>/dev/null & sleep 3 && curl -sf http://localhost:11434 >/dev/null 2>&1 && echo "Ollama started" || echo "Ollama may not be running"`
          await spawnStreaming(win, ollamaStartCmd)
        }

        // Detect VRAM to pick appropriate model
        const vramCmd = process.platform === 'darwin'
          ? `sysctl -n hw.memsize 2>/dev/null | awk '{print int($1/1024/1024/1024)}'`
          : `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | awk '{s += $1} END {print int(s/1024)}' || echo "0"`
        const { command: vramC, args: vramA } = getShellCmd(vramCmd)
        let vramGB = 0
        await new Promise<void>((resolve) => {
          const proc = spawn(vramC, vramA, { shell: false })
          let out = ''
          proc.stdout?.on('data', (d: Buffer) => { out += d.toString().trim() })
          proc.on('close', () => {
            vramGB = parseInt(out, 10) || 0
            resolve()
          })
          proc.on('error', () => resolve())
        })

        sendDebug(win, `Detected VRAM: ${vramGB} GB`)
        const modelToPull = vramGB >= 120 ? 'nemotron-3-super:120b' : 'nemotron-3-nano:30b'
        sendOutput(win, `Pulling model: ${modelToPull} (${vramGB} GB memory detected)...`, 'info')

        const pullCmd = `ollama pull ${modelToPull}`
        sendDebug(win, `CMD: ${pullCmd}`)
        const pullCode = await spawnStreaming(win, pullCmd, env)
        sendDebug(win, `Model pull exited with code ${pullCode}`)

        if (pullCode !== 0) {
          sendOutput(win, `Warning: Failed to pull ${modelToPull} — onboarding may prompt for a model`, 'error')
        } else {
          sendOutput(win, `Model ${modelToPull} ready`, 'success')
          // Update the model name in env to match what we pulled
          env.NEMOCLAW_MODEL = modelToPull
        }
      }

      // ── Step 6/7: Run nemoclaw onboard ─────────────────────────────
      const onboardStep = isOllama ? 7 : 6
      sendOutput(win, `[${onboardStep}/${TOTAL_STEPS}] Running NemoClaw onboard (provider: ${cliProvider})...`, 'info')

      // Check for interrupted session (matches official install.sh)
      let resumeFlag = ''
      const resumeCheckCmd = `${nvmLoad} && node -e '
        const fs = require("fs");
        try {
          const data = JSON.parse(fs.readFileSync(process.env.HOME + "/.nemoclaw/onboard-session.json", "utf8"));
          const resumable = data && data.resumable !== false;
          const status = data && data.status;
          process.exit(resumable && status && status !== "complete" ? 0 : 1);
        } catch { process.exit(1); }
      '`
      const { command: resCmd, args: resArgs } = getShellCmd(resumeCheckCmd)
      const resumeCode = await new Promise<number>((resolve) => {
        const proc = spawn(resCmd, resArgs, { shell: false })
        proc.on('close', (code) => resolve(code ?? 1))
        proc.on('error', () => resolve(1))
      })
      if (resumeCode === 0) {
        sendOutput(win, 'Found interrupted onboarding session — resuming...', 'info')
        resumeFlag = '--resume'
      }

      const onboardCmd = `${nvmLoad} && ${pathSetup} && nemoclaw onboard --non-interactive ${resumeFlag}`.trim()
      sendDebug(win, `CMD: ${onboardCmd}`)
      const onboardCode = await spawnStreaming(win, onboardCmd, env)
      sendDebug(win, `Onboard exited with code ${onboardCode}`)

      if (onboardCode !== 0) {
        fail(`Onboarding failed with exit code ${onboardCode}`, onboardCode)
        return
      }

      // ── Final Step: Done ───────────────────────────────────────────
      sendOutput(win, `[${TOTAL_STEPS}/${TOTAL_STEPS}] Installation complete!`, 'success')
      win.webContents.send('install-complete', {
        success: true,
        code: 0,
        message: 'Installation completed successfully'
      } as InstallCompleteEvent)

      // Write install log (non-critical)
      try {
        const logCmd = `echo 'Install completed at ${new Date().toISOString()} provider=${cliProvider} model=${config.modelName}' >> ~/.nemoclaw/install.log`
        await spawnStreaming(win, logCmd, env)
      } catch {
        // ignore
      }
    } catch (err) {
      const message = (err as Error).message || 'Unknown error'
      sendDebug(win, `Uncaught error: ${message}`)
      sendDebug(win, `Stack: ${(err as Error).stack || 'no stack'}`)
      fail(message)
    }
  })

  ipcMain.handle('cancel-install', async () => {
    if (installProcess) {
      installProcess.kill()
      installProcess = null
    }
  })

  ipcMain.handle('open-external', async (_event, url: string) => {
    await shell.openExternal(url)
  })

  ipcMain.on('window-minimize', () => {
    const win = getMainWindow()
    win?.minimize()
  })

  ipcMain.on('window-maximize', () => {
    const win = getMainWindow()
    if (win?.isMaximized()) {
      win.unmaximize()
    } else {
      win?.maximize()
    }
  })

  ipcMain.on('window-close', () => {
    const win = getMainWindow()
    win?.close()
  })

  ipcMain.handle('remove-install-listeners', async () => {
    const win = getMainWindow()
    if (win) {
      win.webContents.removeAllListeners('install-output')
      win.webContents.removeAllListeners('install-complete')
    }
  })
}
