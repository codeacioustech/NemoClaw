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
});
