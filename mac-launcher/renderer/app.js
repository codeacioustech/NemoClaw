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
    parent.querySelectorAll(groupSelector).forEach((c) => c.classList.remove("sel"));
    el.classList.add("sel");
  }

  function toggle(el) {
    el.classList.toggle("sel");
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

  function initSidebar() {
    $$(".nav-item").forEach((item) => {
      item.addEventListener("click", () => {
        $$(".nav-item").forEach((i) => i.classList.remove("active"));
        item.classList.add("active");
      });
    });
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
  }

  // --- Boot ---

  async function init() {
    // Expose global handlers for inline onclick
    window.go = go;
    window.single = single;
    window.toggle = toggle;
    window.appLaunch = launch;
    window.openChat = () => chat.open();

    // Init sub-modules
    chat.init();
    initSidebar();

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
    }
  }

  return { init, go, launch };
})();

// Boot on DOM ready
document.addEventListener("DOMContentLoaded", () => app.init());
