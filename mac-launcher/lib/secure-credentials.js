// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const path = require("path");
const os = require("os");
const { safeStorage } = require("electron");

const NEMOCLAW_DIR = path.join(os.homedir(), ".nemoclaw");
const CRED_PATH = path.join(NEMOCLAW_DIR, "credentials.json");
const CRED_VERSION = 1;

// Keys the renderer UI should never see — internal plumbing only.
const HIDDEN_KEYS = new Set(["OPENAI_API_KEY"]);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function writeSecure(filePath, data) {
  const content = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const tmp = filePath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function isAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function emptySkeleton() {
  return { _version: CRED_VERSION, entries: {} };
}

function readCredentials() {
  try {
    const raw = fs.readFileSync(CRED_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptySkeleton();
    if (!parsed.entries || typeof parsed.entries !== "object") {
      return emptySkeleton();
    }
    if (!parsed._version) parsed._version = CRED_VERSION;
    return parsed;
  } catch {
    return emptySkeleton();
  }
}

function encryptString(plaintext) {
  const buf = safeStorage.encryptString(plaintext);
  return buf.toString("base64");
}

function decryptString(b64) {
  return safeStorage.decryptString(Buffer.from(b64, "base64"));
}

function writeCredential(key, value) {
  if (typeof key !== "string" || !key) {
    const err = new Error("invalid_key");
    err.code = "INVALID_KEY";
    throw err;
  }
  if (typeof value !== "string") {
    const err = new Error("invalid_value_type");
    err.code = "INVALID_VALUE";
    err.key = key;
    throw err;
  }
  ensureDir(NEMOCLAW_DIR);
  const store = readCredentials();
  try {
    if (isAvailable()) {
      store.entries[key] = { value: encryptString(value), _encrypted: true };
    } else {
      store.entries[key] = { value, _encrypted: false };
    }
  } catch (e) {
    const err = new Error("encrypt_failed");
    err.code = "ENCRYPT_FAILED";
    err.key = key;
    console.warn(`[secure-credentials] encrypt failed for key=${key}`);
    throw err;
  }
  writeSecure(CRED_PATH, store);
}

function deleteCredential(key) {
  const store = readCredentials();
  if (key in store.entries) {
    delete store.entries[key];
    writeSecure(CRED_PATH, store);
  }
}

function hasCredential(key) {
  const store = readCredentials();
  return Object.prototype.hasOwnProperty.call(store.entries, key);
}

function listCredentialKeys() {
  const store = readCredentials();
  return Object.keys(store.entries).filter((k) => !HIDDEN_KEYS.has(k));
}

function decryptEntry(entry) {
  if (!entry) return null;
  if (entry._encrypted) {
    try {
      return decryptString(entry.value);
    } catch (e) {
      const err = new Error("decrypt_failed");
      err.code = "DECRYPT_FAILED";
      console.warn("[secure-credentials] decrypt failed");
      throw err;
    }
  }
  return entry.value;
}

function getDecrypted(key) {
  const store = readCredentials();
  const entry = store.entries[key];
  if (!entry) return null;
  try {
    return decryptEntry(entry);
  } catch (e) {
    e.key = key;
    throw e;
  }
}

function migrateToEncrypted() {
  if (!isAvailable()) return { migrated: 0, skipped: "unavailable" };
  const store = readCredentials();
  let migrated = 0;
  for (const [key, entry] of Object.entries(store.entries)) {
    if (entry && entry._encrypted === false && typeof entry.value === "string") {
      // Skip the placeholder Ollama key — no point encrypting "ollama".
      if (key === "OPENAI_API_KEY" && entry.value === "ollama") continue;
      try {
        store.entries[key] = { value: encryptString(entry.value), _encrypted: true };
        migrated += 1;
      } catch {
        console.warn(`[secure-credentials] migration failed for key=${key}`);
      }
    }
  }
  if (migrated > 0) writeSecure(CRED_PATH, store);
  return { migrated };
}

module.exports = {
  isAvailable,
  readCredentials,
  writeCredential,
  deleteCredential,
  hasCredential,
  listCredentialKeys,
  decryptEntry,
  getDecrypted,
  migrateToEncrypted,
  CRED_PATH,
  CRED_VERSION,
};
