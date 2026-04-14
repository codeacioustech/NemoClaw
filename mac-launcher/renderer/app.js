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

  function navigateTo(label) {
    const items = $$(".nav-item");
    let target = null;
    items.forEach((item) => {
      const text = item.textContent.trim().replace(/\d+$/, "").trim();
      if (text === label) target = item;
    });
    if (target) {
      items.forEach((i) => { i.classList.remove("active"); i.removeAttribute("aria-current"); });
      target.classList.add("active");
      target.setAttribute("aria-current", "page");
      const topTitle = $(".dash-topbar-title");
      if (topTitle) topTitle.textContent = label;
    }
  }

  function initSidebar() {
    $$(".nav-item").forEach((item) => {
      item.addEventListener("click", () => {
        $$(".nav-item").forEach((i) => { i.classList.remove("active"); i.removeAttribute("aria-current"); });
        item.classList.add("active");
        item.setAttribute("aria-current", "page");
        const label = item.textContent.trim().replace(/\d+$/, "").trim();
        const topTitle = $(".dash-topbar-title");
        if (topTitle) topTitle.textContent = label;
      });
    });
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
      <button class="btn-secondary" onclick="removeInviteRow(this)">✕</button>
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

    if (card.classList.contains("connected")) {
      // Already connected — placeholder configure action
      const name = card.querySelector(".conn-name")?.textContent || "connector";
      appendToast(`${name} configuration coming soon.`);
      return;
    }

    // Toggle to connected
    card.classList.add("connected");
    const dot = card.querySelector(".status-dot");
    if (dot) { dot.classList.remove("inactive"); dot.classList.add("running"); }
    const status = card.querySelector(".conn-status");
    if (status) status.style.color = "var(--success)";
    const statusText = card.querySelector(".conn-status");
    if (statusText) {
      const span = statusText.childNodes[statusText.childNodes.length - 1];
      if (span && span.nodeType === Node.TEXT_NODE) span.textContent = " Connected";
    }
    btn.className = "conn-btn active";
    btn.textContent = "✓ Connected — Configure";
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

  async function refreshMountedFolders() {
    try {
      const folders = await window.launcher.getMountedFolders();
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
          list.innerHTML = folders.map((f) => {
            const name = f.path.split("/").pop() || f.path;
            return `<div class="mounted-folder-item">
              <span class="mounted-folder-name" title="${f.path}">${name}</span>
              <button class="mounted-folder-remove" onclick="unmountLocalFolder('${f.path.replace(/'/g, "\\'")}')">✕</button>
            </div>`;
          }).join("");
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
    navigateTo("Workflows");
    appendToast("Workflow builder coming soon.");
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
    menu.innerHTML = `
      <div class="avatar-menu-item" onclick="navigateTo('Settings'); closeAvatarMenu()">Settings</div>
      <div class="avatar-menu-item danger" onclick="logout()">Log out</div>
    `;
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

  async function connectGateway() {
    try {
      _gatewayPort = await window.launcher.getGatewayPort();
    } catch {
      _gatewayPort = 18789;
    }

    try {
      await gateway.connect(_gatewayPort);
      console.log("[app] connected to gateway on port", _gatewayPort);
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
    // Expose global handlers for inline onclick
    window.go = go;
    window.single = single;
    window.toggle = toggle;
    window.appLaunch = launch;
    window.openChat = () => chat.open();
    window.addInviteRow = addInviteRow;
    window.removeInviteRow = removeInviteRow;
    window.toggleConnector = toggleConnector;
    window.newWorkflow = newWorkflow;
    window.toggleAvatarMenu = toggleAvatarMenu;
    window.closeAvatarMenu = closeAvatarMenu;
    window.navigateTo = navigateTo;
    window.logout = logout;
    window.mountLocalFolder = mountLocalFolder;
    window.unmountLocalFolder = unmountLocalFolder;

    // Init sub-modules
    chat.init();
    initSidebar();
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
