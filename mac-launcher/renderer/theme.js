/* SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. */
/* SPDX-License-Identifier: Apache-2.0 */

// Pre-paint theme bootstrap. Loaded synchronously in <head> so the
// data-theme attribute is set on <html> before the first paint, avoiding
// any dark->light flash on cold start. CSP forbids inline scripts, which
// is why this lives in its own file.
(function () {
  var KEY = "opencoot_theme";
  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (_) {}
  var theme = stored === "light" || stored === "dark"
    ? stored
    : (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  document.documentElement.setAttribute("data-theme", theme);

  window.__theme = {
    KEY: KEY,
    get: function () { return document.documentElement.getAttribute("data-theme") || "dark"; },
    set: function (t) {
      if (t !== "light" && t !== "dark") return;
      document.documentElement.setAttribute("data-theme", t);
      try { localStorage.setItem(KEY, t); } catch (_) {}
      var btn = document.querySelector('[data-action="toggle-theme"]');
      if (btn) btn.setAttribute("aria-pressed", t === "light" ? "true" : "false");
    },
    toggle: function () { this.set(this.get() === "light" ? "dark" : "light"); }
  };
})();
