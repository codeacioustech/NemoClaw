// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const path = require("path");
const fs = require("fs");
const { app } = require("electron");

function isPackaged() {
  return app.isPackaged;
}

function resolveOpenclawMjs() {
  if (isPackaged()) {
    const packaged = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "openclaw",
      "openclaw.mjs"
    );
    if (fs.existsSync(packaged)) return packaged;
  }

  const dev = path.join(__dirname, "..", "node_modules", "openclaw", "openclaw.mjs");
  if (fs.existsSync(dev)) return dev;

  throw new Error("Cannot locate openclaw.mjs — ensure openclaw is installed.");
}

function resolveOpenclawDir() {
  return path.dirname(resolveOpenclawMjs());
}

function resolveOllama() {
  if (isPackaged()) {
    const packaged = path.join(process.resourcesPath, "ollama-mac", "ollama");
    if (fs.existsSync(packaged)) return packaged;
  }

  const dev = path.join(__dirname, "..", "resources", "ollama-mac", "ollama");
  if (fs.existsSync(dev)) return dev;

  throw new Error("Cannot locate Ollama binary — run 'npm run download-ollama' first.");
}

function resolveNemoclawPlugin() {
  if (isPackaged()) {
    const packaged = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "nemoclaw",
      "dist",
      "index.js"
    );
    if (fs.existsSync(packaged)) return packaged;
  }

  const dev = path.join(__dirname, "..", "node_modules", "nemoclaw", "dist", "index.js");
  if (fs.existsSync(dev)) return dev;

  return null;
}

module.exports = { resolveOpenclawMjs, resolveOpenclawDir, resolveOllama, resolveNemoclawPlugin };
