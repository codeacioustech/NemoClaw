const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nemoclaw", {
  onStatus: (callback) => {
    ipcRenderer.on("status", (_event, data) => callback(data));
  },
});
