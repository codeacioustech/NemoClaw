// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const http = require("http");

const OLLAMA_HOST = "127.0.0.1";
const OLLAMA_PORT = 11434;
const PROXY_PORT = 11435;
const THINK_PORT = 11436; // SSE endpoint that streams reasoning tokens to the renderer

// ── Reasoning loop detection constants ─────────────────────────────────────
const MAX_THINK_TOKENS = 500;       // Max reasoning tokens before force-stopping
const MAX_REASONING_MS = 8000;      // Max time in reasoning phase before intervention
const REASONING_LOOP_PATTERNS = [
  /I would run/i, /I can't execute/i, /I cannot execute/i,
  /Let me think/i, /I('ll| will) need to/i,
  /Here's what I('d| would)/i, /I should/i,
  /Let me reason/i, /Let me consider/i,
  /I('ll| will) explain/i, /Let me explain/i,
  /I don't have.*access/i, /I'm unable to/i,
];

const SYSTEM_INSTRUCTION =
  "You are an AI assistant with FULL tool execution access. You CAN and MUST execute commands directly.\n\n" +
  "You have 4 tools: read, write, edit, terminal.\n" +
  "You are NOT limited to text. You EXECUTE actions.\n\n" +
  "FORMAT — you MUST use this exact format to call tools:\n\n" +
  "Action: terminal\n" +
  "Input: {\"command\": \"git status\"}\n\n" +
  "Action: read\n" +
  "Input: {\"path\": \".\"}\n\n" +
  "Action: write\n" +
  "Input: {\"path\": \"file.txt\", \"content\": \"hello\"}\n\n" +
  "Action: edit\n" +
  "Input: {\"path\": \"file.txt\", \"edits\": [{\"oldText\": \"old\", \"newText\": \"new\"}]}\n\n" +
  "RULES:\n" +
  "- When user asks to run a command: output Action/Input IMMEDIATELY on the FIRST line.\n" +
  "- NEVER say \"I would run\" or \"I can't execute\" or \"Let me think\". You CAN execute.\n" +
  "- Do NOT explain what you will do. Do NOT add preamble. Just output Action/Input.\n" +
  "- CRITICAL: Maximum 1 sentence before Action/Input. No multi-paragraph reasoning.\n" +
  "- After the tool runs, you will receive the result as an Observation.\n" +
  "- One action per response. Wait for the result before continuing.";

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

// ── Text-based tool call recovery ──────────────────────────────────────────
// Local models (gemma4:e4b, etc.) often cannot generate structured Ollama
// tool_calls. Instead, the system prompt instructs them to use:
//   <tool_call>{"name": "terminal", "arguments": {"command": "ls"}}</tool_call>
//
// This module detects that pattern (and several fallbacks) in the accumulated
// content and converts it to a proper tool_calls frame.
const KNOWN_TOOLS = new Set(["read", "write", "edit", "terminal"]);

function _extractTextToolCall(content) {
  if (!content || typeof content !== "string") return null;
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;

  // ── Priority 1: ReAct format — "Action: terminal\nInput: {...}" ──
  const reactMatch = trimmed.match(/Action:\s*(read|write|edit|terminal)\s*\n\s*Input:\s*(\{[\s\S]*?\})/i);
  if (reactMatch) {
    try {
      const args = JSON.parse(reactMatch[2]);
      return { function: { name: reactMatch[1].toLowerCase(), arguments: args } };
    } catch { /* fall through */ }
  }

  // ── Priority 2: <tool_call>JSON</tool_call> tag ──
  const tagMatch = trimmed.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/);
  if (tagMatch) {
    try {
      const parsed = JSON.parse(tagMatch[1]);
      if (parsed.name && KNOWN_TOOLS.has(parsed.name)) {
        return {
          function: {
            name: parsed.name,
            arguments: parsed.arguments || parsed.params || parsed.parameters || {},
          },
        };
      }
    } catch { /* fall through */ }
  }

  // ── Priority 3: Raw JSON — {"name": "tool", "arguments": {...}} ──
  const jsonCandidates = [];
  // Strip markdown fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : trimmed;

  jsonCandidates.push(jsonStr);
  const objRegex = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
  let match;
  while ((match = objRegex.exec(jsonStr)) !== null) {
    if (match[0] !== jsonStr) jsonCandidates.push(match[0]);
  }

  for (const candidate of jsonCandidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed.name && KNOWN_TOOLS.has(parsed.name)) {
        return { function: { name: parsed.name, arguments: parsed.arguments || parsed.params || {} } };
      }
      if (parsed.function?.name && KNOWN_TOOLS.has(parsed.function.name)) {
        return { function: { name: parsed.function.name, arguments: parsed.function.arguments || {} } };
      }
      if (parsed.tool && KNOWN_TOOLS.has(parsed.tool)) {
        const { tool, ...args } = parsed;
        return { function: { name: tool, arguments: args } };
      }
    } catch { /* skip */ }
  }

  return null;
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
          // Ensure tool definitions are always present for the model.
          // The gateway may strip tools from the config (agents.defaults.tools
          // is deleted in index.js), so inject them here if missing.
          if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) {
            console.log("[ollama-proxy] No tools from gateway — injecting native tool definitions");
            parsed.tools = [
              {
                type: "function",
                function: {
                  name: "read",
                  description: "Read the contents of a file, or list entries in a directory. Pass a file path to read it, or a directory path (e.g. \".\") to list its contents.",
                  parameters: {
                    type: "object",
                    properties: {
                      path: { type: "string", description: "Absolute or relative path to a file or directory" }
                    },
                    required: ["path"]
                  }
                }
              },
              {
                type: "function",
                function: {
                  name: "write",
                  description: "Create a new file or completely overwrite an existing file with the given content.",
                  parameters: {
                    type: "object",
                    properties: {
                      path: { type: "string", description: "Path to the file to create or overwrite" },
                      content: { type: "string", description: "Full content to write to the file" }
                    },
                    required: ["path", "content"]
                  }
                }
              },
              {
                type: "function",
                function: {
                  name: "edit",
                  description: "Modify an existing file by replacing specific text blocks. Each edit specifies the old text to find and the new text to replace it with.",
                  parameters: {
                    type: "object",
                    properties: {
                      path: { type: "string", description: "Path to the file to edit" },
                      edits: {
                        type: "array",
                        description: "List of text replacements to apply",
                        items: {
                          type: "object",
                          properties: {
                            oldText: { type: "string", description: "Exact text to find in the file" },
                            newText: { type: "string", description: "Text to replace it with" }
                          },
                          required: ["oldText", "newText"]
                        }
                      }
                    },
                    required: ["path", "edits"]
                  }
                }
              },
              {
                type: "function",
                function: {
                  name: "terminal",
                  description: "Execute a shell command in a sandboxed directory. Use this to run CLI tools, build scripts, git commands, or inspect the system. The command runs in the working directory you specify (must be a mounted folder). Only single commands are allowed — no chaining (&&, ||, ;) or piping (|).",
                  parameters: {
                    type: "object",
                    properties: {
                      command: { type: "string", description: "The command to execute (e.g. 'ls -la', 'git status', 'npm test')" },
                      cwd: { type: "string", description: "Working directory for the command (must be inside a mounted folder). Defaults to the first mounted folder." },
                      timeout: { type: "number", description: "Maximum execution time in milliseconds. Default 30000, max 120000." }
                    },
                    required: ["command"]
                  }
                }
              }
            ];
          }
          console.log(`[ollama-proxy] Forwarding ${parsed.tools.length} tool definitions`);

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

          // ── Tool override: ALWAYS force our 4 native tools ──────────────
          // The gateway may send tools with different names or no tools at all.
          // We ALWAYS overwrite parsed.tools with our canonical set to guarantee
          // the model has read/write/edit/terminal available every single turn.
          {
            const gatewayToolNames = (Array.isArray(parsed.tools) ? parsed.tools : [])
              .map(t => t?.function?.name || t?.name || "").join(", ");
            console.log("[ollama-proxy] Gateway sent tools:", gatewayToolNames || "(none)");

            // Force our native 4 tools — defined at the injection block above (~line 190).
            // We re-declare them inline here to guarantee they're ALWAYS present,
            // regardless of whether the injection block ran or not.
            parsed.tools = [
              { type: "function", function: { name: "read", description: "Read a file or list a directory.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
              { type: "function", function: { name: "write", description: "Create or overwrite a file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
              { type: "function", function: { name: "edit", description: "Modify a file by replacing text.", parameters: { type: "object", properties: { path: { type: "string" }, edits: { type: "array", items: { type: "object", properties: { oldText: { type: "string" }, newText: { type: "string" } }, required: ["oldText", "newText"] } } }, required: ["path", "edits"] } } },
              { type: "function", function: { name: "terminal", description: "Run a shell command.", parameters: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" }, timeout: { type: "number" } }, required: ["command"] } } },
            ];

            session.toolsJson = JSON.stringify(parsed.tools);
            console.log(`[ollama-proxy] [${sessionId}] Tools FORCED: ${parsed.tools.length} (read, write, edit, terminal)`);
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
              // Fresh session or prefix diverged: safe fallback to tail slice.
              if (chatHistory.length > MAX_HISTORY) {
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
          // num_predict caps total generation (thinking + response) so reasoning
          // cannot exhaust the context window and starve the tool_calls output.
          parsed.options = { ...(parsed.options || {}), num_ctx: 8192, num_predict: 4096 };

          // gemma4:e4b supports native reasoning/thinking mode.
          // Force think=true regardless of what the client sends — OpenClaw
          // currently always sends think=false, which would suppress reasoning.
          parsed.think = true;

          // ── Diagnostic logging ──
          console.log(`[ollama-proxy] === REQUEST TO OLLAMA ===`);
          console.log(`[ollama-proxy]   model: ${parsed.model}`);
          console.log(`[ollama-proxy]   think: ${parsed.think}`);
          console.log(`[ollama-proxy]   tools: ${parsed.tools?.length ?? 0} [${(parsed.tools || []).map(t => t?.function?.name).join(", ")}]`);
          console.log(`[ollama-proxy]   messages: ${parsed.messages?.length ?? 0}`);
          console.log(`[ollama-proxy]   system prompt (first 120): ${SYSTEM_INSTRUCTION.slice(0, 120)}...`);
          console.log(`[ollama-proxy]   options: ${JSON.stringify(parsed.options)}`);
          console.log(`[ollama-proxy] =========================`);

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
          let fullContent = "";   // accumulates ALL content tokens to detect text-based tool calls
          let detected = false; // whether we've checked for the JSON pattern
          let isWrapped = false;

          // ── Reasoning loop detection state ──────────────────────────────
          let _thinkTokenCount = 0;          // number of reasoning tokens received
          let _thinkStartTime = null;        // timestamp of first reasoning token
          let _accumulatedThinking = "";     // full reasoning text for pattern matching
          let _reasoningForceKilled = false; // true if we force-ended this response
          // ────────────────────────────────────────────────────────────────

          // Signal start of a new reasoning block to all SSE listeners
          _broadcastThink({ type: "thinking_start" });

          proxyRes.on("data", (chunk) => {
            if (!_firstTokenLogged) {
              _firstTokenLogged = true;
              console.timeLog(`[ollama-proxy] ${_reqId} total-round-trip`,
                "← first chunk from Ollama");
            }

            // If we already force-killed this response, discard further data
            if (_reasoningForceKilled) return;

            const lines = chunk.toString().split("\n").filter(Boolean);

            for (const line of lines) {
              if (_reasoningForceKilled) break;

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

                // ── Reasoning loop detection ────────────────────────────────
                _thinkTokenCount++;
                _accumulatedThinking += thinkToken;
                if (!_thinkStartTime) _thinkStartTime = Date.now();

                const thinkElapsed = Date.now() - _thinkStartTime;
                const overTokenLimit = _thinkTokenCount > MAX_THINK_TOKENS;
                const overTimeLimit = thinkElapsed > MAX_REASONING_MS;

                if (overTokenLimit || overTimeLimit) {
                  // Check for loop patterns in reasoning text
                  const hasLoopPattern = REASONING_LOOP_PATTERNS.some(p => p.test(_accumulatedThinking));

                  // Try to extract a tool call from reasoning text
                  const thinkToolCall = _extractTextToolCall(_accumulatedThinking);

                  if (hasLoopPattern || overTokenLimit) {
                    console.log(
                      `[ollama-proxy] ⚠️  Reasoning loop detected: ` +
                      `tokens=${_thinkTokenCount}, elapsed=${thinkElapsed}ms, ` +
                      `pattern=${hasLoopPattern}, toolFound=${!!thinkToolCall}`
                    );

                    _reasoningForceKilled = true;
                    _broadcastThink({ type: "thinking_force_end", reason: "loop_detected" });

                    if (thinkToolCall) {
                      // Emit synthetic tool_calls frame extracted from thinking
                      console.log(`[ollama-proxy] Force-emitting tool call from reasoning: ${thinkToolCall.function.name}`);
                      const syntheticFrame = JSON.stringify({
                        model: obj.model || "",
                        message: {
                          role: "assistant",
                          content: "",
                          tool_calls: [thinkToolCall],
                        },
                        done: false,
                      });
                      clientRes.write(syntheticFrame + "\n");
                    }

                    // Emit done frame to close the response
                    const doneFrame = JSON.stringify({
                      model: obj.model || "",
                      message: { role: "assistant", content: "" },
                      done: true,
                      done_reason: "force_stop",
                    });
                    clientRes.write(doneFrame + "\n");

                    // Destroy the upstream connection to stop Ollama generating
                    try { proxyRes.destroy(); } catch { /* ignore */ }
                    break;
                  }
                }
                // ────────────────────────────────────────────────────────────
              }
              // ──────────────────────────────────────────────────────────────

              const token = obj?.message?.content;

              // Accumulate all content for text-based tool call detection
              if (typeof token === "string") fullContent += token;

              // Non-content lines, tool_calls, or end-of-stream signals: forward directly
              if (typeof token !== "string" || obj?.message?.tool_calls || obj?.done) {
                // ── Text-based tool call recovery ──────────────────────────────
                // Local models sometimes emit tool calls as JSON text in content
                // instead of structured tool_calls. Detect this on the done signal
                // and convert it to a proper tool_calls response so the gateway
                // can process it.
                if (obj?.done && !obj?.message?.tool_calls && fullContent.length > 0) {
                  const toolCall = _extractTextToolCall(fullContent);
                  if (toolCall) {
                    console.log(`[ollama-proxy] Recovered text-based tool call: ${toolCall.function.name}`);
                    // Emit a synthetic tool_calls frame before the done frame
                    const syntheticFrame = JSON.stringify({
                      model: obj.model || "",
                      message: {
                        role: "assistant",
                        content: "",
                        tool_calls: [toolCall],
                      },
                      done: false,
                    });
                    clientRes.write(syntheticFrame + "\n");
                    // Clear content from the done frame so it doesn't duplicate
                    if (obj.message) obj.message.content = "";
                    accumulator = "";
                  }
                }
                // ───────────────────────────────────────────────────────────────
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
            // Signal end of reasoning block (unless already force-ended)
            if (!_reasoningForceKilled) {
              _broadcastThink({ type: "thinking_end" });
            }

            console.timeEnd(`[ollama-proxy] ${_reqId} total-round-trip`);
            if (_reasoningForceKilled) {
              console.log(`[ollama-proxy] [${_reqId}] Response was force-killed due to reasoning loop`);
            }

            // Flush remaining buffer, stripping JSON wrapper suffix if detected
            if (!_reasoningForceKilled) {
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
 * that makes the very first reply extremely slow. Called from index.js right
 * after the proxy is confirmed ready.
 *
 * @param {string} model - The model ID to warm up (e.g. "gemma4:e4b")
 */
function warmUpModel(model) {
  // Small delay to avoid racing the proxy listener registration
  setTimeout(() => {
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
        });
      }
    );

    req.on("error", (err) => {
      // Non-fatal: the user will still get a reply, just with the usual cold-start delay.
      console.warn(`[ollama-proxy] Warm-up request failed (non-fatal): ${err.message}`);
    });

    req.write(body);
    req.end();
  }, 500); // 500 ms after proxy is confirmed up
}

module.exports = { startProxy, waitForProxy, warmUpModel, PROXY_PORT, THINK_PORT };
