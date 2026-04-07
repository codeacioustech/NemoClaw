// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { app, BrowserWindow } = require("electron");
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
    title: "NemoClaw",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${GATEWAY_PORT}`);
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
      sendError(`Model pull failed: ${err.message}`);
      return;
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

  // Ensure gateway config has controlUi.dangerouslyDisableDeviceAuth
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG, "utf-8");
    const cfg = JSON.parse(raw);
    if (!cfg.gateway) cfg.gateway = {};
    if (!cfg.gateway.controlUi || !cfg.gateway.controlUi.dangerouslyDisableDeviceAuth) {
      cfg.gateway.controlUi = { ...cfg.gateway.controlUi, dangerouslyDisableDeviceAuth: true };
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
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  hookElectronLifecycle(app);
  bootstrap().catch((err) => {
    console.error("Bootstrap failed:", err);
    sendError(err.message);
  });
});
