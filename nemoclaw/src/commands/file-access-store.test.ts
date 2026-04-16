// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  loadStore,
  saveStore,
  addPermission,
  removePermission,
  revokeByPattern,
  addDenyRule,
  getPermissions,
  getPersistentPermissions,
  purgeSessionPermissions,
} from "./file-access-store.js";

describe("file-access-store", () => {
  let tmpDir: string;

  beforeEach(() => {
    // Create a temporary directory for this test
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-test-"));
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    // Clean up
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignored
    }
  });

  it("loads empty store when no file exists", () => {
    const store = loadStore();
    expect(store.version).toBe(1);
    expect(store.permissions).toHaveLength(0);
    expect(store.deny).toHaveLength(0);
  });

  it("adds a permission and persists to disk", () => {
    const perm = addPermission({
      pattern: "/sandbox/project",
      actions: ["read", "write"],
      scope: "session",
      reason: "Test permission",
      sandbox: "test-sandbox",
      grantedBy: "operator",
    });

    expect(perm.id).toMatch(/^fp_/);
    expect(perm.pattern).toBe("/sandbox/project");
    expect(perm.actions).toContain("read");
    expect(perm.actions).toContain("write");

    // Verify it persists
    const loaded = getPermissions("test-sandbox");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(perm.id);
  });

  it("deduplicates permissions by pattern+sandbox", () => {
    addPermission({
      pattern: "/sandbox/project",
      actions: ["read"],
      scope: "session",
      reason: "First grant",
      sandbox: "test-sandbox",
      grantedBy: "operator",
    });

    const perm2 = addPermission({
      pattern: "/sandbox/project",
      actions: ["write"],
      scope: "persistent",
      reason: "Upgrade",
      sandbox: "test-sandbox",
      grantedBy: "operator",
    });

    // Should be same ID (upgraded, not duplicate)
    const allPerms = getPermissions("test-sandbox");
    expect(allPerms).toHaveLength(1);
    expect(perm2.actions).toContain("read");
    expect(perm2.actions).toContain("write");
    expect(perm2.scope).toBe("persistent"); // Scope upgraded
  });

  it("removes a permission by ID", () => {
    const perm = addPermission({
      pattern: "/sandbox/project",
      actions: ["read"],
      scope: "session",
      reason: "Test",
      sandbox: "test-sandbox",
      grantedBy: "operator",
    });

    const removed = removePermission(perm.id);
    expect(removed).toBe(true);
    expect(getPermissions("test-sandbox")).toHaveLength(0);
  });

  it("revokes by pattern+sandbox", () => {
    addPermission({
      pattern: "/sandbox/project",
      actions: ["read"],
      scope: "session",
      reason: "Test",
      sandbox: "test-sandbox",
      grantedBy: "operator",
    });

    addPermission({
      pattern: "/sandbox/project/src",
      actions: ["read"],
      scope: "session",
      reason: "Test",
      sandbox: "test-sandbox",
      grantedBy: "operator",
    });

    const removed = revokeByPattern("/sandbox/project", "test-sandbox");
    expect(removed).toBe(1);
    expect(getPermissions("test-sandbox")).toHaveLength(1);
  });

  it("filters persistent permissions", () => {
    addPermission({
      pattern: "/sandbox/project",
      actions: ["read"],
      scope: "session",
      reason: "Test",
      sandbox: "test-sandbox",
      grantedBy: "operator",
    });

    addPermission({
      pattern: "/sandbox/home",
      actions: ["read"],
      scope: "persistent",
      reason: "Test",
      sandbox: "test-sandbox",
      grantedBy: "operator",
    });

    const persistent = getPersistentPermissions("test-sandbox");
    expect(persistent).toHaveLength(1);
    expect(persistent[0].pattern).toBe("/sandbox/home");
  });

  it("purges session permissions", () => {
    addPermission({
      pattern: "/sandbox/project",
      actions: ["read"],
      scope: "session",
      reason: "Test",
      sandbox: "test-sandbox",
      grantedBy: "operator",
    });

    addPermission({
      pattern: "/sandbox/home",
      actions: ["read"],
      scope: "persistent",
      reason: "Test",
      sandbox: "test-sandbox",
      grantedBy: "operator",
    });

    const purged = purgeSessionPermissions("test-sandbox");
    expect(purged).toBe(1);

    const remaining = getPermissions("test-sandbox");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].scope).toBe("persistent");
  });

  it("adds deny rules", () => {
    const rule = addDenyRule({
      pattern: "/etc/shadow",
      actions: ["read", "write"],
      reason: "Sensitive file",
      sandbox: "*",
    });

    expect(rule.id).toMatch(/^fd_/);
    expect(rule.pattern).toBe("/etc/shadow");
  });
});
