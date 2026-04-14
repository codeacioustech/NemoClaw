import { app, BrowserWindow, Menu, ipcMain } from 'electron'
import { join } from 'path'
import { registerIpcHandlers } from './ipc-handlers'
import { registerConfigHandlers, getConfig, saveConfig } from './config-service'
import { runMacBootstrap } from './mac-bootstrap'
import { getOpenClawUrl, extractTokenFromContainer } from './openclaw-service'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    resizable: true,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/**
 * Discover the OpenClaw URL and load it in the main window.
 * Prioritizes the saved tokenized URL from config (captured during bootstrap).
 * Falls back to multi-strategy discovery if no saved URL is available.
 * Returns { success, error? }.
 */
async function launchOpenClawInWindow(win: BrowserWindow): Promise<{ success: boolean; error?: string }> {
  const config = getConfig()
  const sandboxName = config?.sandboxName || 'open-coot-default'
  const savedUrl = config?.openclawUrl

  win.webContents.send('openclaw-status', 'Connecting to OpenClaw service...')

  // Fast path: use saved tokenized URL from bootstrap (already has #token=...)
  if (savedUrl && savedUrl.includes('#token=')) {
    console.log('[Main] Using saved tokenized URL from config')
    win.webContents.send('openclaw-status', 'Loading OpenClaw...')
    resizeForOpenClaw(win)
    win.loadURL(savedUrl)
    return { success: true }
  }

  // Slow path: discover URL via nemoclaw CLI strategies
  try {
    win.webContents.send('openclaw-status', 'Discovering OpenClaw URL...')
    const url = await getOpenClawUrl(sandboxName)
    const finalUrl = url || savedUrl

    if (finalUrl) {
      saveConfig({ openclawUrl: finalUrl })
      resizeForOpenClaw(win)
      win.loadURL(finalUrl)
      return { success: true }
    }

    return { success: false, error: 'OpenClaw service failed to respond. Make sure Docker and your sandbox are running.' }
  } catch (err) {
    const message = (err as Error).message
    console.error('[Main] Error launching OpenClaw:', message)

    // Try saved URL as last fallback (even without token)
    if (savedUrl) {
      console.log('[Main] Trying saved URL as fallback...')
      try {
        if (!savedUrl.includes('#token=')) {
          const token = await extractTokenFromContainer(sandboxName)
          if (token) {
            const tokenizedUrl = savedUrl.replace(/\/?$/, '/#token=' + token)
            saveConfig({ openclawUrl: tokenizedUrl })
            win.loadURL(tokenizedUrl)
            return { success: true }
          }
        }
        win.loadURL(savedUrl)
        return { success: true }
      } catch {
        // fallback also failed
      }
    }

    return { success: false, error: message }
  }
}

function resizeForOpenClaw(win: BrowserWindow): void {
  win.setMinimumSize(1000, 700)
  const [w, h] = win.getSize()
  if (w < 1200 || h < 800) {
    win.setSize(1400, 900)
    win.center()
  }
}

// Register IPC handlers before window creation
registerIpcHandlers(() => mainWindow)
registerConfigHandlers()

// ── launch-openclaw IPC handler ────────────────────────────────────────────
// Called by the renderer after install/onboarding completes, or on return launches
ipcMain.handle('launch-openclaw', async () => {
  if (!mainWindow) return { success: false, error: 'No window available' }
  return launchOpenClawInWindow(mainWindow)
})

app.whenReady().then(async () => {
  // Set application menu with Edit role so Cmd+C/V/X/A (mac) and Ctrl+C/V/X/A work
  // Required for frameless windows where the default menu is absent
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as const] : []),
    { role: 'editMenu' }
  ]))

  createWindow()

  // macOS: ALWAYS run bootstrap on every launch.
  // Bootstrap is idempotent — it checks Docker, Ollama, model, sandbox
  // and skips anything already installed. This catches cases where
  // Docker containers were deleted, models changed, etc.
  if (process.platform === 'darwin' && mainWindow) {
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        if (mainWindow) {
          runMacBootstrap(mainWindow).catch((err) => {
            console.error('[Main] Bootstrap failed:', err)
            mainWindow?.webContents.send('bootstrap-progress', {
              stage: 'error',
              status: 'error',
              message: `Bootstrap failed: ${err.message}`,
              progress: 0
            })
          })
        }
      }, 500)
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
