// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const os = require("os");

const UPDATE_SERVER = "https://cdn.example.com";
const MANIFEST_PATH = "/manifest.json";
const SIGNATURE_PATH = "/manifest.json.sig";

let _componentsDir = null;
let _manifestFile = null;

function getComponentsDir() {
  if (_componentsDir) return _componentsDir;
  const home = os.homedir();
  const base = process.env.NEMOCLAW_DIR || path.join(home, ".nemoclaw");
  _componentsDir = path.join(base, "components");
  return _componentsDir;
}

function getManifestFile() {
  if (_manifestFile) return _manifestFile;
  _manifestFile = path.join(getComponentsDir(), "manifest.json");
  return _manifestFile;
}

// ed25519 public key (raw 32 bytes, base64). Override with NEMOCLAW_UPDATE_PUBKEY for dev.
const BUNDLED_PUBLIC_KEY_B64 = process.env.NEMOCLAW_UPDATE_PUBKEY ||
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function pendingFile() { return path.join(getComponentsDir(), "pending.json"); }
function poisonFile()  { return path.join(getComponentsDir(), "poison.json"); }

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fallback; }
}
function writeJson(p, obj) {
  ensureComponentsDir();
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

function isPoisoned(version) {
  const p = readJson(poisonFile(), []);
  return p.some((e) => e.version === version);
}
function addPoison(version, reason) {
  const p = readJson(poisonFile(), []);
  if (!p.some((e) => e.version === version)) {
    p.push({ version, reason, ts: new Date().toISOString() });
    writeJson(poisonFile(), p);
  }
}

function ensureComponentsDir() {
  const dir = getComponentsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function readLocalManifest() {
  try {
    const mf = getManifestFile();
    if (fs.existsSync(mf)) {
      return JSON.parse(fs.readFileSync(mf, "utf-8"));
    }
  } catch {}
  return { version: "0.0.0", etag: "", components: [] };
}

function writeLocalManifest(manifest) {
  ensureComponentsDir();
  const mf = getManifestFile();
  fs.writeFileSync(mf, JSON.stringify(manifest, null, 2), { mode: 0o600 });
}

function computeContentHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function httpFetch(urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const proto = urlPath.startsWith("https") ? https : http;
    const url = new URL(urlPath);
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method || "GET",
      headers: options.headers || {},
    };

    const req = proto.request(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpFetch(res.headers.location, options));
      }
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function verifySignature(manifestBody, signatureB64) {
  if (process.env.NEMOCLAW_ALLOW_UNSIGNED === "1") return true;
  try {
    const raw = Buffer.from(BUNDLED_PUBLIC_KEY_B64, "base64");
    if (raw.length !== 32) throw new Error("Invalid ed25519 pubkey length");
    // DER prefix for Ed25519 SPKI: 302a300506032b6570032100 + raw32
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
    const key = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
    const sig = Buffer.from(signatureB64, "base64");
    return crypto.verify(null, Buffer.from(manifestBody), key, sig);
  } catch (e) {
    throw new Error(`Signature verification failed: ${e.message}`);
  }
}

function classifyManifest(local, remote) {
  if (remote.shellVersion && remote.shellVersion !== local.shellVersion) {
    return { severity: "critical", reason: "Electron binary changed" };
  }
  if (remote.pythonRuntimeHash && remote.pythonRuntimeHash !== local.pythonRuntimeHash) {
    return { severity: "critical", reason: "Python runtime changed" };
  }
  for (const pkg of remote.pythonPackages || []) {
    const lp = (local.pythonPackages || []).find((p) => p.name === pkg.name);
    if (lp) {
      const [lMajor] = lp.version.split(".").map(Number);
      const [rMajor] = pkg.version.split(".").map(Number);
      if (rMajor > lMajor) return { severity: "critical", reason: `Breaking dep: ${pkg.name}` };
    }
  }
  return { severity: "none" };
}

function classifyComponent(l, r) {
  l = l || {};
  if (r.serviceCodeHash && r.serviceCodeHash !== l.serviceCodeHash) {
    return { severity: "major", reason: "Service code changed" };
  }
  if (r.family && r.family !== l.family) {
    return { severity: "major", reason: "Model family changed" };
  }
  if (r.architectureHash && r.architectureHash !== l.architectureHash) {
    return { severity: "major", reason: "Architecture changed" };
  }
  if (r.tokenizerHash && r.tokenizerHash !== l.tokenizerHash) {
    return { severity: "major", reason: "Tokenizer changed" };
  }
  if (r.weightsHash && r.weightsHash !== l.weightsHash) {
    return { severity: "minor", reason: "Weights only" };
  }
  if (r.configHash && r.configHash !== l.configHash) {
    return { severity: "minor", reason: "Config changed" };
  }
  return { severity: "none" };
}

function classifySeverity(localComp, remoteComp) {
  return classifyComponent(localComp, remoteComp);
}

async function checkForUpdates() {
  const local = readLocalManifest();
  const localEtag = local.etag || "";

  let res;
  try {
    res = await httpFetch(`${UPDATE_SERVER}${MANIFEST_PATH}`, {
      method: "HEAD",
      headers: localEtag ? { "If-None-Match": localEtag } : {},
    });
  } catch (err) {
    return { error: err.message, available: false };
  }

  if (res.status === 304) {
    return { error: null, available: false, version: local.version, current: true };
  }

  if (res.status !== 200) {
    return { error: `Server returned ${res.status}`, available: false };
  }

  const remoteEtag = res.headers.etag || "";

  let manifestRes;
  try {
    manifestRes = await httpFetch(`${UPDATE_SERVER}${MANIFEST_PATH}`);
  } catch (err) {
    return { error: err.message, available: false };
  }

  const manifestBody = manifestRes.body;
  const contentHash = computeContentHash(manifestBody);

  let sigRes;
  try {
    sigRes = await httpFetch(`${UPDATE_SERVER}${SIGNATURE_PATH}`);
  } catch {
    return { error: "Missing signature", available: false };
  }

  const isValid = await verifySignature(manifestBody, sigRes.body.trim());
  if (!isValid) {
    return { error: "Invalid signature", available: false };
  }

  let remote;
  try {
    remote = JSON.parse(manifestBody);
  } catch {
    return { error: "Invalid manifest", available: false };
  }

  const changes = [];
  const rank = { none: 0, minor: 1, major: 2, critical: 3 };
  let maxSeverity = "none";
  const bump = (s) => { if (rank[s] > rank[maxSeverity]) maxSeverity = s; };

  const top = classifyManifest(local, remote);
  if (top.severity !== "none") {
    changes.push({ component: "__manifest__", severity: top.severity, reason: top.reason });
    bump(top.severity);
  }

  for (const remoteComp of remote.components || []) {
    const localComp = (local.components || []).find((c) => c.name === remoteComp.name);
    const { severity, reason } = classifyComponent(localComp, remoteComp);
    if (severity !== "none") {
      changes.push({ component: remoteComp.name, severity, reason, size: remoteComp.size });
      bump(severity);
    }
  }

  if (changes.length === 0) {
    return {
      error: null,
      available: false,
      version: remote.version,
      current: true,
    };
  }

  const totalSize = changes.reduce((sum, c) => sum + (c.size || 0), 0);

  if (isPoisoned(remote.version)) {
    return { error: null, available: false, version: local.version, current: true, poisoned: remote.version };
  }

  writeLocalManifest({ ...local, etag: remoteEtag });
  writeJson(pendingFile(), remote);

  return {
    error: null,
    available: true,
    version: remote.version,
    severity: maxSeverity,
    changes,
    totalSize,
    etag: remoteEtag,
  };
}

async function downloadToFile(url, destPath, expectedSha) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    proto
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Download ${url}: ${res.statusCode}`));
        }
        const ws = fs.createWriteStream(destPath);
        res.on("data", (c) => hash.update(c));
        res.pipe(ws);
        ws.on("finish", resolve);
        ws.on("error", reject);
        res.on("error", reject);
      })
      .on("error", reject);
  });
  const got = hash.digest("hex");
  if (expectedSha && got !== expectedSha) {
    try { fs.unlinkSync(destPath); } catch {}
    throw new Error(`Hash mismatch for ${url}: ${got} != ${expectedSha}`);
  }
}

async function applyUpdate(onProgress) {
  const local = readLocalManifest();
  const remote = readJson(pendingFile(), null);
  if (!remote) throw new Error("No pending update; run checkForUpdates first");

  ensureComponentsDir();
  const versionDir = path.join(getComponentsDir(), `v${remote.version}.staging`);
  fs.mkdirSync(versionDir, { recursive: true });

  try {
    const comps = remote.components || [];
    for (let i = 0; i < comps.length; i++) {
      const c = comps[i];
      if (!c.url) continue;
      const dest = path.join(versionDir, path.basename(new URL(c.url).pathname));
      await downloadToFile(c.url, dest, c.sha256 || c.weightsHash);
      onProgress?.({ done: i + 1, total: comps.length });
    }

    const finalDir = path.join(getComponentsDir(), `v${remote.version}`);
    try { fs.rmSync(finalDir, { recursive: true, force: true }); } catch {}
    fs.renameSync(versionDir, finalDir);

    const currentLink = path.join(getComponentsDir(), "current");
    const prevLink = path.join(getComponentsDir(), "previous");
    try {
      const old = fs.readlinkSync(currentLink);
      try { fs.unlinkSync(prevLink); } catch {}
      fs.symlinkSync(old, prevLink);
    } catch {}
    try { fs.unlinkSync(currentLink); } catch {}
    fs.symlinkSync(finalDir, currentLink);

    writeLocalManifest({ ...remote, etag: local.etag });
    try { fs.unlinkSync(pendingFile()); } catch {}
    pruneOldVersions(finalDir);
    return { version: remote.version, dir: finalDir };
  } catch (err) {
    try { fs.rmSync(versionDir, { recursive: true, force: true }); } catch {}
    throw err;
  }
}

function pruneOldVersions(keepDir) {
  const dir = getComponentsDir();
  const prevLink = path.join(dir, "previous");
  let keepPrev = null;
  try { keepPrev = fs.readlinkSync(prevLink); } catch {}
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith("v")) continue;
    const full = path.join(dir, name);
    if (full === keepDir || full === keepPrev) continue;
    try { fs.rmSync(full, { recursive: true, force: true }); } catch {}
  }
}

async function rollback() {
  const dir = getComponentsDir();
  const currentLink = path.join(dir, "current");
  const prevLink = path.join(dir, "previous");
  if (!fs.existsSync(prevLink)) throw new Error("No previous version");
  const prev = fs.readlinkSync(prevLink);
  try { fs.unlinkSync(currentLink); } catch {}
  fs.symlinkSync(prev, currentLink);
  return { rolledBackTo: prev };
}

function setUpdateAvailable(manifest) {
  writeLocalManifest(manifest);
}

function getCurrentVersion() {
  const local = readLocalManifest();
  return local.version || "0.0.0";
}

function canHotReload(severity) {
  return severity === "minor";
}

function shouldRestartService(severity) {
  return severity === "major";
}

function shouldRestartApp(severity) {
  return severity === "critical";
}

module.exports = {
  get COMPONENTS_DIR() {
    return getComponentsDir();
  },
  get MANIFEST_FILE() {
    return getManifestFile();
  },
  checkForUpdates,
  applyUpdate,
  rollback,
  addPoison,
  setUpdateAvailable,
  getCurrentVersion,
  canHotReload,
  shouldRestartService,
  shouldRestartApp,
  classifySeverity,
  _setPaths: (componentsDir, manifestFile) => {
    _componentsDir = componentsDir;
    _manifestFile = manifestFile;
  },
};
