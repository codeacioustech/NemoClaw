// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Chat UI controller — manages the slide-out chat panel,
 * message rendering, and streaming responses.
 */

const chat = (() => {
  let _sessionKey = null;
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

    if (role === "user") {
      // User messages are editable: wrap text in span + add edit button
      const textSpan = document.createElement("span");
      textSpan.className = "chat-msg-text";
      textSpan.textContent = text;
      el.appendChild(textSpan);

      const editBtn = document.createElement("button");
      editBtn.className = "chat-msg-edit-btn";
      editBtn.setAttribute("data-action", "msg-edit");
      editBtn.setAttribute("aria-label", "Edit message");
      editBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
      el.appendChild(editBtn);
    } else {
      el.textContent = text;
    }

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

  async function ensureSession() {
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
      const res = await gateway.createSession("open-coot Chat");
      _sessionKey = res.key;
      return _sessionKey;
    } catch (e) {
      console.error("[chat] failed to create session:", e.message);
      appendSystemMessage("Failed to create chat session. Is the gateway running?");
      return null;
    }
  }

  async function newChat() {
    try {
      const res = await gateway.createSession("open-coot Chat");
      _sessionKey = res.key;
      clearMessages();
    } catch (e) {
      appendSystemMessage("Failed to create new chat: " + e.message);
    }
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

  // --- Tool call extraction from model content ---
  // Local models can't emit structured tool_calls. We detect multiple formats:

  const TOOL_NAMES = ["read", "write", "edit", "terminal"];

  /**
   * Try to extract a tool call from the model's text output.
   * Returns { name, args, beforeText } or null.
   */
  function _extractToolFromContent(text) {
    if (!text || typeof text !== "string") return null;

    // ── Format 1: ReAct — "Action: terminal\nInput: {...}" ──
    const reactMatch = text.match(/Action:\s*(read|write|edit|terminal)\s*\n\s*Input:\s*(\{[\s\S]*?\})/i);
    if (reactMatch) {
      try {
        const args = JSON.parse(reactMatch[2]);
        const beforeText = text.slice(0, reactMatch.index).trim();
        return { name: reactMatch[1].toLowerCase(), args, beforeText };
      } catch { /* fall through */ }
    }

    // ── Format 2: <tool_call>JSON</tool_call> ──
    const tagMatch = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/);
    if (tagMatch) {
      try {
        const parsed = JSON.parse(tagMatch[1]);
        if (parsed.name && TOOL_NAMES.includes(parsed.name)) {
          const beforeText = text.slice(0, tagMatch.index).trim();
          return { name: parsed.name, args: parsed.arguments || parsed.params || {}, beforeText };
        }
      } catch { /* fall through */ }
    }

    // ── Format 3: Raw JSON — {"name": "terminal", "arguments": {...}} ──
    const jsonMatch = text.match(/\{\s*"name"\s*:\s*"(read|write|edit|terminal)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/);
    if (jsonMatch) {
      try {
        const args = JSON.parse(jsonMatch[2]);
        const beforeText = text.slice(0, jsonMatch.index).trim();
        return { name: jsonMatch[1], args, beforeText };
      } catch { /* fall through */ }
    }

    // ── Format 4: Natural language — "I'll run `git status`" / "Let me execute `ls -la`" ──
    // Match backtick-wrapped commands after action verbs
    const nlMatch = text.match(/(?:(?:I(?:'ll| will| am going to|'m going to)|let me|running|executing|using)\s+(?:run|execute|use|check|call)?[:\s]*`([^`]+)`)/i);
    if (nlMatch) {
      const cmd = nlMatch[1].trim();
      // Only match if it looks like a real command (not a file path or code snippet)
      if (cmd.length > 0 && cmd.length < 200 && !cmd.includes("\n")) {
        const beforeText = text.slice(0, nlMatch.index).trim();
        return { name: "terminal", args: { command: cmd }, beforeText };
      }
    }

    // ── Format 5: Code block with shell command ──
    const codeBlockMatch = text.match(/```(?:bash|sh|shell|terminal|console|zsh)?\s*\n\s*([^\n]+?)\s*\n\s*```/);
    if (codeBlockMatch) {
      const cmd = codeBlockMatch[1].trim();
      if (cmd.length > 0 && cmd.length < 200) {
        const beforeText = text.slice(0, codeBlockMatch.index).trim();
        return { name: "terminal", args: { command: cmd }, beforeText };
      }
    }

    return null;
  }

  /**
   * Strips tool-call syntax from display text so the user sees clean output.
   */
  function _cleanDisplayText(text) {
    if (!text) return "";
    return text
      .replace(/Action:\s*(read|write|edit|terminal)\s*\n\s*Input:\s*\{[\s\S]*?\}/gi, "")
      .replace(/<tool_call>[\s\S]*?(<\/tool_call>)?/g, "")
      .replace(/```(?:bash|sh|shell|terminal|console|zsh)?\s*\n\s*[^\n]+?\s*\n\s*```/g, "")
      .trim();
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
      ensureAssistantBubble();
      _accumulatedText = text;

      // Display cleaned text (strip tool call syntax while streaming)
      const displayText = _cleanDisplayText(_accumulatedText);
      const answerDiv = _currentAssistantEl.querySelector(".chat-answer");
      if (answerDiv) answerDiv.textContent = displayText;
      scrollToBottom();
    }

    if (state === "final" || state === "error") {
      hideTyping();

      // ── Content-based tool call detection ─────────────────────────────
      // Detect tool calls from ANY format the model might use:
      // ReAct (Action/Input), <tool_call> tags, raw JSON, natural language,
      // or code blocks. Execute them directly via handleToolInvoke.
      const finalText = text || _accumulatedText || "";

      if (state !== "error") {
        const extracted = _extractToolFromContent(finalText);

        if (extracted) {
          console.log("[chat] Detected tool call in content:", extracted.name, JSON.stringify(extracted.args));

          // Update display to show only the reasoning before the tool call
          if (_currentAssistantEl) {
            const answerDiv = _currentAssistantEl.querySelector(".chat-answer");
            if (answerDiv) answerDiv.textContent = extracted.beforeText || "";
          }

          // Synthesize a tool.invoke payload and handle it
          const syntheticPayload = {
            sessionKey: _sessionKey,
            toolCallId: "content-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
            name: extracted.name,
            arguments: extracted.args,
          };

          _streaming = false;
          _currentAssistantEl = null;
          _currentThinkEl = null;
          _currentThinkBody = null;
          _thinkingActive = false;
          _accumulatedText = "";
          updateSendButton();

          // Execute the tool
          handleToolInvoke(syntheticPayload);
          return;
        }
      }
      // ─────────────────────────────────────────────────────────────────

      if (!_currentAssistantEl && finalText) {
        ensureAssistantBubble();
      }
      if (_currentAssistantEl && finalText) {
        const answerDiv = _currentAssistantEl.querySelector(".chat-answer");
        if (answerDiv) answerDiv.textContent = _cleanDisplayText(finalText);
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
    console.log("[chat] handleToolInvoke called:", payload?.name || payload);
    if (!payload || payload.sessionKey !== _sessionKey) {
      console.log("[chat] handleToolInvoke skipped: session mismatch", payload?.sessionKey, "vs", _sessionKey);
      return;
    }

    const { toolCallId, name, arguments: args } = payload;
    console.log("[chat] tool invocation:", name, "id:", toolCallId);

    // ── Pre-flight: enrich terminal args with risk classification ──
    if (name === "terminal" && args && args.command) {
      try {
        args._risk = await window.launcher.classifyCommandRisk(args.command);
      } catch (_e) {
        args._risk = "high";
      }
    }

    // ── Permission gate: every tool invocation requires explicit user approval ──
    appendToolMessage("🔒", `Permission requested: ${name}`, "pending");

    const decision = await permission.request({ toolCallId, name, arguments: args });

    if (!decision.allowed) {
      const reason = decision.reason || "denied by user";
      appendToolMessage("🚫", `Denied: ${name} (${reason})`, "error");
      try {
        await gateway.sendToolResult(_sessionKey, toolCallId,
          { success: false, error: `Tool execution denied: ${reason}` });
      } catch (e) {
        appendSystemMessage("Failed to send denial: " + e.message);
      }
      return;
    }

    // ── Approved: execute the tool ──
    let result;

    try {
      switch (name) {
        case "read": {
          const targetPath = args.path || '.';
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
                if (content.includes(edit.oldText)) {
                  content = content.replace(edit.oldText, edit.newText);
                } else {
                  throw new Error(`Target text block not found in file.`);
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
        case "terminal": {
          const cmd = args.command || "";
          const cwd = args.cwd || "";
          appendToolMessage("💻", `Terminal: ${cmd}${cwd ? " (in " + cwd + ")" : ""}`, "pending");
          try {
            result = await window.launcher.executeCommand({
              command: cmd,
              cwd: args.cwd,
              timeout: args.timeout,
            });
            if (result.success) {
              appendToolMessage("✅", `Command completed (exit ${result.exit_code})`, "success");
            } else {
              appendToolMessage("⚠️", `Command failed (exit ${result.exit_code})`, "error");
            }
          } catch (e) {
            result = { success: false, stdout: "", stderr: e.message, exit_code: -1 };
            appendToolMessage("❌", `Terminal error: ${e.message}`, "error");
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
      console.warn("[chat] sendToolResult failed:", e.message);
      // Fallback for content-based tool calls: the gateway doesn't know
      // about our synthetic toolCallId, so send the result as a user
      // message instead so the model can see the output and respond.
      if (typeof toolCallId === "string" && toolCallId.startsWith("content-")) {
        const resultText =
          `[Tool Result: ${name}]\n` +
          (result.success === false ? `Error: ${result.error || result.stderr || "unknown"}` :
           result.stdout || result.message || JSON.stringify(result));
        try {
          await gateway.sendMessage(_sessionKey, resultText);
          _streaming = true;
          updateSendButton();
          showTyping();
        } catch (e2) {
          appendSystemMessage("Failed to send tool result as message: " + e2.message);
        }
      } else {
        appendSystemMessage("Failed to send tool result: " + e.message);
      }
    }
  }

  // --- Editable user messages ---

  function startEdit(msgEl) {
    if (_streaming || !msgEl || msgEl.classList.contains("editing")) return;

    const textSpan = msgEl.querySelector(".chat-msg-text");
    if (!textSpan) return;

    const originalText = textSpan.textContent;
    msgEl.classList.add("editing");

    // Hide text and edit button
    textSpan.style.display = "none";
    const editBtn = msgEl.querySelector(".chat-msg-edit-btn");
    if (editBtn) editBtn.style.display = "none";

    // Create inline edit area
    const editWrap = document.createElement("div");
    editWrap.className = "chat-msg-edit-wrap";

    const textarea = document.createElement("textarea");
    textarea.className = "chat-msg-edit-input";
    textarea.value = originalText;
    textarea.rows = 1;

    const actions = document.createElement("div");
    actions.className = "chat-msg-edit-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "chat-msg-edit-cancel";
    cancelBtn.setAttribute("data-action", "msg-edit-cancel");
    cancelBtn.textContent = "Cancel";

    const saveBtn = document.createElement("button");
    saveBtn.className = "chat-msg-edit-save";
    saveBtn.setAttribute("data-action", "msg-edit-save");
    saveBtn.textContent = "Save & Resend";

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    editWrap.appendChild(textarea);
    editWrap.appendChild(actions);
    msgEl.appendChild(editWrap);

    // Auto-resize textarea
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 160) + "px";
    textarea.addEventListener("input", () => {
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 160) + "px";
    });

    // Keyboard: Escape = cancel, Ctrl/Cmd+Enter = save
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit(msgEl);
      }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveEdit(msgEl);
      }
    });

    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  function cancelEdit(msgEl) {
    if (!msgEl) return;
    const editWrap = msgEl.querySelector(".chat-msg-edit-wrap");
    if (editWrap) editWrap.remove();

    const textSpan = msgEl.querySelector(".chat-msg-text");
    if (textSpan) textSpan.style.display = "";
    const editBtn = msgEl.querySelector(".chat-msg-edit-btn");
    if (editBtn) editBtn.style.display = "";

    msgEl.classList.remove("editing");
  }

  async function saveEdit(msgEl) {
    if (!msgEl || _streaming) return;

    const textarea = msgEl.querySelector(".chat-msg-edit-input");
    if (!textarea) return;

    const newText = textarea.value.trim();
    if (!newText) {
      cancelEdit(msgEl);
      return;
    }

    // Update the message text
    const textSpan = msgEl.querySelector(".chat-msg-text");
    if (textSpan) textSpan.textContent = newText;

    // Clean up editing UI
    cancelEdit(msgEl);

    // Remove all messages after the edited one
    const container = $(".chat-messages");
    if (container) {
      let sibling = msgEl.nextElementSibling;
      while (sibling) {
        const next = sibling.nextElementSibling;
        sibling.remove();
        sibling = next;
      }
    }

    // Re-send the edited message
    const key = await ensureSession();
    if (!key) return;

    _streaming = true;
    _accumulatedText = "";
    _currentAssistantEl = null;
    updateSendButton();
    showTyping();

    try {
      await gateway.sendMessage(key, newText);
    } catch (e) {
      hideTyping();
      _streaming = false;
      updateSendButton();
      appendSystemMessage("Failed to send: " + e.message);
    }
  }

  function updateSendButton() {
    const btn = $(".chat-send");
    if (btn) btn.disabled = _streaming;
  }

  // --- Initialize ---

  function init() {
    // Wire send button
    const sendBtn = $(".chat-send");
    if (sendBtn) {
      sendBtn.addEventListener("click", send);
    }

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
      // Auto-deny all pending permission requests on disconnect
      permission.denyAll("disconnected");

      if (_streaming) {
        _streaming = false;
        _currentAssistantEl = null;
        hideTyping();
        updateSendButton();
        appendSystemMessage("Disconnected from gateway");
      }
    });
  }

  return { init, open, close, toggle, isOpen, send, newChat, clearMessages, startEdit, saveEdit, cancelEdit };
})();
