// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { checkAccess, clearCache } from "./file-access-matcher.js";
import { addPermission, addDenyRule, loadStore } from "./file-access-store.js";

describe("file-access-matcher", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-matcher-test-"));
    process.env.HOME = tmpDir;
    clearCache();
  });

  afterEach(() => {
    clearCache();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignored
    }
  });

  it("denies access by default", () => {
    const result = checkAccess("/sandbox/project/src/index.ts", "read", "test-sandbox");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("default deny");
  });

  it("allows access when permission is granted", () => {
    addPermission({
      pattern: "/sandbox/project",
      actions: ["read"],
      scope: "session",
      reason: "Test",
      sandbox: "test-sandbox",
      grantedBy: "operator",
    });

    clearCache();

    const result = checkAccess("/sandbox/project/src/index.ts", "read", "test-sandbox");
    expect(result.allowed).toBe(true);
  });

  it("denies when action is not in permission", () => {
    addPermission({
      pattern: "/sandbox/project",
      actions: ["read"],
      scope: "session",
      reason: "Test",
      sandbox: "test-sandbox",
      grantedBy: "operator",
    });

    clearCache();

    const result = checkAccess("/sandbox/project/src/index.ts", "write", "test-sandbox");
    expect(result.allowed).toBe(false);
  });

  it("allows write when granted", () => {
    addPermission({
      pattern: "/sandbox/project",
      actions: ["write"],
      scope: "session",
      reason: "Test",
      sandbox: "test-sandbox",
      grantedBy: "operator",
    });

    clearCache();

    const result = checkAccess("/sandbox/project/src/index.ts", "write", "test-sandbox");
    expect(result.allowed).toBe(true);
  });

  it("deny rules always win", () => {
    addPermission({
      pattern: "/sandbox/project",
      actions: ["read", "write"],
      scope: "session",
      reason: "Test",
      sandbox: "test-sandbox",
      grantedBy: "operator",
    });

    addDenyRule({
      pattern: "/sandbox/project/secret",
      actions: ["read", "write"],
      reason: "Blocked",
      sandbox: "test-sandbox",
    });

    clearCache();

    // General path should be allowed
    let result = checkAccess("/sandbox/project/src/index.ts", "read", "test-sandbox");
    expect(result.allowed).toBe(true);

    // Denied path should be denied
    result = checkAccess("/sandbox/project/secret/password.txt", "read", "test-sandbox");
    expect(result.allowed).toBe(false);
  });

  it("most specific pattern wins", () => {
    addPermission({
      pattern: "/sandbox/project",
      actions: ["read"],
      scope: "session",
      reason: "General",
      sandbox: "test-sandbox",
      grantedBy: "operator",
    });

    addPermission({
      pattern: "/sandbox/project/src/**",
      actions: ["write"],
      scope: "session",
      reason: "Specific",
      sandbox: "test-sandbox",
      grantedBy: "operator",
    });

    clearCache();

    const result = checkAccess("/sandbox/project/src/index.ts", "write", "test-sandbox");
    expect(result.allowed).toBe(true);
    expect(result.matchedRule?.pattern).toContain("/sandbox/project/src");
  });

  it("cache works correctly", () => {
    addPermission({
      pattern: "/sandbox/project",
      actions: ["read"],
      scope: "session",
      reason: "Test",
      sandbox: "test-sandbox",
      grantedBy: "operator",
    });

    clearCache();

    // First check
    let result = checkAccess("/sandbox/project/file.txt", "read", "test-sandbox");
    expect(result.allowed).toBe(true);

    // Modify store (add new permission)
    addPermission({
      pattern: "/sandbox/other",
      actions: ["read"],
      scope: "session",
      reason: "New",
      sandbox: "test-sandbox",
      grantedBy: "operator",
    });

    // Cache still returns old result (cache is still valid)
    result = checkAccess("/sandbox/project/file.txt", "read", "test-sandbox");
    expect(result.allowed).toBe(true);

    // Clear cache
    clearCache();

    // New check uses fresh data
    result = checkAccess("/sandbox/other/file.txt", "read", "test-sandbox");
    expect(result.allowed).toBe(true);
  });

  it("handles glob patterns", () => {
    addPermission({
      pattern: "/sandbox/project/**",
      actions: ["read"],
      scope: "session",
      reason: "Test",
      sandbox: "test-sandbox",
      grantedBy: "operator",
    });

    clearCache();

    const result = checkAccess("/sandbox/project/deeply/nested/file.txt", "read", "test-sandbox");
    expect(result.allowed).toBe(true);
  });

  it("deny rule with wildcard sandbox applies to all", () => {
    addDenyRule({
      pattern: "/etc/shadow",
      actions: ["read"],
      reason: "Universal block",
      sandbox: "*",
    });

    clearCache();

    const result = checkAccess("/etc/shadow", "read", "any-sandbox");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Denied");
  });
});
