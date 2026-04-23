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
const { startProxy, waitForProxy, warmUpModel } = require("./lib/ollama-proxy");
const wfDb = require("./lib/workflow-db");
const { runWorkflow, startRunsSSE } = require("./lib/workflow-runner");
const { trackProcess, trackServer, hookElectronLifecycle } = require("./lib/cleanup");
const db = require("./lib/db");

const OLLAMA_HOST = "127.0.0.1";
const OLLAMA_PORT = 11434;
const LAUNCHER_CONFIG = path.join(NEMOCLAW_DIR, "launcher_config.json");
const PKG_INSTALL_META = path.join(NEMOCLAW_DIR, "pkg-install-meta.json");
const OPENCLAW_CONFIG = path.join(os.homedir(), ".openclaw", "openclaw.json");

let splashWindow = null;
let mainWindow = null;
let proxyServer = null;

// ---------------------------------------------------------------------------
// Launcher config persistence
// ---------------------------------------------------------------------------

const CONFIG_VERSION = 3;

function migrateConfig(config) {
  const v = config.configVersion || 0;

  if (v < 1) {
    // v0 → v1: restructure onboarding data with stable IDs
    if (config.onboarding && !config.onboarding.workspace) {
      const old = config.onboarding;
      config.onboarding = {
        completedAt: config.setupCompletedAt || null,
        workspace: { type: old.purpose || "", teamSize: old.size || "" },
        experience: old.techs || [],
        invites: old.invites || [],
        connectors: old.connectors || { "local-files": true },
        microapps: old.microapps || [],
      };
    }
    config.configVersion = 1;
  }

  if (v < 2) {
    // v1 → v2: separate onboarding_complete from launcher_setup_complete
    // If the old config had launcher_setup_complete but no onboarding_complete,
    // check whether onboarding data exists to infer whether the user actually
    // went through the wizard or bootstrap just set the flag.
    if (config.onboarding_complete === undefined) {
      const hasOnboardingData = config.onboarding &&
        (config.onboarding.workspace?.type || config.onboarding.purpose);
      config.onboarding_complete = !!hasOnboardingData;
    }
    config.configVersion = 2;
  }

  if (v < 3) {
    // v2 → v3: credential storage moved from plaintext
    // {OPENAI_API_KEY: "ollama"} to encrypted entry format in
    // credentials.json (handled by migrateToEncrypted() at bootstrap).
    config.credentialsEncryptionMigratedAt = new Date().toISOString();
    config.configVersion = 3;
  }

  return config;
}

function readLauncherConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(LAUNCHER_CONFIG, "utf-8"));
    if ((config.configVersion || 0) < CONFIG_VERSION) {
      const migrated = migrateConfig(config);
      writeLauncherConfig(migrated);
      return migrated;
    }
    return config;
  } catch {
    return { configVersion: CONFIG_VERSION };
  }
}

function writeLauncherConfig(data) {
  const dir = path.dirname(LAUNCHER_CONFIG);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  data.configVersion = CONFIG_VERSION;
  fs.writeFileSync(LAUNCHER_CONFIG, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function checkPkgInstallFlag() {
  if (fs.existsSync(PKG_INSTALL_META)) {
    try {
      const meta = JSON.parse(fs.readFileSync(PKG_INSTALL_META, "utf-8"));
      if (meta.firstLaunchNeeded) {
        return true;
      }
    } catch {
      // ignore malformed meta
    }
  }
  return false;
}

function clearPkgInstallFlag() {
  if (fs.existsSync(PKG_INSTALL_META)) {
    try {
      fs.unlinkSync(PKG_INSTALL_META);
    } catch {
      // ignore
    }
  }
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
    function followRedirects(url, redirects) {
      if (redirects > 5) return reject(new Error("Too many redirects"));
      const mod = url.startsWith("https") ? require("https") : http;
      mod.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return followRedirects(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }

        const total = parseInt(res.headers["content-length"] || "0", 10);
        let downloaded = 0;
        const fileStream = fs.createWriteStream(tgzPath);

        res.on("data", (chunk) => {
          downloaded += chunk.length;
          if (total > 0) {
            sendProgress({ completed: downloaded, total });
          }
        });

        res.pipe(fileStream);
        fileStream.on("finish", () => {
          fileStream.close(() => {
            try {
              require("child_process").execSync(
                `tar -xzf "${tgzPath}" -C "${OLLAMA_DEST}"`,
                { stdio: "pipe" }
              );
              fs.chmodSync(path.join(OLLAMA_DEST, "ollama"), 0o755);
              fs.unlinkSync(tgzPath);
              resolve();
            } catch (err) {
              reject(new Error(`Extract failed: ${err.message}`));
            }
          });
        });
        fileStream.on("error", reject);
      }).on("error", reject);
    }

    followRedirects(OLLAMA_URL, 0);
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
  const config = readLauncherConfig();
  const isPkgInstall = checkPkgInstallFlag();
  const isFirstRun = !config.launcher_setup_complete || isPkgInstall;

  // Step 1 — Ensure Ollama binary exists (bundled, runtime-downloaded, or system)
  let ollamaPath = paths.resolveOllama();
  if (!ollamaPath) {
    await ensureSplash();
    sendStatus("Downloading AI engine...");
    try {
      await downloadOllama();
      ollamaPath = paths.resolveOllama();
      if (!ollamaPath) throw new Error("Binary not found after download");
    } catch (err) {
      sendError(`Failed to download AI engine: ${err.message}`);
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

  // Step 3 — Always check model, download if missing
  const modelPresent = await checkModelExists(MODEL);
  if (!modelPresent) {
    await ensureSplash();
    sendStatus(`Downloading AI model: ${MODEL}...`);
    try {
      await pullModel();
    } catch (err) {
      console.error(`Model pull failed: ${err.message}`);
      sendStatus(`Model pull failed (${err.message}) — continuing startup...`);
    }
  }

  // Step 4 — First-run config seeding
  if (isFirstRun) {
    sendStatus("Configuring NemoClaw...");
    seedAll();

    writeLauncherConfig({
      ...config,
      launcher_setup_complete: true,
      ollama_model: MODEL,
      gateway_port: GATEWAY_PORT,
      connector_proxy_port: 11437,
      setupCompletedAt: new Date().toISOString(),
    });
    clearPkgInstallFlag();
  }

  // Step 5b — Upgrade any plaintext credentials to safeStorage-encrypted
  // format. Runs BEFORE the gateway spawns so the agent subprocess never
  // sees a plaintext token on disk.
  try {
    const secureCreds = require("./lib/secure-credentials");
    if (secureCreds.isAvailable()) {
      const result = secureCreds.migrateToEncrypted();
      if (result.migrated > 0) {
        console.log(`[bootstrap] encrypted ${result.migrated} credential(s) via safeStorage`);
      }
    } else {
      console.warn("[bootstrap] safeStorage unavailable — credentials remain plaintext on disk");
    }
  } catch (e) {
    console.warn(`[bootstrap] credential migration failed: ${e.code || e.message}`);
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
  try { trackServer(startRunsSSE()); } catch (e) { console.error("[wf] startRunsSSE failed:", e.message); }
  try {
    const probed = validateMountedFoldersAtBoot();
    const stale = probed.filter((f) => f.stale);
    if (stale.length) console.warn(`[bookmarks] ${stale.length} stale mount(s):`, stale.map((f) => f.path));
  } catch (e) { console.error("[bookmarks] boot validation failed:", e.message); }

  try {
    await waitForProxy();
  } catch (err) {
    sendError(`Inference proxy failed to start: ${err.message}`);
    return;
  }

  // Fire warm-up request so the model is in VRAM before the user
  // sends their first message. We await this to prevent "cold start" lag.
  sendStatus("Warming up AI model (VRAM)...");
  await warmUpModel(MODEL);

  // 5c. Start connector proxy (third-party API calls on behalf of agent)
  try {
    const { startConnectorProxy } = require("./lib/connector-proxy");
    const connectorServer = startConnectorProxy();
    trackServer(connectorServer);
  } catch (e) {
    console.error(`[bootstrap] connector proxy failed to start: ${e.message}`);
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

ipcMain.handle("db-create-session", (_, title) => db.createSession(title));
ipcMain.handle("db-get-sessions", () => db.getSessions());
ipcMain.handle("db-save-message", (_, sessionId, role, content) => db.saveMessage(sessionId, role, content));
ipcMain.handle("db-get-messages", (_, sessionId) => db.getMessages(sessionId));
ipcMain.handle("db-update-session-title", (_, sessionId, title) => db.updateSessionTitle(sessionId, title));
ipcMain.handle("db-delete-session", (_, id) => db.deleteSession(id));

// Workflow IPC
ipcMain.handle("wf-list", () => wfDb.listWorkflows());
ipcMain.handle("wf-get", (_, id) => wfDb.getWorkflow(id));
ipcMain.handle("wf-create", (_, input) => wfDb.createWorkflow(input || {}));
ipcMain.handle("wf-update", (_, id, patch) => wfDb.updateWorkflow(id, patch || {}));
ipcMain.handle("wf-delete", (_, id) => wfDb.deleteWorkflow(id));
ipcMain.handle("wf-step-add", (_, workflowId, step) => wfDb.addStep(workflowId, step || {}));
ipcMain.handle("wf-step-update", (_, stepId, patch) => wfDb.updateStep(stepId, patch || {}));
ipcMain.handle("wf-step-delete", (_, stepId) => wfDb.deleteStep(stepId));
ipcMain.handle("wf-step-reorder", (_, workflowId, orderedIds) => wfDb.reorderSteps(workflowId, orderedIds || []));
ipcMain.handle("wf-run", async (_, workflowId) => runWorkflow(workflowId));
ipcMain.handle("wf-runs-list", (_, workflowId) => wfDb.listRuns(workflowId));
ipcMain.handle("wf-run-get", (_, runId) => wfDb.getRun(runId));

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
  return !config.onboarding_complete;
});

ipcMain.handle("reset-onboarding", () => {
  const existing = readLauncherConfig();
  writeLauncherConfig({
    ...existing,
    onboarding_complete: false,
    onboarding: {},
  });
  return { ok: true };
});

ipcMain.handle("mark-onboarding-complete", (_event, data) => {
  const existing = readLauncherConfig();
  writeLauncherConfig({
    ...existing,
    onboarding_complete: true,
    onboarding: data || {},
    gateway_port: GATEWAY_PORT,
  });
  return true;
});

// ---------------------------------------------------------------------------
// Credential IPC — main-process-only custody of third-party API tokens.
// Never expose decrypted values to the renderer; it only needs to know
// which credentials exist. Decryption happens only inside the connector
// proxy at request time.
// ---------------------------------------------------------------------------

ipcMain.handle("save-credential", (_event, key, value) => {
  try {
    require("./lib/secure-credentials").writeCredential(key, value);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e.code || "SAVE_FAILED" };
  }
});

ipcMain.handle("delete-credential", (_event, key) => {
  try {
    require("./lib/secure-credentials").deleteCredential(key);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e.code || "DELETE_FAILED" };
  }
});

ipcMain.handle("has-credential", (_event, key) => {
  try {
    return require("./lib/secure-credentials").hasCredential(key);
  } catch {
    return false;
  }
});

ipcMain.handle("list-credential-keys", () => {
  try {
    return require("./lib/secure-credentials").listCredentialKeys();
  } catch {
    return [];
  }
});

// ---------------------------------------------------------------------------
// File system IPC — folder mounting & sandboxed file access
// ---------------------------------------------------------------------------

const {
  withBookmarkAccess,
  releaseHandlesForPath,
  hasLiveHandles,
  validateMountedFoldersAtBoot,
  listMountedFoldersPublic,
} = require("./lib/bookmarks");

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
  return withBookmarkAccess(filePath, async () => {
    const st = await fs.promises.stat(filePath);
    if (st.isDirectory()) {
      const entries = await fs.promises.readdir(filePath, { withFileTypes: true });
      return entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort()
        .join("\n");
    }
    return fs.promises.readFile(filePath, "utf-8");
  });
});

ipcMain.handle("fs-write-file", async (_, filePath, content) => {
  console.log(`[fs-write-file] request path=${filePath} bytes=${content ? Buffer.byteLength(content) : 0}`);
  try {
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
  return withBookmarkAccess(dirPath, async () => {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  });
});

ipcMain.handle("get-mounted-folders", () => listMountedFoldersPublic());

ipcMain.handle("mount-folder", (_, folderData) => {
  if (!folderData || !folderData.path) return { ok: false, error: "path required" };
  const cfg = readLauncherConfig();
  cfg.mountedFolders = cfg.mountedFolders || [];
  const now = Date.now();
  const existing = cfg.mountedFolders.find((f) => f.path === folderData.path);
  if (existing) {
    // Refresh the bookmark in place (re-authorize via the same channel).
    existing.bookmark = folderData.bookmark || existing.bookmark;
    existing.addedAt = existing.addedAt || now;
    delete existing.stale;
  } else {
    cfg.mountedFolders.push({
      path: folderData.path,
      bookmark: folderData.bookmark,
      addedAt: now,
    });
  }
  writeLauncherConfig(cfg);
  return { ok: true, path: folderData.path, addedAt: existing ? existing.addedAt : now };
});

ipcMain.handle("unmount-folder", (_, folderPath) => {
  if (hasLiveHandles(folderPath)) {
    // Release any brokered fs ops still holding the bookmark before removing.
    releaseHandlesForPath(folderPath);
  }
  const cfg = readLauncherConfig();
  cfg.mountedFolders = (cfg.mountedFolders || []).filter((f) => f.path !== folderPath);
  writeLauncherConfig(cfg);
  return { ok: true };
});

ipcMain.handle("reauthorize-folder", async (_, folderPath) => {
  if (!mainWindow) return { ok: false, error: "no window" };
  const { canceled, filePaths, bookmarks } = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    defaultPath: folderPath,
    securityScopedBookmarks: true,
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  const cfg = readLauncherConfig();
  cfg.mountedFolders = cfg.mountedFolders || [];
  const entry = cfg.mountedFolders.find((f) => f.path === folderPath);
  const newPath = filePaths[0];
  const newBookmark = (bookmarks && bookmarks[0]) || null;
  if (entry) {
    entry.path = newPath;
    entry.bookmark = newBookmark;
    delete entry.stale;
  } else {
    cfg.mountedFolders.push({ path: newPath, bookmark: newBookmark, addedAt: Date.now() });
  }
  writeLauncherConfig(cfg);
  return { ok: true, path: newPath };
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
