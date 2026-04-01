"use strict";

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const { seedAll } = require("./lib/config-seeder");
const { spawnOllama, waitForOllamaReady, pullModel } = require("./lib/ollama-manager");
const { spawnGateway, waitForGatewayReady, GATEWAY_URL } = require("./lib/gateway");
const { trackProcess, killAll, installCleanupHandlers } = require("./lib/cleanup");

const MODEL_NAME = "qwen2.5:0.5b";
const LAUNCHER_CONFIG = path.join(os.homedir(), ".nemoclaw", "launcher_config.json");

let splashWindow = null;
let mainWindow = null;

// ── Launcher config helpers ──────────────────────────────────────

function isSetupComplete() {
  try {
    if (!fs.existsSync(LAUNCHER_CONFIG)) return false;
    const cfg = JSON.parse(fs.readFileSync(LAUNCHER_CONFIG, "utf-8"));
    return cfg.launcher_setup_complete === true;
  } catch {
    return false;
  }
}

function markSetupComplete() {
  const dir = path.dirname(LAUNCHER_CONFIG);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = LAUNCHER_CONFIG + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ launcher_setup_complete: true }, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(tmp, LAUNCHER_CONFIG);
}

// ── IPC helpers ──────────────────────────────────────────────────

function sendStatus(phase, message) {
  splashWindow?.webContents.send("setup-status", { phase, message });
}

function sendProgress(data) {
  splashWindow?.webContents.send("ollama-progress", data);
}

function sendError(message) {
  splashWindow?.webContents.send("setup-error", { message });
}

// ── Window creation ──────────────────────────────────────────────

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 480,
    height: 360,
    frame: false,
    resizable: false,
    transparent: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  splashWindow.loadFile(path.join(__dirname, "splash.html"));
  splashWindow.on("closed", () => {
    splashWindow = null;
  });

  return splashWindow;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "NemoClaw",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(GATEWAY_URL);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

// ── Setup flow ───────────────────────────────────────────────────

async function runFirstTimeSetup() {
  const splash = createSplashWindow();

  try {
    // Step 1: Spawn Ollama
    sendStatus("ollama", "Starting local inference server…");
    const ollamaProc = spawnOllama();
    trackProcess("ollama", ollamaProc);

    // Step 2: Wait for Ollama to be ready
    await waitForOllamaReady(60000);

    // Step 3: Pull model
    sendStatus("pulling", `Downloading ${MODEL_NAME}…`);
    await pullModel(MODEL_NAME, sendProgress);
    sendProgress({ status: "Model ready", completed: 0, total: 0, percent: 100 });

    // Step 4: Seed config files
    sendStatus("config", "Configuring NemoClaw…");
    seedAll({ model: MODEL_NAME, sandboxName: "nemoclaw-mac" });

    // Step 5: Mark setup complete
    markSetupComplete();
  } catch (err) {
    sendError(err.message);
    throw err;
  }

  // Step 6: Start gateway
  await startGateway(splash);
}

async function startGateway(splash) {
  sendStatus("gateway", "Starting NemoClaw gateway…");
  const gatewayProc = spawnGateway();
  trackProcess("gateway", gatewayProc);

  await waitForGatewayReady(120000);

  // Close splash, open main window
  if (splash) {
    splash.close();
  }
  createMainWindow();
}

// ── App lifecycle ────────────────────────────────────────────────

app.whenReady().then(async () => {
  installCleanupHandlers(app);

  try {
    if (isSetupComplete()) {
      // Already set up — just start the gateway directly
      createSplashWindow();
      sendStatus("gateway", "Starting NemoClaw gateway…");

      // Also re-spawn Ollama if it's not running
      const ollamaProc = spawnOllama();
      trackProcess("ollama", ollamaProc);
      try {
        await waitForOllamaReady(15000);
      } catch {
        // Ollama might already be running from a previous session
        console.log("[main] Ollama not responding to spawn, may already be running");
      }

      await startGateway(splashWindow);
    } else {
      // First run — full bootstrap
      await runFirstTimeSetup();
    }
  } catch (err) {
    console.error("[main] Fatal error:", err);
    sendError(err.message || "Unknown error during setup");
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});
