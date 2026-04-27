// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const http = require("http");
const https = require("https");
const { URL } = require("url");

const { getDecrypted, hasCredential, listCredentialKeys } = require("./secure-credentials");

const BIND_HOST = "127.0.0.1";
// Keep this distinct from RUNS_PORT (workflow runner SSE) to avoid EADDRINUSE.
const CONNECTOR_PORT = 11438;
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

// service → { base URL, credKey, auth scheme, extraHeaders? }
const SERVICES = {
  slack: {
    base: "https://slack.com/api",
    credKey: "slack_token",
    authHeader: (t) => ({ Authorization: `Bearer ${t}` }),
  },
  gmail: {
    base: "https://gmail.googleapis.com/gmail/v1",
    credKey: "gmail_token",
    authHeader: (t) => ({ Authorization: `Bearer ${t}` }),
  },
  gdrive: {
    base: "https://www.googleapis.com/drive/v3",
    credKey: "gdrive_token",
    authHeader: (t) => ({ Authorization: `Bearer ${t}` }),
  },
  notion: {
    base: "https://api.notion.com/v1",
    credKey: "notion_token",
    authHeader: (t) => ({ Authorization: `Bearer ${t}`, "Notion-Version": "2022-06-28" }),
  },
  github: {
    base: "https://api.github.com",
    credKey: "github_token",
    authHeader: (t) => ({ Authorization: `token ${t}`, Accept: "application/vnd.github+json" }),
  },
  onedrive: {
    base: "https://graph.microsoft.com/v1.0",
    credKey: "onedrive_token",
    authHeader: (t) => ({ Authorization: `Bearer ${t}` }),
  },
};

// Strip anything credential-shaped from outbound error strings.
const REDACT_PATTERNS = [
  /Bearer\s+\S+/gi,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /\b[A-Za-z0-9+/=]{40,}\b/g,
];

function sanitize(str) {
  if (typeof str !== "string") return str;
  let out = str;
  for (const re of REDACT_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

function isLoopback(req) {
  const a = req.socket?.remoteAddress || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Future extension point — user deferred action scoping/policies to a follow-up.
// TODO(follow-up): enforce per-service method allowlists, rate limits,
// and require user approval for sensitive actions (e.g., slack chat.postMessage,
// gmail send, drive delete). Today this is a no-op.
function checkPolicy(_service, _method, _body) {
  return { allowed: true };
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("body_too_large"), { code: "TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function forwardToService(service, method, body) {
  return new Promise((resolve, reject) => {
    let token;
    try {
      token = getDecrypted(service.credKey);
    } catch (e) {
      return reject(Object.assign(new Error("decrypt_failed"), { code: "DECRYPT_FAILED" }));
    }
    if (!token) {
      return reject(Object.assign(new Error("connector_not_configured"), { code: "NOT_CONFIGURED" }));
    }

    const target = new URL(`${service.base}/${method}`);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      ...service.authHeader(token),
    };

    const req = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method: "POST",
        headers,
      },
      (upstream) => {
        const chunks = [];
        upstream.on("data", (c) => chunks.push(c));
        upstream.on("end", () => {
          resolve({
            status: upstream.statusCode || 502,
            contentType: upstream.headers["content-type"] || "application/json",
            body: Buffer.concat(chunks),
          });
        });
        upstream.on("error", reject);
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function startConnectorProxy(onListening) {
  const server = http.createServer(async (req, res) => {
    if (!isLoopback(req)) {
      jsonResponse(res, 403, { error: "loopback_only" });
      return;
    }

    if (req.method === "GET" && req.url === "/api/connectors") {
      jsonResponse(res, 200, { configured: listCredentialKeys() });
      return;
    }

    // POST /api/<service>/<method...>
    const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
    if (req.method === "POST" && parts[0] === "api" && parts.length >= 3) {
      const serviceName = parts[1];
      const method = parts.slice(2).join("/");
      const service = SERVICES[serviceName];

      if (!service) {
        jsonResponse(res, 404, { error: "unknown_service", service: serviceName });
        return;
      }
      const ct = (req.headers["content-type"] || "").toLowerCase();
      if (!ct.includes("application/json")) {
        jsonResponse(res, 415, { error: "expected_json" });
        return;
      }
      if (!hasCredential(service.credKey)) {
        jsonResponse(res, 401, { error: "connector_not_configured", service: serviceName });
        return;
      }

      let body;
      try {
        body = await collectBody(req);
      } catch (e) {
        jsonResponse(res, e.code === "TOO_LARGE" ? 413 : 400, { error: "bad_body" });
        return;
      }

      let parsed = {};
      try {
        parsed = body.length ? JSON.parse(body.toString()) : {};
      } catch {
        jsonResponse(res, 400, { error: "invalid_json" });
        return;
      }

      const policy = checkPolicy(serviceName, method, parsed);
      if (!policy.allowed) {
        jsonResponse(res, 403, { error: "policy_denied", reason: sanitize(policy.reason || "") });
        return;
      }

      try {
        const upstream = await forwardToService(service, method, body.length ? body : Buffer.from("{}"));
        res.writeHead(upstream.status, { "Content-Type": upstream.contentType });
        res.end(upstream.body);
      } catch (e) {
        if (e.code === "NOT_CONFIGURED") {
          jsonResponse(res, 401, { error: "connector_not_configured", service: serviceName });
        } else if (e.code === "DECRYPT_FAILED") {
          jsonResponse(res, 500, { error: "credential_unreadable", service: serviceName });
        } else {
          console.warn(`[connector-proxy] upstream error for ${serviceName}: ${sanitize(e.message || "unknown")}`);
          jsonResponse(res, 502, { error: "upstream_failed", service: serviceName });
        }
      }
      return;
    }

    jsonResponse(res, 404, { error: "not_found" });
  });

  server.on("error", (err) => {
    console.error(`[connector-proxy] Server error: ${err.code || err.message}`);
  });

  server.listen(CONNECTOR_PORT, BIND_HOST, () => {
    console.log(`[connector-proxy] Listening on ${BIND_HOST}:${CONNECTOR_PORT}`);
    if (onListening) onListening();
  });

  return server;
}

module.exports = { startConnectorProxy, CONNECTOR_PORT };
