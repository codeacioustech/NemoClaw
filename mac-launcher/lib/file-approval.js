// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Minimal in-memory file-approval manager. Tracks which files the user has
// approved for read/write access, scoped per-session or per-chat.

const crypto = require("crypto");

class FileApprovalManager {
  constructor() {
    this.currentSessionId = crypto.randomUUID();
    this.currentChatId = null;
    // Map<filePath, { scope, permissions, chatId, sessionId, grantedAt }>
    this._approvals = new Map();
  }

  setCurrentChatId(chatId) {
    this.currentChatId = chatId;
  }

  addApproval(filePath, scope, permissions) {
    this._approvals.set(filePath, {
      scope,
      permissions,
      chatId: this.currentChatId,
      sessionId: this.currentSessionId,
      grantedAt: Date.now(),
    });
  }

  canAccessFile(filePath, operation) {
    const entry = this._approvals.get(filePath);
    if (!entry) return { allowed: false, reason: "NOT_APPROVED" };

    if (entry.scope === "per-session" && entry.sessionId !== this.currentSessionId) {
      return { allowed: false, reason: "SESSION_EXPIRED" };
    }
    if (entry.scope === "per-chat" && entry.chatId !== this.currentChatId) {
      return { allowed: false, reason: "CHAT_CHANGED" };
    }

    const perms = entry.permissions;
    if (operation === "read" && !/read/i.test(perms)) {
      return { allowed: false, reason: "READ_NOT_APPROVED" };
    }
    if (operation === "write" && !/write/i.test(perms)) {
      return { allowed: false, reason: "WRITE_NOT_APPROVED" };
    }
    return { allowed: true };
  }

  getAllApprovals() {
    return Array.from(this._approvals.entries()).map(([filePath, entry]) => ({
      filePath,
      ...entry,
    }));
  }

  revokeApproval(filePath) {
    return this._approvals.delete(filePath);
  }

  clearAllApprovals() {
    this._approvals.clear();
  }

  clearExpiredApprovals() {
    for (const [filePath, entry] of this._approvals) {
      if (entry.scope === "per-session" && entry.sessionId !== this.currentSessionId) {
        this._approvals.delete(filePath);
      } else if (entry.scope === "per-chat" && entry.chatId !== this.currentChatId) {
        this._approvals.delete(filePath);
      }
    }
  }
}

module.exports = FileApprovalManager;
