"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const NEMOCLAW_DIR = path.join(os.homedir(), ".nemoclaw");

/**
 * Pre-seed ~/.nemoclaw/config.json with the Ollama provider configuration
 * so that the frontend setup wizard is completely skipped.
 *
 * This mirrors the NemoClawOnboardConfig interface from
 * nemoclaw/src/onboard/config.ts and the getProviderSelectionConfig()
 * output for the "ollama-local" provider from
 * bin/lib/inference-config.js:99-109.
 */
function seedInferenceConfig(opts) {
  const config = {
    endpointType: "custom",
    endpointUrl: "https://inference.local/v1",
    ncpPartner: null,
    model: opts.model || "qwen2.5:0.5b",
    profile: "inference-local",
    credentialEnv: "OPENAI_API_KEY",
    provider: "ollama-local",
    providerLabel: "Local Ollama",
    onboardedAt: new Date().toISOString(),
  };

  fs.mkdirSync(NEMOCLAW_DIR, { recursive: true, mode: 0o700 });
  const configPath = path.join(NEMOCLAW_DIR, "config.json");
  const tmpPath = configPath + ".tmp." + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, configPath);

  return configPath;
}

/**
 * Pre-seed ~/.nemoclaw/onboard-session.json as a completed session.
 * This satisfies the onboarding-complete check in onboard-session.js:352-359
 * (completeSession sets status="complete", resumable=false).
 */
function seedOnboardSession(opts) {
  const now = new Date().toISOString();
  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const completedStep = (name) => ({
    status: "complete",
    startedAt: now,
    completedAt: now,
    error: null,
  });

  const session = {
    version: 1,
    sessionId,
    resumable: false,
    status: "complete",
    mode: "non-interactive",
    startedAt: now,
    updatedAt: now,
    lastStepStarted: "policies",
    lastCompletedStep: "policies",
    failure: null,
    sandboxName: opts.sandboxName || "nemoclaw-mac",
    provider: "ollama-local",
    model: opts.model || "qwen2.5:0.5b",
    endpointUrl: "http://localhost:11434/v1",
    credentialEnv: "OPENAI_API_KEY",
    preferredInferenceApi: "ollama",
    nimContainer: null,
    policyPresets: null,
    metadata: {
      gatewayName: "nemoclaw",
    },
    steps: {
      preflight: completedStep("preflight"),
      gateway: completedStep("gateway"),
      sandbox: completedStep("sandbox"),
      provider_selection: completedStep("provider_selection"),
      inference: completedStep("inference"),
      openclaw: completedStep("openclaw"),
      policies: completedStep("policies"),
    },
  };

  fs.mkdirSync(NEMOCLAW_DIR, { recursive: true, mode: 0o700 });
  const sessionPath = path.join(NEMOCLAW_DIR, "onboard-session.json");
  const tmpPath = sessionPath + ".tmp." + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, sessionPath);

  return sessionPath;
}

/**
 * Seed both config files. Call this after Ollama model pull completes
 * and before the gateway starts.
 */
function seedAll(opts = {}) {
  const configPath = seedInferenceConfig(opts);
  const sessionPath = seedOnboardSession(opts);
  return { configPath, sessionPath };
}

module.exports = { seedAll, seedInferenceConfig, seedOnboardSession, NEMOCLAW_DIR };
