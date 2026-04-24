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
    // Step 1 — workspace config
    const purposeCard = $(".purpose-card.sel");
    const workspaceType = purposeCard?.dataset.purposeId || "";
    const experience = Array.from($$(".tech-pill.sel")).map((p) => p.dataset.toolId || p.textContent.trim());
    const sizeCard = $(".size-card.sel");
    const teamSize = sizeCard?.dataset.sizeId || "";

    // Step 2 — invites
    const invites = [];
    $$(".invite-row").forEach((row) => {
      const email = row.querySelector("input[type=email]")?.value?.trim();
      const role = row.querySelector(".role-select")?.value?.toLowerCase() || "member";
      if (email && email.includes("@")) {
        invites.push({ email, role });
      }
    });

    // Step 3 — connectors
    const connectors = {};
    $$(".conn-card").forEach((card) => {
      const id = card.dataset.connectorId;
      if (id) {
        connectors[id] = card.classList.contains("connected");
      }
    });

    // Step 4 — microapps
    const microapps = Array.from($$(".ma-card.sel")).map(
      (card) => card.dataset.microappId || card.querySelector(".ma-name")?.textContent || ""
    ).filter(Boolean);

    return {
      completedAt: new Date().toISOString(),
      workspace: { type: workspaceType, teamSize },
      experience,
      invites,
      connectors,
      microapps,
    };
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
    else if (label === "Chat") { try { chat.open(); } catch {} }
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

  // Maps a connector card's data-connector-id to the credential key used
  // by the connector proxy (lib/connector-proxy.js). IDs not listed here
  // (e.g., local-files) are handled by their own flow and fall through
  // to the legacy toast.
  const CONNECTOR_KEY_MAP = {
    slack: "slack_token",
    gmail: "gmail_token",
    gdrive: "gdrive_token",
    notion: "notion_token",
    github: "github_token",
    onedrive: "onedrive_token",
  };

  function setConnectorConnectedUI(card, connected) {
    if (!card) return;
    card.classList.toggle("connected", connected);
    const btn = card.querySelector(".conn-btn");
    const name = card.querySelector(".conn-name")?.textContent?.trim() || "Connector";
    if (btn) {
      btn.className = connected ? "conn-btn active" : "conn-btn idle";
      btn.textContent = connected ? "Disconnect" : `Connect ${name}`;
    }
    const dot = card.querySelector(".status-dot");
    if (dot) {
      dot.classList.toggle("running", connected);
      dot.classList.toggle("inactive", !connected);
    }
  }

  async function toggleConnector(btn) {
    const card = btn.closest(".conn-card");
    if (!card) return;
    const id = card.dataset.connectorId;
    const key = id ? CONNECTOR_KEY_MAP[id] : null;
    const name = card.querySelector(".conn-name")?.textContent?.trim() || "This connector";

    if (!key) {
      appendToast(`${name} integration is not yet available. For local file access, use Mount a Folder.`);
      return;
    }

    let alreadyConnected = false;
    try {
      alreadyConnected = await window.launcher.hasCredential(key);
    } catch {
      alreadyConnected = card.classList.contains("connected");
    }

    if (alreadyConnected) {
      // Disconnect
      const ok = window.confirm(`Disconnect ${name}? The stored token will be removed.`);
      if (!ok) return;
      try {
        const res = await window.launcher.deleteCredential(key);
        if (res && res.ok === false) throw new Error(res.code || "delete_failed");
        setConnectorConnectedUI(card, false);
        appendToast(`${name} disconnected.`);
      } catch (e) {
        appendToast(`Failed to disconnect ${name}.`);
      }
      return;
    }

    // Connect — Dummy OAuth Flow
    const originalText = btn.textContent;
    btn.innerHTML = `⏳ Connecting...`;
    btn.disabled = true;
    btn.style.opacity = '0.7';
    btn.style.cursor = 'wait';

    setTimeout(async () => {
      btn.innerHTML = originalText;
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
      
      window.open(`https://dummy-oauth.com/${id || 'auth'}`, '_blank');
      
      // Simulate that the callback was received and token was saved successfully
      try {
        const dummyToken = `oauth_${id}_${Date.now()}`;
        const res = await window.launcher.saveCredential(key, dummyToken);
        if (res && res.ok === false) throw new Error(res.code || "save_failed");
        setConnectorConnectedUI(card, true);
        appendToast(`${name} connected.`);
      } catch (e) {
        appendToast(`Failed to save ${name} credential.`);
      }
    }, 800);
  }

  async function hydrateConnectorStates() {
    try {
      const keys = await window.launcher.listCredentialKeys();
      const saved = new Set(keys || []);
      $$(".conn-card").forEach((card) => {
        const id = card.dataset.connectorId;
        const key = id ? CONNECTOR_KEY_MAP[id] : null;
        if (!key) return;
        setConnectorConnectedUI(card, saved.has(key));
      });
    } catch {
      // listCredentialKeys isn't available pre-app-ready — silently ignore.
    }
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

  async function reauthorizeLocalFolder(folderPath) {
    try {
      const res = await window.launcher.reauthorizeFolder(folderPath);
      if (res?.ok) appendToast("Folder re-authorized.");
      else if (!res?.canceled) appendToast("Re-authorization failed.");
      await refreshMountedFolders();
    } catch (e) {
      appendToast("Failed to re-authorize: " + e.message);
    }
  }

  function renderMountedFolderList(listEl, folders) {
    if (!listEl) return;
    listEl.replaceChildren(...folders.map((f) => {
      const name = f.path.split("/").pop() || f.path;
      const item = document.createElement("div");
      item.className = "mounted-folder-item" + (f.stale ? " stale" : "");

      const nameEl = document.createElement("span");
      nameEl.className = "mounted-folder-name";
      nameEl.title = f.path + (f.stale ? " (access expired — re-authorize)" : "");
      nameEl.textContent = name;

      item.appendChild(nameEl);

      if (f.stale) {
        const reauth = document.createElement("button");
        reauth.className = "mounted-folder-reauth";
        reauth.dataset.action = "reauthorize-local-folder";
        reauth.dataset.path = f.path;
        reauth.textContent = "Re-authorize";
        item.appendChild(reauth);
      }

      const removeBtn = document.createElement("button");
      removeBtn.className = "mounted-folder-remove";
      removeBtn.dataset.action = "unmount-local-folder";
      removeBtn.dataset.path = f.path;
      removeBtn.textContent = "✕";
      item.appendChild(removeBtn);
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
            item.className = "mounted-folder-item" + (f.stale ? " stale" : "");

            const nameEl = document.createElement("span");
            nameEl.className = "mounted-folder-name";
            nameEl.title = f.path + (f.stale ? " (access expired — re-authorize)" : "");
            nameEl.textContent = name;

            item.appendChild(nameEl);

            if (f.stale) {
              const reauth = document.createElement("button");
              reauth.className = "mounted-folder-reauth";
              reauth.dataset.action = "reauthorize-local-folder";
              reauth.dataset.path = f.path;
              reauth.textContent = "Re-authorize";
              item.appendChild(reauth);
            }

            const btn = document.createElement("button");
            btn.className = "mounted-folder-remove";
            btn.dataset.action = "unmount-local-folder";
            btn.dataset.path = f.path;
            btn.textContent = "✕";
            item.appendChild(btn);

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

  // Avatar menu removed — Settings lives in sidebar nav.

  function logout() {
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

  // --- Apply onboarding config to dashboard ---

  const MICROAPP_LABELS = {
    "finance": "Finance Tracker",
    "knowledge-base": "Knowledge Base",
    "projects": "Project Manager",
    "hr": "HR Assistant",
    "support": "Customer Support",
    "custom": "Custom Microapp",
  };

  async function applyOnboardingConfig() {
    let config;
    try {
      config = await window.launcher.getConfig();
    } catch {
      return;
    }

    const ob = config?.onboarding;
    if (!ob) return;

    // Update stat cards with real counts
    const statValues = $$(".stat-value");
    const statTrends = $$(".stat-trend");

    // Connectors count
    if (statValues[2] && ob.connectors) {
      const activeCount = Object.values(ob.connectors).filter(Boolean).length;
      statValues[2].textContent = String(activeCount);
      if (statTrends[2]) {
        statTrends[2].textContent = activeCount > 0 ? `${activeCount} source${activeCount > 1 ? "s" : ""} connected` : "No sources connected";
      }
    }

    // Team members count
    if (statValues[3] && ob.invites) {
      const memberCount = 1 + (ob.invites.length || 0); // +1 for the user
      statValues[3].textContent = String(memberCount);
      if (statTrends[3]) {
        statTrends[3].textContent = memberCount > 1 ? `You + ${memberCount - 1} invited` : "You";
      }
    }

    // Populate active microapps panel
    const microappsPanel = document.querySelector('.dash-section[data-section="Dashboard"] .panel-header .panel-title');
    const microappsPanelParent = microappsPanel?.closest(".dash-panel");
    if (microappsPanelParent && ob.microapps && ob.microapps.length > 0) {
      const container = microappsPanelParent.querySelector(".cp-row")?.parentElement;
      if (container) {
        // Clear existing static rows after the panel-header
        const existingRows = container.querySelectorAll(".cp-row");
        // Keep only microapps the user selected
        const selectedSet = new Set(ob.microapps);
        existingRows.forEach((row) => {
          const name = row.querySelector(".cp-name")?.textContent || "";
          // Find matching ID by label
          const matchId = Object.entries(MICROAPP_LABELS).find(([, label]) => label === name)?.[0];
          if (matchId && !selectedSet.has(matchId)) {
            row.style.display = "none";
          }
        });
      }
    }

    // Show workspace type in settings
    const workspaceLabel = ob.workspace?.type;
    if (workspaceLabel) {
      const settingsList = document.querySelector(".settings-list");
      if (settingsList && !settingsList.querySelector(".settings-workspace")) {
        const dt = document.createElement("dt");
        dt.textContent = "Workspace type";
        const dd = document.createElement("dd");
        dd.className = "settings-workspace";
        dd.textContent = workspaceLabel;
        settingsList.prepend(dd);
        settingsList.prepend(dt);
      }
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
    applyOnboardingConfig();
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
        case "reauthorize-local-folder": reauthorizeLocalFolder(el.dataset.path); break;
        case "toggle-connector":     toggleConnector(el); break;
        case "app-launch":           launch(); break;
        case "open-chat":            if (!el.disabled) chat.open(); break;
        case "new-workflow":         newWorkflow(); break;
        case "navigate":             navigateTo(el.dataset.target); break;
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
      applyOnboardingConfig();
      startLlmPolling();
      connectGateway();
      refreshMountedFolders();
    }

    // Mark connector cards connected/disconnected based on saved
    // credentials so returning users see the correct state on both
    // the onboarding Connectors step and the dashboard Connectors section.
    hydrateConnectorStates();
  }

  return { init, go, launch };
})();

// Boot on DOM ready
document.addEventListener("DOMContentLoaded", () => app.init());
