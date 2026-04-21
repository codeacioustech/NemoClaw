// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Shared helper for security-scoped bookmark resolution. Any fs op in main
// that touches a user-mounted folder MUST go through withBookmarkAccess —
// otherwise the macOS sandbox denies it with EPERM.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { app } = require("electron");

const LAUNCHER_CONFIG = path.join(os.homedir(), ".nemoclaw", "launcher_config.json");

function readLauncherConfig() {
  try {
    return JSON.parse(fs.readFileSync(LAUNCHER_CONFIG, "utf-8"));
  } catch {
    return {};
  }
}

async function getMountedFolderForPath(resolvedPath) {
  const folders = readLauncherConfig().mountedFolders || [];
  for (const folder of folders) {
    if (folder.stale) continue;
    let root;
    try {
      root = await fs.promises.realpath(folder.path);
    } catch {
      root = path.resolve(folder.path);
    }
    if (resolvedPath === root || resolvedPath.startsWith(root + path.sep)) {
      return folder;
    }
  }
  return null;
}

async function findAnyMountedFolderForPath(resolvedPath) {
  const folders = readLauncherConfig().mountedFolders || [];
  for (const folder of folders) {
    let root;
    try { root = await fs.promises.realpath(folder.path); }
    catch { root = path.resolve(folder.path); }
    if (resolvedPath === root || resolvedPath.startsWith(root + path.sep)) {
      return folder;
    }
  }
  return null;
}

async function validatePathInMountedFolders(filePath) {
  if (typeof filePath !== "string" || !filePath) throw new Error("Path required");
  if (!path.isAbsolute(filePath)) throw new Error(`Absolute path required: ${filePath}`);
  if (filePath.includes("..")) throw new Error("Path traversal not allowed");
  let resolved;
  try {
    resolved = await fs.promises.realpath(filePath);
  } catch {
    try {
      const parentDir = await fs.promises.realpath(path.dirname(filePath));
      resolved = path.join(parentDir, path.basename(filePath));
    } catch {
      resolved = path.resolve(filePath);
    }
  }
  const folder = await getMountedFolderForPath(resolved);
  if (!folder) {
    const stale = await findAnyMountedFolderForPath(resolved);
    const mounts = (readLauncherConfig().mountedFolders || []).map((f) => f.path);
    console.warn(`[bookmarks] DENY ${filePath} (resolved=${resolved}) mounts=${JSON.stringify(mounts)}`);
    if (stale && stale.stale) {
      throw new Error(`Mounted folder is stale; re-authorize before reading: ${stale.path}`);
    }
    throw new Error(`Path is not within a mounted folder: ${filePath}`);
  }
  console.log(`[bookmarks] ALLOW ${filePath} via mount=${folder.path}`);
  return folder;
}

// Tracks currently-held stopAccess callbacks, keyed by folder path, so
// unmount can release them explicitly rather than waiting for process exit.
const _liveHandles = new Map();

function _addHandle(folderPath, stopAccess) {
  if (!_liveHandles.has(folderPath)) _liveHandles.set(folderPath, new Set());
  _liveHandles.get(folderPath).add(stopAccess);
}
function _removeHandle(folderPath, stopAccess) {
  const set = _liveHandles.get(folderPath);
  if (set) { set.delete(stopAccess); if (!set.size) _liveHandles.delete(folderPath); }
}

async function withBookmarkAccess(filePath, fn) {
  const folder = await validatePathInMountedFolders(filePath);
  let stopAccess = null;
  if (folder.bookmark) {
    stopAccess = app.startAccessingSecurityScopedResource(folder.bookmark);
    if (stopAccess) _addHandle(folder.path, stopAccess);
  }
  try {
    return await fn();
  } finally {
    if (stopAccess) {
      try { stopAccess(); } catch {}
      _removeHandle(folder.path, stopAccess);
    }
  }
}

function releaseHandlesForPath(folderPath) {
  const set = _liveHandles.get(folderPath);
  if (!set) return 0;
  let n = 0;
  for (const stopAccess of set) {
    try { stopAccess(); n += 1; } catch {}
  }
  _liveHandles.delete(folderPath);
  return n;
}

function hasLiveHandles(folderPath) {
  const set = _liveHandles.get(folderPath);
  return !!(set && set.size);
}

// Probe each persisted bookmark. If startAccessing returns null, the OS has
// dropped it (folder moved, disk unmounted, macOS major update) and we mark
// the entry stale so the UI can offer a Re-authorize button.
function validateMountedFoldersAtBoot() {
  const cfg = readLauncherConfig();
  const folders = cfg.mountedFolders || [];
  for (const f of folders) {
    if (!f.bookmark) { f.stale = true; continue; }
    try {
      const stop = app.startAccessingSecurityScopedResource(f.bookmark);
      if (!stop) { f.stale = true; continue; }
      try { stop(); } catch {}
      delete f.stale;
    } catch {
      f.stale = true;
    }
  }
  cfg.mountedFolders = folders;
  try {
    const fsSync = require("fs");
    fsSync.writeFileSync(LAUNCHER_CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  } catch {}
  return folders.map((f) => ({ path: f.path, addedAt: f.addedAt, stale: !!f.stale }));
}

// Renderer-safe listing: strips the raw bookmark bytes.
function listMountedFoldersPublic() {
  return (readLauncherConfig().mountedFolders || []).map((f) => ({
    path: f.path,
    addedAt: f.addedAt,
    stale: !!f.stale,
  }));
}

module.exports = {
  readLauncherConfig,
  getMountedFolderForPath,
  validatePathInMountedFolders,
  withBookmarkAccess,
  releaseHandlesForPath,
  hasLiveHandles,
  validateMountedFoldersAtBoot,
  listMountedFoldersPublic,
  LAUNCHER_CONFIG,
};
