// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const KILL_ESCALATION_MS = 5000;

const tracked = new Map();
const servers = [];

function trackProcess(name, child) {
  if (!child || !child.pid) return;
  tracked.set(name, child.pid);
  child.on("exit", () => tracked.delete(name));
}

function trackServer(server) {
  servers.push(server);
}

function killAll() {
  for (const server of servers) {
    try { server.close(); } catch { /* ignore */ }
  }
  servers.length = 0;

  const pids = [...tracked.values()];
  if (pids.length === 0) return Promise.resolve();

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (_) {
      // already dead
    }
  }

  return new Promise((resolve) => {
    setTimeout(() => {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (_) {
          // already dead
        }
      }
      tracked.clear();
      resolve();
    }, KILL_ESCALATION_MS);
  });
}

function hookElectronLifecycle(app) {
  app.on("before-quit", (e) => {
    if (tracked.size > 0) {
      e.preventDefault();
      killAll().then(() => app.quit());
    }
  });

  app.on("window-all-closed", () => {
    killAll().then(() => app.quit());
  });
}

module.exports = { trackProcess, trackServer, killAll, hookElectronLifecycle };
