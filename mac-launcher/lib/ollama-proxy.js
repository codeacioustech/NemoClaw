// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const http = require("http");

const OLLAMA_HOST = "127.0.0.1";
const OLLAMA_PORT = 11434;
const PROXY_PORT = 11435;

const SYSTEM_INSTRUCTION =
  "You are a helpful assistant running inside the NemoClaw desktop app. " +
  "When the user asks you to create, read, or modify files, you MUST call " +
  "the appropriate tool — `create_file`, `read_file`, or `list_directory` — " +
  "and wait for the tool result before replying. " +
  "Never claim to have created, read, or modified a file unless you actually " +
  "called the tool and received a success result. " +
  "For all non-file questions, respond in plain text. Do not wrap text " +
  'responses in JSON or action wrappers like {"request": ...}.';

const JSON_WRAPPER_PREFIX =
  /^\{\s*"request"\s*:\s*\{\s*"action"\s*:\s*"[^"]*"\s*,\s*"(?:text|message)"\s*:\s*"/;
const JSON_WRAPPER_SUFFIX = /"\s*\}\s*\}\s*$/;

/**
 * Start a lightweight HTTP proxy between OpenClaw and Ollama.
 * - Injects a system instruction into /api/chat requests (primary fix).
 * - Strips JSON action-wrapper patterns from streamed response tokens (fallback).
 */
function startProxy(onListening) {
  const server = http.createServer((clientReq, clientRes) => {
    console.log(`[ollama-proxy] ${clientReq.method} ${clientReq.url} content-length=${clientReq.headers["content-length"] || "none"}`);

    const isChatEndpoint =
      clientReq.method === "POST" && clientReq.url === "/api/chat";

    const bodyChunks = [];
    clientReq.on("data", (chunk) => bodyChunks.push(chunk));
    clientReq.on("end", () => {
      let body = Buffer.concat(bodyChunks);
      console.log(`[ollama-proxy] Body received: ${body.length} bytes, forwarding to Ollama`);

      // Inject system instruction and trim tools from chat requests
      if (isChatEndpoint) {
        try {
          const parsed = JSON.parse(body.toString());
          if (Array.isArray(parsed.messages)) {
            parsed.messages.unshift({
              role: "system",
              content: SYSTEM_INSTRUCTION,
            });
          }
          // Forward tool definitions as-is. qwen2.5:3b supports function
          // calling via Ollama's /api/chat `tools` field; stripping them
          // meant the model could never emit a tool call and would
          // hallucinate "file created" responses in plain text instead.
          if (Array.isArray(parsed.tools)) {
            console.log(`[ollama-proxy] Forwarding ${parsed.tools.length} tool definitions`);
          }
          // Strip the "think" flag — qwen2.5:3b (and most small local models)
          // don't support reasoning/thinking mode and Ollama 400s with
          // `"<model>" does not support thinking` if the flag is set.
          if (parsed.think !== undefined) {
            console.log(`[ollama-proxy] Stripped think=${parsed.think} (model does not support thinking)`);
            delete parsed.think;
          }
          if (parsed.options && parsed.options.think !== undefined) {
            delete parsed.options.think;
          }
          body = Buffer.from(JSON.stringify(parsed));
          console.log(`[ollama-proxy] Request body after processing: ${body.length} bytes`);
        } catch {
          // Forward as-is if body isn't valid JSON
        }
      }

      const proxyReq = http.request(
        {
          hostname: OLLAMA_HOST,
          port: OLLAMA_PORT,
          path: clientReq.url,
          method: clientReq.method,
          headers: {
            ...clientReq.headers,
            "content-length": Buffer.byteLength(body),
            host: `${OLLAMA_HOST}:${OLLAMA_PORT}`,
          },
        },
        (proxyRes) => {
          // Non-chat endpoints: passthrough
          if (!isChatEndpoint) {
            clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(clientRes);
            return;
          }

          // Chat endpoint: stream-transform to strip JSON wrappers
          clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);

          let accumulator = "";
          let detected = false; // whether we've checked for the JSON pattern
          let isWrapped = false;

          proxyRes.on("data", (chunk) => {
            const lines = chunk.toString().split("\n").filter(Boolean);

            for (const line of lines) {
              let obj;
              try {
                obj = JSON.parse(line);
              } catch {
                clientRes.write(line + "\n");
                continue;
              }

              const token = obj?.message?.content;

              // Non-content lines or done signal: forward directly
              if (typeof token !== "string") {
                clientRes.write(JSON.stringify(obj) + "\n");
                continue;
              }

              // Phase 1: buffer tokens to detect JSON wrapper (~60 chars)
              if (!detected) {
                accumulator += token;
                if (accumulator.length < 60 && !obj.done) continue;

                detected = true;
                const trimmed = accumulator.trimStart();
                const match = trimmed.match(JSON_WRAPPER_PREFIX);

                if (match) {
                  isWrapped = true;
                  accumulator = trimmed.slice(match[0].length);
                }

                // Flush accumulated content
                if (accumulator) {
                  obj.message.content = accumulator;
                  clientRes.write(JSON.stringify(obj) + "\n");
                }
                accumulator = "";
                continue;
              }

              // Phase 2: forward tokens, buffer last few chars for suffix stripping
              if (isWrapped) {
                accumulator += token;
                // Keep a small tail buffer for the closing "}}
                if (accumulator.length > 10) {
                  const toSend = accumulator.slice(0, -10);
                  accumulator = accumulator.slice(-10);
                  obj.message.content = toSend;
                  clientRes.write(JSON.stringify(obj) + "\n");
                }
              } else {
                clientRes.write(JSON.stringify(obj) + "\n");
              }
            }
          });

          proxyRes.on("end", () => {
            // Flush remaining buffer, stripping JSON wrapper suffix if detected
            if (isWrapped && accumulator) {
              const cleaned = accumulator.replace(JSON_WRAPPER_SUFFIX, "");
              if (cleaned) {
                const flush = JSON.stringify({
                  model: "",
                  message: { role: "assistant", content: cleaned },
                  done: false,
                });
                clientRes.write(flush + "\n");
              }
            } else if (accumulator && !detected) {
              // Short response that never hit detection threshold
              const flush = JSON.stringify({
                model: "",
                message: { role: "assistant", content: accumulator },
                done: false,
              });
              clientRes.write(flush + "\n");
            }
            clientRes.end();
          });
        }
      );

      proxyReq.on("error", (err) => {
        console.error(`[ollama-proxy] Proxy error: ${err.message}`);
        clientRes.writeHead(502);
        clientRes.end(`Proxy error: ${err.message}`);
      });

      proxyReq.write(body);
      proxyReq.end();
    });
  });

  server.on("error", (err) => {
    console.error(`[ollama-proxy] Server error: ${err.message}`);
  });

  server.listen(PROXY_PORT, OLLAMA_HOST, () => {
    console.log(`[ollama-proxy] Listening on ${OLLAMA_HOST}:${PROXY_PORT}`);
    if (onListening) onListening();
  });

  return server;
}

function waitForProxy(timeoutMs = 10000, intervalMs = 300) {
  const url = `http://${OLLAMA_HOST}:${PROXY_PORT}/api/tags`;
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    function poll() {
      if (Date.now() > deadline) {
        return reject(
          new Error(`Ollama proxy did not respond within ${timeoutMs / 1000}s`)
        );
      }
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => setTimeout(poll, intervalMs));
      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(poll, intervalMs);
      });
    }
    poll();
  });
}

module.exports = { startProxy, waitForProxy, PROXY_PORT };
