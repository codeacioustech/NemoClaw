import { ipcMain, shell, BrowserWindow } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { runSystemChecks } from './system-checks'
import type { InstallConfig, InstallOutputEvent, InstallCompleteEvent } from '../shared/types'
import * as https from 'https'
import * as http from 'http'

let installProcess: ChildProcess | null = null

// ── HTTP helper for API key validation ──────────────────────────────────────

function httpRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const lib = parsedUrl.protocol === 'https:' ? https : http
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
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }))
      }
    )
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.on('error', (err) => reject(err))
    if (options.body) req.write(options.body)
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
      if (res.status >= 200 && res.status < 300) return { valid: true }
      if (res.status === 401 || res.status === 403) return { valid: false, message: 'Invalid API key' }
      if (res.status === 429) return { valid: false, message: 'Rate limited or quota exceeded' }
      if (res.status >= 500 && attempt === 0) continue
      return { valid: false, message: `Validation failed (HTTP ${res.status})` }
    } catch (err) {
      if (attempt === 0) continue
      const msg = (err as Error).message
      return { valid: false, message: msg === 'timeout' ? 'Network timeout' : `Network error: ${msg}` }
    }
  }
  return { valid: false, message: 'Validation failed after retries' }
}

// ── Shell + streaming helpers ───────────────────────────────────────────────

function getShellCmd(cmd: string): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: 'wsl', args: ['bash', '-l', '-c', cmd] }
  }
  // Force bash — the official install.sh is a bash script
  return { command: 'bash', args: ['-l', '-c', cmd] }
}

function sendOutput(win: BrowserWindow, line: string, type: InstallOutputEvent['type']): void {
  win.webContents.send('install-output', { line, type } as InstallOutputEvent)
}

function spawnStreaming(
  win: BrowserWindow,
  cmd: string,
  envVars?: Record<string, string>
): Promise<number> {
  return new Promise((resolve, reject) => {
    // Prepend env var exports so they survive shell nesting
    let fullCmd = cmd
    if (envVars && Object.keys(envVars).length > 0) {
      const exports = Object.entries(envVars)
        .map(([k, v]) => `export ${k}="${v.replace(/"/g, '\\"')}"`)
        .join(' && ')
      fullCmd = `${exports} && ${cmd}`
    }

    const { command, args } = getShellCmd(fullCmd)
    console.log(`[install] Spawning: ${command} ${args[0]} ${args[1]} "${fullCmd.substring(0, 80)}..."`)

    const proc = spawn(command, args, { shell: false })
    installProcess = proc
    proc.stdin?.end() // close stdin — non-interactive

    // Stale output timer — kill if no output for 3 minutes
    let staleTimer: ReturnType<typeof setTimeout> | null = null
    const resetStale = (): void => {
      if (staleTimer) clearTimeout(staleTimer)
      staleTimer = setTimeout(() => {
        sendOutput(win, 'Timed out — no output for 180 seconds', 'error')
        proc.kill()
      }, 180000)
    }
    resetStale()

    proc.stdout?.on('data', (data: Buffer) => {
      resetStale()
      for (const line of data.toString().split('\n')) {
        if (line.trim()) sendOutput(win, line, 'stdout')
      }
    })

    proc.stderr?.on('data', (data: Buffer) => {
      resetStale()
      for (const line of data.toString().split('\n')) {
        if (line.trim()) sendOutput(win, line, 'stderr')
      }
    })

    proc.on('close', (code) => {
      if (staleTimer) clearTimeout(staleTimer)
      installProcess = null
      resolve(code ?? 1)
    })

    proc.on('error', (err) => {
      if (staleTimer) clearTimeout(staleTimer)
      installProcess = null
      reject(err)
    })
  })
}

// ── IPC Handlers ────────────────────────────────────────────────────────────

export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null): void {

  // System checks
  ipcMain.handle('check-system-requirements', async () => {
    return await runSystemChecks()
  })

  // API key validation
  ipcMain.handle('validate-api-key', async (_event, provider: string, apiKey: string) => {
    switch (provider) {
      case 'nvidia':
        return validateWithRetry('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
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
          headers: { 'x-api-key': apiKey, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-3-5-haiku-20241022', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
        })
      case 'gemini':
        return validateWithRetry(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {})
      default:
        return { valid: false, message: 'Unknown provider' }
    }
  })

  // ── The actual install — just runs the official script ──────────────────
  ipcMain.handle('run-install', async (_event, config: InstallConfig) => {
    const win = getMainWindow()
    if (!win) return

    const isOllama = config.provider === 'ollama'

    // Provider mapping: our UI id → what install.sh expects
    const cliProviderMap: Record<string, string> = {
      nvidia: 'cloud', openai: 'openai', anthropic: 'anthropic',
      gemini: 'gemini', ollama: 'ollama'
    }
    const cliProvider = cliProviderMap[config.provider] || config.provider

    // API key env var name per provider
    const keyEnvMap: Record<string, string> = {
      nvidia: 'NVIDIA_API_KEY', openai: 'OPENAI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY', gemini: 'GOOGLE_API_KEY'
    }

    // Build env vars for non-interactive install
    const env: Record<string, string> = {
      NEMOCLAW_NON_INTERACTIVE: '1',
      NEMOCLAW_PROVIDER: cliProvider,
      NEMOCLAW_SANDBOX_NAME: config.sandboxName,
      NEMOCLAW_MODEL: config.modelName
    }

    // Set API key only for cloud providers
    if (!isOllama && config.apiKey) {
      const keyVar = keyEnvMap[config.provider] || 'NVIDIA_API_KEY'
      env[keyVar] = config.apiKey
    }

    sendOutput(win, 'Starting NemoClaw installation...', 'info')
    sendOutput(win, `Provider: ${config.providerLabel} | Model: ${config.modelName} | Sandbox: ${config.sandboxName}`, 'info')
    sendOutput(win, '', 'info')

    try {
      // We configure npm to use a user-local directory before running the script
      // This prevents EACCES (Permission Denied) errors on Macs using Homebrew Node
      const installCmd = 'mkdir -p ~/.npm-global && npm config set prefix "$HOME/.npm-global" && export PATH="$HOME/.npm-global/bin:$PATH" && curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash'

      sendOutput(win, `Running: curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash`, 'info')
      sendOutput(win, '─'.repeat(60), 'info')

      const exitCode = await spawnStreaming(win, installCmd, env)

      if (exitCode === 0) {
        sendOutput(win, '', 'info')
        sendOutput(win, '✓ Installation completed successfully!', 'success')
        win.webContents.send('install-complete', {
          success: true, code: 0, message: 'Installation completed successfully'
        } as InstallCompleteEvent)
      } else {
        sendOutput(win, '', 'info')
        sendOutput(win, `Installation failed with exit code ${exitCode}`, 'error')
        win.webContents.send('install-complete', {
          success: false, code: exitCode, message: `Installation failed (exit code ${exitCode})`
        } as InstallCompleteEvent)
      }
    } catch (err) {
      const msg = (err as Error).message || 'Unknown error'
      sendOutput(win, `Error: ${msg}`, 'error')
      win.webContents.send('install-complete', {
        success: false, code: 1, message: msg
      } as InstallCompleteEvent)
    }
  })

  // Cancel
  ipcMain.handle('cancel-install', async () => {
    if (installProcess) { installProcess.kill(); installProcess = null }
  })

  // External links
  ipcMain.handle('open-external', async (_event, url: string) => {
    await shell.openExternal(url)
  })

  // Window controls
  ipcMain.on('window-minimize', () => getMainWindow()?.minimize())
  ipcMain.on('window-maximize', () => {
    const win = getMainWindow()
    if (win?.isMaximized()) win.unmaximize()
    else win?.maximize()
  })
  ipcMain.on('window-close', () => getMainWindow()?.close())

  // Cleanup listeners
  ipcMain.handle('remove-install-listeners', async () => {
    const win = getMainWindow()
    if (win) {
      win.webContents.removeAllListeners('install-output')
      win.webContents.removeAllListeners('install-complete')
    }
  })
}
