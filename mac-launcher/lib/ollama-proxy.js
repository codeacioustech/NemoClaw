// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const http = require("http");

const OLLAMA_HOST = "127.0.0.1";
const OLLAMA_PORT = 11434;
const PROXY_PORT = 11435;
const THINK_PORT = 11436; // SSE endpoint that streams reasoning tokens to the renderer

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

// Active SSE subscribers for thinking-token broadcasts.
// Each entry is a { res, sessionId } where res is a Node.js ServerResponse.
const _thinkSubscribers = new Set();

/**
 * Broadcast a JSON payload to every connected SSE thinking-stream subscriber.
 */
function _broadcastThink(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const sub of _thinkSubscribers) {
    try { sub.res.write(data); } catch { _thinkSubscribers.delete(sub); }
  }
}

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
          if (Array.isArray(parsed.tools)) {
            console.log(`[ollama-proxy] Forwarding ${parsed.tools.length} tool definitions`);
          }

          // ── Context Pruning Engine ──────────────────────────────────────────
          // Aggressively trims the messages array to reduce payload size and
          // prevent context bloat from slowing down local LLM inference.
          if (Array.isArray(parsed.messages)) {
            const MAX_HISTORY = 10;     // Keep only the last 10 messages (5 turns)
            const MAX_TOOL_OUTPUT = 2000; // Truncate tool reads/outputs over 2000 chars

            // Separate the primary system prompt from the chat history
            const systemMessages = parsed.messages.filter(m => m.role === 'system');
            const mainSystem = systemMessages.length > 0 ? systemMessages : null;

            let chatHistory = parsed.messages.filter(m => m.role !== 'system');

            // Truncate massive tool outputs (e.g., reading a huge file)
            chatHistory = chatHistory.map(msg => {
              if (msg.role === 'tool' && msg.content && typeof msg.content === 'string') {
                if (msg.content.length > MAX_TOOL_OUTPUT) {
                  msg.content = msg.content.substring(0, MAX_TOOL_OUTPUT) + "\n...[TRUNCATED FOR LENGTH TO SAVE CONTEXT]...";
                }
              }
              return msg;
            });

            // Drop old messages to prevent massive attention calculation slowdowns
            if (chatHistory.length > MAX_HISTORY) {
              chatHistory = chatHistory.slice(-MAX_HISTORY);
            }

            // Reconstruct the array: System prompt first, then pruned history
            parsed.messages = mainSystem ? [...mainSystem, ...chatHistory] : chatHistory;

            console.log(`[ollama-proxy] Pruned context: history limited to ${chatHistory.length} messages.`);
          }
          // ───────────────────────────────────────────────────────────────────

          // gemma4:e4b supports native reasoning/thinking mode.
          // Force think=true regardless of what the client sends — OpenClaw
          // currently always sends think=false, which would suppress reasoning.
          parsed.think = true;
          console.log(`[ollama-proxy] think forced to true (gemma4:e4b supports reasoning)`);
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

          // Signal start of a new reasoning block to all SSE listeners
          _broadcastThink({ type: "thinking_start" });

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

              // ── Capture thinking/reasoning tokens from Ollama ──────────────
              // Ollama emits reasoning tokens in message.thinking (separate from
              // message.content). The gateway strips this field, so we intercept
              // it here and broadcast to SSE subscribers before forwarding.
              const thinkToken = obj?.message?.thinking;
              if (typeof thinkToken === "string" && thinkToken.length > 0) {
                _broadcastThink({ type: "thinking_delta", text: thinkToken });
              }
              // ──────────────────────────────────────────────────────────────

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
            // Signal end of reasoning block
            _broadcastThink({ type: "thinking_end" });

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

  // ── Thinking-token SSE server ────────────────────────────────────────────
  // Runs on THINK_PORT. The Electron renderer connects here via EventSource
  // to receive reasoning tokens in real-time, completely bypassing the gateway
  // (which strips the thinking field from Ollama responses).
  const thinkServer = http.createServer((req, res) => {
    // CORS: allow the local file:// origin used by the Electron renderer
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/think" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      // Send a keepalive comment immediately so the client knows it's connected
      res.write(": connected\n\n");

      const sub = { res };
      _thinkSubscribers.add(sub);
      console.log(`[think-sse] Client connected (total=${_thinkSubscribers.size})`);

      // Heartbeat every 15 s to prevent idle connection teardown
      const hb = setInterval(() => {
        try { res.write(": ping\n\n"); } catch { clearInterval(hb); _thinkSubscribers.delete(sub); }
      }, 15000);

      req.on("close", () => {
        clearInterval(hb);
        _thinkSubscribers.delete(sub);
        console.log(`[think-sse] Client disconnected (total=${_thinkSubscribers.size})`);
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  thinkServer.on("error", (err) => {
    console.error(`[think-sse] Server error: ${err.message}`);
  });

  thinkServer.listen(THINK_PORT, OLLAMA_HOST, () => {
    console.log(`[think-sse] Listening on ${OLLAMA_HOST}:${THINK_PORT}`);
  });
  // ────────────────────────────────────────────────────────────────────────

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

module.exports = { startProxy, waitForProxy, PROXY_PORT, THINK_PORT };
