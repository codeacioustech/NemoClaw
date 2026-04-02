"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const OPENCLAW_DIR = path.join(os.homedir(), ".openclaw");

/**
 * Pre-seed ~/.openclaw/openclaw.json with a minimal valid configuration
 * so that the gateway can start without the full onboarding flow.
 *
 * This config is designed for local-only usage with Ollama.
 */
function seedOpenclawConfig(opts) {
  const config = {
    version: 1,
    gateway: {
      mode: "local",
      port: 18789,
      bind: "loopback",
      auth: {
        mode: "none",
      },
    },
    tools: {
      profile: "general",
      web: {
        search: {
          provider: "brave",
          brave: {
            api_key: null,
          },
        },
      },
    },
    inference: {
      provider: "ollama-local",
      model: opts.model || "qwen2.5:0.5b",
      endpoint: "http://localhost:11434",
    },
    extensions: {},
  };

  fs.mkdirSync(OPENCLAW_DIR, { recursive: true, mode: 0o700 });
  const configPath = path.join(OPENCLAW_DIR, "openclaw.json");
  const tmpPath = configPath + ".tmp." + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, configPath);

  return configPath;
}

/**
 * Seed both config files. Call this after Ollama model pull completes
 * and before the gateway starts.
 */
function seedAll(opts = {}) {
  const configPath = seedOpenclawConfig(opts);
  return { configPath };
}

module.exports = { seedAll, seedOpenclawConfig, OPENCLAW_DIR };
