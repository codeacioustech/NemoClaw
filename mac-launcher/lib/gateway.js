"use strict";

const { spawn } = require("child_process");
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
  // Packaged app: asar is disabled, so files are on the regular filesystem
  if (process.resourcesPath) {
    const candidates = [
      path.join(process.resourcesPath, "app", "node_modules", "openclaw", "openclaw.mjs"),
      path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "openclaw",
        "openclaw.mjs",
      ),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
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
 * Spawn the OpenClaw gateway process using Electron with ELECTRON_RUN_AS_NODE=1.
 * This lets Electron's bundled Node runtime execute the .mjs file headlessly.
 */
function spawnGateway(opts = {}) {
  const { onLog } = opts;
  const entryPoint = resolveOpenclawEntry();

  const child = spawn(process.execPath, [entryPoint, "gateway", "run"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
    },
  });

  child.stdout?.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg) {
      console.log("[gateway]", msg);
      onLog?.(msg);
    }
  });

  child.stderr?.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg) {
      console.error("[gateway]", msg);
      onLog?.(msg);
    }
  });

  child.on("error", (err) => {
    const msg = `[gateway] Failed to spawn: ${err.message}`;
    console.error(msg);
    onLog?.(msg);
  });

  child.on("exit", (code, signal) => {
    const msg = `[gateway] Process exited with code ${code}, signal ${signal}`;
    console.error(msg);
    onLog?.(msg);
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
