// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit logging for file access decisions.
 *
 * Writes append-only JSONL to ~/.nemoclaw/audit/file-access.log
 * One JSON object per line. Easy to grep, ship to SIEM, or review.
 */

import fs from "node:fs";
import path from "node:path";

const AUDIT_DIR = path.join(process.env.HOME || "/tmp", ".nemoclaw", "audit");
const AUDIT_FILE = path.join(AUDIT_DIR, "file-access.log");

export interface AuditEntry {
  timestamp?: string;
  sandbox: string;
  action: "grant" | "deny" | "revoke" | "check" | "blocked";
  path: string;
  permissions?: string; // "r", "rw", "rwx"
  scope?: string; // "session" or "persistent"
  reason?: string;
  grantedBy?: string;
  result?: string; // "allowed" or "denied"
}

/** Append an audit entry as JSONL. */
export function audit(entry: AuditEntry): void {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true, mode: 0o700 });

    const enriched = {
      timestamp: entry.timestamp || new Date().toISOString(),
      ...entry,
    };

    const line = JSON.stringify(enriched);
    fs.appendFileSync(AUDIT_FILE, line + "\n", { mode: 0o600 });
  } catch {
    // Fail silently on audit errors — don't break the permission flow
  }
}
