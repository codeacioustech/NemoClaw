// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Permission controller — intercepts ALL AI tool invocations and
 * requires explicit user approval via a modal popup before execution.
 *
 * Public API:
 *   permission.request(payload) → Promise<{allowed, reason?}>
 *   permission.allow()          → resolve current request as allowed
 *   permission.deny()           → resolve current request as denied
 *   permission.denyAll(reason)  → auto-deny all queued requests
 */

const permission = (() => {
  console.log("[permission] module loaded");

  const $ = (sel) => document.querySelector(sel);

  let _queue = [];
  let _current = null;
  let _previousFocus = null;

  const DEFAULT_TIMEOUT_MS = 60000;

  // --- Tool metadata mapping ---

  const TOOL_META = {
    read: {
      type: "File Read",
      title: "Read File / Directory",
      desc: "The AI wants to read a file or list a directory.",
      iconSvg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
      colorClass: "perm-icon-primary",
    },
    write: {
      type: "File Write",
      title: "Write File",
      desc: "The AI wants to create or overwrite a file.",
      iconSvg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>',
      colorClass: "perm-icon-warning",
    },
    edit: {
      type: "File Edit",
      title: "Edit File",
      desc: "The AI wants to modify an existing file.",
      iconSvg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
      colorClass: "perm-icon-warning",
    },
    terminal: {
      type: "Terminal Command",
      title: "Execute Command",
      desc: "The AI wants to run a shell command.",
      iconSvg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
      colorClass: "perm-icon-warning",
    },
  };

  const DEFAULT_META = {
    type: "Tool Execution",
    title: "Execute Tool",
    desc: "The AI wants to execute an action.",
    iconSvg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    colorClass: "perm-icon-muted",
  };

  // --- HTML escape helper ---

  function _escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // --- Modal show/hide (simplified, no hidden attribute) ---

  function _showModal() {
    const overlay = $("#perm-modal");
    if (!overlay) {
      console.error("[permission] #perm-modal element not found in DOM!");
      return;
    }
    console.log("[permission] showing modal");
    _previousFocus = document.activeElement;
    // Use direct style to guarantee visibility — no hidden attr, no CSS transition race
    overlay.style.display = "flex";
    overlay.style.visibility = "visible";
    overlay.style.opacity = "1";
    overlay.style.pointerEvents = "auto";
    // Focus the Allow button
    const allowBtn = overlay.querySelector(".perm-btn-allow");
    if (allowBtn) allowBtn.focus();
  }

  function _hideModal() {
    const overlay = $("#perm-modal");
    if (!overlay) return;
    console.log("[permission] hiding modal");
    overlay.style.display = "none";
    overlay.style.visibility = "hidden";
    overlay.style.opacity = "0";
    overlay.style.pointerEvents = "none";
    // Restore focus
    if (_previousFocus && typeof _previousFocus.focus === "function") {
      _previousFocus.focus();
    }
    _previousFocus = null;
  }

  // --- Render current request into modal ---

  function _renderRequest(entry) {
    const { name, arguments: args } = entry.payload;
    const meta = TOOL_META[name] || DEFAULT_META;
    console.log("[permission] rendering request:", name, args);

    // Type badge
    const typeEl = $("#perm-type");
    if (typeEl) typeEl.textContent = meta.type;

    // Title
    const titleEl = $("#perm-title");
    if (titleEl) titleEl.textContent = meta.title;

    // Description — include path if available, or terminal-specific info
    const descEl = $("#perm-desc");
    if (descEl) {
      if (name === "terminal" && args) {
        // Terminal-specific rendering with risk badge
        const risk = args._risk || "high";
        const riskColors = { low: "perm-icon-primary", medium: "perm-icon-warning", high: "perm-icon-danger" };
        // Override icon color based on risk
        if (iconWrap) iconWrap.className = "perm-icon-wrap " + (riskColors[risk] || "perm-icon-danger");
        descEl.innerHTML = meta.desc +
          '<br><span class="perm-risk-badge perm-risk-' + risk + '">' + risk.toUpperCase() + ' RISK</span>' +
          '<br><strong>Command:</strong> <code>' + _escapeHtml(args.command || "") + '</code>' +
          (args.cwd ? '<br><strong>Directory:</strong> ' + _escapeHtml(args.cwd) : "");
      } else if (args && args.path) {
        descEl.textContent = meta.desc + "\nPath: " + args.path;
      } else {
        descEl.textContent = meta.desc;
      }
    }

    // Icon
    const iconWrap = $("#perm-icon-wrap");
    const iconEl = $("#perm-icon");
    if (iconWrap) {
      iconWrap.className = "perm-icon-wrap " + meta.colorClass;
    }
    if (iconEl) {
      iconEl.innerHTML = meta.iconSvg;
    }

    // Payload list
    const payloadList = $("#perm-payload-list");
    if (payloadList) {
      payloadList.innerHTML = "";
      if (args && typeof args === "object") {
        for (const [key, value] of Object.entries(args)) {
          const dt = document.createElement("dt");
          dt.textContent = key;
          const dd = document.createElement("dd");
          let displayVal = typeof value === "string" ? value : JSON.stringify(value, null, 2);
          // Truncate long content
          if (displayVal.length > 500) {
            displayVal = displayVal.slice(0, 200) + "\n... (" + displayVal.length + " chars total) ...\n" + displayVal.slice(-200);
            dd.classList.add("perm-payload-truncated");
          }
          dd.textContent = displayVal;
          payloadList.appendChild(dt);
          payloadList.appendChild(dd);
        }
      }
    }

    // Queue indicator
    const queueEl = $("#perm-queue");
    const queueCount = $("#perm-queue-count");
    if (queueEl && queueCount) {
      if (_queue.length > 0) {
        queueCount.textContent = _queue.length + " more pending";
        queueEl.removeAttribute("hidden");
      } else {
        queueEl.setAttribute("hidden", "");
      }
    }

    // Timer bar
    _startTimer(entry);
  }

  // --- Timer bar ---

  let _timerInterval = null;

  function _startTimer(entry) {
    const bar = $("#perm-timer-bar");
    if (!bar) return;
    if (_timerInterval) clearInterval(_timerInterval);
    bar.style.width = "100%";
    const startTime = entry.requestedAt;
    _timerInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, 1 - elapsed / DEFAULT_TIMEOUT_MS);
      bar.style.width = (remaining * 100) + "%";
      if (remaining <= 0) {
        clearInterval(_timerInterval);
        _timerInterval = null;
      }
    }, 200);
  }

  function _stopTimer() {
    if (_timerInterval) {
      clearInterval(_timerInterval);
      _timerInterval = null;
    }
  }

  // --- Queue processing ---

  function _processNext() {
    if (_queue.length === 0) {
      _current = null;
      _hideModal();
      return;
    }
    _current = _queue.shift();
    _renderRequest(_current);
    _showModal();
  }

  function _resolve(entry, result) {
    if (!entry) return;
    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    _stopTimer();
    if (typeof entry.resolve === "function") {
      entry.resolve(result);
    }
  }

  // --- Public methods ---

  function request(payload) {
    console.log("[permission] request() called for tool:", payload.name);
    return new Promise((resolve) => {
      const entry = {
        payload,
        resolve,
        timeoutId: null,
        requestedAt: Date.now(),
      };
      entry.timeoutId = setTimeout(() => {
        console.log("[permission] auto-deny timeout for:", payload.name);
        // Auto-deny on timeout
        if (_current === entry) {
          _resolve(entry, { allowed: false, reason: "timeout" });
          _current = null;
          _processNext();
        } else {
          // Still in queue — remove and resolve
          const idx = _queue.indexOf(entry);
          if (idx !== -1) _queue.splice(idx, 1);
          _resolve(entry, { allowed: false, reason: "timeout" });
        }
      }, DEFAULT_TIMEOUT_MS);

      if (!_current) {
        _current = entry;
        _renderRequest(entry);
        _showModal();
      } else {
        _queue.push(entry);
      }
    });
  }

  function allow() {
    if (!_current) return;
    console.log("[permission] ALLOWED:", _current.payload.name);
    const entry = _current;
    _resolve(entry, { allowed: true });
    _current = null;
    _processNext();
  }

  function deny(reason) {
    if (!_current) return;
    console.log("[permission] DENIED:", _current.payload.name, reason);
    const entry = _current;
    _resolve(entry, { allowed: false, reason: reason || "denied by user" });
    _current = null;
    _processNext();
  }

  function denyAll(reason) {
    const r = reason || "cancelled";
    console.log("[permission] denyAll:", r);
    if (_current) {
      _resolve(_current, { allowed: false, reason: r });
      _current = null;
    }
    while (_queue.length > 0) {
      const entry = _queue.shift();
      _resolve(entry, { allowed: false, reason: r });
    }
    _hideModal();
  }

  // --- Keyboard handling (focus trap + Escape) ---

  document.addEventListener("keydown", (e) => {
    const overlay = $("#perm-modal");
    if (!overlay || overlay.style.display !== "flex") return;

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      deny("denied by user");
      return;
    }

    // Focus trap: Tab cycles between Deny and Allow buttons
    if (e.key === "Tab") {
      const denyBtn = overlay.querySelector(".perm-btn-deny");
      const allowBtn = overlay.querySelector(".perm-btn-allow");
      if (!denyBtn || !allowBtn) return;

      const focusables = [denyBtn, allowBtn];
      const currentIdx = focusables.indexOf(document.activeElement);

      if (e.shiftKey) {
        const nextIdx = currentIdx <= 0 ? focusables.length - 1 : currentIdx - 1;
        focusables[nextIdx].focus();
      } else {
        const nextIdx = currentIdx >= focusables.length - 1 ? 0 : currentIdx + 1;
        focusables[nextIdx].focus();
      }
      e.preventDefault();
    }
  });

  // Hide modal on initial load
  const _initOverlay = $("#perm-modal");
  if (_initOverlay) {
    _initOverlay.style.display = "none";
    _initOverlay.removeAttribute("hidden");
  }

  return { request, allow, deny, denyAll };
})();
