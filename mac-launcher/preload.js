const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nemoclaw", {
  onProgress: (callback) => {
    ipcRenderer.on("ollama-progress", (_event, data) => callback(data));
  },
  onStatus: (callback) => {
    ipcRenderer.on("setup-status", (_event, data) => callback(data));
  },
  onError: (callback) => {
    ipcRenderer.on("setup-error", (_event, data) => callback(data));
  },
});
