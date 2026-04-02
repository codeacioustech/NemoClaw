"use strict";

const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

const OLLAMA_PORT = 11434;
const OLLAMA_BASE = `http://127.0.0.1:${OLLAMA_PORT}`;

/**
 * Spawn the bundled Ollama daemon.
 * The binary is located at process.resourcesPath/ollama-mac/ollama
 * when running from the packaged Electron app, or at ../resources/ollama-mac/ollama
 * during development.
 */
function spawnOllama() {
  const ollamaPath = getOllamaPath();
  try {
    fs.accessSync(ollamaPath, fs.constants.X_OK);
  } catch {
    throw new Error(
      `Ollama binary not found or not executable at: ${ollamaPath}\n` +
        "Run 'npm run download-ollama' in mac-launcher/ first.",
    );
  }

  const child = spawn(ollamaPath, ["serve"], {
    env: {
      ...process.env,
      OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}`,
      OLLAMA_MODELS: path.join(process.env.HOME, ".ollama", "models"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.on("error", (err) => {
    console.error("[ollama] Failed to spawn:", err.message);
  });

  return child;
}

function getOllamaPath() {
  // In packaged app: process.resourcesPath/ollama-mac/ollama
  // In development: <project>/resources/ollama-mac/ollama
  if (process.resourcesPath) {
    return path.join(process.resourcesPath, "ollama-mac", "ollama");
  }
  return path.join(__dirname, "..", "resources", "ollama-mac", "ollama");
}

/**
 * Poll Ollama's /api/tags endpoint until it responds, indicating the daemon is ready.
 */
function waitForOllamaReady(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      http
        .get(`${OLLAMA_BASE}/api/tags`, (res) => {
          res.resume();
          if (res.statusCode === 200) {
            resolve();
          } else {
            retry();
          }
        })
        .on("error", retry);
    };

    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error(`Ollama not ready after ${timeoutMs}ms`));
      } else {
        setTimeout(attempt, 500);
      }
    };

    attempt();
  });
}

/**
 * Pull a model from Ollama with streaming progress.
 * Calls onProgress({ completed, total, percent, status }) for each NDJSON line.
 * Returns a promise that resolves when the pull is complete.
 */
function pullModel(modelName, onProgress) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ name: modelName, stream: true });

    const req = http.request(
      `${OLLAMA_BASE}/api/pull`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let buffer = "";

        res.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop(); // keep incomplete line in buffer

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.total && msg.completed != null) {
                const percent = Math.round((msg.completed / msg.total) * 100);
                onProgress({
                  completed: msg.completed,
                  total: msg.total,
                  percent,
                  status: msg.status || "",
                });
              } else if (msg.status) {
                onProgress({ status: msg.status });
              }
            } catch {
              // skip malformed JSON lines
            }
          }
        });

        res.on("end", () => {
          // Process any remaining buffered line
          if (buffer.trim()) {
            try {
              const msg = JSON.parse(buffer);
              if (msg.status) {
                onProgress({ status: msg.status });
              }
            } catch {
              // ignore
            }
          }
          resolve();
        });

        res.on("error", reject);
      },
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

module.exports = { spawnOllama, waitForOllamaReady, pullModel, OLLAMA_BASE, OLLAMA_PORT };
