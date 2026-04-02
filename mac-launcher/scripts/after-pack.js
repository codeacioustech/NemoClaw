"use strict";

const fs = require("fs");
const path = require("path");

/**
 * After-pack hook: ensure the bundled Ollama binary is executable.
 * Electron-builder may strip executable bits during packaging.
 */
module.exports = async function (context) {
  const appOutDir = context.appOutDir;
  const resourcesDir = path.join(appOutDir, "NemoClaw.app", "Contents", "Resources");
  const ollamaPath = path.join(resourcesDir, "ollama-mac", "ollama");

  try {
    fs.chmodSync(ollamaPath, 0o755);
    console.log("[after-pack] Set executable permission on ollama binary");
  } catch (err) {
    console.warn("[after-pack] Could not chmod ollama binary:", err.message);
  }
};
