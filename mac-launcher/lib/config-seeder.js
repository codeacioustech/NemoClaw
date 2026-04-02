// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const path = require("path");
const os = require("os");

const NEMOCLAW_DIR = path.join(os.homedir(), ".nemoclaw");
const OPENCLAW_DIR = path.join(os.homedir(), ".openclaw");
const GATEWAY_PORT = 18789;
const MODEL = "qwen2.5:0.5b";

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function writeSecure(filePath, data) {
  const content = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const tmp = filePath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function seedOpenclawConfig() {
  ensureDir(OPENCLAW_DIR);
  const configPath = path.join(OPENCLAW_DIR, "openclaw.json");

  writeSecure(configPath, {
    gateway: {
      mode: "local",
      bind: "loopback",
      port: GATEWAY_PORT,
      auth: { mode: "none" },
    },
  });
}

function seedNemoclawConfig() {
  ensureDir(NEMOCLAW_DIR);
  const now = new Date().toISOString();

  const configPath = path.join(NEMOCLAW_DIR, "config.json");
  writeSecure(configPath, {
      endpointType: "ollama",
      endpointUrl: "http://localhost:11434/v1",
      ncpPartner: null,
      model: MODEL,
      profile: "inference-local",
      credentialEnv: "OPENAI_API_KEY",
      provider: "ollama-local",
      providerLabel: "NemoClaw Mac",
      onboardedAt: now,
  });

  const sessionPath = path.join(NEMOCLAW_DIR, "onboard-session.json");
  {
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const stepComplete = { status: "complete", startedAt: now, completedAt: now, error: null };
    const stepSkipped = { status: "skipped", startedAt: null, completedAt: null, error: null };

    writeSecure(sessionPath, {
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
      sandboxName: null,
      provider: "ollama-local",
      model: MODEL,
      endpointUrl: "http://localhost:11434/v1",
      credentialEnv: "OPENAI_API_KEY",
      preferredInferenceApi: null,
      nimContainer: null,
      policyPresets: null,
      metadata: { gatewayName: "nemoclaw" },
      steps: {
        preflight: stepComplete,
        gateway: stepComplete,
        sandbox: stepSkipped,
        provider_selection: stepComplete,
        inference: stepComplete,
        openclaw: stepComplete,
        policies: stepComplete,
      },
    });
  }

  const credPath = path.join(NEMOCLAW_DIR, "credentials.json");
  writeSecure(credPath, { OPENAI_API_KEY: "ollama" });
}

function seedAll() {
  seedOpenclawConfig();
  seedNemoclawConfig();
}

module.exports = { seedAll, GATEWAY_PORT, MODEL, NEMOCLAW_DIR };
