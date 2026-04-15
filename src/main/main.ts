import { app, BrowserWindow, Menu, ipcMain } from 'electron'
import { join } from 'path'
import { registerIpcHandlers } from './ipc-handlers'
import { registerConfigHandlers, getConfig, saveConfig } from './config-service'
import { runMacBootstrap } from './mac-bootstrap'
import { getOpenClawUrl, extractTokenFromContainer, stopSandboxLogStream, ensurePortForward } from './openclaw-service'

const IS_DEV = !!process.env.ELECTRON_RENDERER_URL

// Tracks whether the window is currently trying to load the OpenClaw URL.
// Used by did-fail-load to know if a load failure means "OpenClaw wouldn't
// load" (recover by going back to installer) vs. an unrelated sub-resource
// failure inside the installer itself (ignore).
let loadingOpenClawUrl = false

/**
 * Navigate the window back to the installer renderer (dev URL or file).
 * Used as a recovery path when loadURL to the OpenClaw tokenized URL fails.
 */
function loadInstallerUI(win: BrowserWindow): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

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

  // Dev mode: auto-open DevTools in detached window so it survives navigation
  // to the OpenClaw URL (otherwise the main window's DevTools disconnects
  // when we loadURL to http://127.0.0.1:18789/).
  if (IS_DEV) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  // Guard against stranding the user on a blank Chromium error page. If the
  // OpenClaw URL fails to load (port forward dead, sandbox restarted, stale
  // token, etc.) navigate back to the installer and surface the error via
  // IPC so the renderer can show a Retry button instead of a blank screen.
  mainWindow.webContents.on('did-fail-load', (
    _event: unknown,
    errorCode: number,
    errorDescription: string,
    validatedURL: string,
    isMainFrame: boolean
  ) => {
    if (!isMainFrame) return
    if (errorCode === -3) return // ERR_ABORTED from our own navigation
    if (!loadingOpenClawUrl) return // not our OpenClaw load — ignore

    console.error(`[Main] did-fail-load: ${errorDescription} (${errorCode}) for ${validatedURL}`)
    loadingOpenClawUrl = false

    if (!mainWindow) return
    loadInstallerUI(mainWindow)
    // Wait for the installer to be ready, then tell it what happened
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow?.webContents.send('openclaw-load-failed', {
        url: validatedURL,
        errorCode,
        errorDescription
      })
    })
  })

  // When OpenClaw actually finishes loading, clear the flag so subsequent
  // sub-resource failures inside OpenClaw (which fire did-fail-load too)
  // don't trigger the installer recovery.
  mainWindow.webContents.on('did-finish-load', () => {
    loadingOpenClawUrl = false
  })

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

    // Forward process dies when the app quits; re-establish it before loadURL
    // so we don't get ERR_CONNECTION_REFUSED on relaunches.
    win.webContents.send('openclaw-status', 'Restoring port forward...')
    const forwardOk = await ensurePortForward(sandboxName)
    if (!forwardOk) {
      console.warn('[Main] ensurePortForward failed — falling through to URL discovery')
      // Fall through to the slow-path discovery below, don't give up yet
    } else {
      resizeForOpenClaw(win)
      loadingOpenClawUrl = true
      win.loadURL(savedUrl)
      return { success: true }
    }
  }

  // Slow path: discover URL via nemoclaw CLI strategies
  try {
    win.webContents.send('openclaw-status', 'Discovering OpenClaw URL...')
    const url = await getOpenClawUrl(sandboxName)
    const finalUrl = url || savedUrl

    if (finalUrl) {
      saveConfig({ openclawUrl: finalUrl })
      resizeForOpenClaw(win)
      loadingOpenClawUrl = true
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
            loadingOpenClawUrl = true
            win.loadURL(tokenizedUrl)
            return { success: true }
          }
        }
        loadingOpenClawUrl = true
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

  // macOS: run bootstrap exactly ONCE per app launch, on the initial renderer
  // load. Using .once() is critical — later navigations (e.g. loadURL to the
  // tokenized OpenClaw URL) would otherwise re-fire did-finish-load and kick
  // off a second bootstrap that bounces the port-18789 forward mid-session,
  // killing the UI's WebSocket to the sandbox.
  if (process.platform === 'darwin' && mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => {
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
  stopSandboxLogStream()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopSandboxLogStream()
})
