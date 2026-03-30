import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronAPI, InstallConfig, InstallOutputEvent, InstallCompleteEvent } from '../shared/types'

const api: ElectronAPI = {
  checkSystemRequirements: () => ipcRenderer.invoke('check-system-requirements'),

  validateApiKey: (provider: string, apiKey: string) =>
    ipcRenderer.invoke('validate-api-key', provider, apiKey),

  runInstall: (config: InstallConfig) => ipcRenderer.invoke('run-install', config),

  cancelInstall: () => ipcRenderer.invoke('cancel-install'),

  onInstallOutput: (callback: (event: InstallOutputEvent) => void) => {
    ipcRenderer.on('install-output', (_event, data: InstallOutputEvent) => callback(data))
  },

  onInstallComplete: (callback: (event: InstallCompleteEvent) => void) => {
    ipcRenderer.on('install-complete', (_event, data: InstallCompleteEvent) => callback(data))
  },

  removeInstallListeners: () => {
    ipcRenderer.removeAllListeners('install-output')
    ipcRenderer.removeAllListeners('install-complete')
  },

  openExternalLink: (url: string) => ipcRenderer.invoke('open-external', url),

  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),

  getPlatform: () => process.platform
}

contextBridge.exposeInMainWorld('electronAPI', api)
