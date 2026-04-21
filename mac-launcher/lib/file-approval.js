// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const path = require("path");
const os = require("os");

class FileApprovalManager {
  constructor() {
    this.appDataDir = path.join(os.homedir(), ".nemoclaw");
    this.approvalsPath = path.join(this.appDataDir, "file-approvals.json");
    this.currentSessionId = this.generateSessionId();
    this.currentChatId = null;
    this.cache = this.loadApprovals();
  }

  generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  setCurrentChatId(chatId) {
    this.currentChatId = chatId;
  }

  getCurrentChatId() {
    return this.currentChatId;
  }

  loadApprovals() {
    try {
      const data = fs.readFileSync(this.approvalsPath, "utf-8");
      return JSON.parse(data);
    } catch (e) {
      return {};
    }
  }

  saveApprovals() {
    try {
      fs.mkdirSync(this.appDataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        this.approvalsPath,
        JSON.stringify(this.cache, null, 2),
        { mode: 0o600 }
      );
    } catch (e) {
      console.error("[FileApproval] Failed to save approvals:", e.message);
    }
  }

  /**
   * Get the cache key for a file path
   */
  getCacheKey(filePath) {
    try {
      const realPath = require("fs").realpathSync(filePath);
      return realPath;
    } catch {
      return path.resolve(filePath);
    }
  }

  /**
   * Check if a file is approved
   * Returns: { approved: boolean, reason: string, scope?: string }
   */
  isFileApproved(filePath) {
    const cacheKey = this.getCacheKey(filePath);
    const approval = this.cache[cacheKey];

    if (!approval) {
      return { approved: false, reason: "NOT_APPROVED" };
    }

    // Check if approval has expired
    if (approval.scope === "per-session") {
      if (approval.sessionId !== this.currentSessionId) {
        return { approved: false, reason: "SESSION_EXPIRED" };
      }
    } else if (approval.scope === "per-chat") {
      if (approval.chatId !== this.currentChatId) {
        return { approved: false, reason: "CHAT_CHANGED" };
      }
    }

    return { approved: true, reason: "APPROVED", scope: approval.scope };
  }

  /**
   * Add approval for a file with scope and permissions
   */
  addApproval(filePath, scope, permissions = "read") {
    const cacheKey = this.getCacheKey(filePath);

    this.cache[cacheKey] = {
      path: filePath,
      scope, // "per-session" or "per-chat"
      permissions, // "read", "write", or "read+write"
      sessionId: this.currentSessionId,
      chatId: this.currentChatId,
      approvedAt: new Date().toISOString(),
    };

    this.saveApprovals();
  }

  /**
   * Check if file access is allowed for specific operation
   */
  canAccessFile(filePath, operation = "read") {
    const cacheKey = this.getCacheKey(filePath);
    const approval = this.cache[cacheKey];

    if (!approval) {
      return { allowed: false, reason: "NOT_APPROVED" };
    }

    // Check scope expiration
    if (approval.scope === "per-session") {
      if (approval.sessionId !== this.currentSessionId) {
        return { allowed: false, reason: "SESSION_EXPIRED" };
      }
    } else if (approval.scope === "per-chat") {
      if (approval.chatId !== this.currentChatId) {
        return { allowed: false, reason: "CHAT_CHANGED" };
      }
    }

    // Check permission level
    const permissions = approval.permissions || "read";
    if (operation === "write" && !permissions.includes("write")) {
      return { allowed: false, reason: "WRITE_NOT_APPROVED" };
    }
    if (operation === "read" && !permissions.includes("read")) {
      return { allowed: false, reason: "READ_NOT_APPROVED" };
    }

    return { allowed: true, reason: "APPROVED", scope: approval.scope, permissions };
  }

  /**
   * Get all approvals for display/management
   */
  getAllApprovals() {
    return Object.values(this.cache);
  }

  /**
   * Clear expired approvals (cleanup)
   */
  clearExpiredApprovals() {
    const before = Object.keys(this.cache).length;

    const filtered = {};
    for (const [key, approval] of Object.entries(this.cache)) {
      if (approval.scope === "per-session") {
        if (approval.sessionId === this.currentSessionId) {
          filtered[key] = approval;
        }
      } else if (approval.scope === "per-chat") {
        if (approval.chatId === this.currentChatId) {
          filtered[key] = approval;
        }
      }
    }

    this.cache = filtered;
    const after = Object.keys(this.cache).length;

    if (before !== after) {
      this.saveApprovals();
      console.log(`[FileApproval] Cleared ${before - after} expired approvals`);
    }
  }

  /**
   * Clear all approvals (for logout/reset)
   */
  clearAllApprovals() {
    this.cache = {};
    this.saveApprovals();
  }

  /**
   * Revoke approval for a specific file
   */
  revokeApproval(filePath) {
    const cacheKey = this.getCacheKey(filePath);
    if (this.cache[cacheKey]) {
      delete this.cache[cacheKey];
      this.saveApprovals();
      return true;
    }
    return false;
  }
}

module.exports = FileApprovalManager;
