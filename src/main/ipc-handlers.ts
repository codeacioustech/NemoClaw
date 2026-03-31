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
  // Use the user's default shell on macOS/Linux (zsh on modern macOS)
  // so that nvm/PATH from .zshrc or .bashrc is picked up
  const userShell = process.env.SHELL || '/bin/bash'
  return { command: userShell, args: ['-l', '-c', cmd] }
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
        return validateWithRetry('https://integrate.api.nvidia.com/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` }
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
            model: 'claude-haiku-4-5-20251001',
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
    const keyEnvName = providerKeyEnv[config.provider] || 'NVIDIA_API_KEY'

    // Map internal provider IDs → NemoClaw CLI provider values
    // Valid CLI values: build, openai, anthropic, anthropicCompatible, gemini, ollama, custom, nim-local, vllm
    const cliProviderMap: Record<string, string> = {
      nvidia: 'build',
      openai: 'openai',
      anthropic: 'anthropic',
      gemini: 'gemini'
    }
    const cliProvider = cliProviderMap[config.provider] || config.provider

    // Set all provider key env vars — only the selected one gets the real key
    const env: Record<string, string> = {
      NEMOCLAW_NON_INTERACTIVE: '1',
      NEMOCLAW_PROVIDER: cliProvider,
      NEMOCLAW_SANDBOX_NAME: config.sandboxName,
      NEMOCLAW_MODEL: config.modelName,
      [keyEnvName]: config.apiKey
    }

    try {
      sendDebug(win, `Platform: ${process.platform}, Node: ${process.version}`)
      sendDebug(win, `Provider: ${cliProvider}, Model: ${config.modelName}, Sandbox: ${config.sandboxName}`)
      sendDebug(win, `Env key variable: ${keyEnvName}`)

      // Step 1: Write credentials to WSL filesystem
      sendOutput(win, 'Writing credentials...', 'info')
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

      // nvm prefix — nemoclaw is installed under nvm's node path, so nvm must
      // be sourced in every fresh bash session for `nemoclaw` and `openshell` to be in PATH
      const nvmLoad = 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'

      // Step 2: Check if CLI is already installed
      sendOutput(win, 'Checking if NemoClaw CLI is already installed...', 'info')
      const checkCmd = `${nvmLoad} && nemoclaw --version`
      sendDebug(win, `CMD: ${checkCmd}`)
      const { command: chkCmd, args: chkArgs } = getShellCmd(checkCmd)
      sendDebug(win, `Shell: ${chkCmd} ${chkArgs.join(' ')}`)
      const checkResult = await new Promise<number>((resolve) => {
        const proc = spawn(chkCmd, chkArgs, { shell: false })
        proc.on('close', (code) => resolve(code ?? 1))
        proc.on('error', (err) => {
          sendDebug(win, `CLI check spawn error: ${err.message}`)
          resolve(1)
        })
      })
      sendDebug(win, `CLI check exited with code ${checkResult}`)

      if (checkResult !== 0) {
        // Step 3: Install CLI — the curl script installs the CLI and then runs
        // `nemoclaw onboard` automatically. The onboard will likely fail because
        // it tries to verify the inference endpoint (network-dependent).
        // That's OK — we only need the CLI binary installed here.
        // We'll run our own onboard with --no-verify afterwards.
        sendOutput(win, 'Installing NemoClaw CLI...', 'info')

        const curlCmd = `${nvmLoad}; curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash`
        sendDebug(win, `CMD: ${curlCmd}`)
        const curlCode = await spawnStreaming(win, curlCmd, env)
        sendDebug(win, `curl install exited with code ${curlCode}`)

        // Check if the CLI binary was actually installed (regardless of curl exit code)
        sendOutput(win, 'Verifying CLI installation...', 'info')
        const verifyCmd = `${nvmLoad} && nemoclaw --version`
        sendDebug(win, `CMD: ${verifyCmd}`)
        const verifyCode = await spawnStreaming(win, verifyCmd, env)
        sendDebug(win, `CLI verify exited with code ${verifyCode}`)
        if (verifyCode !== 0) {
          sendDebug(win, 'FATAL: nemoclaw binary not found after install — aborting')
          const evt: InstallCompleteEvent = {
            success: false,
            code: 1,
            message: 'CLI installation failed — nemoclaw binary not found after install'
          }
          win.webContents.send('install-complete', evt)
          return
        }
      } else {
        sendOutput(win, 'NemoClaw CLI already installed, skipping download', 'success')
      }

      // Step 4: Create openshell shim, then run our own onboard
      // The install script's onboard likely failed at inference verification.
      // We create a shim that intercepts `openshell inference set` and adds
      // --no-verify, then run onboard ourselves.
      sendOutput(win, 'Preparing inference configuration...', 'info')

      // Find where openshell is installed and create a wrapper shim
      const shimCmd = `${nvmLoad} && mkdir -p /tmp/nc-shim && REAL_OPENSHELL="$(which openshell 2>/dev/null)" && printf '#!/bin/bash\\nif [ "$1" = "inference" ] && [ "$2" = "set" ]; then\\n  exec %s "$@" --no-verify\\nelse\\n  exec %s "$@"\\nfi\\n' "$REAL_OPENSHELL" "$REAL_OPENSHELL" > /tmp/nc-shim/openshell && chmod +x /tmp/nc-shim/openshell && echo "openshell shim ready (wrapping $REAL_OPENSHELL)"`

      sendDebug(win, `CMD (shim): ${shimCmd.substring(0, 120)}...`)
      const shimCode = await spawnStreaming(win, shimCmd)
      sendDebug(win, `Shim creation exited with code ${shimCode}`)
      if (shimCode !== 0) {
        sendOutput(win, 'Warning: Could not create openshell shim, onboard may fail at verification', 'stderr')
      }

      // Step 5: Run onboard with shim in PATH
      sendOutput(win, `Running NemoClaw onboard (provider: ${cliProvider})...`, 'info')
      const onboardCmd = `${nvmLoad} && export PATH="/tmp/nc-shim:$PATH" && nemoclaw onboard --non-interactive`
      sendDebug(win, `CMD: ${onboardCmd}`)
      const onboardCode = await spawnStreaming(win, onboardCmd, env)
      sendDebug(win, `Onboard exited with code ${onboardCode}`)

      if (onboardCode === 0) {
        sendOutput(win, 'Installation complete!', 'success')
        const evt: InstallCompleteEvent = {
          success: true,
          code: 0,
          message: 'Installation completed successfully'
        }
        win.webContents.send('install-complete', evt)
      } else {
        const evt: InstallCompleteEvent = {
          success: false,
          code: onboardCode,
          message: `Onboarding failed with exit code ${onboardCode}`
        }
        win.webContents.send('install-complete', evt)
      }

      // Write install log
      try {
        const logCmd = `echo 'Install completed at ${new Date().toISOString()}' >> ~/.nemoclaw/install.log`
        await spawnStreaming(win, logCmd, env)
      } catch {
        // Non-critical, ignore
      }
    } catch (err) {
      const message = (err as Error).message || 'Unknown error'
      sendDebug(win, `Uncaught error: ${message}`)
      sendDebug(win, `Stack: ${(err as Error).stack || 'no stack'}`)
      sendOutput(win, `Error: ${message}`, 'error')
      const evt: InstallCompleteEvent = {
        success: false,
        code: 1,
        message
      }
      win.webContents.send('install-complete', evt)
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
