"use strict";

const { fork } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

const GATEWAY_PORT = 18789;
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;

/**
 * Resolve the path to the bundled openclaw CLI entry point.
 * In a packaged Electron app, node_modules are unpacked under
 * process.resourcesPath/app.asar.unpacked/node_modules/.
 */
function resolveOpenclawEntry() {
  // Packaged app: use process.resourcesPath to find unpacked openclaw
  if (process.resourcesPath) {
    const unpackedPath = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "openclaw",
      "openclaw.mjs",
    );
    if (fs.existsSync(unpackedPath)) {
      return unpackedPath;
    }
  }

  // Dev mode: require.resolve works normally
  try {
    return require.resolve("openclaw/openclaw.mjs");
  } catch {
    throw new Error(
      "Cannot find openclaw/openclaw.mjs in node_modules. Run 'npm install' in mac-launcher/ first.",
    );
  }
}

/**
 * Fork the OpenClaw gateway process using child_process.fork().
 * Passes ELECTRON_RUN_AS_NODE=1 to prevent Electron from booting
 * another Chromium window when executing the raw JS file.
 */
function spawnGateway() {
  const entryPoint = resolveOpenclawEntry();

  const child = fork(entryPoint, ["gateway", "run"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
    },
  });

  child.stdout?.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg) console.log("[gateway]", msg);
  });

  child.stderr?.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg) console.error("[gateway]", msg);
  });

  child.on("error", (err) => {
    console.error("[gateway] Failed to spawn:", err.message);
  });

  return child;
}

/**
 * Poll the gateway dashboard URL until it responds with HTTP 200.
 */
function waitForGatewayReady(timeoutMs = 120000) {
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

module.exports = { spawnGateway, waitForGatewayReady, GATEWAY_PORT, GATEWAY_URL };
