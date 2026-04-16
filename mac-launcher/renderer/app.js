// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * App controller — screen navigation, onboarding, sidebar, LLM status.
 */

const app = (() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  let _currentScreen = 1;
  let _gatewayPort = null;

  // --- Screen navigation ---

  function go(n) {
    $$(".screen").forEach((el) => el.classList.remove("active"));
    const target = document.getElementById(`screen-${n}`);
    if (target) target.classList.add("active");
    _currentScreen = n;
  }

  // --- Selection helpers ---

  function single(el, groupSelector) {
    const parent = el.closest(".ob-card, .ob-card-wide, .ob-body");
    if (!parent) return;
    parent.querySelectorAll(groupSelector).forEach((c) => {
      c.classList.remove("sel");
      if (c.hasAttribute("aria-selected")) c.setAttribute("aria-selected", "false");
    });
    el.classList.add("sel");
    if (el.hasAttribute("aria-selected")) el.setAttribute("aria-selected", "true");
  }

  function toggle(el) {
    el.classList.toggle("sel");
    if (el.hasAttribute("aria-selected")) {
      el.setAttribute("aria-selected", el.classList.contains("sel") ? "true" : "false");
    }
  }

  // --- Onboarding state ---

  function getOnboardingData() {
    // Step 1
    const purpose = $(".purpose-card.sel .purpose-label")?.textContent || "";
    const techs = Array.from($$(".tech-pill.sel")).map((p) => p.textContent.trim());
    const size = $(".size-card.sel .size-num")?.textContent || "";

    // Step 4
    const microapps = Array.from($$(".ma-card.sel .ma-name")).map((n) => n.textContent);

    return { purpose, techs, size, microapps };
  }

  function saveOnboarding() {
    const data = getOnboardingData();
    localStorage.setItem("opencoot_onboarding", JSON.stringify(data));
    localStorage.setItem("opencoot_onboarded", "true");
  }

  function isOnboarded() {
    return localStorage.getItem("opencoot_onboarded") === "true";
  }

  // --- LLM status polling ---

  let _llmPollTimer = null;

  async function pollLlmStatus() {
    const dot = $(".llm-dot");
    const info = $(".llm-info h4");
    const detail = $(".llm-info p");
    if (!dot || !info) return;

    try {
      const res = await fetch("http://127.0.0.1:11434/api/tags");
      if (res.ok) {
        const data = await res.json();
        const models = data.models || [];
        dot.classList.remove("offline");
        if (models.length > 0) {
          const m = models[0];
          info.textContent = `${m.name} · Running`;
          const sizeMB = m.size ? (m.size / 1e9).toFixed(1) + " GB" : "";
          detail.textContent = `Local${sizeMB ? " · " + sizeMB : ""}`;
        } else {
          info.textContent = "Ollama · Running";
          detail.textContent = "No models loaded";
        }
      } else {
        dot.classList.add("offline");
        info.textContent = "Ollama · Offline";
        detail.textContent = "Not responding";
      }
    } catch {
      dot.classList.add("offline");
      info.textContent = "Ollama · Offline";
      detail.textContent = "Connection failed";
    }
  }

  function startLlmPolling() {
    pollLlmStatus();
    _llmPollTimer = setInterval(pollLlmStatus, 10000);
  }

  function stopLlmPolling() {
    if (_llmPollTimer) clearInterval(_llmPollTimer);
  }

  // --- Sidebar navigation ---

  function showSection(label) {
    const sections = $$(".dash-section");
    let matched = false;
    sections.forEach((s) => {
      if (s.dataset.section === label) {
        s.hidden = false;
        matched = true;
      } else {
        s.hidden = true;
      }
    });
    // Fallback: if no section matches, show Dashboard.
    if (!matched) {
      const fallback = document.querySelector('.dash-section[data-section="Dashboard"]');
      if (fallback) fallback.hidden = false;
    }
  }

  function navigateTo(label) {
    // Update active state on nav-item whose data-target matches (fall
    // back to text-match for robustness if data-target is missing).
    const items = $$(".nav-item");
    let target = null;
    items.forEach((item) => {
      const dt = item.dataset.target;
      const text = item.textContent.trim().replace(/\d+$/, "").trim();
      if ((dt && dt === label) || (!dt && text === label)) target = item;
    });
    items.forEach((i) => { i.classList.remove("active"); i.removeAttribute("aria-current"); });
    if (target) {
      target.classList.add("active");
      target.setAttribute("aria-current", "page");
    }
    const topTitle = $(".dash-topbar-title");
    if (topTitle) topTitle.textContent = label;
    showSection(label);

    // Lazy-populate section-specific content.
    if (label === "Connectors") refreshMountedFolders();
    else if (label === "Settings") refreshSettings();
  }

  // --- Keyboard navigation for role="button" elements ---

  function initKeyboardNav() {
    document.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target.matches('[role="button"]')) {
        e.preventDefault();
        e.target.click();
      }
    });
  }

  // --- Invite rows (Screen 2) ---

  function addInviteRow() {
    const container = $(".invite-row")?.parentElement;
    if (!container) return;
    const row = document.createElement("div");
    row.className = "invite-row";
    row.innerHTML = `
      <input class="input" type="email" placeholder="name@email.com" style="flex:1;">
      <select class="role-select">
        <option>Admin</option>
        <option selected>Member</option>
        <option>Viewer</option>
      </select>
      <button class="btn-secondary" data-action="remove-invite-row">✕</button>
    `;
    // Insert before the role-legend
    const legend = container.querySelector(".role-legend");
    if (legend) container.insertBefore(row, legend);
    else container.appendChild(row);
  }

  function removeInviteRow(btn) {
    const row = btn.closest(".invite-row");
    if (row) row.remove();
  }

  // --- Connector toggle (Screen 3) ---

  function toggleConnector(btn) {
    const card = btn.closest(".conn-card");
    if (!card) return;
    const name = card.querySelector(".conn-name")?.textContent?.trim() || "This connector";
    // OAuth integrations (Google Drive, Slack, Notion, GitHub, OneDrive)
    // aren't wired to any real provider yet. Don't paint a fake
    // "Connected" state — be honest so users aren't surprised when
    // their assistant can't actually reach these services.
    appendToast(`${name} integration is not yet available. For local file access, use Mount a Folder.`);
  }

  // --- Toast helper ---

  function appendToast(msg) {
    let container = $(".toast-container");
    if (!container) {
      container = document.createElement("div");
      container.className = "toast-container";
      document.body.appendChild(container);
    }
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => { toast.classList.add("fade-out"); }, 3500);
    setTimeout(() => { toast.remove(); }, 4000);
  }

  // --- Local Files / Folder mounting ---

  async function mountLocalFolder() {
    try {
      const result = await window.launcher.selectFolder();
      if (!result) return; // cancelled
      const res = await window.launcher.mountFolder(result);
      if (res.duplicate) {
        appendToast("Folder already mounted.");
      } else {
        appendToast("Folder mounted: " + result.path.split("/").pop());
      }
      await refreshMountedFolders();
    } catch (e) {
      appendToast("Failed to mount folder: " + e.message);
    }
  }

  async function unmountLocalFolder(folderPath) {
    try {
      await window.launcher.unmountFolder(folderPath);
      appendToast("Folder unmounted.");
      await refreshMountedFolders();
    } catch (e) {
      appendToast("Failed to unmount: " + e.message);
    }
  }

  function renderMountedFolderList(listEl, folders) {
    if (!listEl) return;
    listEl.replaceChildren(...folders.map((f) => {
      const name = f.path.split("/").pop() || f.path;
      const item = document.createElement("div");
      item.className = "mounted-folder-item";

      const nameEl = document.createElement("span");
      nameEl.className = "mounted-folder-name";
      nameEl.title = f.path;
      nameEl.textContent = name;

      const removeBtn = document.createElement("button");
      removeBtn.className = "mounted-folder-remove";
      removeBtn.dataset.action = "unmount-local-folder";
      removeBtn.dataset.path = f.path;
      removeBtn.textContent = "✕";

      item.append(nameEl, removeBtn);
      return item;
    }));
  }

  async function refreshSettings() {
    // Model
    const modelEl = $(".settings-model");
    if (modelEl) {
      try {
        const res = await fetch("http://127.0.0.1:11434/api/tags");
        if (res.ok) {
          const data = await res.json();
          modelEl.textContent = data.models?.[0]?.name || "No models loaded";
        } else {
          modelEl.textContent = "Ollama offline";
        }
      } catch {
        modelEl.textContent = "Ollama offline";
      }
    }
    // Gateway port
    const portEl = $(".settings-gateway-port");
    if (portEl) portEl.textContent = String(_gatewayPort ?? "unknown");
    // Folder count
    const countEl = $(".settings-folder-count");
    if (countEl) {
      try {
        const folders = await window.launcher.getMountedFolders();
        countEl.textContent = `${folders.length} mounted`;
      } catch {
        countEl.textContent = "unavailable";
      }
    }
  }

  async function resetOnboarding() {
    try {
      await window.launcher.resetOnboarding();
      localStorage.removeItem("opencoot_onboarded");
      localStorage.removeItem("opencoot_onboarding");
      appendToast("Onboarding reset. Restart the app to see the setup flow.");
    } catch (e) {
      appendToast("Reset failed: " + e.message);
    }
  }

  async function refreshMountedFolders() {
    try {
      const folders = await window.launcher.getMountedFolders();

      // Populate the Connectors section list (in dash-section, not in the
      // onboarding connector card). Safe to call even when the section
      // isn't currently visible.
      const sectionList = document.querySelector(".connectors-mounted-list");
      if (sectionList) renderMountedFolderList(sectionList, folders);

      const card = document.getElementById("local-files-connector");
      if (!card) return;

      const list = card.querySelector(".mounted-folders-list");
      const status = card.querySelector(".local-files-status");
      const dot = card.querySelector(".status-dot");
      const btn = card.querySelector(".conn-btn");

      if (folders.length > 0) {
        card.classList.add("connected");
        if (dot) { dot.classList.remove("inactive"); dot.classList.add("running"); }
        if (status) {
          status.style.color = "var(--success)";
          status.innerHTML = `<span class="status-dot running"></span> ${folders.length} folder${folders.length > 1 ? "s" : ""} mounted`;
        }
        if (btn) {
          btn.className = "conn-btn active";
          btn.textContent = "Mount Another Folder";
        }
        if (list) {
          // Build with DOM APIs rather than innerHTML so user-supplied
          // folder paths (which may contain quotes, backslashes, angle
          // brackets) can't become markup. The delegated click listener
          // reads the path from the button's dataset.
          list.replaceChildren(...folders.map((f) => {
            const name = f.path.split("/").pop() || f.path;
            const item = document.createElement("div");
            item.className = "mounted-folder-item";

            const nameEl = document.createElement("span");
            nameEl.className = "mounted-folder-name";
            nameEl.title = f.path;
            nameEl.textContent = name;

            const btn = document.createElement("button");
            btn.className = "mounted-folder-remove";
            btn.dataset.action = "unmount-local-folder";
            btn.dataset.path = f.path;
            btn.textContent = "✕";

            item.append(nameEl, btn);
            return item;
          }));
        }
      } else {
        card.classList.remove("connected");
        if (dot) { dot.classList.remove("running"); dot.classList.add("inactive"); }
        if (status) {
          status.style.color = "var(--text-muted)";
          status.innerHTML = `<span class="status-dot inactive"></span> No folders mounted`;
        }
        if (btn) {
          btn.className = "conn-btn idle";
          btn.textContent = "Mount a Folder";
        }
        if (list) list.innerHTML = "";
      }

      // Update dashboard meta
      const dashMeta = $(".local-files-dash-meta");
      if (dashMeta) {
        dashMeta.textContent = folders.length > 0
          ? `${folders.length} folder${folders.length > 1 ? "s" : ""} mounted`
          : "No folders mounted";
      }
    } catch (e) {
      console.warn("[app] failed to refresh mounted folders:", e.message);
    }
  }

  // --- New Workflow (Dashboard) ---

  function newWorkflow() {
    // No visual workflow editor yet — the useful thing we can do is
    // open chat with a prefilled prompt so the local AI can help the
    // user describe and scaffold a workflow.
    chat.open();
    const input = document.querySelector(".chat-input");
    if (input) {
      input.value = "Help me build a new workflow that ";
      input.focus();
      // Move caret to end.
      input.setSelectionRange(input.value.length, input.value.length);
      input.dispatchEvent(new Event("input"));
    }
  }

  // --- Avatar menu (Dashboard) ---

  function toggleAvatarMenu() {
    let menu = $(".avatar-menu");
    if (menu) {
      menu.remove();
      return;
    }
    const avatar = $(".topbar-avatar");
    if (!avatar) return;
    menu = document.createElement("div");
    menu.className = "avatar-menu";

    const settingsItem = document.createElement("div");
    settingsItem.className = "avatar-menu-item";
    settingsItem.dataset.action = "avatar-settings";
    settingsItem.textContent = "Settings";

    const logoutItem = document.createElement("div");
    logoutItem.className = "avatar-menu-item danger";
    logoutItem.dataset.action = "logout";
    logoutItem.textContent = "Log out";

    menu.append(settingsItem, logoutItem);
    avatar.style.position = "relative";
    avatar.appendChild(menu);

    // Close on outside click
    setTimeout(() => {
      document.addEventListener("click", _avatarOutsideClick, { once: true });
    }, 0);
  }

  function _avatarOutsideClick(e) {
    const menu = $(".avatar-menu");
    if (menu && !menu.contains(e.target) && !$(".topbar-avatar").contains(e.target)) {
      menu.remove();
    }
  }

  function closeAvatarMenu() {
    const menu = $(".avatar-menu");
    if (menu) menu.remove();
  }

  function logout() {
    closeAvatarMenu();
    localStorage.removeItem("opencoot_onboarded");
    localStorage.removeItem("opencoot_onboarding");
    stopLlmPolling();
    go(1);
  }

  // --- Gateway connection ---

  async function performBackgroundWarmup() {
    const btn = document.querySelector('.topbar-btn[data-action="open-chat"]');
    const originalContent = btn ? btn.innerHTML : '';

    const SPINNER_SVG = `<svg viewBox="0 0 24 24" style="display:inline-block;vertical-align:middle;animation:spin 1s linear infinite"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>`;

    const setBusy = (msg) => {
      if (!btn) return;
      btn.disabled = true;
      btn.innerHTML = `${SPINNER_SVG} ${msg}`;
    };

    const setReady = () => {
      if (!btn) return;
      btn.disabled = false;
      btn.innerHTML = originalContent;
    };

    setBusy("Connecting...");

    // Wait for the gateway to be in a connected state
    await new Promise((resolve) => {
      if (gateway.connected) return resolve();
      gateway.on("connected", resolve);
      setTimeout(resolve, 5000); // max 5 s wait for connection
    });

    setBusy("Warming up AI...");

    let warmupSessionKey = null;
    try {
      const sess = await gateway.createSession("__warmup__");
      warmupSessionKey = sess.key;
    } catch (e) {
      console.warn("[warmup] Could not create warmup session:", e.message);
      setReady();
      return;
    }

    await new Promise((resolve) => {
      // 60s hard ceiling — still unlocks button if Ollama is extremely slow
      const timeout = setTimeout(() => {
        console.warn("[warmup] timed out waiting for Ollama response");
        resolve();
      }, 60000);

      // Listen on the raw "event" hook — this fires for EVERY WS frame.
      // gateway.on("chat",...) was never triggered because the server sends
      // frames whose .event field is e.g. "session.delta", not "chat".
      const rawHandler = (frame) => {
        const key = frame.payload?.sessionKey ?? frame.payload?.key;
        if (key === warmupSessionKey) {
          clearTimeout(timeout);
          gateway.off("event", rawHandler);
          resolve();
        }
      };
      gateway.on("event", rawHandler);

      // Fire the actual warmup message
      gateway.sendMessage(warmupSessionKey, "Ping. Reply OK.").catch((e) => {
        console.warn("[warmup] sendMessage failed:", e.message);
        clearTimeout(timeout);
        gateway.off("event", rawHandler);
        resolve();
      });
    });

    // Delete the warmup session so it doesn't pollute history
    if (warmupSessionKey) {
      gateway.deleteSession(warmupSessionKey).catch(() => {});
    }

    setReady();
    console.log("[warmup] AI is hot — KV cache anchored.");
  }

  async function connectGateway() {
    try {
      _gatewayPort = await window.launcher.getGatewayPort();
    } catch {
      _gatewayPort = 18789;
    }

    try {
      await gateway.connect(_gatewayPort);
      console.log("[app] connected to gateway on port", _gatewayPort);
      performBackgroundWarmup();
    } catch (e) {
      console.error("[app] gateway connection failed:", e.message);
      // Will auto-reconnect
    }
  }

  // --- Launch (after onboarding step 4) ---

  async function launch() {
    saveOnboarding();

    try {
      await window.launcher.markOnboardingComplete(getOnboardingData());
    } catch (e) {
      console.warn("[app] failed to save onboarding to main process:", e.message);
    }

    go(5); // dashboard
    startLlmPolling();
    connectGateway();
    refreshMountedFolders();
  }

  // --- Boot ---

  async function init() {
    // Delegated click handling for all [data-action] elements.
    // CSP (default-src 'self', no script-src 'unsafe-inline') forbids
    // inline onclick="..." — every interactive element uses data-action
    // instead, dispatched here.
    document.addEventListener("click", (e) => {
      const el = e.target.closest("[data-action]");
      if (!el) return;
      switch (el.dataset.action) {
        case "single":               single(el, "." + el.dataset.group); break;
        case "toggle":               toggle(el); break;
        case "go":                   go(Number(el.dataset.step)); break;
        case "add-invite-row":       addInviteRow(); break;
        case "remove-invite-row":    removeInviteRow(el); break;
        case "mount-local-folder":   mountLocalFolder(); break;
        case "unmount-local-folder": unmountLocalFolder(el.dataset.path); break;
        case "toggle-connector":     toggleConnector(el); break;
        case "app-launch":           launch(); break;
        case "open-chat":            chat.open(); break;
        case "new-workflow":         newWorkflow(); break;
        case "toggle-avatar-menu":   toggleAvatarMenu(); break;
        case "navigate":             navigateTo(el.dataset.target); break;
        case "avatar-settings":      navigateTo("Settings"); closeAvatarMenu(); break;
        case "logout":               logout(); break;
        case "reset-onboarding":     resetOnboarding(); break;
      }
    });

    // Init sub-modules
    chat.init();
    initKeyboardNav();

    // Check if already onboarded
    let firstRun = true;
    try {
      firstRun = await window.launcher.isFirstRun();
    } catch {
      firstRun = !isOnboarded();
    }

    if (firstRun) {
      go(1); // onboarding step 1
    } else {
      go(5); // dashboard
      startLlmPolling();
      connectGateway();
      refreshMountedFolders();
    }
  }

  return { init, go, launch };
})();

// Boot on DOM ready
document.addEventListener("DOMContentLoaded", () => app.init());
