export interface SystemCheckResult {
  id: string
  name: string
  status: 'pass' | 'fail' | 'warn'
  value: string
  message: string
  fixUrl?: string
  fixCommand?: string
}

export interface SystemCheckResponse {
  platform: NodeJS.Platform
  checks: SystemCheckResult[]
  allPassed: boolean
}

export interface InstallConfig {
  provider: 'nvidia' | 'openai' | 'anthropic' | 'gemini' | 'ollama'
  providerLabel: string
  apiKey: string
  sandboxName: string
  modelName: string
}

export interface InstallOutputEvent {
  line: string
  type: 'stdout' | 'stderr' | 'info' | 'error' | 'success' | 'debug'
}

export interface InstallCompleteEvent {
  success: boolean
  code: number | null
  message: string
}

export interface ElectronAPI {
  checkSystemRequirements: () => Promise<SystemCheckResponse>
  validateApiKey: (provider: string, apiKey: string) => Promise<{ valid: boolean; message?: string }>
  runInstall: (config: InstallConfig) => Promise<void>
  cancelInstall: () => Promise<void>
  onInstallOutput: (callback: (event: InstallOutputEvent) => void) => void
  onInstallComplete: (callback: (event: InstallCompleteEvent) => void) => void
  removeInstallListeners: () => void
  openExternalLink: (url: string) => Promise<void>
  minimizeWindow: () => void
  maximizeWindow: () => void
  closeWindow: () => void
  getPlatform: () => string
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
