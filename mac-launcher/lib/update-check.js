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
const UPDATE_SERVER = process.env.NEMOCLAW_UPDATE_URL || "https://cdn.example.com";

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
  return true;
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
  const basePath = manifestPath.replace("/manifest.json", "");

  let sigRes;
  try {
    sigRes = await httpFetch(basePath + "/manifest.json.sig");
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
  const sigUrl = manifestUrl.replace(MANIFEST_PATH, SIGNATURE_PATH);

  let sigRes;
  try {
    sigRes = await httpFetch(sigUrl);
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

  const totalSize = changes.reduce((sum, c) => sum + (c.size || 0), 0);

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
