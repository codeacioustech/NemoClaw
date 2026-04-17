// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * File access matcher — checks if a path is allowed for a given action.
 *
 * Evaluation order:
 *   1. Deny rules first (if match, deny always wins)
 *   2. Allow rules (most specific pattern wins)
 *   3. Default: deny
 *
 * Uses minimatch for glob patterns. Results are cached with a 30s TTL.
 */

import * as path from "node:path";
import { minimatch } from "minimatch";

import type {
  FileAction,
  FilePermission,
  FileDenyRule,
  AccessCheckResult,
} from "./file-access-types.js";
import { getPermissions, getDenyRules } from "./file-access-store.js";

const cache = new Map<string, { result: AccessCheckResult; expiresAt: number }>();
const CACHE_TTL_MS = 30_000; // 30 seconds

function cacheKey(filePath: string, action: FileAction, sandbox: string): string {
  return `${sandbox}:${action}:${filePath}`;
}

/** Clear the access check cache. Call this when permissions change. */
export function clearCache(): void {
  cache.clear();
}

/**
 * Check if access to a file path is allowed for a given action in a sandbox.
 *
 * Evaluation:
 *   1. Check deny rules first (deny always wins)
 *   2. Check allow rules (most specific pattern match wins)
 *   3. Default: DENY
 *
 * Results are cached for 30 seconds.
 */
export function checkAccess(
  filePath: string,
  action: FileAction,
  sandbox: string,
): AccessCheckResult {
  const key = cacheKey(filePath, action, sandbox);

  // Check cache
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const result = _checkAccessUncached(filePath, action, sandbox);

  // Store in cache
  cache.set(key, {
    result,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return result;
}

function _checkAccessUncached(
  filePath: string,
  action: FileAction,
  sandbox: string,
): AccessCheckResult {
  const deny = getDenyRules();

  // Step 1: Check deny rules (deny always wins)
  for (const rule of deny) {
    // Sandbox check: rule applies to this sandbox or all sandboxes (*)
    if (rule.sandbox !== "*" && rule.sandbox !== sandbox) {
      continue;
    }

    // Action check: this action is denied
    if (!rule.actions.includes(action)) {
      continue;
    }

    // Pattern match: use minimatch with dot:true to handle dotfiles
    if (minimatch(filePath, rule.pattern, { dot: true })) {
      return {
        allowed: false,
        matchedRule: rule,
        reason: `Denied: ${rule.reason}`,
      };
    }
  }

  // Step 2: Check allow rules (most specific wins)
  const allow = getPermissions(sandbox);

  // Filter to candidates: must have this action and match pattern
  const candidates = allow
    .filter((p) => p.actions.includes(action))
    .filter((p) => minimatch(filePath, p.pattern, { dot: true }))
    // Sort by pattern length desc: longer (more specific) first
    .sort((a, b) => b.pattern.length - a.pattern.length);

  if (candidates.length > 0) {
    const matched = candidates[0];
    return {
      allowed: true,
      matchedRule: matched,
      reason: `Allowed by: ${matched.pattern}`,
    };
  }

  // Step 3: Default deny
  return {
    allowed: false,
    matchedRule: null,
    reason: "No matching permission (default deny)",
  };
}

/**
 * Resolve path for local vs remote sandbox environments.
 * Maps host paths to sandbox paths automatically.
 */
export function resolvePathForSandbox(filePath: string): string {
  if (!filePath || typeof filePath !== "string") {
    return "/sandbox/";
  }

  // Already a sandbox path
  if (filePath.startsWith("/sandbox/") || filePath.startsWith("/tmp/")) {
    return filePath;
  }

  // Detect if running in sandbox
  const sandboxRoot = "/sandbox";
  const hostHome = process.env.HOME ?? "/tmp";

  // Handle empty or current directory
  if (!filePath || filePath === ".") {
    return `${sandboxRoot}/`;
  }

  // Host path patterns to replace
  const hostPatterns: Array<{ from: RegExp; to: string }> = [
    // ~/.openclaw/... → /sandbox/... (not .openclaw subfolder)
    { from: new RegExp(`^${hostHome}/\\.openclaw/workspace-default/`), to: `${sandboxRoot}/` },
    // ~/.openclaw/... → /sandbox/.openclaw/...
    { from: new RegExp(`^${hostHome}/\\.openclaw/`), to: `${sandboxRoot}/.openclaw/` },
    // ~/... → /sandbox/home/...
    { from: new RegExp(`^${hostHome}/`), to: `${sandboxRoot}/home/` },
    // /Users/username/... → /sandbox/home/...
    { from: /^\/Users\/[^/]+\//, to: `${sandboxRoot}/home/` },
    // workspace-default → workspace → /sandbox/...
    { from: /workspace-default/, to: "workspace" },
  ];

  for (const { from, to } of hostPatterns) {
    if (from.test(filePath)) {
      return filePath.replace(from, to);
    }
  }

  // If relative path, assume relative to sandbox workspace
  if (!filePath.startsWith("/")) {
    return `${sandboxRoot}/${filePath}`;
  }

  return filePath;
}
