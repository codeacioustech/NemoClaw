// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

import {
  permissionsToFsPolicyPatch,
  mergeFilePermissionsIntoPolicy,
  validatePathPattern,
} from "./file-access-policy.js";
import type { FilePermission } from "./file-access-types.js";

describe("file-access-policy", () => {
  describe("permissionsToFsPolicyPatch", () => {
    it("converts read permissions to read_only", () => {
      const perms: FilePermission[] = [
        {
          id: "test1",
          pattern: "/sandbox/project",
          actions: ["read"],
          scope: "session",
          reason: "Test",
          sandbox: "test",
          grantedAt: "2026-04-16T10:00:00Z",
          grantedBy: "operator",
        },
      ];

      const patch = permissionsToFsPolicyPatch(perms);
      expect(patch.read_only).toContain("/sandbox/project");
      expect(patch.read_write).toHaveLength(0);
    });

    it("converts write permissions to read_write", () => {
      const perms: FilePermission[] = [
        {
          id: "test1",
          pattern: "/sandbox/project",
          actions: ["write"],
          scope: "session",
          reason: "Test",
          sandbox: "test",
          grantedAt: "2026-04-16T10:00:00Z",
          grantedBy: "operator",
        },
      ];

      const patch = permissionsToFsPolicyPatch(perms);
      expect(patch.read_write).toContain("/sandbox/project");
      expect(patch.read_only).toHaveLength(0);
    });

    it("write wins over read for same path", () => {
      const perms: FilePermission[] = [
        {
          id: "test1",
          pattern: "/sandbox/project",
          actions: ["read", "write"],
          scope: "session",
          reason: "Test",
          sandbox: "test",
          grantedAt: "2026-04-16T10:00:00Z",
          grantedBy: "operator",
        },
      ];

      const patch = permissionsToFsPolicyPatch(perms);
      expect(patch.read_write).toContain("/sandbox/project");
      expect(patch.read_only).not.toContain("/sandbox/project");
    });

    it("strips glob patterns", () => {
      const perms: FilePermission[] = [
        {
          id: "test1",
          pattern: "/sandbox/project/**",
          actions: ["read"],
          scope: "session",
          reason: "Test",
          sandbox: "test",
          grantedAt: "2026-04-16T10:00:00Z",
          grantedBy: "operator",
        },
      ];

      const patch = permissionsToFsPolicyPatch(perms);
      expect(patch.read_only).toContain("/sandbox/project");
      expect(patch.read_only).not.toContain("/sandbox/project/**");
    });
  });

  describe("mergeFilePermissionsIntoPolicy", () => {
    it("merges permissions into empty policy", () => {
      const perms: FilePermission[] = [
        {
          id: "test1",
          pattern: "/sandbox/project",
          actions: ["read"],
          scope: "session",
          reason: "Test",
          sandbox: "test",
          grantedAt: "2026-04-16T10:00:00Z",
          grantedBy: "operator",
        },
      ];

      const result = mergeFilePermissionsIntoPolicy("", perms);
      expect(result).toContain("read_only");
      expect(result).toContain("/sandbox/project");
    });

    it("preserves existing policy sections", () => {
      const existing = `
version: 1
network_policies:
  test:
    name: test
    endpoints: []
filesystem_policy:
  read_only:
    - /usr
  read_write:
    - /tmp
`;

      const perms: FilePermission[] = [
        {
          id: "test1",
          pattern: "/sandbox/project",
          actions: ["read"],
          scope: "session",
          reason: "Test",
          sandbox: "test",
          grantedAt: "2026-04-16T10:00:00Z",
          grantedBy: "operator",
        },
      ];

      const result = mergeFilePermissionsIntoPolicy(existing, perms);

      // Should preserve network_policies
      expect(result).toContain("network_policies");
      expect(result).toContain("test");

      // Should add new path
      expect(result).toContain("/sandbox/project");

      // Should preserve existing paths
      expect(result).toContain("/usr");
      expect(result).toContain("/tmp");
    });

    it("deduplicates paths", () => {
      const existing = `
version: 1
filesystem_policy:
  read_only:
    - /sandbox/project
`;

      const perms: FilePermission[] = [
        {
          id: "test1",
          pattern: "/sandbox/project",
          actions: ["read"],
          scope: "session",
          reason: "Test",
          sandbox: "test",
          grantedAt: "2026-04-16T10:00:00Z",
          grantedBy: "operator",
        },
      ];

      const result = mergeFilePermissionsIntoPolicy(existing, perms);

      // Count occurrences of /sandbox/project in read_only
      const matches = (result.match(/read_only:[\s\S]*?- \/sandbox\/project/g) || []).length;
      expect(matches).toBe(1);
    });

    it("removes from read_only anything now in read_write", () => {
      const existing = `
version: 1
filesystem_policy:
  read_only:
    - /sandbox/project
  read_write: []
`;

      const perms: FilePermission[] = [
        {
          id: "test1",
          pattern: "/sandbox/project",
          actions: ["write"],
          scope: "session",
          reason: "Test",
          sandbox: "test",
          grantedAt: "2026-04-16T10:00:00Z",
          grantedBy: "operator",
        },
      ];

      const result = mergeFilePermissionsIntoPolicy(existing, perms);

      const lines = result.split("\n");
      const roIdx = lines.findIndex((l) => l.includes("read_only"));
      const rwIdx = lines.findIndex((l) => l.includes("read_write"));

      // Find read_only content
      const roSection = lines
        .slice(roIdx, rwIdx)
        .join("\n");

      // /sandbox/project should NOT be in read_only
      expect(roSection).not.toContain("- /sandbox/project");

      // But should be in read_write
      expect(result).toContain("read_write:");
    });
  });

  describe("validatePathPattern", () => {
    it("accepts absolute paths", () => {
      const result = validatePathPattern("/sandbox/project");
      expect(result.valid).toBe(true);
    });

    it("rejects relative paths", () => {
      const result = validatePathPattern("sandbox/project");
      expect(result.valid).toBe(false);
    });

    it("rejects path traversal", () => {
      const result = validatePathPattern("/sandbox/../etc/shadow");
      expect(result.valid).toBe(false);
    });

    it("rejects empty paths", () => {
      const result = validatePathPattern("");
      expect(result.valid).toBe(false);
    });

    it("rejects null bytes", () => {
      const result = validatePathPattern("/sandbox/project\0");
      expect(result.valid).toBe(false);
    });
  });
});
