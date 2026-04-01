"use strict";

const childProcesses = new Map(); // name -> child_process

/**
 * Register a child process for cleanup on app exit.
 */
function trackProcess(name, child) {
  if (!child || !child.pid) return;
  childProcesses.set(name, child);

  child.on("exit", () => {
    childProcesses.delete(name);
  });
}

/**
 * Send SIGTERM to a process, then SIGKILL after a timeout.
 */
function killProcess(proc, name, killTimeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!proc || !proc.pid) {
      resolve();
      return;
    }

    try {
      process.kill(proc.pid, "SIGTERM");
    } catch (err) {
      // Process already dead
      if (err.code === "ESRCH") {
        resolve();
        return;
      }
      console.error(`[cleanup] Failed to SIGTERM ${name} (pid ${proc.pid}):`, err.message);
    }

    const timer = setTimeout(() => {
      try {
        process.kill(proc.pid, "SIGKILL");
        console.log(`[cleanup] SIGKILL sent to ${name} (pid ${proc.pid})`);
      } catch (err) {
        if (err.code !== "ESRCH") {
          console.error(`[cleanup] Failed to SIGKILL ${name}:`, err.message);
        }
      }
      resolve();
    }, killTimeoutMs);

    // If process exits before timeout, clear the timer
    const checkExit = setInterval(() => {
      try {
        process.kill(proc.pid, 0); // check if alive
      } catch {
        clearInterval(checkExit);
        clearTimeout(timer);
        resolve();
      }
    }, 200);
  });
}

/**
 * Kill all tracked processes. Returns a promise that resolves when all are dead.
 */
async function killAll() {
  const promises = [];
  for (const [name, proc] of childProcesses) {
    promises.push(killProcess(proc, name));
  }
  await Promise.all(promises);
  childProcesses.clear();
}

/**
 * Install signal handlers for graceful shutdown.
 * Hooks into Electron's before-quit and window-all-closed events,
 * as well as OS signals (SIGINT, SIGTERM).
 */
function installCleanupHandlers(app) {
  const doCleanup = async () => {
    console.log("[cleanup] Shutting down child processes...");
    await killAll();
  };

  if (app) {
    app.on("before-quit", async (e) => {
      if (!app._nemoclawCleanedUp) {
        e.preventDefault();
        app._nemoclawCleanedUp = true;
        await doCleanup();
        app.quit();
      }
    });

    app.on("window-all-closed", () => {
      // On macOS, apps stay in the dock unless explicitly quit
      if (process.platform !== "darwin") {
        app.quit();
      }
    });

    app.on("activate", () => {
      // macOS dock click — re-create window if needed
    });
  }

  // OS-level signal handlers
  const handleSignal = async (signal) => {
    console.log(`[cleanup] Received ${signal}`);
    await doCleanup();
    process.exit(0);
  };

  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  process.on("uncaughtException", async (err) => {
    console.error("[cleanup] Uncaught exception:", err);
    await doCleanup();
    process.exit(1);
  });
}

module.exports = { trackProcess, killProcess, killAll, installCleanupHandlers };
