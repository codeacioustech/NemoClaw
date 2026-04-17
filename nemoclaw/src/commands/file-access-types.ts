// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Type definitions for the file access permission system.
 */

/** Filesystem actions that can be permitted or denied */
export type FileAction = "read" | "write" | "execute";

/** How long a permission lasts */
export type PermissionScope = "chat" | "session" | "persistent";

/** Scope labels for display */
export const SCOPE_LABELS: Record<PermissionScope, string> = {
  chat: "this chat",
  session: "session",
  persistent: "forever",
};

/** Who granted the permission */
export type GrantedBy = "operator" | "tui-approval";

/**
 * A single file access permission rule.
 *
 * Path patterns support:
 *   /sandbox/project          — exact directory
 *   /sandbox/project/**       — recursive (expanded to /sandbox/project for Landlock)
 *   /sandbox/project/*.ts     — glob (but Landlock only understands directory prefixes)
 */
export interface FilePermission {
  /** Unique ID for revocation tracking */
  id: string;

  /** Path pattern (will be normalized to directory prefix for Landlock) */
  pattern: string;

  /** Which actions are permitted */
  actions: FileAction[];

  /** session = cleared on restart; persistent = survives restart */
  scope: PermissionScope;

  /** Human-readable reason for audit trail */
  reason: string;

  /** Which sandbox this applies to */
  sandbox: string;

  /** ISO timestamp when granted */
  grantedAt: string;

  /** Who granted it */
  grantedBy: GrantedBy;
}

/**
 * An explicit deny rule (checked before allow rules).
 * Deny always wins — no way to override.
 */
export interface FileDenyRule {
  id: string;
  pattern: string;
  /** All these actions are denied */
  actions: FileAction[];
  reason: string;
  /** sandbox or "*" for all sandboxes */
  sandbox: string;
  createdAt: string;
}

/** The complete permission store (persisted to ~/.nemoclaw/file-permissions.json) */
export interface FilePermissionStore {
  version: 1;
  permissions: FilePermission[];
  deny: FileDenyRule[];
}

/** Result of an access check */
export interface AccessCheckResult {
  allowed: boolean;
  matchedRule: FilePermission | FileDenyRule | null;
  reason: string;
}

/** Result of ensureFileAccess call from agent */
export interface EnsureFileAccessResult {
  granted: boolean;
  scope?: PermissionScope;
  pattern?: string;
}
