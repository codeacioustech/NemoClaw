/**
 * Router — Decides which UI flow to show based on platform and config state.
 *
 * macOS (darwin):
 *   Every launch → Bootstrap checks (Docker, Ollama, model, sandbox)
 *     First launch  → Bootstrap → Onboarding → Launch OpenClaw
 *     Return launch → Bootstrap (quick checks) → Launch OpenClaw directly
 *
 * Windows / Linux:
 *   First launch  → 6-step wizard installer (app.ts) → Launch OpenClaw
 *   Return launch → Launch OpenClaw directly
 */

// Dynamic imports to avoid loading unnecessary code per platform
let wizardLoaded = false

export async function initRouter(): Promise<void> {
  const platform = window.electronAPI.getPlatform()
  const config = await window.electronAPI.getConfig()

  // macOS: ALWAYS run bootstrap checks on every launch.
  // Bootstrap is idempotent — it skips steps that are already done.
  // After bootstrap, it will either go to onboarding (first launch)
  // or launch OpenClaw directly (return launch with setupComplete).
  if (platform === 'darwin') {
    hideLegacyUI()
    const { renderBootstrapView } = await import('./bootstrap-view')
    renderBootstrapView(getOcRoot())
    return
  }

  // Windows / Linux: if setup is complete, launch OpenClaw directly
  if (config && config.setupComplete) {
    hideLegacyUI()
    showConnectingScreen(getOcRoot())
    return
  }

  // Windows / Linux first launch: load wizard installer
  loadWizardInstaller()
}

/**
 * Shows a loading screen while discovering the OpenClaw URL,
 * then tells the main process to load it in the BrowserWindow.
 */
function showConnectingScreen(container: HTMLElement): void {
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:20px;font-family:'Inter',sans-serif;color:#e0e0e0;">
      <div style="width:60px;height:60px;border:3px solid rgba(118,185,0,0.3);border-top-color:#76b900;border-radius:50%;animation:oc-spin 1s linear infinite;"></div>
      <h2 style="margin:0;font-size:1.4rem;">Connecting to OpenClaw...</h2>
      <p id="oc-connect-status" style="margin:0;color:#888;font-size:0.9rem;">Starting services and discovering URL</p>
      <style>@keyframes oc-spin{to{transform:rotate(360deg)}}</style>
    </div>
  `

  // Listen for status updates from main process
  window.electronAPI.onOpenclawStatus((message: string) => {
    const el = document.getElementById('oc-connect-status')
    if (el) el.textContent = message
  })

  // Ask main process to discover URL and load it
  window.electronAPI.launchOpenClaw().then((result) => {
    window.electronAPI.removeOpenclawListeners()
    if (!result.success) {
      container.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:20px;font-family:'Inter',sans-serif;color:#e0e0e0;">
          <div style="font-size:3rem;">&#x26A0;</div>
          <h2 style="margin:0;font-size:1.4rem;color:#ff6b6b;">Failed to connect to OpenClaw</h2>
          <p style="margin:0;color:#888;font-size:0.9rem;max-width:400px;text-align:center;">${result.error || 'Unknown error'}</p>
          <button id="oc-retry-btn" style="margin-top:12px;padding:10px 28px;background:#76b900;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer;">Retry</button>
        </div>
      `
      document.getElementById('oc-retry-btn')?.addEventListener('click', () => {
        showConnectingScreen(container)
      })
    }
  })
}

function hideLegacyUI(): void {
  const app = document.getElementById('app')
  if (app) app.style.display = 'none'

  const ocRoot = getOcRoot()
  ocRoot.style.display = 'flex'
}

function showLegacyUI(): void {
  const app = document.getElementById('app')
  if (app) app.style.display = 'flex'

  const ocRoot = getOcRoot()
  ocRoot.style.display = 'none'
}

function getOcRoot(): HTMLElement {
  let root = document.getElementById('oc-root')
  if (!root) {
    root = document.createElement('div')
    root.id = 'oc-root'
    document.body.appendChild(root)
  }
  return root
}

function loadWizardInstaller(): void {
  if (wizardLoaded) return
  wizardLoaded = true
  showLegacyUI()
  // app.ts auto-initializes on DOMContentLoaded, which has already fired.
  // The import triggers its side effect (new NemoClawWizard).
  import('./app')
}

// ── Navigation helpers (called from views) ──────────────────────────────────

export async function navigateToOnboarding(): Promise<void> {
  const { renderOnboarding } = await import('./onboarding-view')
  renderOnboarding(getOcRoot())
}

// ── Init ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initRouter()
})
