// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Agent-facing API for file access permission requests.
 *
 * The agent calls ensureFileAccess() before executing commands that need file access.
 * If access is not granted, a TUI prompt appears (on the host).
 * The agent blocks until the operator approves or denies.
 */

import readline from "node:readline";

import type { EnsureFileAccessResult, FileAction, PermissionScope } from "./file-access-types.js";
import { checkAccess, clearCache } from "./file-access-matcher.js";
import { addPermission } from "./file-access-store.js";
import { audit } from "./file-access-audit.js";

export interface EnsureFileAccessOpts {
  path: string;
  action: FileAction;
  reason?: string;
  /** Skip prompt if access already granted; return false if not. Useful for dry-runs. */
  silent?: boolean;
}

/**
 * Ensure file access is granted before proceeding.
 * Blocks (via TUI prompt) until operator approves or denies.
 *
 * Usage in agent code:
 *   const result = await ensureFileAccess({
 *     path: "/sandbox/project/src/index.ts",
 *     action: "write",
 *     reason: "Need to edit source file to fix bug #123",
 *   }, sandboxName, grantFunc);
 *   if (!result.granted) throw new Error("File access denied");
 *   // ... proceed with file operation
 */
export async function ensureFileAccess(
  opts: EnsureFileAccessOpts,
  sandboxName: string,
  grantFunc: (pattern: string, actions: FileAction[], scope: PermissionScope, reason: string) => void,
): Promise<EnsureFileAccessResult> {
  // Fast path: already permitted
  const existing = checkAccess(opts.path, opts.action, sandboxName);
  if (existing.allowed) {
    audit({
      sandbox: sandboxName,
      action: "check",
      path: opts.path,
      permissions: opts.action,
      result: "allowed",
    });
    return { granted: true, pattern: existing.matchedRule?.pattern };
  }

  if (opts.silent) {
    audit({
      sandbox: sandboxName,
      action: "check",
      path: opts.path,
      permissions: opts.action,
      result: "denied",
    });
    return { granted: false };
  }

  // Compute suggested parent directory for "allow directory" option
  const parentDir = opts.path.replace(/\/[^/]+$/, "");
  const parentGlob = parentDir + "/**";

  // Present approval prompt to operator (via TUI on host)
  const choice = await showApprovalPrompt({
    path: opts.path,
    action: opts.action,
    reason: opts.reason || "Agent requested file access",
    parentGlob,
  });

  if (!choice) {
    audit({
      sandbox: sandboxName,
      action: "blocked",
      path: opts.path,
      permissions: opts.action,
      reason: "User denied access",
    });
    return { granted: false };
  }

  // Apply the grant
  grantFunc(choice.pattern, [opts.action], choice.scope, opts.reason || "");
  clearCache();

  audit({
    sandbox: sandboxName,
    action: "grant",
    path: opts.path,
    permissions: opts.action,
    scope: choice.scope,
    reason: opts.reason || "Approved via TUI",
    grantedBy: "tui-approval",
  });

  return {
    granted: true,
    scope: choice.scope,
    pattern: choice.pattern,
  };
}

interface ApprovalChoice {
  pattern: string;
  scope: PermissionScope;
}

/**
 * Display an interactive TUI prompt for file access approval.
 * Returns the user's choice or null if denied.
 */
async function showApprovalPrompt(opts: {
  path: string;
  action: FileAction;
  reason: string;
  parentGlob: string;
}): Promise<ApprovalChoice | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    const pathDisplay = opts.path.length > 45 ? opts.path.slice(0, 42) + "..." : opts.path;
    const reasonDisplay = opts.reason.length > 45 ? opts.reason.slice(0, 42) + "..." : opts.reason;
    const parentDisplay = opts.parentGlob.length > 30 ? opts.parentGlob.slice(0, 27) + "..." : opts.parentGlob;

    process.stderr.write(`
  ┌─ File Access Request ────────────────────────────────────┐
  │                                                           │
  │  Path:   ${pathDisplay.padEnd(45)}│
  │  Action: ${opts.action.padEnd(45)}│
  │  Reason: ${reasonDisplay.padEnd(45)}│
  │                                                           │
  │  [1] Allow this path (session)                            │
  │  [2] Allow this path (persistent)                         │
  │  [3] Allow directory ${parentDisplay.padEnd(20)} (session)  │
  │  [4] Allow directory ${parentDisplay.padEnd(20)} (persist)  │
  │  [5] Deny                                                 │
  │                                                           │
  └───────────────────────────────────────────────────────────┘
`);

    rl.question("  Choose [1-5]: ", (answer) => {
      rl.close();

      const trimmed = answer.trim();

      switch (trimmed) {
        case "1":
          resolve({ pattern: opts.path, scope: "session" });
          break;
        case "2":
          resolve({ pattern: opts.path, scope: "persistent" });
          break;
        case "3":
          resolve({ pattern: opts.parentGlob, scope: "session" });
          break;
        case "4":
          resolve({ pattern: opts.parentGlob, scope: "persistent" });
          break;
        case "5":
        default:
          resolve(null);
          break;
      }
    });
  });
}
