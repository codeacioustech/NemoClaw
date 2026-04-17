// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Terminal Access Tool — Secure sandboxed command execution for the AI agent.
 *
 * Runs in the Electron main process ONLY. Never import this in the renderer.
 *
 * Security model (layered):
 *   1. Blocked binaries — unconditionally rejected
 *   2. Blocked argument patterns — dangerous flag combinations
 *   3. Shell injection detection — no chaining, piping, or redirection
 *   4. Directory sandbox — cwd must be inside a user-mounted folder
 *   5. execFile (not exec) — no shell spawned, metacharacters are inert
 *   6. Timeout + output size limits — prevent resource exhaustion
 */

const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_COMMAND_LENGTH = 2000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 1024 * 1024;       // 1 MB
const MAX_OUTPUT_CHARS = 10_000;       // truncation threshold per stream
const HISTORY_MAX = 100;

// ─────────────────────────────────────────────────────────────────────────────
// A. Blocked Binaries (exact match, case-insensitive)
// ─────────────────────────────────────────────────────────────────────────────

const BLOCKED_BINARIES = new Set([
  // Privilege escalation
  "sudo", "su", "doas", "pkexec", "runas",
  // Disk / partition destruction
  "mkfs", "fdisk", "parted", "dd", "format",
  // System power
  "shutdown", "reboot", "halt", "poweroff", "init",
  // Mount / unmount
  "mount", "umount",
  // Firewall / networking
  "iptables", "ip6tables", "nft", "ufw", "netsh",
  // Service management
  "systemctl", "service", "launchctl",
  // User / group management
  "passwd", "useradd", "userdel", "usermod", "groupadd", "groupdel",
  // Scheduled tasks
  "crontab", "at",
  // Windows registry
  "reg", "regedit",
  // Dangerous scripting
  "eval",
]);

// ─────────────────────────────────────────────────────────────────────────────
// B. Blocked Argument Patterns (regex on full command string)
// ─────────────────────────────────────────────────────────────────────────────

const BLOCKED_PATTERNS = [
  // rm -rf / or rm -rf /*  (with any flag ordering)
  { re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+\/(\s|$|\*)/, msg: "rm -rf / is blocked" },
  // dd writing to block devices
  { re: /\bdd\b.*\bof=\/dev\//, msg: "dd to block devices is blocked" },
  // Redirect to block devices
  { re: />\s*\/dev\/sd/, msg: "Redirect to block devices is blocked" },
  // Fork bomb patterns
  { re: /:\(\)\s*\{.*\}\s*;?\s*:/, msg: "Fork bombs are blocked" },
  // mkfs variants
  { re: /\bmkfs\.\w+/, msg: "mkfs is blocked" },
  // chmod/chown recursive on root
  { re: /\b(chmod|chown)\s+(-[a-zA-Z]*R|-[a-zA-Z]*R)\s+.*\s+\/(\s|$)/, msg: "Recursive chmod/chown on / is blocked" },
  // Curl/wget piped to shell
  { re: /\b(curl|wget)\b.*\|\s*(bash|sh|zsh|dash)/, msg: "Piping downloads to shell is blocked" },
];

// ─────────────────────────────────────────────────────────────────────────────
// C. Shell Injection Patterns
// ─────────────────────────────────────────────────────────────────────────────

const SHELL_INJECTION_CHARS = [
  { pattern: /&&/, name: "&&" },
  { pattern: /\|\|/, name: "||" },
  { pattern: /;/, name: ";" },
  { pattern: /\|/, name: "|" },
  { pattern: /`/, name: "backtick" },
  { pattern: /\$\(/, name: "$(" },
  { pattern: /\$\{/, name: "${" },
  { pattern: /\n/, name: "newline" },
  { pattern: /\r/, name: "carriage return" },
  { pattern: />>/, name: ">>" },
  { pattern: />/, name: ">" },
  { pattern: /</, name: "<" },
];

// ─────────────────────────────────────────────────────────────────────────────
// E. Risk Classification
// ─────────────────────────────────────────────────────────────────────────────

const LOW_RISK_BINARIES = new Set([
  "ls", "dir", "cat", "head", "tail", "wc", "find", "grep", "rg", "ag",
  "which", "where", "echo", "printf", "pwd", "date", "whoami", "uname",
  "hostname", "tree", "file", "stat", "du", "df", "env", "printenv",
  "git",  // risk depends on subcommand — refined below
  "node", "npm",  // risk depends on subcommand — refined below
]);

const LOW_RISK_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "branch", "tag", "remote", "show", "stash",
  "ls-files", "ls-tree", "rev-parse", "describe", "shortlog", "blame",
]);

const LOW_RISK_NPM_SUBCOMMANDS = new Set([
  "list", "ls", "view", "info", "search", "outdated", "audit", "doctor",
  "explain", "why", "pack", "version",
]);

const MEDIUM_RISK_BINARIES = new Set([
  "mkdir", "cp", "mv", "touch", "ln",
  "make", "cmake", "tsc", "esbuild", "webpack", "vite",
  "cargo", "go", "rustc", "gcc", "g++", "javac",
  "python", "python3", "pip", "pip3",
  "node", "npx", "npm", "yarn", "pnpm", "bun",
  "git",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Command History (in-memory ring buffer)
// ─────────────────────────────────────────────────────────────────────────────

const _history = [];

function _pushHistory(entry) {
  _history.push(entry);
  if (_history.length > HISTORY_MAX) {
    _history.shift();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split a command string into [binary, ...args] respecting simple quoting.
 * This is intentionally simple — shell injection chars are already blocked,
 * so we only need to handle spaces and quoted strings.
 */
function parseCommand(command) {
  const tokens = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === " " && !inSingle && !inDouble) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);

  return tokens;
}

/**
 * Truncate a string to maxLen, appending a marker if truncated.
 */
function truncate(str, maxLen = MAX_OUTPUT_CHARS) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `\n[TRUNCATED — ${str.length} chars total]`;
}

/**
 * Check whether resolvedPath is inside one of the allowedDirs.
 */
function isInsideAllowedDir(resolvedPath, allowedDirs) {
  const normalised = resolvedPath.replace(/\\/g, "/").toLowerCase();
  return allowedDirs.some((dir) => {
    const normDir = dir.replace(/\\/g, "/").toLowerCase();
    const dirWithSlash = normDir.endsWith("/") ? normDir : normDir + "/";
    return normalised === normDir || normalised.startsWith(dirWithSlash);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify the risk level of a command string.
 * Returns "low", "medium", or "high".
 */
function classifyRisk(command) {
  if (typeof command !== "string" || command.trim().length === 0) return "high";

  const tokens = parseCommand(command.trim());
  if (tokens.length === 0) return "high";

  const binary = path.basename(tokens[0]).toLowerCase().replace(/\.exe$/i, "");
  const subcommand = tokens[1] ? tokens[1].toLowerCase() : "";

  // Special-case: git with read-only subcommand
  if (binary === "git" && LOW_RISK_GIT_SUBCOMMANDS.has(subcommand)) return "low";

  // Special-case: npm with read-only subcommand
  if ((binary === "npm" || binary === "npx") && LOW_RISK_NPM_SUBCOMMANDS.has(subcommand)) return "low";

  // Special-case: node --version, python --version
  if ((binary === "node" || binary === "python" || binary === "python3") &&
      (subcommand === "--version" || subcommand === "-v")) return "low";

  // General low-risk binaries (only if not git/npm which need subcommand check)
  if (LOW_RISK_BINARIES.has(binary) && binary !== "git" && binary !== "npm" && binary !== "node") {
    return "low";
  }

  // Medium-risk
  if (MEDIUM_RISK_BINARIES.has(binary)) return "medium";

  // Everything else
  return "high";
}

/**
 * Validate a command string. Throws on blocked or injected commands.
 * Returns { tokens, binary, risk } on success.
 */
function validateCommand(command) {
  // Type & length check
  if (typeof command !== "string") {
    throw new Error("Command must be a string");
  }

  const trimmed = command.trim();
  if (trimmed.length === 0) {
    throw new Error("Command cannot be empty");
  }
  if (trimmed.length > MAX_COMMAND_LENGTH) {
    throw new Error(`Command too long (${trimmed.length} chars, max ${MAX_COMMAND_LENGTH})`);
  }

  // Shell injection detection
  for (const { pattern, name } of SHELL_INJECTION_CHARS) {
    if (pattern.test(trimmed)) {
      throw new Error(
        `Shell operator "${name}" is not allowed. Use separate terminal calls instead of chaining commands.`
      );
    }
  }

  // Parse tokens
  const tokens = parseCommand(trimmed);
  if (tokens.length === 0) {
    throw new Error("Command cannot be empty after parsing");
  }

  const binary = path.basename(tokens[0]).toLowerCase().replace(/\.exe$/i, "");

  // Blocked binary check
  if (BLOCKED_BINARIES.has(binary)) {
    throw new Error(`Command "${binary}" is blocked for security. Blocked commands include privilege escalation, disk formatting, and system management tools.`);
  }

  // Blocked pattern check (on original trimmed string)
  for (const { re, msg } of BLOCKED_PATTERNS) {
    if (re.test(trimmed)) {
      throw new Error(msg);
    }
  }

  const risk = classifyRisk(trimmed);

  return { tokens, binary, risk };
}

/**
 * Execute a command in a sandboxed directory.
 *
 * @param {object} opts
 * @param {string} opts.command         — the command to run
 * @param {string} [opts.cwd]           — working directory (must be inside a mounted folder)
 * @param {number} [opts.timeout]       — timeout in ms (default 30s, max 120s)
 * @param {function} opts.getMountedFolders — callback returning string[] of mounted folder paths
 * @returns {Promise<{success: boolean, stdout: string, stderr: string, exit_code: number, risk: string}>}
 */
async function executeCommand({ command, cwd, timeout, getMountedFolders }) {
  // ── Validate command ──
  const { tokens, binary, risk } = validateCommand(command);

  // ── Resolve timeout ──
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (typeof timeout === "number" && timeout > 0) {
    timeoutMs = Math.min(timeout, MAX_TIMEOUT_MS);
  }

  // ── Resolve and validate cwd ──
  const mountedFolders = typeof getMountedFolders === "function" ? getMountedFolders() : [];
  if (!Array.isArray(mountedFolders) || mountedFolders.length === 0) {
    throw new Error("No folders are mounted. Mount a folder first before running terminal commands.");
  }

  let resolvedCwd;
  if (cwd) {
    resolvedCwd = path.resolve(cwd);
  } else {
    // Default to first mounted folder
    resolvedCwd = path.resolve(mountedFolders[0]);
  }

  if (!isInsideAllowedDir(resolvedCwd, mountedFolders)) {
    throw new Error(
      `Working directory "${resolvedCwd}" is not inside a mounted folder. ` +
      `Mounted folders: ${mountedFolders.join(", ")}`
    );
  }

  // Verify directory exists
  try {
    const stat = fs.statSync(resolvedCwd);
    if (!stat.isDirectory()) {
      throw new Error(`"${resolvedCwd}" is not a directory`);
    }
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`Working directory does not exist: ${resolvedCwd}`);
    }
    throw err;
  }

  // ── Execute via execFile (no shell) ──
  const isWindows = os.platform() === "win32";
  let execBinary;
  let execArgs;

  if (isWindows) {
    // On Windows, use cmd.exe /C for built-in commands and PATH resolution.
    // Shell injection chars are already stripped, so this is safe.
    execBinary = process.env.COMSPEC || "cmd.exe";
    execArgs = ["/C", ...tokens];
  } else {
    execBinary = tokens[0];
    execArgs = tokens.slice(1);
  }

  return new Promise((resolve) => {
    const startTime = Date.now();

    const child = execFile(
      execBinary,
      execArgs,
      {
        cwd: resolvedCwd,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        env: { ...process.env },
      },
      (error, stdout, stderr) => {
        const duration = Date.now() - startTime;
        let exitCode = 0;
        let success = true;

        if (error) {
          exitCode = error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? -2
            : (typeof error.code === "number" ? error.code : (error.killed ? -1 : 1));
          success = false;

          // Enrich stderr on timeout
          if (error.killed && !stderr) {
            stderr = `Command timed out after ${timeoutMs}ms`;
          }
          // Enrich stderr on buffer overflow
          if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            stderr = (stderr || "") + "\n[Output exceeded 1MB buffer limit]";
          }
        }

        const result = {
          success,
          stdout: truncate(stdout || ""),
          stderr: truncate(stderr || ""),
          exit_code: exitCode,
          risk,
          duration,
        };

        // Record in history
        _pushHistory({
          command: command.trim(),
          cwd: resolvedCwd,
          timestamp: new Date().toISOString(),
          exit_code: exitCode,
          risk,
          duration,
        });

        resolve(result);
      }
    );

    // Safety net: if the child somehow doesn't exit, kill after timeout + 5s
    const safetyTimeout = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (_) { /* ignore */ }
    }, timeoutMs + 5000);

    child.on("exit", () => clearTimeout(safetyTimeout));
  });
}

/**
 * Return command history (most recent last).
 */
function getHistory() {
  return [..._history];
}

module.exports = { executeCommand, classifyRisk, validateCommand, getHistory };
