// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const express = require("express");

const paths = require("./lib/paths");
const { seedAll, GATEWAY_PORT, MODEL, NEMOCLAW_DIR } = require("./lib/config-seeder");
const { startGateway, waitForGateway } = require("./lib/gateway");
const { startProxy, waitForProxy, warmUpModel } = require("./lib/ollama-proxy");
const { trackProcess, trackServer, hookElectronLifecycle } = require("./lib/cleanup");
const db = require("./lib/db");
const FileApprovalManager = require("./lib/file-approval");

const OLLAMA_HOST = "127.0.0.1";
const OLLAMA_PORT = 11434;
const LAUNCHER_CONFIG = path.join(NEMOCLAW_DIR, "launcher_config.json");
const OPENCLAW_CONFIG = path.join(os.homedir(), ".openclaw", "openclaw.json");

let splashWindow = null;
let mainWindow = null;
let proxyServer = null;
let fileApprovalManager = null;

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

const OLLAMA_URL = "https://github.com/ollama/ollama/releases/latest/download/ollama-darwin.tgz";
const OLLAMA_DEST = path.join(os.homedir(), ".nemoclaw", "ollama-mac");

function downloadOllama() {
  fs.mkdirSync(OLLAMA_DEST, { recursive: true });
  const tgzPath = path.join(OLLAMA_DEST, "ollama-darwin.tgz");

  return new Promise((resolve, reject) => {
    const dl = spawn("curl", ["-L", OLLAMA_URL, "-o", tgzPath]);
    dl.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`curl exited with code ${code}`));
      const ext = spawn("tar", ["-xzf", tgzPath, "-C", OLLAMA_DEST]);
      ext.on("exit", (code2) => {
        if (code2 !== 0) return reject(new Error(`tar exited with code ${code2}`));
        try {
          fs.chmodSync(path.join(OLLAMA_DEST, "ollama"), 0o755);
          fs.unlinkSync(tgzPath);
        } catch (e) {
          return reject(e);
        }
        resolve();
      });
    });
  });
}

function checkModelExists(model) {
  return new Promise((resolve) => {
    const req = http.get(`http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/tags`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const { models = [] } = JSON.parse(data);
          resolve(models.some((m) => m.name === model || m.name === `${model}:latest`));
        } catch { resolve(false); }
      });
    });
    req.on("error", () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
  });
}

function spawnOllama() {
  const ollamaPath = paths.resolveOllama();
  if (!ollamaPath) throw new Error("Ollama binary not found");
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
  if (process.platform === "darwin" && typeof mainWindow.setWindowButtonVisibility === "function") {
    mainWindow.setWindowButtonVisibility(false);
  }
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  return mainWindow;
}

// ---------------------------------------------------------------------------
// Bootstrap flow
// ---------------------------------------------------------------------------

async function ensureSplash() {
  if (!splashWindow || splashWindow.isDestroyed()) {
    createSplashWindow();
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function bootstrap() {
  // Initialize file approval manager
  fileApprovalManager = new FileApprovalManager();

  const config = readLauncherConfig();
  const isFirstRun = !config.launcher_setup_complete;

  // Step 1 — Ensure Ollama binary exists
  let ollamaPath = paths.resolveOllama();
  if (!ollamaPath) {
    await ensureSplash();
    sendStatus("Installing Ollama...");
    try {
      await downloadOllama();
      ollamaPath = paths.resolveOllama();
      if (!ollamaPath) throw new Error("Binary not found after download");
    } catch (err) {
      sendError(`Ollama install failed: ${err.message}`);
      return;
    }
  }

  // Step 2 — Start & wait for Ollama
  sendStatus("Starting Ollama...");
  spawnOllama();

  try {
    await waitForOllama();
  } catch (err) {
    sendError(`Ollama failed to start: ${err.message}`);
    return;
  }

  // Step 3 + 4 — Check model, download if missing
  const modelPresent = await checkModelExists(MODEL);
  if (!modelPresent) {
    await ensureSplash();
    sendStatus(`Downloading model: ${MODEL}`);
    try {
      await pullModel();
    } catch (err) {
      console.error(`Model pull failed: ${err.message}`);
      sendStatus(`Model pull failed (${err.message}) — continuing startup...`);
    }
  }

  // Step 5 — First-run config seeding
  if (isFirstRun) {
    sendStatus("Configuring NemoClaw...");
    seedAll();

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

    // Allow the Electron renderer's file:// origin for WS handshake
    const requiredOrigins = ["file://", "null"];
    const currentOrigins = cfg.gateway.controlUi.allowedOrigins || [];
    const missingOrigins = requiredOrigins.filter((o) => !currentOrigins.includes(o));
    if (missingOrigins.length > 0) {
      cfg.gateway.controlUi.allowedOrigins = [...currentOrigins, ...missingOrigins];
      dirty = true;
    }

    // Increase LLM idle timeout — gateway watchdog must wait long enough for
    // gemma4:e4b to finish prompt-eval on a pruned but still sizeable payload.
    if (!cfg.agents.defaults.llm || cfg.agents.defaults.llm.idleTimeoutSeconds < 600) {
      cfg.agents.defaults.llm = { ...cfg.agents.defaults.llm, idleTimeoutSeconds: 600 };
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
    // Remove tools key entirely — the gateway schema rejects agents.defaults.tools
    // in any form (array or policy object). Tool filtering is handled exclusively
    // in ollama-proxy.js via the ALLOWED_TOOLS allow-list.
    if (cfg.agents.defaults.tools !== undefined) {
      delete cfg.agents.defaults.tools;
      dirty = true;
    }

    // Force the agent to route through the local ollama proxy. Without
    // this, openclaw rewrites the config to a minimal version that drops
    // our agents.defaults block and falls back to its built-in default
    // (openai/gpt-5.4), which has no API key here and fails immediately
    // with "No API key found for provider 'openai'".
    const ollamaModelId = `ollama/${MODEL}`;
    if (!cfg.agents.defaults.model) cfg.agents.defaults.model = {};
    if (cfg.agents.defaults.model.primary !== ollamaModelId) {
      cfg.agents.defaults.model.primary = ollamaModelId;
      dirty = true;
    }
    if (!cfg.agents.defaults.models || !cfg.agents.defaults.models[ollamaModelId]) {
      cfg.agents.defaults.models = { ...cfg.agents.defaults.models, [ollamaModelId]: {} };
      dirty = true;
    }

    // Restore the ollama provider entry if openclaw stripped it.
    if (!cfg.models) cfg.models = { mode: "merge", providers: {} };
    if (!cfg.models.providers) cfg.models.providers = {};
    if (!cfg.models.providers.ollama) {
      cfg.models.providers.ollama = {
        baseUrl: "http://127.0.0.1:11435",
        apiKey: "OLLAMA_API_KEY",
        api: "ollama",
        models: [{
          id: MODEL,
          name: "Gemma 4 E4B",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0 },
          contextWindow: 32768,
          maxTokens: 8192,
        }],
      };
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

  // Fire silent warm-up request so the model is in VRAM before the user
  // sends their first message. Non-blocking — we don't await it.
  warmUpModel(MODEL);

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

ipcMain.handle("db-create-session", (_, title) => db.createSession(title));
ipcMain.handle("db-get-sessions", () => db.getSessions());
ipcMain.handle("db-save-message", (_, sessionId, role, content) => db.saveMessage(sessionId, role, content));
ipcMain.handle("db-get-messages", (_, sessionId) => db.getMessages(sessionId));
ipcMain.handle("db-update-session-title", (_, sessionId, title) => db.updateSessionTitle(sessionId, title));
ipcMain.handle("db-delete-session", (_, id) => db.deleteSession(id));

ipcMain.handle("get-ollama-models", () => {
  return new Promise((resolve) => {
    http.get(`http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/tags`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data).models || []);
        } catch { resolve([]); }
      });
    }).on("error", () => resolve([]));
  });
});

ipcMain.handle("set-ollama-model", (_, modelName) => {
  const existing = readLauncherConfig();
  writeLauncherConfig({
    ...existing,
    ollama_model: modelName
  });
  return true;
});

ipcMain.handle("is-first-run", () => {
  const config = readLauncherConfig();
  return !config.launcher_setup_complete;
});

ipcMain.handle("reset-onboarding", () => {
  const existing = readLauncherConfig();
  writeLauncherConfig({
    ...existing,
    launcher_setup_complete: false,
    onboarding: {},
  });
  return { ok: true };
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

async function getMountedFolderForPath(resolvedPath) {
  const folders = readLauncherConfig().mountedFolders || [];
  for (const folder of folders) {
    let root;
    try {
      root = await fs.promises.realpath(folder.path);
    } catch {
      root = path.resolve(folder.path);
    }
    if (resolvedPath === root || resolvedPath.startsWith(root + path.sep)) {
      return folder;
    }
  }
  return null;
}

async function validatePathInMountedFolders(filePath) {
  // Block path traversal attempts
  if (filePath.includes("..")) {
    throw new Error("Path traversal not allowed");
  }

  let resolved;
  try {
    resolved = await fs.promises.realpath(filePath);
  } catch (err) {
    // If file doesn't exist, validate its real parent directory path
    try {
      const parentDir = await fs.promises.realpath(path.dirname(filePath));
      resolved = path.join(parentDir, path.basename(filePath));
    } catch (e) {
      resolved = path.resolve(filePath);
    }
  }

  const folder = await getMountedFolderForPath(resolved);
  if (!folder) {
    throw new Error("Path is not within a mounted folder");
  }
  return folder;
}

async function withBookmarkAccess(filePath, fn) {
  const folder = await validatePathInMountedFolders(filePath);
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

/**
 * Helper: Request approval for file access
 */
async function requestFileApproval(filePath) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("Main window not available");
  }

  const fileName = path.basename(filePath);
  const folderName = path.dirname(filePath);

  const result = await dialog.showMessageBox(mainWindow, {
    type: "question",
    buttons: ["Allow (this session)", "Allow (this chat)", "Deny"],
    title: "File Access Request",
    message: `Allow agent to access this file?`,
    detail: `File: ${fileName}\nPath: ${folderName}`,
    defaultId: 0,
    cancelId: 2,
  });

  // Button indices: 0 = session, 1 = chat, 2 = deny
  if (result.response === 2) {
    throw new Error("File access denied by user");
  }

  const scope = result.response === 0 ? "per-session" : "per-chat";
  fileApprovalManager.addApproval(filePath, scope);
  return scope;
}

/**
 * Helper: Check if file access is approved, request if needed
 */
async function ensureFileApproval(filePath) {
  const check = fileApprovalManager.isFileApproved(filePath);

  if (check.approved) {
    return;
  }

  // File is in mounted folder but not approved — ask user
  if (check.reason === "NOT_APPROVED" || check.reason === "SESSION_EXPIRED" || check.reason === "CHAT_CHANGED") {
    await requestFileApproval(filePath);
  }
}

ipcMain.handle("fs-read-file", async (_, filePath) => {
  // First, validate it's in a mounted folder
  await validatePathInMountedFolders(filePath);

  // Then, check approval
  await ensureFileApproval(filePath);

  // Finally, read with bookmark access
  return withBookmarkAccess(filePath, async () => {
    // Auto-detect: if path is a directory, list contents instead of error
    const stat = await fs.promises.stat(filePath);
    if (stat.isDirectory()) {
      const entries = await fs.promises.readdir(filePath, { withFileTypes: true });
      return JSON.stringify({
        type: "directory",
        path: filePath,
        contents: entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }))
      });
    }

    // Regular file read
    return fs.promises.readFile(filePath, "utf-8");
  });
});

ipcMain.handle("fs-write-file", async (_, filePath, content) => {
  console.log(`[fs-write-file] request path=${filePath} bytes=${content ? Buffer.byteLength(content) : 0}`);

  try {
    // First, validate it's in a mounted folder
    await validatePathInMountedFolders(filePath);

    // Then, check approval
    await ensureFileApproval(filePath);

    // Finally, write with bookmark access
    const result = await withBookmarkAccess(filePath, async () => {
      const dir = path.dirname(filePath);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(filePath, content, "utf-8");
      return { ok: true };
    });
    console.log(`[fs-write-file] wrote ${filePath}`);
    return result;
  } catch (err) {
    console.error(`[fs-write-file] failed ${filePath}: ${err.message}`);
    throw err;
  }
});

ipcMain.handle("fs-list-dir", async (_, dirPath) => {
  // First, validate it's in a mounted folder
  await validatePathInMountedFolders(dirPath);

  // Then, check approval
  await ensureFileApproval(dirPath);

  // Finally, list with bookmark access
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
// File access approval management
// ---------------------------------------------------------------------------

ipcMain.handle("set-current-chat-id", (_, chatId) => {
  if (fileApprovalManager) {
    fileApprovalManager.setCurrentChatId(chatId);
    return { ok: true, chatId };
  }
  return { ok: false };
});

ipcMain.handle("get-session-info", () => {
  if (fileApprovalManager) {
    return {
      sessionId: fileApprovalManager.currentSessionId,
      chatId: fileApprovalManager.currentChatId,
    };
  }
  return { sessionId: null, chatId: null };
});

ipcMain.handle("get-file-approvals", () => {
  if (fileApprovalManager) {
    return fileApprovalManager.getAllApprovals();
  }
  return [];
});

ipcMain.handle("revoke-file-approval", (_, filePath) => {
  if (fileApprovalManager) {
    const revoked = fileApprovalManager.revokeApproval(filePath);
    return { ok: true, revoked };
  }
  return { ok: false, revoked: false };
});

ipcMain.handle("clear-file-approvals", () => {
  if (fileApprovalManager) {
    fileApprovalManager.clearAllApprovals();
    return { ok: true };
  }
  return { ok: false };
});

ipcMain.handle("clear-expired-approvals", () => {
  if (fileApprovalManager) {
    fileApprovalManager.clearExpiredApprovals();
    return { ok: true };
  }
  return { ok: false };
});

// ---------------------------------------------------------------------------
// File Access HTTP API (for OpenClaw gateway to call)
// ---------------------------------------------------------------------------

function startFileAccessAPI() {
  const fileApp = express();
  fileApp.use(express.json());

  // POST /api/files/read - Read file or list directory
  fileApp.post("/api/files/read", async (req, res) => {
    const { filePath } = req.body;
    if (!filePath) {
      return res.status(400).json({ error: "Missing filePath" });
    }

    try {
      await validatePathInMountedFolders(filePath);
      await ensureFileApproval(filePath);

      const content = await withBookmarkAccess(filePath, async () => {
        const stat = await fs.promises.stat(filePath);
        if (stat.isDirectory()) {
          const entries = await fs.promises.readdir(filePath, { withFileTypes: true });
          return JSON.stringify({
            type: "directory",
            path: filePath,
            contents: entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }))
          });
        }
        return fs.promises.readFile(filePath, "utf-8");
      });

      res.json({ ok: true, content });
    } catch (err) {
      res.status(403).json({ error: err.message });
    }
  });

  // POST /api/files/write - Write file
  fileApp.post("/api/files/write", async (req, res) => {
    const { filePath, content } = req.body;
    if (!filePath || content === undefined) {
      return res.status(400).json({ error: "Missing filePath or content" });
    }

    try {
      await validatePathInMountedFolders(filePath);
      await ensureFileApproval(filePath);

      await withBookmarkAccess(filePath, async () => {
        const dir = path.dirname(filePath);
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(filePath, content, "utf-8");
      });

      res.json({ ok: true });
    } catch (err) {
      res.status(403).json({ error: err.message });
    }
  });

  // POST /api/files/list - List directory
  fileApp.post("/api/files/list", async (req, res) => {
    const { dirPath } = req.body;
    if (!dirPath) {
      return res.status(400).json({ error: "Missing dirPath" });
    }

    try {
      await validatePathInMountedFolders(dirPath);
      await ensureFileApproval(dirPath);

      const entries = await withBookmarkAccess(dirPath, async () => {
        const items = await fs.promises.readdir(dirPath, { withFileTypes: true });
        return items.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
      });

      res.json({ ok: true, entries });
    } catch (err) {
      res.status(403).json({ error: err.message });
    }
  });

  fileApp.listen(3001, "127.0.0.1", () => {
    console.log("[File API] Listening on http://127.0.0.1:3001");
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  hookElectronLifecycle(app);
  bootstrap().catch((err) => {
    console.error("Bootstrap failed:", err);
    sendError(err.message);
  });

  // Start file access API after bootstrap
  setTimeout(() => {
    startFileAccessAPI();
  }, 2000);
});
