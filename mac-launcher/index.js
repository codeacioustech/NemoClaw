"use strict";

const { app, BrowserWindow } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const GATEWAY_PORT = 18789;
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;

let mainWindow = null;
let gatewayProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "NemoClaw",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(GATEWAY_URL);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function waitForGateway(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      http
        .get(GATEWAY_URL, (res) => {
          res.resume();
          if (res.statusCode >= 200 && res.statusCode < 500) {
            resolve();
          } else {
            retry();
          }
        })
        .on("error", retry);
    };
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error(`Gateway not ready after ${timeoutMs}ms`));
      } else {
        setTimeout(attempt, 1000);
      }
    };
    attempt();
  });
}

function startGateway() {
  console.log("[main] Starting gateway via npx...");

  gatewayProcess = spawn("npx", ["openclaw", "gateway", "run", "--port", String(GATEWAY_PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    shell: true,
  });

  gatewayProcess.stdout.on("data", (d) => console.log("[gateway]", d.toString().trim()));
  gatewayProcess.stderr.on("data", (d) => console.error("[gateway]", d.toString().trim()));

  gatewayProcess.on("error", (err) => {
    console.error("[main] Failed to start gateway:", err.message);
  });

  gatewayProcess.on("exit", (code) => {
    console.log("[main] Gateway exited with code", code);
  });
}

app.whenReady().then(async () => {
  console.log("[main] Starting NemoClaw launcher...");

  startGateway();

  try {
    await waitForGateway(30000);
    console.log("[main] Gateway ready, opening window...");
    createWindow();
  } catch (err) {
    console.error("[main] Gateway not ready:", err.message);
    console.log("[main] Make sure Ollama is installed: brew install ollama");
  }
});

app.on("window-all-closed", () => {
  if (gatewayProcess) {
    gatewayProcess.kill();
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
