// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * File policy merger — converts file permissions into Landlock policy and applies via openshell.
 *
 * Integration with existing openshell policy system:
 *   1. Read current policy (openshell policy get --full)
 *   2. Parse YAML, extract filesystem_policy section
 *   3. Merge new permissions into read_only[] and read_write[]
 *   4. Write merged YAML to temp file
 *   5. Apply via openshell policy set --policy <tmpfile> --wait <sandbox>
 *   6. Clean up temp file
 *
 * This module does NOT touch network_policies or other sections.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

import type { FilePermission } from "./file-access-types.js";

/**
 * Convert file permissions into a filesystem_policy patch.
 *
 * Mapping:
 *   "read"    → read_only[]
 *   "write"   → read_write[]
 *   "execute" → read_write[] (Landlock doesn't separate execute at dir level)
 *
 * Returns normalized paths (strips /** and /* suffixes for Landlock prefixes).
 */
export function permissionsToFsPolicyPatch(permissions: FilePermission[]): {
  read_only: string[];
  read_write: string[];
} {
  const readOnly = new Set<string>();
  const readWrite = new Set<string>();

  for (const perm of permissions) {
    // Normalize pattern to directory prefix (strip glob suffixes)
    const policyPath = normalizePath(perm.pattern);

    // If path is in both read and write, write wins (includes read implicitly)
    if (perm.actions.includes("write") || perm.actions.includes("execute")) {
      readWrite.add(policyPath);
      // Remove from read_only if it was there (write is stricter)
      readOnly.delete(policyPath);
    } else if (perm.actions.includes("read")) {
      // Only add to read_only if not already in read_write
      if (!readWrite.has(policyPath)) {
        readOnly.add(policyPath);
      }
    }
  }

  return {
    read_only: Array.from(readOnly).sort(),
    read_write: Array.from(readWrite).sort(),
  };
}

/**
 * Normalize a path pattern to a Landlock directory prefix.
 *
 * Examples:
 *   /sandbox/project       → /sandbox/project
 *   /sandbox/project/**    → /sandbox/project
 *   /sandbox/project/*.ts  → /sandbox/project
 *   /sandbox/.config       → /sandbox/.config
 */
function normalizePath(pattern: string): string {
  // Strip trailing /** or /*
  let normalized = pattern.replace(/\/\*\*$/, "").replace(/\/\*$/, "");

  // For glob patterns like /project/src/*.ts, strip to parent dir
  // (Landlock only understands directory prefixes)
  if (normalized.includes("*")) {
    // Find the last slash before any glob
    const lastSlash = normalized.lastIndexOf("/");
    if (lastSlash > 0) {
      normalized = normalized.substring(0, lastSlash);
    }
  }

  return normalized;
}

/**
 * Merge file permissions into the current sandbox policy YAML.
 *
 * Behavior:
 *   - Parses current policy YAML
 *   - Converts permissions to fs_policy patch
 *   - Adds new paths to filesystem_policy.read_only[] and read_write[]
 *   - PRESERVES all existing paths (baseline + previously granted)
 *   - PRESERVES network_policies and other sections untouched
 *   - Deduplicates: if path is in both read_only and read_write, keeps only in read_write
 *
 * Does NOT remove paths — Landlock is additive only.
 */
export function mergeFilePermissionsIntoPolicy(
  currentPolicyYaml: string,
  permissions: FilePermission[],
): string {
  const patch = permissionsToFsPolicyPatch(permissions);

  let policy: Record<string, unknown>;
  try {
    policy = YAML.parse(currentPolicyYaml) || {};
  } catch {
    policy = {};
  }

  if (!policy.version) {
    policy.version = 1;
  }

  // Get or create filesystem_policy section
  const fsPol = (policy.filesystem_policy as Record<string, unknown>) || {};

  // Get existing paths (preserve them)
  const existingReadOnly: string[] = Array.isArray(fsPol.read_only)
    ? [...(fsPol.read_only as string[])]
    : [];
  const existingReadWrite: string[] = Array.isArray(fsPol.read_write)
    ? [...(fsPol.read_write as string[])]
    : [];

  // Merge: combine existing with new, deduplicate
  const mergedReadOnly = [...new Set([...existingReadOnly, ...patch.read_only])].sort();
  const mergedReadWrite = [...new Set([...existingReadWrite, ...patch.read_write])].sort();

  // Final dedup: remove from read_only anything now in read_write
  const readWriteSet = new Set(mergedReadWrite);
  const finalReadOnly = mergedReadOnly.filter((p) => !readWriteSet.has(p));

  // Update filesystem_policy section
  policy.filesystem_policy = {
    ...fsPol,
    read_only: finalReadOnly,
    read_write: mergedReadWrite,
  };

  return YAML.stringify(policy);
}

/**
 * Dependency injection interface for openshell commands.
 * This allows testing and alternate implementations.
 */
export interface OpenshellDeps {
  /** Run a command and capture stdout/stderr. May throw on non-zero exit. */
  runCapture: (cmd: string, opts?: { ignoreError?: boolean }) => string;
  /** Run a command and stream output. Throws on non-zero exit unless ignoreError. */
  run: (cmd: string) => void;
  /** Parse policy output from openshell (strip metadata header). */
  parseCurrentPolicy: (raw: string) => string;
  /** Build policy get command string. */
  buildPolicyGetCommand: (sandboxName: string) => string;
  /** Build policy set command string. */
  buildPolicySetCommand: (policyFile: string, sandboxName: string) => string;
}

/**
 * Apply file permissions to a running sandbox.
 *
 * Steps:
 *   1. openshell policy get --full <sandbox> → current YAML
 *   2. Merge permissions into filesystem_policy
 *   3. Write merged YAML to temp file
 *   4. openshell policy set --policy <tmpfile> --wait <sandbox>
 *   5. Clean up temp file
 *
 * Reuses the temp file pattern from src/lib/policies.ts:applyPreset().
 * Throws on error.
 */
export function applyFilePermissions(
  sandboxName: string,
  permissions: FilePermission[],
  deps: OpenshellDeps,
): void {
  // Step 1: Get current policy
  let rawPolicy = "";
  try {
    rawPolicy = deps.runCapture(deps.buildPolicyGetCommand(sandboxName), {
      ignoreError: true,
    });
  } catch {
    // Ignore errors — will create fresh policy below
  }

  const currentPolicy = deps.parseCurrentPolicy(rawPolicy);

  // Step 2: Merge permissions
  const merged = mergeFilePermissionsIntoPolicy(currentPolicy, permissions);

  // Step 3: Write temp file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fapolicy-"));
  const tmpFile = path.join(tmpDir, "policy.yaml");

  try {
    fs.writeFileSync(tmpFile, merged, { encoding: "utf-8", mode: 0o600 });

    // Step 4: Apply policy
    deps.run(deps.buildPolicySetCommand(tmpFile, sandboxName));
  } finally {
    // Step 5: Cleanup
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignored */
    }
    try {
      fs.rmdirSync(tmpDir);
    } catch {
      /* ignored */
    }
  }
}

/**
 * Validate a path pattern before storing.
 * Prevents obvious path traversal attempts (../../etc/shadow).
 */
export function validatePathPattern(pattern: string): { valid: boolean; error?: string } {
  if (!pattern) {
    return { valid: false, error: "Path cannot be empty" };
  }

  if (!pattern.startsWith("/")) {
    return { valid: false, error: "Path must be absolute (start with /)" };
  }

  // Check for path traversal
  if (pattern.includes("..")) {
    return { valid: false, error: "Path traversal (..) not allowed" };
  }

  // Check for null bytes
  if (pattern.includes("\0")) {
    return { valid: false, error: "Path contains null byte" };
  }

  return { valid: true };
}
