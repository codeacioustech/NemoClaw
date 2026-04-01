/**
 * Router — Decides which UI flow to show based on platform and config state.
 *
 * macOS (darwin):
 *   First launch  → Bootstrap loading screen → Onboarding (4 steps) → Dashboard
 *   Return launch → Dashboard immediately
 *
 * Windows / Linux:
 *   Always → Existing 6-step wizard installer (app.ts)
 */

import type { AppConfig } from '../shared/types'

// Dynamic imports to avoid loading unnecessary code per platform
let wizardLoaded = false

export async function initRouter(): Promise<void> {
  const platform = window.electronAPI.getPlatform()

  if (platform !== 'darwin') {
    // Windows / Linux: load existing wizard
    loadWizardInstaller()
    return
  }

  // macOS: check config
  const config = await window.electronAPI.getConfig()

  if (config && config.setupComplete) {
    // Return launch — load dashboard directly
    hideLegacyUI()
    const { renderDashboard } = await import('./dashboard-view')
    renderDashboard(getOcRoot(), config)
  } else {
    // First launch — show bootstrap screen, main process will send events
    hideLegacyUI()
    const { renderBootstrapView } = await import('./bootstrap-view')
    renderBootstrapView(getOcRoot())
  }
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

export async function navigateToDashboard(config?: AppConfig | null): Promise<void> {
  const resolved = config || await window.electronAPI.getConfig()
  const { renderDashboard } = await import('./dashboard-view')
  renderDashboard(getOcRoot(), resolved)
}

// ── Init ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initRouter()
})
