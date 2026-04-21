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
      const models = await window.launcher.getModels();
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
    const modelSelect = $("#model-selector");
    if (modelSelect) {
      try {
        const models = await window.launcher.getModels();
        const currentConfig = await window.launcher.getConfig();
        const activeModel = currentConfig.ollama_model || (models.length ? models[0].name : "");

        modelSelect.innerHTML = "";
        if (models.length === 0) {
          const opt = document.createElement("option");
          opt.textContent = "No models loaded";
          modelSelect.appendChild(opt);
        } else {
          for (const m of models) {
             const opt = document.createElement("option");
             opt.value = m.name;
             opt.textContent = m.name;
             if (m.name === activeModel) opt.selected = true;
             modelSelect.appendChild(opt);
          }
        }

        if (!modelSelect.dataset.handled) {
          modelSelect.dataset.handled = "true";
          modelSelect.addEventListener("change", (e) => {
             window.launcher.setModel(e.target.value);
          });
        }
      } catch (e) {
        modelSelect.innerHTML = "<option>Ollama offline</option>";
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

    const setBusy = (msg) => {
      if (!btn) return;
      // Snapshot original HTML the first time so setReady can restore it exactly
      if (!btn.dataset.originalHtml) {
        btn.dataset.originalHtml = btn.innerHTML;
      }
      btn.disabled = true;
      btn.classList.add("topbar-btn--warming");
      btn.innerHTML = msg;
    };

    const setReady = () => {
      if (!btn) return;
      btn.disabled = false;
      btn.classList.remove("topbar-btn--warming");
      if (btn.dataset.originalHtml) {
        btn.innerHTML = btn.dataset.originalHtml;
        delete btn.dataset.originalHtml;
      }
    };

    setBusy("Connecting...");

    // Phase 1 — wait for gateway handshake
    await new Promise((resolve) => {
      if (gateway.connected) return resolve();
      const onConn = () => resolve();
      gateway.on("connected", onConn);
      setTimeout(() => { gateway.off("connected", onConn); resolve(); }, 8000);
    });

    if (!gateway.connected) {
      console.warn("[warmup] Gateway not reachable — unlocking button.");
      setReady();
      return;
    }

    setBusy("Warming up AI...");

    // Phase 2 — create warmup session
    let warmupKey = null;
    try {
      const sess = await gateway.createSession("__warmup__");
      // Defensive: OpenClaw may return key or sessionKey
      warmupKey = sess.key ?? sess.sessionKey ?? null;
      console.log("[warmup] session created, key =", warmupKey, "| full response:", JSON.stringify(sess));
    } catch (e) {
      console.warn("[warmup] createSession failed:", e.message);
      setReady();
      return;
    }

    if (!warmupKey) {
      console.warn("[warmup] No session key in response — cannot warmup.");
      setReady();
      return;
    }

    // Phase 3 — send ping and wait for ANY event from the warmup session
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn("[warmup] 60s timeout — Ollama may be loading model from disk.");
        gateway.off("event", rawHandler);
        resolve();
      }, 60000);

      const rawHandler = (frame) => {
        // frame = { type, event, payload }
        // Extract session key from any location the gateway may embed it
        const key =
          frame.payload?.sessionKey ??
          frame.payload?.key ??
          frame.payload?.session?.key ??
          null;
        console.log("[warmup] event:", frame.event, "| key in payload:", key);
        if (key && key === warmupKey) {
          clearTimeout(timeout);
          gateway.off("event", rawHandler);
          resolve();
        }
      };
      gateway.on("event", rawHandler);

      gateway.sendMessage(warmupKey, "Ping. Reply OK.").catch((e) => {
        console.warn("[warmup] sendMessage failed:", e.message);
        clearTimeout(timeout);
        gateway.off("event", rawHandler);
        resolve();
      });
    });

    // Phase 4 — cleanup silently
    gateway.deleteSession(warmupKey).catch(() => {});

    setReady();
    console.log("[warmup] ✅ AI is hot — KV cache anchored, button unlocked.");
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
        case "open-chat":            if (!el.disabled) chat.open(); break;
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
