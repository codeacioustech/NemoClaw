// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * File permission store — CRUD operations on ~/.nemoclaw/file-permissions.json
 *
 * All writes are atomic (write to tmp, then rename).
 * No locking needed at the JSON level — OS rename is atomic.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import type {
  FilePermission,
  FileDenyRule,
  FilePermissionStore,
  FileAction,
  PermissionScope,
} from "./file-access-types.js";

const HOME = process.env.HOME ?? "/tmp";
const isSandbox = HOME.startsWith("/sandbox");
const STORE_DIR =
  process.env.SANDBOX_PERMISSIONS_DIR ??
  (isSandbox ? "/sandbox/.nemoclaw" : path.join(HOME, ".nemoclaw"));
const STORE_FILE = path.join(STORE_DIR, "file-permissions.json");

function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
}

/** Load the permission store from disk. Returns empty store if missing. */
export function loadStore(): FilePermissionStore {
  try {
    const raw = fs.readFileSync(STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as FilePermissionStore;
    return parsed.version === 1 ? parsed : { version: 1, permissions: [], deny: [] };
  } catch {
    return { version: 1, permissions: [], deny: [] };
  }
}

/** Write the permission store to disk atomically (tmp + rename). */
export function saveStore(store: FilePermissionStore): void {
  fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${STORE_FILE}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STORE_FILE);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignored */
    }
  }
}

/**
 * Add a new permission or upgrade an existing one.
 * If a rule with the same pattern+sandbox exists, merge actions and upgrade scope.
 */
export function addPermission(opts: {
  pattern: string;
  actions: FileAction[];
  scope: PermissionScope;
  reason: string;
  sandbox: string;
  grantedBy: "operator" | "tui-approval";
}): FilePermission {
  const store = loadStore();

  // Deduplication: if pattern+sandbox match, upgrade instead of duplicate
  const existing = store.permissions.find(
    (p) => p.pattern === opts.pattern && p.sandbox === opts.sandbox,
  );

  if (existing) {
    // Merge actions (union of action sets)
    const mergedActions = Array.from(
      new Set([...existing.actions, ...opts.actions]),
    ) as FileAction[];
    existing.actions = mergedActions;

    // Upgrade scope: persistent > session
    if (opts.scope === "persistent") {
      existing.scope = "persistent";
    }

    existing.grantedAt = new Date().toISOString();
    existing.grantedBy = opts.grantedBy;
    existing.reason = opts.reason || existing.reason;

    saveStore(store);
    return existing;
  }

  // New permission
  const perm: FilePermission = {
    id: generateId("fp"),
    pattern: opts.pattern,
    actions: opts.actions,
    scope: opts.scope,
    reason: opts.reason,
    sandbox: opts.sandbox,
    grantedAt: new Date().toISOString(),
    grantedBy: opts.grantedBy,
  };

  store.permissions.push(perm);
  saveStore(store);
  return perm;
}

/** Remove a permission by ID. Returns true if found. */
export function removePermission(id: string): boolean {
  const store = loadStore();
  const idx = store.permissions.findIndex((p) => p.id === id);
  if (idx === -1) return false;

  store.permissions.splice(idx, 1);
  saveStore(store);
  return true;
}

/** Remove all permissions matching a pattern for a sandbox. Returns count removed. */
export function revokeByPattern(pattern: string, sandbox: string): number {
  const store = loadStore();
  const before = store.permissions.length;

  store.permissions = store.permissions.filter(
    (p) => !(p.pattern === pattern && p.sandbox === sandbox),
  );

  const removed = before - store.permissions.length;
  if (removed > 0) {
    saveStore(store);
  }
  return removed;
}

/** Add a deny rule. Deny rules are checked before allow rules. */
export function addDenyRule(opts: {
  pattern: string;
  actions: FileAction[];
  reason: string;
  sandbox: string; // "*" for all sandboxes
}): FileDenyRule {
  const store = loadStore();

  const rule: FileDenyRule = {
    id: generateId("fd"),
    pattern: opts.pattern,
    actions: opts.actions,
    reason: opts.reason,
    sandbox: opts.sandbox,
    createdAt: new Date().toISOString(),
  };

  store.deny.push(rule);
  saveStore(store);
  return rule;
}

/** Get all permissions for a sandbox (both session and persistent). */
export function getPermissions(sandbox: string): FilePermission[] {
  const store = loadStore();
  return store.permissions.filter((p) => p.sandbox === sandbox);
}

/** Get only persistent permissions (for baseline policy merge). */
export function getPersistentPermissions(sandbox: string): FilePermission[] {
  const store = loadStore();
  return store.permissions.filter((p) => p.sandbox === sandbox && p.scope === "persistent");
}

/** Purge all session-scoped permissions for a sandbox. Called on sandbox stop. */
export function purgeSessionPermissions(sandbox: string): number {
  const store = loadStore();
  const before = store.permissions.length;

  store.permissions = store.permissions.filter(
    (p) => !(p.sandbox === sandbox && p.scope === "session"),
  );

  const removed = before - store.permissions.length;
  if (removed > 0) {
    saveStore(store);
  }
  return removed;
}

/** Get all deny rules (for matching during access checks). */
export function getDenyRules(): FileDenyRule[] {
  const store = loadStore();
  return store.deny;
}

/** List all permissions for a sandbox (for CLI output). */
export function listPermissions(sandbox: string): FilePermission[] {
  return getPermissions(sandbox);
}
