// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Chat UI controller — manages the slide-out chat panel,
 * message rendering, and streaming responses.
 */

import { gateway } from "./gateway-client.js";

export const chat = (() => {
  let _sessionKey = null;
  let _dbSessionId = null;
  let _streaming = false;
  let _currentAssistantEl = null;   // outer .chat-msg.assistant bubble
  let _currentThinkEl = null;       // <details> reasoning block inside bubble
  let _currentThinkBody = null;     // <pre> inside the <details>
  let _thinkingActive = false;      // true while reasoning tokens are flowing
  let _accumulatedText = "";

  const $ = (sel) => document.querySelector(sel);

  function open() {
    $(".chat-overlay").classList.add("open");
    $(".chat-input")?.focus();
  }

  function close() {
    $(".chat-overlay").classList.remove("open");
  }

  function toggle() {
    $(".chat-overlay").classList.toggle("open");
    if ($(".chat-overlay").classList.contains("open")) {
      $(".chat-input")?.focus();
    }
  }

  function isOpen() {
    return $(".chat-overlay")?.classList.contains("open") || false;
  }

  // --- Message rendering ---

  // Ensure the assistant bubble exists and return it.
  // On first call it constructs outer bubble + answer div.
  // If a thinking block has already been appended, the answer
  // text goes below it inside the same bubble.
  function ensureAssistantBubble() {
    if (_currentAssistantEl) return _currentAssistantEl;
    const container = $(".chat-messages");
    if (!container) return null;
    const empty = container.querySelector(".chat-empty");
    if (empty) empty.remove();

    const el = document.createElement("div");
    el.className = "chat-msg assistant";

    // The answer text lives in its own div so any reasoning block that gets
    // prepended above it is never clobbered by textContent writes.
    // NOTE: do NOT pre-attach _currentThinkEl here. The thinking_start handler
    // calls ensureAssistantBubble() BEFORE setting _currentThinkEl, then
    // explicitly inserts the <details> node before the answer div itself.
    // Pre-attaching here would cause a double-insertion race.
    const answerDiv = document.createElement("div");
    answerDiv.className = "chat-answer";
    el.appendChild(answerDiv);

    container.appendChild(el);
    scrollToBottom();
    _currentAssistantEl = el;
    return el;
  }

  function appendMessage(role, text) {
    const container = $(".chat-messages");
    if (!container) return null;

    // Remove empty state if present
    const empty = container.querySelector(".chat-empty");
    if (empty) empty.remove();

    const el = document.createElement("div");
    el.className = `chat-msg ${role}`;
    el.textContent = text;
    container.appendChild(el);
    scrollToBottom();
    return el;
  }

  function appendSystemMessage(text) {
    return appendMessage("system", text);
  }

  function scrollToBottom() {
    const container = $(".chat-messages");
    if (container) container.scrollTop = container.scrollHeight;
  }

  function showTyping() {
    const el = $(".chat-typing");
    if (el) el.classList.add("active");
    scrollToBottom();
  }

  function hideTyping() {
    const el = $(".chat-typing");
    if (el) el.classList.remove("active");
  }

  function clearMessages() {
    const container = $(".chat-messages");
    if (!container) return;
    container.innerHTML = `
      <div class="chat-empty">
        <div class="chat-empty-icon icon" style="width:48px;height:48px;"><svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg></div>
        <div class="chat-empty-text">
          Send a message to start chatting<br>with your local AI.
        </div>
      </div>
    `;
  }

  // --- Session management ---

  async function loadHistoryList() {
    const list = $("#chat-history-list");
    if (!list) return;
    const sessions = await window.launcher.db.getSessions();
    list.innerHTML = "";
    for (const s of sessions) {
      const el = document.createElement("div");
      el.className = "chat-history-item" + (s.id === _dbSessionId ? " active" : "");
      const title = document.createElement("span");
      title.className = "chat-history-title";
      title.textContent = s.title;
      const delBtn = document.createElement("button");
      delBtn.className = "chat-history-delete";
      delBtn.setAttribute("aria-label", "Delete chat");
      delBtn.textContent = "×";
      delBtn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (!confirm("Delete this chat?")) return;
        try {
          await window.launcher.db.deleteSession(s.id);
        } catch (e) {
          appendSystemMessage("Failed to delete chat: " + e.message);
          return;
        }
        if (s.id === _dbSessionId) {
          await newChat();
        } else {
          loadHistoryList();
        }
      });
      el.appendChild(title);
      el.appendChild(delBtn);
      el.addEventListener("click", () => loadHistoricalSession(s.id));
      list.appendChild(el);
    }
  }

  async function loadHistoricalSession(id) {
    if (_streaming) return;
    _dbSessionId = id;
    try {
      await fetch("http://127.0.0.1:11435/session/reset", { method: "POST" });
    } catch {}
    const msgs = await window.launcher.db.getMessages(id);
    try {
      await fetch("http://127.0.0.1:11435/session/prime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: msgs.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
    } catch {}
    try {
      const res = await gateway.createSession("OpenCoot Chat");
      _sessionKey = res.key;
    } catch {
       _sessionKey = null;
    }

    clearMessages();
    const container = $(".chat-messages");
    if (!container) return;
    const empty = container.querySelector(".chat-empty");
    if (empty) empty.remove();

    for (const m of msgs) {
      const el = document.createElement("div");
      el.className = `chat-msg ${m.role}`;
      const answerDiv = document.createElement("div");
      if (m.role === 'assistant') {
         answerDiv.className = "chat-answer";
      }
      answerDiv.textContent = m.content;
      el.appendChild(answerDiv);
      container.appendChild(el);
    }
    scrollToBottom();
    appendSystemMessage("Historical session loaded. Context restored.");
    loadHistoryList();
  }

  async function ensureSession() {
    if (!_dbSessionId) {
      const s = await window.launcher.db.createSession("New Chat");
      _dbSessionId = s.id;
      loadHistoryList();
    }
    if (_sessionKey) return _sessionKey;

    try {
      const sessions = await gateway.listSessions();
      if (sessions.length > 0) {
        _sessionKey = sessions[0].key;
        return _sessionKey;
      }
    } catch (e) {
      console.warn("[chat] failed to list sessions:", e.message);
    }

    try {
      const res = await gateway.createSession("OpenCoot Chat");
      _sessionKey = res.key;
      return _sessionKey;
    } catch (e) {
      console.error("[chat] failed to create session:", e.message);
      appendSystemMessage("Failed to create chat session. Is the gateway running?");
      return null;
    }
  }

  async function newChat() {
    // If a generation is in flight, cancel it first so we don't leak state.
    if (_streaming) {
      await stopGeneration();
    }
    // Tear down the old gateway session so the LLM context is fresh.
    const oldKey = _sessionKey;
    _sessionKey = null;
    if (oldKey) {
      try { await gateway.deleteSession(oldKey); } catch {}
    }
    try {
      await fetch("http://127.0.0.1:11435/session/reset", { method: "POST" });
    } catch {}
    clearMessages();
    try {
      const s = await window.launcher.db.createSession("New Chat");
      _dbSessionId = s.id;
    } catch (e) {
      appendSystemMessage("Failed to create DB session: " + e.message);
    }
    try {
      const res = await gateway.createSession("OpenCoot Chat");
      _sessionKey = res.key;
    } catch (e) {
      appendSystemMessage("Failed to create gateway session: " + e.message);
    }
    loadHistoryList();
  }

  // --- Slash command handler ---

  // Handle a client-side slash command typed into the chat input.
  // Slash commands are consumed entirely here and never sent to the LLM.
  //
  // Supported commands:
  //   /clear | /reset  - clear the UI and rotate the gateway session
  //   /help            - list available commands
  async function handleSlashCommand(raw) {
    const parts = raw.trim().split(/\s+/);
    const cmd   = parts[0].toLowerCase();

    switch (cmd) {
      case "/clear":
      case "/reset": {
        // newChat() creates a brand-new gateway session key AND clears the UI.
        // Rotating the session key forces the gateway to start a fresh context
        // window so the LLM has no memory of prior messages. The proxy's
        // _sessionStore sees a new first-user-message hash and starts a
        // clean KV anchor on the next turn.
        try {
          await newChat();
          appendSystemMessage("Chat history cleared. AI context reset. Start a new conversation.");
        } catch (e) {
          appendSystemMessage("Failed to reset session: " + e.message);
        }
        break;
      }

      case "/help": {
        appendSystemMessage(
          "Available commands:\n" +
          "  /clear  or  /reset - wipe chat history and reset AI memory\n" +
          "  /help              - show this message"
        );
        break;
      }

      default: {
        appendSystemMessage(
          "Unknown command: " + parts[0] + "\n" +
          "Type /help for a list of available commands."
        );
      }
    }
  }

  // --- Sending messages ---


  async function send() {
    const input = $(".chat-input");
    if (!input) return;

    const text = input.value.trim();
    if (!text || _streaming) return;

    input.value = "";
    input.style.height = "40px";

    // ── Slash command interceptor ─────────────────────────────────────────
    // Must run BEFORE appendMessage so the slash text is never rendered
    // as a user bubble and never forwarded to the gateway or LLM.
    if (text.startsWith("/")) {
      handleSlashCommand(text);
      return;
    }
    // ─────────────────────────────────────────────────────────

    appendMessage("user", text);

    // Defensive: if the user's message looks file-related but no folder
    // is mounted, the file tools will fail validation. Surface that up
    // front so the model's claim to have "created" a file isn't
    // contradicted only by a silent tool error bubble.
    if (/\b(create|save|write|read|open|edit|file|folder|directory)\b/i.test(text)) {
      try {
        const folders = await window.launcher.getMountedFolders();
        if (!folders || folders.length === 0) {
          appendSystemMessage(
            "No folders are mounted yet. File tools (create_file, read_file, list_directory) " +
            "can only touch paths inside mounted folders. Mount one via Connectors → Local Files."
          );
        }
      } catch {
        // Non-fatal — continue.
      }
    }

    const key = await ensureSession();
    if (!key) return;

    if (_dbSessionId) {
       await window.launcher.db.saveMessage(_dbSessionId, "user", text);

       // Auto-title the session from the first user message.
       const priorMsgs = await window.launcher.db.getMessages(_dbSessionId);
       const userCount = priorMsgs.filter((m) => m.role === "user").length;
       if (userCount === 1) {
         const title = text.replace(/\s+/g, " ").trim().slice(0, 60);
         try {
           await window.launcher.db.updateSessionTitle(_dbSessionId, title);
           loadHistoryList();
         } catch (e) {
           console.warn("[chat] updateSessionTitle failed:", e.message);
         }
       }
    }

    const isFirstMsg = document.querySelectorAll(".chat-bubble.user").length === 1;
    if (isFirstMsg) {
      appendSystemMessage("Evaluating OpenClaw tool schemas into VRAM. This initial evaluation takes ~20 seconds. Please wait...");
    }

    _streaming = true;
    _accumulatedText = "";
    _currentAssistantEl = null;
    _currentThinkEl = null;
    _currentThinkBody = null;
    _thinkingActive = false;
    updateSendButton();
    showTyping();

    try {
      await gateway.sendMessage(key, text);
    } catch (e) {
      hideTyping();
      _streaming = false;
      updateSendButton();
      appendSystemMessage("Failed to send: " + e.message);
    }
  }

  // --- Thinking/Reasoning SSE stream handler ---

  function connectThinkStream() {
    const THINK_URL = "http://127.0.0.1:11436/think";
    let es;

    function connect() {
      es = new EventSource(THINK_URL);

      es.onmessage = (evt) => {
        let payload;
        try { payload = JSON.parse(evt.data); } catch { return; }

        if (payload.type === "thinking_start") {
          // ── Critical fix: attach the bubble to the live DOM RIGHT NOW. ──
          // Previously the <details> node was built detached and only wired
          // into the DOM when the first gateway "delta" event fired. That
          // meant every thinking_delta token was written to a detached <pre>
          // that the browser never painted — all tokens appeared to arrive
          // at once after the final answer. By eagerly creating the bubble
          // here we guarantee every token renders immediately as it arrives.
          _thinkingActive = true;

          const details = document.createElement("details");
          details.className = "chat-reasoning";
          details.open = true; // expanded so the user sees tokens stream live

          const summary = document.createElement("summary");
          summary.className = "chat-reasoning-summary";
          summary.textContent = "💭 Reasoning";
          details.appendChild(summary);

          const body = document.createElement("pre");
          body.className = "chat-reasoning-body";
          details.appendChild(body);

          _currentThinkEl = details;
          _currentThinkBody = body;

          // Ensure the outer bubble is in the live DOM, then attach the
          // reasoning block as its first child — answer div follows below.
          const bubble = ensureAssistantBubble();
          if (bubble) {
            // ensureAssistantBubble() already appended _currentThinkEl if it
            // was set, but here _currentThinkEl was just created after the
            // call so we need to manually prepend it before the answer div.
            const answerDiv = bubble.querySelector(".chat-answer");
            if (answerDiv) {
              bubble.insertBefore(details, answerDiv);
            } else {
              bubble.prepend(details);
            }
          }
          // Hide the typing indicator now that we have a live block
          hideTyping();

        } else if (payload.type === "thinking_delta" && _currentThinkBody) {
          _currentThinkBody.textContent += payload.text;
          scrollToBottom();

        } else if (payload.type === "thinking_end") {
          _thinkingActive = false;
          // Collapse the reasoning block once the answer starts — the user
          // can still re-open it by clicking the summary.
          if (_currentThinkEl) {
            _currentThinkEl.open = false;
          }
        }
      };

      es.onerror = () => {
        // Silently reconnect after 3 s — the proxy may not be up yet
        es.close();
        setTimeout(connect, 3000);
      };
    }

    connect();
  }

  // --- Streaming handler ---

  function handleChatEvent(payload) {
    if (!payload || payload.sessionKey !== _sessionKey) return;

    const state = payload.state;
    const content = payload.message?.content;
    let text = "";
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "text") text += part.text;
      }
    }

    if (state === "delta") {
      hideTyping();
      // Ensure the outer bubble exists (creates it and attaches the pending
      // thinking block if one was built before the first text delta).
      ensureAssistantBubble();
      _accumulatedText = text;
      const answerDiv = _currentAssistantEl.querySelector(".chat-answer");
      if (answerDiv) answerDiv.textContent = _accumulatedText;
      scrollToBottom();
    }

    if (state === "final" || state === "error") {
      hideTyping();
      if (!_currentAssistantEl && text) {
        ensureAssistantBubble();
      }
      if (_currentAssistantEl && text) {
        const answerDiv = _currentAssistantEl.querySelector(".chat-answer");
        if (answerDiv) answerDiv.textContent = text;
      }

      if (state === "final" && text && _dbSessionId) {
         window.launcher.db.saveMessage(_dbSessionId, "assistant", text);
      }

      if (state === "error") {
        const errMsg = payload.error?.message || "Response failed";
        appendSystemMessage("Error: " + errMsg);
      }

      _streaming = false;
      _currentAssistantEl = null;
      _currentThinkEl = null;
      _currentThinkBody = null;
      _thinkingActive = false;
      _accumulatedText = "";
      updateSendButton();
      scrollToBottom();
    }
  }

  // --- Tool invocation handler ---

  function appendToolMessage(icon, text, status) {
    const container = $(".chat-messages");
    if (!container) return null;
    const el = document.createElement("div");
    el.className = `chat-msg tool-call ${status || ""}`;
    el.innerHTML = `<span class="tool-icon">${icon}</span> <span class="tool-text">${text}</span>`;
    container.appendChild(el);
    scrollToBottom();
    return el;
  }

  async function handleToolInvoke(payload) {
    if (!payload || payload.sessionKey !== _sessionKey) return;

    const { toolCallId, name, arguments: args } = payload;
    let result;

    try {
      switch (name) {
        case "read": {
          let targetPath = args.path || '.';
          if (targetPath === '.' || targetPath === './' || targetPath === '') {
            try {
              const folders = await window.launcher.getMountedFolders();
              if (folders && folders.length > 0) targetPath = folders[0].path;
            } catch (e) { /* silent fallback */ }
          }
          appendToolMessage("📖", `Reading/Listing: ${targetPath}`, "pending");
          try {
            // Overload read: check if it's a directory first
            const entries = await window.launcher.listDir(targetPath);
            if (Array.isArray(entries)) {
              result = { success: true, type: "directory", entries };
              appendToolMessage("✅", `Listed directory: ${targetPath} (${entries.length} items)`, "success");
            } else {
              throw new Error("Not a directory");
            }
          } catch (e) {
            // Fallback to file reading
            try {
              const content = await window.launcher.readFile(targetPath);
              result = { success: true, type: "file", content };
              appendToolMessage("✅", `Read file: ${targetPath} (${content.length} chars)`, "success");
            } catch (fileErr) {
              result = { success: false, error: fileErr.message };
              appendToolMessage("❌", `Failed to read: ${targetPath}`, "error");
            }
          }
          break;
        }
        case "write": {
          appendToolMessage("📄", `Writing file: ${args.path}`, "pending");
          try {
            await window.launcher.writeFile(args.path, args.content);
            result = { success: true, message: `Written to ${args.path}` };
            appendToolMessage("✅", `File saved: ${args.path}`, "success");
          } catch (e) {
            result = { success: false, error: e.message };
            appendToolMessage("❌", `Failed to write: ${args.path}`, "error");
          }
          break;
        }
        case "edit": {
          appendToolMessage("✏️", `Editing file: ${args.path}`, "pending");
          try {
            let content = await window.launcher.readFile(args.path);
            if (args.edits && Array.isArray(args.edits)) {
              for (const edit of args.edits) {
                const occurrences = content.split(edit.oldText).length - 1;
                if (occurrences === 0) {
                  throw new Error(`oldText not found in file.`);
                } else if (occurrences > 1) {
                  throw new Error(`oldText matches multiple locations. Please provide more context to make oldText unique.`);
                } else {
                  content = content.replace(edit.oldText, edit.newText);
                }
              }
            }
            await window.launcher.writeFile(args.path, content);
            result = { success: true, message: `Edited ${args.path}` };
            appendToolMessage("✅", `File edited: ${args.path}`, "success");
          } catch(e) {
            result = { success: false, error: e.message };
            appendToolMessage("❌", `Failed to edit: ${args.path} - ${e.message}`, "error");
          }
          break;
        }
        default:
          result = { success: false, error: `Unknown tool: ${name}` };
          appendToolMessage("❌", `Unknown tool: ${name}`, "error");
      }
    } catch (e) {
      result = { success: false, error: e.message };
      appendToolMessage("❌", `Tool error: ${e.message}`, "error");
    }

    try {
      await gateway.sendToolResult(_sessionKey, toolCallId, result);
    } catch (e) {
      appendSystemMessage("Failed to send tool result: " + e.message);
    }
  }

  async function stopGeneration() {
     if (!_streaming) return;
     _streaming = false;
     const oldKey = _sessionKey;
     // Null out immediately so any in-flight deltas are ignored by handleChatEvent
     _sessionKey = null;
     _currentAssistantEl = null;
     _currentThinkEl = null;
     _currentThinkBody = null;
     _thinkingActive = false;
     _accumulatedText = "";
     hideTyping();
     updateSendButton();
     appendSystemMessage("Generation stopped by user.");

     // Abort the live generation by deleting the old session, then make a fresh one
     if (oldKey) {
       try { await gateway.deleteSession(oldKey); } catch (e) { console.warn("[chat] deleteSession:", e.message); }
     }
     try {
       await fetch("http://127.0.0.1:11435/session/reset", { method: "POST" });
     } catch {}
     try {
      const res = await gateway.createSession("OpenCoot Chat");
       _sessionKey = res.key;
     } catch (e) {
       console.error("[chat] createSession after stop failed:", e.message);
     }
  }

  function handleSendClick() {
     if (_streaming) stopGeneration();
     else send();
  }

  function updateSendButton() {
    const btn = $(".chat-send");
    if (!btn) return;
    btn.disabled = false;
    if (_streaming) {
       btn.innerHTML = `<span class="icon icon-md"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12"/></svg></span>`;
    } else {
       btn.innerHTML = `<span class="icon icon-md"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg></span>`;
    }
  }

  // --- Initialize ---

  function init() {
    // Wire send button
    const sendBtn = $(".chat-send");
    if (sendBtn) {
      sendBtn.addEventListener("click", handleSendClick);
    }

    loadHistoryList();

    // Wire input: Enter to send, Shift+Enter for newline
    const input = $(".chat-input");
    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      });
      // Auto-resize
      input.addEventListener("input", () => {
        input.style.height = "40px";
        input.style.height = Math.min(input.scrollHeight, 120) + "px";
      });
    }

    // Wire close button
    const closeBtn = $(".chat-close");
    if (closeBtn) closeBtn.addEventListener("click", close);

    // Wire backdrop click
    const backdrop = $(".chat-backdrop");
    if (backdrop) backdrop.addEventListener("click", close);

    // Wire new chat button
    const newChatBtn = $(".chat-new-btn");
    if (newChatBtn) newChatBtn.addEventListener("click", newChat);

    // Connect to the thinking-token SSE stream from the proxy
    connectThinkStream();

    // Listen for gateway chat events
    gateway.on("chat", handleChatEvent);

    // Listen for tool invocations from the AI
    gateway.on("tool.invoke", handleToolInvoke);

    // Listen for connection state
    gateway.on("connected", () => {
      const statusEl = $(".chat-header .chat-status");
      if (statusEl) statusEl.textContent = "Connected";
    });

    gateway.on("disconnected", () => {
      if (_streaming) {
        _streaming = false;
        _currentAssistantEl = null;
        hideTyping();
        updateSendButton();
        appendSystemMessage("Disconnected from gateway");
      }
    });
  }

  return { init, open, close, toggle, isOpen, send, newChat, clearMessages };
})();
