// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const os = require("os");

const MANIFEST_PATH = "/manifest.json";
const SIGNATURE_PATH = "/manifest.json.sig";
const UPDATE_SERVER =
  process.env.NEMOCLAW_UPDATE_URL ||
  "https://github.com/codeacioustech/NemoClaw/releases/latest/download";

const BUNDLED_PUBLIC_KEY_B64 =
  process.env.NEMOCLAW_UPDATE_PUBKEY ||
  "ntziBjll2bKiCB0iCf/sft8CGz8Ve2m8eyEFtCPdU/g=";

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

async function httpFetch(urlPath, options = {}) {
  options = options || {};
  if (urlPath.startsWith("file://") || urlPath.startsWith("/")) {
    const filePath = urlPath.replace(/^file:\/\//, "");
    try {
      const body = fs.readFileSync(filePath, "utf-8");
      return { status: 200, headers: { etag: "" }, body };
    } catch {
      return { status: 404, headers: {}, body: "" };
    }
  }
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
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
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
      if (rMajor > lMajor) return { severity: "critical", reason: "Breaking dep: " + pkg.name };
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
    if (!r.serviceCodeHash && !r.architectureHash && !r.tokenizerHash) {
      return { severity: "minor", reason: "Weights only" };
    }
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
  let serverUrl = UPDATE_SERVER;

  // If URL already contains manifest.json, use it directly
  if (serverUrl.includes("manifest.json")) {
    serverUrl = serverUrl.replace(/^file:\/\//, "");
    return checkFromFilePath(serverUrl, readLocalManifest());
  }

  // Otherwise check if it's file:// prefix
  if (serverUrl.startsWith("file://")) {
    const filePath = serverUrl.replace("file://", "") + MANIFEST_PATH;
    return checkFromFilePath(filePath, readLocalManifest());
  }

  // HTTP/S URL
  return checkFromUrl(serverUrl + MANIFEST_PATH, readLocalManifest());
}

async function checkFromFilePath(manifestPath, local) {
  let manifestRes;
  try {
    manifestRes = await httpFetch(manifestPath);
  } catch (err) {
    return { error: err.message, available: false };
  }

  if (manifestRes.status !== 200) {
    return { error: "Server returned " + manifestRes.status, available: false };
  }

  const manifestBody = manifestRes.body;
  // const basePath = manifestPath.replace("/manifest.json", "");

  // ── SIGNATURE VERIFICATION TEMPORARILY DISABLED ─────────────────────────
  // To re-enable: uncomment the block below and the basePath line above.
  // let sigRes;
  // try {
  //   sigRes = await httpFetch(basePath + "/manifest.json.sig");
  // } catch {
  //   return { error: "Missing signature", available: false };
  // }
  // const isValid = await verifySignature(manifestBody, sigRes.body.trim());
  // if (!isValid) {
  //   return { error: "Invalid signature", available: false };
  // }
  // ────────────────────────────────────────────────────────────────────────

  let remote;
  try {
    remote = JSON.parse(manifestBody);
  } catch {
    return { error: "Invalid manifest", available: false };
  }

  return computeUpdateResult(local, remote, { status: 200, headers: { etag: "" } });
}

async function checkFromUrl(manifestUrl, local) {
  let res;
  try {
    res = await httpFetch(manifestUrl, { method: "HEAD" });
  } catch (err) {
    return { error: err.message, available: false };
  }

  if (res.status === 304) {
    return { error: null, available: false, version: local.version, current: true };
  }
  if (res.status !== 200) {
    return { error: "Server returned " + res.status, available: false };
  }

  let manifestRes;
  try {
    manifestRes = await httpFetch(manifestUrl);
  } catch (err) {
    return { error: err.message, available: false };
  }

  const manifestBody = manifestRes.body;

  // ── SIGNATURE VERIFICATION TEMPORARILY DISABLED ─────────────────────────
  // To re-enable: uncomment the block below.
  // const sigUrl = manifestUrl.replace(MANIFEST_PATH, SIGNATURE_PATH);
  // let sigRes;
  // try {
  //   sigRes = await httpFetch(sigUrl);
  // } catch {
  //   return { error: "Missing signature", available: false };
  // }
  // const isValid = await verifySignature(manifestBody, sigRes.body.trim());
  // if (!isValid) {
  //   return { error: "Invalid signature", available: false };
  // }
  // ────────────────────────────────────────────────────────────────────────

  let remote;
  try {
    remote = JSON.parse(manifestBody);
  } catch {
    return { error: "Invalid manifest", available: false };
  }

  return computeUpdateResult(local, remote, res);
}

function computeUpdateResult(local, remote, res) {
  const changes = [];
  const rank = { none: 0, minor: 1, major: 2, critical: 3 };
  let maxSeverity = "none";
  const bump = (s) => {
    if (rank[s] > rank[maxSeverity]) maxSeverity = s;
  };

  const top = classifyManifest(local, remote);
  if (top.severity !== "none") {
    changes.push({ component: "__manifest__", severity: top.severity, reason: top.reason });
    bump(top.severity);
  }

  // Fallback: any newer version counts as at least a minor update, even when
  // no component-level fields differ. Ensures releases with plain artifacts
  // (e.g. dev-mode readme-only builds) are still detected.
  if (remote.version && local.version && remote.version !== local.version) {
    const r = remote.version.split(".").map(Number);
    const l = local.version.split(".").map(Number);
    const isNewer =
      r[0] > l[0] ||
      (r[0] === l[0] && r[1] > l[1]) ||
      (r[0] === l[0] && r[1] === l[1] && r[2] > l[2]);
    if (isNewer) {
      changes.push({
        component: "__version__",
        severity: "minor",
        reason: `Version ${local.version} → ${remote.version}`,
      });
      bump("minor");
    }
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
    return { error: null, available: false, version: remote.version, current: true };
  }

  if (isPoisoned(remote.version)) {
    return { error: null, available: false, version: local.version, current: true, poisoned: remote.version };
  }

  const totalSize = changes.reduce((sum, c) => sum + (c.size || 0), 0);

  // Persist: ETag into local manifest, full remote manifest into pending.json
  // so applyUpdate() can find it on the next click.
  writeLocalManifest({ ...local, etag: res.headers.etag || "" });
  writeJson(pendingFile(), remote);

  return {
    error: null,
    available: true,
    version: remote.version,
    severity: maxSeverity,
    changes,
    totalSize,
    etag: res.headers.etag || "",
  };
}

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
  return readJson(poisonFile(), []).some((e) => e.version === version);
}
function addPoison(version, reason) {
  const p = readJson(poisonFile(), []);
  if (!p.some((e) => e.version === version)) {
    p.push({ version, reason, ts: new Date().toISOString() });
    writeJson(poisonFile(), p);
  }
}

async function downloadToFile(url, destPath, expectedSha) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    proto.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadToFile(res.headers.location, destPath, expectedSha).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download ${url}: HTTP ${res.statusCode}`));
      }
      const ws = fs.createWriteStream(destPath);
      res.on("data", (c) => hash.update(c));
      res.pipe(ws);
      ws.on("finish", resolve);
      ws.on("error", reject);
      res.on("error", reject);
    }).on("error", reject);
  });
  if (expectedSha) {
    const got = hash.digest("hex");
    if (got !== expectedSha) {
      try { fs.unlinkSync(destPath); } catch {}
      throw new Error(`Hash mismatch for ${url}: ${got} != ${expectedSha}`);
    }
  }
}

async function applyUpdate(onProgress) {
  const local = readLocalManifest();
  const remote = readJson(pendingFile(), null);
  if (!remote) throw new Error("No pending update; run checkForUpdates first");

  ensureComponentsDir();
  const stagingDir = path.join(getComponentsDir(), `v${remote.version}.staging`);
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    const comps = remote.components || [];
    for (let i = 0; i < comps.length; i++) {
      const c = comps[i];
      if (!c.url) continue;
      const dest = path.join(stagingDir, path.basename(new URL(c.url).pathname));
      await downloadToFile(c.url, dest, c.sha256 || c.weightsHash);
      onProgress?.({ done: i + 1, total: comps.length });
    }

    const finalDir = path.join(getComponentsDir(), `v${remote.version}`);
    try { fs.rmSync(finalDir, { recursive: true, force: true }); } catch {}
    fs.renameSync(stagingDir, finalDir);

    const currentLink = path.join(getComponentsDir(), "current");
    const prevLink    = path.join(getComponentsDir(), "previous");
    try {
      const old = fs.readlinkSync(currentLink);
      try { fs.unlinkSync(prevLink); } catch {}
      fs.symlinkSync(old, prevLink);
    } catch {}
    try { fs.unlinkSync(currentLink); } catch {}
    fs.symlinkSync(finalDir, currentLink);

    writeLocalManifest({ ...remote, etag: local.etag });
    try { fs.unlinkSync(pendingFile()); } catch {}
    return { version: remote.version, dir: finalDir };
  } catch (err) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    throw err;
  }
}

async function rollback() {
  const dir = getComponentsDir();
  const currentLink = path.join(dir, "current");
  const prevLink    = path.join(dir, "previous");
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
  return readLocalManifest().version || "0.0.0";
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
  httpFetch,
  classifyComponent,
  readLocalManifest,
};
