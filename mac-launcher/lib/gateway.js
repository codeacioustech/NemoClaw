"use strict";

const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const GATEWAY_PORT = 18789;
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;

/**
 * Resolve the path to the bundled openclaw CLI entry point.
 * In a packaged Electron app, node_modules are under app.asar or app directory.
 */
function resolveOpenclawEntry() {
  try {
    return require.resolve("openclaw/openclaw.mjs");
  } catch {
    throw new Error(
      "Cannot find openclaw/openclaw.mjs in node_modules. Run 'npm install' in mac-launcher/ first.",
    );
  }
}

/**
 * Spawn the OpenClaw gateway process using the bundled openclaw binary.
 * Uses spawn() with node to execute the .mjs entry point directly.
 */
function spawnGateway() {
  const entryPoint = resolveOpenclawEntry();
  const nodeExec = process.execPath || "node";

  const child = spawn(nodeExec, [entryPoint, "gateway", "run"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
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
