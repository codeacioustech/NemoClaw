// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const http = require("http");
const fs = require("fs");
const path = require("path");
const { NEMOCLAW_DIR } = require("./config-seeder");
const LAUNCHER_CONFIG = path.join(NEMOCLAW_DIR, "launcher_config.json");

const OLLAMA_HOST = "127.0.0.1";
const OLLAMA_PORT = 11434;
const PROXY_PORT = 11435;
const THINK_PORT = 11436; // SSE endpoint that streams reasoning tokens to the renderer

const SYSTEM_INSTRUCTION =
  "You are a helpful assistant running inside the NemoClaw desktop app. " +
  "You must use the following tools to interact with the filesystem:\n" +
  "- `read`: to read a file OR to list the contents of a directory (e.g. pass \".\" or a folder path).\n" +
  "- `edit`: to modify existing files.\n" +
  "- `write`: to create or completely overwrite files.\n" +
  "- `exex`: to run shell commands. Use this for listing processes, running scripts, " +
  "git operations, package managers, etc. \n" +
  "Whenever you're going to run a shell command, output the user the exact command and a short description does before running it" +
  "ask the user for confirmation for the command along with the command description then prompt the user to confirm and wait, if the user says yes, run the command and continue, if the user says no, stop and don't run the command," +
  "You are NOT allowed to run any commands that require sudo access" +
  "ALWAYS wait for the tool result before replying. " +
  "For non-file questions, answer in plain text. " +
  "Never read, list, edit, or write any file under `~/.nemoclaw/` or `~/.openclaw/`. " +
  "Those directories hold system credentials and launcher config; the user does " +
  "not want them accessed. If a user request requires credentials, inform them " +
  "that connector integrations are managed through the launcher UI.";

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

// ── Proxy-side session store for KV prefix-cache maximisation ──────────────
//
// Ollama has no session_id API — it caches KV pairs implicitly based on
// whether the token prefix of the new request is byte-for-byte identical
// to the previous one. We maximise cache hits by:
//   1. Tracking the last message array we sent per logical chat session.
//   2. Only appending new messages; never re-slicing from a different tail
//      offset (which shifts the prefix and causes a cache miss).
//   3. Keeping tool definitions frozen (same JSON string every turn).
//   4. Injecting keep_alive so the model + KV state stay in VRAM.
//
// Session ID is derived from the most stable identifier the OpenClaw gateway
// sends. In descending preference: x-session-id header, x-request-id header,
// authorization token suffix, or a hash of the first user message.
//
const _sessionStore = new Map();
// { sessionId -> { messages: [...], toolsJson: string } }

/**
 * Derive a stable, gateway-provided session key from the request.
 * Returns a short opaque ASCII string suitable for logging.
 */
function deriveSessionId(headers, parsedBody) {
  // 1. Explicit session header (most reliable)
  const explicit =
    headers["x-session-id"] ||
    headers["x-openclaw-session"] ||
    headers["x-request-id"];
  if (explicit) return explicit.slice(0, 40);

  // 2. Stable suffix of the Authorization token (first 32 chars of bearer)
  const auth = headers["authorization"] || "";
  const bearer = auth.replace(/^Bearer\s+/i, "");
  if (bearer.length >= 8) return `auth-${bearer.slice(0, 32)}`;

  // 3. Stable hash of the system prompt + first user message content.
  // Falls back to a per-process ephemeral session (single session mode).
  const msgs = Array.isArray(parsedBody?.messages) ? parsedBody.messages : [];
  const firstUser = msgs.find(m => m.role === "user");
  const seed = SYSTEM_INSTRUCTION.slice(0, 40) + (firstUser?.content?.slice?.(0, 80) ?? "");
  // djb2 hash — fast, no crypto module needed
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h) ^ seed.charCodeAt(i);
  return `hash-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Start a lightweight HTTP proxy between OpenClaw and Ollama.
 * - Injects a system instruction into /api/chat requests (primary fix).
 * - Strips JSON action-wrapper patterns from streamed response tokens (fallback).
 */
function startProxy(onListening) {
  const server = http.createServer((clientReq, clientRes) => {
    console.log(`[ollama-proxy] ${clientReq.method} ${clientReq.url} content-length=${clientReq.headers["content-length"] || "none"}`);

    // Renderer-triggered reset: wipe proxy-side session store so a new chat
    // starts with zero prior messages regardless of static bearer token.
    if (clientReq.method === "POST" && clientReq.url === "/session/reset") {
      _sessionStore.clear();
      console.log("[ollama-proxy] /session/reset — cleared all session state");
      clientRes.writeHead(200, { "Content-Type": "application/json" });
      clientRes.end(JSON.stringify({ ok: true }));
      return;
    }

    // Prime the proxy's session anchor with historical messages so the model
    // sees full prior context on the next /api/chat even though the gateway
    // only sends the new user turn.
    if (clientReq.method === "POST" && clientReq.url === "/session/prime") {
      const chunks = [];
      clientReq.on("data", (c) => chunks.push(c));
      clientReq.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
          const msgs = Array.isArray(body.messages) ? body.messages : [];
          const clean = msgs
            .filter((m) => m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant"))
            .map((m) => ({ role: m.role, content: m.content }));
          _sessionStore.set("auth-ollama-local", {
            messages: clean,
            toolsJson: null,
            primed: true,
          });
          console.log(`[ollama-proxy] /session/prime — primed ${clean.length} messages`);
          clientRes.writeHead(200, { "Content-Type": "application/json" });
          clientRes.end(JSON.stringify({ ok: true, count: clean.length }));
        } catch (e) {
          clientRes.writeHead(400);
          clientRes.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

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

          // Prevent model unloading and KV cache eviction (Ollama default is 5m)
          parsed.keep_alive = -1;

          // ── Session-aware Context Pruning + KV Prefix Cache Engine ───────────
          //
          // Goal: send the shortest legal payload AND keep the token prefix
          // byte-identical to the previous request so Ollama reuses its
          // KV cache instead of re-evaluating shared history.
          //
          // Strategy:
          //   a) Derive a stable session ID from gateway request headers.
          //   b) Load the message array we sent last turn (the "anchor").
          //   c) If the new history is a strict extension of the anchor
          //      (same messages in same order + N new ones at the end), only
          //      append the new portion — prefix is unchanged → cache HIT.
          //   d) If the history diverged (new session, or gateway reordered
          //      something), fall back to a clean slice of the last MAX_HISTORY
          //      messages — cache MISS, but prefix is correct for next turn.
          //   e) Save the resulting message array as the new anchor.
          //
          const MAX_HISTORY     = 4;    // messages kept when starting fresh
          const MAX_TOOL_OUTPUT = 800;  // chars per tool-result before truncation

          const sessionId = deriveSessionId(clientReq.headers, parsed);
          const session   = _sessionStore.get(sessionId) || { messages: null, toolsJson: null };

          // ── Tool override: Inject the 3 exact tools the chat.js UI natively supports ──
          // ── Tool intercept: Capture and filter native OpenClaw tools ──
          if (Array.isArray(parsed.tools)) {
            // Find tools that look related to files to debug their OpenClaw schema
            console.log("\n[DEBUG] ALL NATIVE TOOLS:\n", parsed.tools.map(t => t?.function?.name || t?.name).join(", "), "\n");

            const before = parsed.tools.length;
            // Filter to only the core file tools so we don't blow up Ollama's VRAM
            const ALLOWED_TOOLS = new Set(["read", "write", "edit", "exec"]);
            parsed.tools = parsed.tools.filter(t => {
              const name = (t?.function?.name || t?.name || "").toLowerCase();
              return ALLOWED_TOOLS.has(name);
            });

            // Freeze: serialise tools once per session so the JSON bytes are
            // identical across turns (same token sequence → cache hit).
            if (!session.toolsJson) {
              session.toolsJson = JSON.stringify(parsed.tools);
            }
            parsed.tools = JSON.parse(session.toolsJson);

            console.log(
              `[ollama-proxy] [${sessionId}] Tools: ${before} → ${parsed.tools.length} ` +
              `(stripped ${before - parsed.tools.length} unused definitions. frozen for KV cache)`
            );
          }

          // ── Message pruning with prefix-stability check ───────────────────
          if (Array.isArray(parsed.messages)) {
            // Strip system messages injected by gateway (we inject our own below)
            // NOTE: SYSTEM_INSTRUCTION was already unshifted above; filter dupes.
            let chatHistory = parsed.messages.filter(m => m.role !== 'system');

            // Truncate massive tool results
            chatHistory = chatHistory.map(msg => {
              if (msg.role === 'tool' && msg.content && typeof msg.content === 'string') {
                if (msg.content.length > MAX_TOOL_OUTPUT) {
                  msg.content =
                    msg.content.substring(0, MAX_TOOL_OUTPUT) +
                    "\n...[TRUNCATED FOR CONTEXT]...";
                }
              }
              return msg;
            });

            // ── Prefix stability decision ─────────────────────────────────
            let cacheHit = false;
            if (session.messages && session.messages.length > 0) {
              const anchor = session.messages; // what we sent last turn
              const al = anchor.length;

              // Check if chatHistory starts with exactly the same messages as
              // anchor (i.e. gateway simply appended new turns at the end).
              const prefixMatch =
                chatHistory.length >= al &&
                anchor.every((m, i) =>
                  chatHistory[i].role    === m.role &&
                  chatHistory[i].content === m.content
                );

              if (prefixMatch) {
                // Take anchor messages (already in Ollama's KV cache) plus any
                // new messages the gateway appended this turn.
                chatHistory = chatHistory.slice(0, al + 2); // anchor + 1 new turn (2 msgs)
                cacheHit = true;
              }
            }

            if (!cacheHit) {
              // If the session was primed from a historical DB load, prepend
              // the primed anchor so the model sees full prior context on
              // the very first turn of this restored chat. Consumed once.
              if (session.primed && Array.isArray(session.messages) && session.messages.length) {
                chatHistory = [...session.messages, ...chatHistory];
                session.primed = false;
                console.log(`[ollama-proxy] primed anchor merged (${session.messages.length} prior msgs)`);
              } else if (chatHistory.length > MAX_HISTORY) {
                // Fresh session or prefix diverged: safe fallback to tail slice.
                chatHistory = chatHistory.slice(-MAX_HISTORY);
              }
            }

            // Always place our canonical system prompt first.
            parsed.messages = [
              { role: "system", content: SYSTEM_INSTRUCTION },
              ...chatHistory,
            ];

            // Save the non-system portion as the anchor for the next turn.
            session.messages = chatHistory;
            _sessionStore.set(sessionId, session);

            console.log(
              `[ollama-proxy] [${sessionId}] Context: ${chatHistory.length} msgs, ` +
              `${parsed.tools?.length ?? 0} tools, ` +
              `prefix-cache=${cacheHit ? "HIT" : "MISS"}`
            );
          }
          // ─────────────────────────────────────────────────────────────────────

          // Keep the model + KV state resident in VRAM between turns.
          parsed.keep_alive = "10m";

          // Constrain context window for faster prompt eval.
          parsed.options = { ...(parsed.options || {}), num_ctx: 8192 };

          try {
            const config = JSON.parse(fs.readFileSync(LAUNCHER_CONFIG, "utf-8"));
            if (config.ollama_model) {
              parsed.model = config.ollama_model;
            }
          } catch (e) {
            // fallback
          }

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

      // ── Latency logging ─────────────────────────────────────────────────────
      const _reqId = `ollama-req-${Date.now()}`;
      console.time(`[ollama-proxy] ${_reqId} total-round-trip`);
      let _firstTokenLogged = false;
      // ────────────────────────────────────────────────────────────────────────

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
            if (!_firstTokenLogged) {
              _firstTokenLogged = true;
              console.timeLog(`[ollama-proxy] ${_reqId} total-round-trip`,
                "← first chunk from Ollama");
            }
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

              // Non-content lines, tool_calls, or end-of-stream signals: forward directly
              if (typeof token !== "string" || obj?.message?.tool_calls || obj?.done) {
                if (obj?.done && accumulator && !obj.message) obj.message = { role: "assistant" };
                if (accumulator) obj.message.content = accumulator;
                clientRes.write(JSON.stringify(obj) + "\n");
                accumulator = "";
                continue;
              }

              // Phase 1: buffer tokens to detect JSON wrapper (~60 chars)
              if (!detected) {
                accumulator += token;
                if (accumulator.length < 60) continue;

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

            console.timeEnd(`[ollama-proxy] ${_reqId} total-round-trip`);

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

/**
 * Fire a silent /api/generate request to force Ollama to load the model
 * weights into VRAM before the user sends the first message.
 *
 * This eliminates the "cold start" penalty (loading several GB from disk)
 * that makes the very first reply extremely slow.
 *
 * @param {string} model - The model ID to warm up (e.g. "gemma4:e4b")
 * @returns {Promise<void>}
 */
function warmUpModel(model) {
  return new Promise((resolve) => {
    console.log(`[ollama-proxy] Warming up model "${model}" (load into VRAM)...`);
    const warmStart = Date.now();

    const body = JSON.stringify({
      model,
      prompt: "",          // empty prompt — just loads the model
      stream: false,
      keep_alive: "10m",   // keep weights in VRAM for 10 minutes
    });

    const req = http.request(
      {
        hostname: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: "/api/generate",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume(); // drain and discard the response
        res.on("end", () => {
          console.log(
            `[ollama-proxy] Model "${model}" warm-up complete in ${
              Date.now() - warmStart
            }ms — now resident in VRAM`
          );
          resolve();
        });
      }
    );

    req.on("error", (err) => {
      // Non-fatal: the user will still get a reply, just with the usual cold-start delay.
      console.warn(`[ollama-proxy] Warm-up request failed (non-fatal): ${err.message}`);
      resolve();
    });

    req.write(body);
    req.end();
  });
}

module.exports = { startProxy, waitForProxy, warmUpModel, PROXY_PORT, THINK_PORT };
