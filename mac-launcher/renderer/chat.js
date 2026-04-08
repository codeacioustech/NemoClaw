// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Chat UI controller — manages the slide-out chat panel,
 * message rendering, and streaming responses.
 */

const chat = (() => {
  let _sessionKey = null;
  let _streaming = false;
  let _currentAssistantEl = null;
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
        <div class="chat-empty-icon">💬</div>
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

  // --- Sending messages ---

  async function send() {
    const input = $(".chat-input");
    if (!input) return;

    const text = input.value.trim();
    if (!text || _streaming) return;

    input.value = "";
    input.style.height = "40px";

    appendMessage("user", text);

    const key = await ensureSession();
    if (!key) return;

    _streaming = true;
    _accumulatedText = "";
    _currentAssistantEl = null;
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
      if (!_currentAssistantEl) {
        _currentAssistantEl = appendMessage("assistant", "");
      }
      _accumulatedText = text;
      if (_currentAssistantEl) {
        _currentAssistantEl.textContent = _accumulatedText;
      }
      scrollToBottom();
    }

    if (state === "final" || state === "error") {
      hideTyping();
      if (!_currentAssistantEl && text) {
        _currentAssistantEl = appendMessage("assistant", text);
      } else if (_currentAssistantEl && text) {
        _currentAssistantEl.textContent = text;
      }

      if (state === "error") {
        const errMsg = payload.error?.message || "Response failed";
        appendSystemMessage("Error: " + errMsg);
      }

      _streaming = false;
      _currentAssistantEl = null;
      _accumulatedText = "";
      updateSendButton();
      scrollToBottom();
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

    // Listen for gateway chat events
    gateway.on("chat", handleChatEvent);

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
