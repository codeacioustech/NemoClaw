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
  return { command: 'bash', args: ['-l', '-c', cmd] }
}

function sendOutput(win: BrowserWindow, line: string, type: InstallOutputEvent['type']): void {
  win.webContents.send('install-output', { line, type } as InstallOutputEvent)
}

function spawnStreaming(
  win: BrowserWindow,
  cmd: string,
  env?: Record<string, string>
): Promise<number> {
  return new Promise((resolve, reject) => {
    const { command, args } = getShellCmd(cmd)
    const proc = spawn(command, args, {
      shell: false,
      env: { ...process.env, ...env }
    })

    installProcess = proc

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

    const env = { NEMOCLAW_NON_INTERACTIVE: '1' }

    try {
      // Step 1: Check if CLI is already installed
      sendOutput(win, 'Checking if NemoClaw CLI is already installed...', 'info')
      const checkCmd = 'nemoclaw --version'
      const { command: chkCmd, args: chkArgs } = getShellCmd(checkCmd)
      const checkResult = await new Promise<number>((resolve) => {
        const proc = spawn(chkCmd, chkArgs, { shell: false })
        proc.on('close', (code) => resolve(code ?? 1))
        proc.on('error', () => resolve(1))
      })

      if (checkResult !== 0) {
        // Step 2: Install CLI with retries
        sendOutput(win, 'Installing NemoClaw CLI...', 'info')
        let installSuccess = false

        for (let attempt = 1; attempt <= 3; attempt++) {
          if (attempt > 1) {
            sendOutput(win, `Retry attempt ${attempt}/3...`, 'info')
          }
          const curlCmd = 'curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash'
          const code = await spawnStreaming(win, curlCmd, env)
          if (code === 0) {
            installSuccess = true
            break
          }
          if (attempt < 3) {
            sendOutput(win, `Download failed (exit code ${code}), retrying...`, 'stderr')
          }
        }

        if (!installSuccess) {
          const evt: InstallCompleteEvent = {
            success: false,
            code: 1,
            message: 'CLI installation failed after 3 attempts'
          }
          win.webContents.send('install-complete', evt)
          return
        }

        // Verify CLI is available after install
        sendOutput(win, 'Verifying CLI installation...', 'info')
        const verifyCmd = 'nemoclaw --version'
        const verifyCode = await spawnStreaming(win, verifyCmd, env)
        if (verifyCode !== 0) {
          sendOutput(win, 'CLI installed but not found in PATH. Trying with fresh shell...', 'stderr')
        }
      } else {
        sendOutput(win, 'NemoClaw CLI already installed, skipping download', 'success')
      }

      // Step 3: Write credentials
      sendOutput(win, 'Writing credentials...', 'info')
      const credJson = JSON.stringify({
        provider: config.provider,
        api_key: config.apiKey,
        model: config.modelName
      })
      const escapedJson = credJson.replace(/'/g, "'\\''")

      let writeCredCmd: string
      if (process.platform === 'win32') {
        writeCredCmd = `mkdir -p ~/.nemoclaw && echo '${escapedJson}' > ~/.nemoclaw/credentials.json`
      } else {
        writeCredCmd = `mkdir -p ~/.nemoclaw && echo '${escapedJson}' > ~/.nemoclaw/credentials.json`
      }
      const credCode = await spawnStreaming(win, writeCredCmd, env)
      if (credCode !== 0) {
        sendOutput(win, 'Warning: Could not write credentials file', 'error')
      }

      // Step 4: Run onboard
      sendOutput(win, 'Running NemoClaw onboard...', 'info')
      const onboardCmd = `nemoclaw onboard --non-interactive --name ${config.sandboxName}`
      const onboardCode = await spawnStreaming(win, onboardCmd, env)

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

      // Step 5: Write install log
      try {
        const logLines: string[] = []
        const logListener = (_e: unknown, data: InstallOutputEvent): void => {
          logLines.push(data.line)
        }
        // Log is already streamed, just attempt to save it
        const logCmd = `echo 'Install completed at ${new Date().toISOString()}' >> ~/.nemoclaw/install.log`
        await spawnStreaming(win, logCmd, env)
      } catch {
        // Non-critical, ignore
      }
    } catch (err) {
      const message = (err as Error).message || 'Unknown error'
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
