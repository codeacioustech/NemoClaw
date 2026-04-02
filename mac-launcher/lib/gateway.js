// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { spawn } = require("child_process");
const http = require("http");
const paths = require("./paths");
const { GATEWAY_PORT } = require("./config-seeder");

function startGateway(onStdout, onStderr) {
  const openclawMjs = paths.resolveOpenclawMjs();
  const openclawDir = paths.resolveOpenclawDir();

  const child = spawn(
    process.execPath,
    [
      openclawMjs,
      "gateway",
      "run",
      "--port",
      String(GATEWAY_PORT),
      "--auth",
      "none",
      "--allow-unconfigured",
      "--bind",
      "loopback",
      "--verbose",
    ],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        OPENCLAW_GATEWAY_PORT: String(GATEWAY_PORT),
        NODE_OPTIONS: "",
      },
      cwd: openclawDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    }
  );

  if (onStdout) child.stdout.on("data", (chunk) => onStdout(chunk.toString()));
  if (onStderr) child.stderr.on("data", (chunk) => onStderr(chunk.toString()));

  return child;
}

function waitForGateway(timeoutMs = 30000, intervalMs = 500) {
  const url = `http://127.0.0.1:${GATEWAY_PORT}/`;
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    function poll() {
      if (Date.now() > deadline) {
        return reject(new Error(`Gateway did not respond within ${timeoutMs / 1000}s`));
      }

      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });

      req.on("error", () => {
        setTimeout(poll, intervalMs);
      });

      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(poll, intervalMs);
      });
    }

    poll();
  });
}

module.exports = { startGateway, waitForGateway, GATEWAY_PORT };
