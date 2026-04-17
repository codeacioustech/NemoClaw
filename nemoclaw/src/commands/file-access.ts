// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI commands for file access management.
 *
 * Subcommands:
 *   nemoclaw file-access grant <path> <r|rw|rwx> [session|persistent] [reason]
 *   nemoclaw file-access revoke <pattern>
 *   nemoclaw file-access list
 *   nemoclaw file-access deny <pattern> [reason]
 *   nemoclaw file-access cleanup
 */

import type { FileAction, PermissionScope } from "./file-access-types.js";
import {
  addPermission,
  getPermissions,
  listPermissions,
  revokeByPattern,
  addDenyRule,
  purgeSessionPermissions,
} from "./file-access-store.js";
import { checkAccess, clearCache } from "./file-access-matcher.js";
import { validatePathPattern } from "./file-access-policy.js";
import { audit } from "./file-access-audit.js";

function parseActions(input: string): FileAction[] {
  switch (input.toLowerCase()) {
    case "r":
      return ["read"];
    case "rw":
      return ["read", "write"];
    case "rwx":
      return ["read", "write", "execute"];
    case "w":
      return ["write"];
    case "x":
      return ["execute"];
    default:
      return ["read"];
  }
}

function actionsToString(actions: FileAction[]): string {
  const has = {
    read: actions.includes("read"),
    write: actions.includes("write"),
    execute: actions.includes("execute"),
  };

  if (has.read && has.write && has.execute) return "rwx";
  if (has.read && has.write) return "rw";
  if (has.write && has.execute) return "wx";
  if (has.write) return "w";
  if (has.execute) return "x";
  if (has.read) return "r";
  return "---";
}

/**
 * nemoclaw file-access grant <path> <r|rw|rwx> [session|persistent] [reason]
 */
export function commandGrant(
  sandboxName: string,
  pathPattern: string,
  actionsStr: string,
  scopeStr: string = "session",
  reason: string = "Granted via CLI",
): void {
  // Validate path
  const validation = validatePathPattern(pathPattern);
  if (!validation.valid) {
    console.error(`  ✗ Invalid path: ${validation.error}`);
    process.exit(1);
  }

  const actions = parseActions(actionsStr);
  const scope: PermissionScope =
    scopeStr === "persistent" ? "persistent" : scopeStr === "chat" ? "chat" : "session";

  const perm = addPermission({
    pattern: pathPattern,
    actions,
    scope,
    reason,
    sandbox: sandboxName,
    grantedBy: "operator",
  });

  clearCache();

  audit({
    sandbox: sandboxName,
    action: "grant",
    path: pathPattern,
    permissions: actionsToString(actions),
    scope,
    reason,
    grantedBy: "operator",
  });

  console.log(`  ✓ Granted ${actionsToString(actions)} on ${pathPattern} (${scope})`);
  console.log(`    Rule ID: ${perm.id}`);
}

/**
 * nemoclaw file-access revoke <pattern>
 */
export function commandRevoke(sandboxName: string, pattern: string): void {
  const validation = validatePathPattern(pattern);
  if (!validation.valid) {
    console.error(`  ✗ Invalid path: ${validation.error}`);
    process.exit(1);
  }

  const removed = revokeByPattern(pattern, sandboxName);
  clearCache();

  if (removed === 0) {
    console.log(`  No permissions found for pattern: ${pattern}`);
    return;
  }

  audit({
    sandbox: sandboxName,
    action: "revoke",
    path: pattern,
    reason: "Revoked via CLI",
  });

  console.log(`  ✓ Revoked ${removed} permission(s) for ${pattern}`);
  console.log(`  ⚠ Note: Landlock cannot shrink permissions on running processes.`);
  console.log(`    Full revocation takes effect on sandbox restart.`);
}

/**
 * nemoclaw file-access list
 */
export function commandList(sandboxName: string): void {
  const perms = listPermissions(sandboxName);

  if (perms.length === 0) {
    console.log("  No file access permissions granted.");
    return;
  }

  console.log(`\n  File permissions for sandbox: ${sandboxName}\n`);

  // Header
  const header = [
    "ID".padEnd(16),
    "Pattern".padEnd(40),
    "Actions".padEnd(10),
    "Scope".padEnd(12),
    "Reason",
  ].join("  ");
  console.log(`  ${header}`);
  console.log(`  ${"-".repeat(90)}`);

  // Rows
  for (const p of perms) {
    const row = [
      p.id.padEnd(16),
      p.pattern.padEnd(40),
      actionsToString(p.actions).padEnd(10),
      p.scope.padEnd(12),
      (p.reason || "").slice(0, 30),
    ].join("  ");
    console.log(`  ${row}`);
  }
  console.log();
}

/**
 * nemoclaw file-access deny <pattern> [reason]
 */
export function commandDeny(
  sandboxName: string,
  pattern: string,
  reason: string = "Denied via CLI",
): void {
  const validation = validatePathPattern(pattern);
  if (!validation.valid) {
    console.error(`  ✗ Invalid path: ${validation.error}`);
    process.exit(1);
  }

  const rule = addDenyRule({
    pattern,
    actions: ["read", "write", "execute"],
    reason,
    sandbox: sandboxName,
  });

  clearCache();

  audit({
    sandbox: sandboxName,
    action: "deny",
    path: pattern,
    permissions: "rwx",
    reason,
  });

  console.log(`  ✓ Deny rule created: ${rule.id}`);
  console.log(`    Pattern: ${pattern}`);
  console.log(`    Actions: all (read, write, execute)`);
}

/**
 * nemoclaw file-access cleanup
 * Purges session permissions for a sandbox (called on sandbox stop).
 */
export function commandCleanup(sandboxName: string): void {
  const removed = purgeSessionPermissions(sandboxName);
  clearCache();

  console.log(`  ✓ Purged ${removed} session permission(s) for ${sandboxName}`);

  audit({
    sandbox: sandboxName,
    action: "revoke",
    path: "(all session permissions)",
    reason: "Cleanup on sandbox stop",
  });
}

/**
 * Check access for debugging (internal).
 */
export function commandCheck(filePath: string, action: FileAction, sandboxName: string): void {
  const result = checkAccess(filePath, action, sandboxName);

  console.log(`\n  Access check result:`);
  console.log(`  Path:   ${filePath}`);
  console.log(`  Action: ${action}`);
  console.log(`  Result: ${result.allowed ? "✓ ALLOWED" : "✗ DENIED"}`);
  console.log(`  Reason: ${result.reason}`);
  console.log();

  audit({
    sandbox: sandboxName,
    action: "check",
    path: filePath,
    permissions: action,
    result: result.allowed ? "allowed" : "denied",
  });
}
