// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("launcher", {
  // Splash screen channels
  onProgress: (cb) => ipcRenderer.on("pull-progress", (_e, data) => cb(data)),
  onStatus: (cb) => ipcRenderer.on("status-update", (_e, msg) => cb(msg)),

  // App channels
  getGatewayPort: () => ipcRenderer.invoke("get-gateway-port"),
  getConfig: () => ipcRenderer.invoke("get-config"),
  isFirstRun: () => ipcRenderer.invoke("is-first-run"),
  markOnboardingComplete: (data) => ipcRenderer.invoke("mark-onboarding-complete", data),
  resetOnboarding: () => ipcRenderer.invoke("reset-onboarding"),

  // File system channels
  selectFolder: () => ipcRenderer.invoke("select-folder"),
  readFile: (filePath) => ipcRenderer.invoke("fs-read-file", filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke("fs-write-file", filePath, content),
  listDir: (dirPath) => ipcRenderer.invoke("fs-list-dir", dirPath),
  getMountedFolders: () => ipcRenderer.invoke("get-mounted-folders"),
  mountFolder: (data) => ipcRenderer.invoke("mount-folder", data),
  unmountFolder: (folderPath) => ipcRenderer.invoke("unmount-folder", folderPath),

  // Database channels
  db: {
    createSession: (title) => ipcRenderer.invoke("db-create-session", title),
    getSessions: () => ipcRenderer.invoke("db-get-sessions"),
    saveMessage: (sessionId, role, content) => ipcRenderer.invoke("db-save-message", sessionId, role, content),
    getMessages: (sessionId) => ipcRenderer.invoke("db-get-messages", sessionId),
    updateSessionTitle: (sessionId, title) => ipcRenderer.invoke("db-update-session-title", sessionId, title),
    deleteSession: (id) => ipcRenderer.invoke("db-delete-session", id)
  },

  // Model selection
  getModels: () => ipcRenderer.invoke("get-ollama-models"),
  setModel: (modelName) => ipcRenderer.invoke("set-ollama-model", modelName)
});
