// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");

const paths = require("./lib/paths");
const { seedAll, GATEWAY_PORT, MODEL, NEMOCLAW_DIR } = require("./lib/config-seeder");
const { startGateway, waitForGateway } = require("./lib/gateway");
const { startProxy, waitForProxy } = require("./lib/ollama-proxy");
const { trackProcess, trackServer, hookElectronLifecycle } = require("./lib/cleanup");

const OLLAMA_HOST = "127.0.0.1";
const OLLAMA_PORT = 11434;
const LAUNCHER_CONFIG = path.join(NEMOCLAW_DIR, "launcher_config.json");
const OPENCLAW_CONFIG = path.join(os.homedir(), ".openclaw", "openclaw.json");

let splashWindow = null;
let mainWindow = null;
let proxyServer = null;

// ---------------------------------------------------------------------------
// Launcher config persistence
// ---------------------------------------------------------------------------

function readLauncherConfig() {
  try {
    return JSON.parse(fs.readFileSync(LAUNCHER_CONFIG, "utf-8"));
  } catch {
    return {};
  }
}

function writeLauncherConfig(data) {
  const dir = path.dirname(LAUNCHER_CONFIG);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(LAUNCHER_CONFIG, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Splash window
// ---------------------------------------------------------------------------

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 480,
    height: 360,
    frame: false,
    resizable: false,
    transparent: false,
    backgroundColor: "#0d1117",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  splashWindow.loadFile("splash.html");
  return splashWindow;
}

function sendStatus(text) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send("status-update", { text });
  }
}

function sendError(error) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send("status-update", { error });
  }
}

function sendProgress(data) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send("pull-progress", data);
  }
}

// ---------------------------------------------------------------------------
// Ollama management
// ---------------------------------------------------------------------------

function spawnOllama() {
  const ollamaPath = paths.resolveOllama();
  const child = spawn(ollamaPath, ["serve"], {
    env: {
      ...process.env,
      OLLAMA_HOST: `${OLLAMA_HOST}:${OLLAMA_PORT}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  trackProcess("ollama", child);
  return child;
}

function waitForOllama(timeoutMs = 15000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function poll() {
      if (Date.now() > deadline) {
        return reject(new Error("Ollama did not start in time"));
      }
      const req = http.get(`http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/tags`, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => setTimeout(poll, intervalMs));
      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(poll, intervalMs);
      });
    }
    poll();
  });
}

function pullModel() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ name: MODEL, stream: true });
    const req = http.request(
      {
        hostname: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: "/api/pull",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let buffer = "";
        res.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const json = JSON.parse(line);
              if (json.total) {
                sendProgress({ completed: json.completed || 0, total: json.total });
              } else if (json.status) {
                sendProgress({ status: json.status });
              }
              if (json.status === "success") {
                resolve();
              }
            } catch {
              // ignore malformed lines
            }
          }
        });
        res.on("end", () => resolve());
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "open-coot",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  return mainWindow;
}

// ---------------------------------------------------------------------------
// Bootstrap flow
// ---------------------------------------------------------------------------

async function bootstrap() {
  const config = readLauncherConfig();
  const isFirstRun = !config.launcher_setup_complete;

  if (isFirstRun) {
    createSplashWindow();
    await new Promise((r) => setTimeout(r, 500)); // let splash render
  }

  // 1. Start Ollama
  sendStatus("Starting Ollama...");
  spawnOllama();

  try {
    await waitForOllama();
  } catch (err) {
    sendError(`Ollama failed to start: ${err.message}`);
    return;
  }

  // 2. Pull model on first run
  if (isFirstRun) {
    sendStatus(`Downloading model: ${MODEL}`);
    try {
      await pullModel();
    } catch (err) {
      console.error(`Model pull failed: ${err.message}`);
      sendStatus(`Model pull failed (${err.message}) — continuing startup...`);
    }

    // 3. Seed configs
    sendStatus("Configuring NemoClaw...");
    seedAll();

    // 4. Mark setup complete
    writeLauncherConfig({
      launcher_setup_complete: true,
      ollama_model: MODEL,
      gateway_port: GATEWAY_PORT,
      setupCompletedAt: new Date().toISOString(),
    });
  }

  // Ensure gateway config has required settings
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG, "utf-8");
    const cfg = JSON.parse(raw);
    let dirty = false;

    // Disable device auth for local Control UI
    if (!cfg.gateway) cfg.gateway = {};
    if (!cfg.gateway.controlUi || !cfg.gateway.controlUi.dangerouslyDisableDeviceAuth) {
      cfg.gateway.controlUi = { ...cfg.gateway.controlUi, dangerouslyDisableDeviceAuth: true };
      dirty = true;
    }

    // Increase LLM idle timeout and skip bootstrap for local models
    if (!cfg.agents) cfg.agents = {};
    if (!cfg.agents.defaults) cfg.agents.defaults = {};
    if (!cfg.agents.defaults.llm || cfg.agents.defaults.llm.idleTimeoutSeconds < 300) {
      cfg.agents.defaults.llm = { ...cfg.agents.defaults.llm, idleTimeoutSeconds: 300 };
      dirty = true;
    }
    if (cfg.agents.defaults.skipBootstrap !== true) {
      cfg.agents.defaults.skipBootstrap = true;
      dirty = true;
    }
    if (cfg.agents.defaults.heartbeat?.every) {
      delete cfg.agents.defaults.heartbeat.every;
      dirty = true;
    }

    if (dirty) {
      fs.writeFileSync(OPENCLAW_CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    }
  } catch {
    // Config will be created by seedAll on first run
  }

  // 5. Start inference proxy
  sendStatus("Starting inference proxy...");
  proxyServer = startProxy();
  trackServer(proxyServer);

  try {
    await waitForProxy();
  } catch (err) {
    sendError(`Inference proxy failed to start: ${err.message}`);
    return;
  }

  // 6. Start gateway
  sendStatus("Starting gateway...");
  const gatewayChild = startGateway(
    (out) => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        // Forward gateway logs during startup
      }
    },
    (err) => {
      console.error("[gateway stderr]", err);
    }
  );
  trackProcess("gateway", gatewayChild);

  gatewayChild.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`Gateway exited with code ${code}`);
    }
  });

  // 6. Wait for gateway readiness
  try {
    await waitForGateway();
  } catch (err) {
    sendError(`Gateway failed to start: ${err.message}`);
    return;
  }

  // 7. Show main window
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
    splashWindow = null;
  }

  createMainWindow();
}

// ---------------------------------------------------------------------------
// IPC handlers for renderer
// ---------------------------------------------------------------------------

ipcMain.handle("get-gateway-port", () => GATEWAY_PORT);

ipcMain.handle("get-config", () => readLauncherConfig());

ipcMain.handle("is-first-run", () => {
  const config = readLauncherConfig();
  return !config.launcher_setup_complete;
});

ipcMain.handle("mark-onboarding-complete", (_event, data) => {
  const existing = readLauncherConfig();
  writeLauncherConfig({
    ...existing,
    launcher_setup_complete: true,
    onboarding: data || {},
    gateway_port: GATEWAY_PORT,
    setupCompletedAt: new Date().toISOString(),
  });
  return true;
});

// ---------------------------------------------------------------------------
// File system IPC — folder mounting & sandboxed file access
// ---------------------------------------------------------------------------

function getMountedFolderForPath(filePath) {
  const folders = readLauncherConfig().mountedFolders || [];
  const resolved = path.resolve(filePath);
  for (const folder of folders) {
    const root = path.resolve(folder.path);
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return folder;
    }
  }
  return null;
}

function validatePathInMountedFolders(filePath) {
  const resolved = path.resolve(filePath);
  // Block path traversal attempts
  if (filePath.includes("..")) {
    throw new Error("Path traversal not allowed");
  }
  const folder = getMountedFolderForPath(resolved);
  if (!folder) {
    throw new Error("Path is not within a mounted folder");
  }
  return folder;
}

async function withBookmarkAccess(filePath, fn) {
  const folder = validatePathInMountedFolders(filePath);
  let stopAccess = null;
  if (folder.bookmark) {
    stopAccess = app.startAccessingSecurityScopedResource(folder.bookmark);
  }
  try {
    return await fn();
  } finally {
    if (stopAccess) stopAccess();
  }
}

ipcMain.handle("select-folder", async () => {
  if (!mainWindow) return null;
  const { canceled, filePaths, bookmarks } = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
    securityScopedBookmarks: true,
  });
  if (canceled || filePaths.length === 0) return null;
  return { path: filePaths[0], bookmark: (bookmarks && bookmarks[0]) || null };
});

ipcMain.handle("fs-read-file", async (_, filePath) => {
  return withBookmarkAccess(filePath, () => fs.promises.readFile(filePath, "utf-8"));
});

ipcMain.handle("fs-write-file", async (_, filePath, content) => {
  return withBookmarkAccess(filePath, async () => {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(filePath, content, "utf-8");
    return { ok: true };
  });
});

ipcMain.handle("fs-list-dir", async (_, dirPath) => {
  return withBookmarkAccess(dirPath, async () => {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  });
});

ipcMain.handle("get-mounted-folders", () => {
  return readLauncherConfig().mountedFolders || [];
});

ipcMain.handle("mount-folder", (_, folderData) => {
  const cfg = readLauncherConfig();
  cfg.mountedFolders = cfg.mountedFolders || [];
  // Avoid duplicates
  if (cfg.mountedFolders.some((f) => f.path === folderData.path)) {
    return { ok: true, duplicate: true };
  }
  cfg.mountedFolders.push({
    path: folderData.path,
    bookmark: folderData.bookmark,
    addedAt: Date.now(),
  });
  writeLauncherConfig(cfg);
  return { ok: true };
});

ipcMain.handle("unmount-folder", (_, folderPath) => {
  const cfg = readLauncherConfig();
  cfg.mountedFolders = (cfg.mountedFolders || []).filter((f) => f.path !== folderPath);
  writeLauncherConfig(cfg);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  hookElectronLifecycle(app);
  bootstrap().catch((err) => {
    console.error("Bootstrap failed:", err);
    sendError(err.message);
  });
});
