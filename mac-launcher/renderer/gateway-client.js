// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenClaw Gateway WebSocket client.
 * Protocol v3 — JSON RPC over WebSocket.
 */

class GatewayClient {
  constructor() {
    this._ws = null;
    this._port = null;
    this._connected = false;
    this._pendingRequests = new Map();
    this._listeners = new Map();
    this._reconnectTimer = null;
    this._reconnectDelay = 1000;
    this._sessionKey = null;
  }

  // --- Event emitter ---

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(fn);
    return this;
  }

  off(event, fn) {
    const fns = this._listeners.get(event);
    if (fns) this._listeners.set(event, fns.filter((f) => f !== fn));
    return this;
  }

  _emit(event, data) {
    const fns = this._listeners.get(event) || [];
    for (const fn of fns) {
      try { fn(data); } catch (e) { console.error(`[gw] listener error (${event}):`, e); }
    }
  }

  // --- Connection ---

  async connect(port) {
    this._port = port;
    return new Promise((resolve, reject) => {
      this._doConnect(resolve, reject);
    });
  }

  _doConnect(resolve, reject) {
    if (this._ws) {
      try { this._ws.close(); } catch {}
    }

    const url = `ws://127.0.0.1:${this._port}`;
    this._ws = new WebSocket(url);

    let handshakeDone = false;

    this._ws.onopen = () => {
      this._reconnectDelay = 1000;
    };

    this._ws.onmessage = (evt) => {
      let frame;
      try { frame = JSON.parse(evt.data); } catch { return; }

      // Handshake: wait for connect.challenge, then send connect request
      if (!handshakeDone && frame.type === "event" && frame.event === "connect.challenge") {
        const nonce = frame.payload?.nonce;
        this._sendConnectRequest(nonce);
        return;
      }

      // Handshake response
      if (!handshakeDone && frame.type === "res") {
        if (frame.ok) {
          handshakeDone = true;
          this._connected = true;
          this._emit("connected", frame.payload);
          if (resolve) { resolve(); resolve = null; }
        } else {
          const err = new Error(frame.error?.message || "Connect failed");
          this._emit("error", err);
          if (reject) { reject(err); reject = null; }
        }
        return;
      }

      // Response to a pending request
      if (frame.type === "res" && frame.id) {
        const pending = this._pendingRequests.get(frame.id);
        if (pending) {
          this._pendingRequests.delete(frame.id);
          if (frame.ok) pending.resolve(frame.payload);
          else pending.reject(new Error(frame.error?.message || "Request failed"));
        }
        return;
      }

      // Tool invocation from gateway
      if (frame.type === "event" && frame.event === "tool.invoke") {
        this._emit("tool.invoke", frame.payload);
        return;
      }

      // Streaming event
      if (frame.type === "event") {
        this._emit("event", frame);
        this._emit(frame.event, frame.payload);
      }
    };

    this._ws.onclose = () => {
      const wasConnected = this._connected;
      this._connected = false;
      this._emit("disconnected");

      // Reject all pending requests
      for (const [, pending] of this._pendingRequests) {
        pending.reject(new Error("WebSocket closed"));
      }
      this._pendingRequests.clear();

      if (wasConnected || handshakeDone) {
        this._scheduleReconnect();
      }
    };

    this._ws.onerror = (err) => {
      this._emit("error", err);
      if (!handshakeDone && reject) {
        reject(new Error("WebSocket connection failed"));
        reject = null;
      }
    };
  }

  _sendConnectRequest(_nonce) {
    const req = {
      type: "req",
      id: crypto.randomUUID(),
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "openclaw-control-ui",
          version: "0.1.0",
          platform: "electron",
          mode: "ui",
          displayName: "NemoClaw Desktop",
        },
        role: "operator",
        scopes: ["operator.read", "operator.write", "operator.admin"],
        caps: ["tool-use"],
        commands: ["read", "write", "edit", "terminal"],
        permissions: {},
        auth: {},
        locale: "en-US",
        userAgent: "nemoclaw-mac-launcher/0.1.0",
        // device omitted: gateway runs with dangerouslyDisableDeviceAuth=true,
        // and the device subschema requires a full signed bundle (id, publicKey,
        // signature, signedAt, nonce) if present at all. Sending a partial
        // device triggers schema rejection.
      },
    };
    this._ws.send(JSON.stringify(req));
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._doConnect(
        () => {},
        () => this._scheduleReconnect()
      );
    }, this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 1.5, 10000);
  }

  disconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._connected = false;
  }

  get connected() { return this._connected; }

  // --- Request/Response ---

  async request(method, params = {}) {
    if (!this._connected) throw new Error("Not connected to gateway");

    const id = crypto.randomUUID();
    const frame = { type: "req", id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, 30000);

      this._pendingRequests.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });

      this._ws.send(JSON.stringify(frame));
    });
  }

  // --- Session API ---

  async listSessions() {
    const res = await this.request("sessions.list", { limit: 50 });
    return res.sessions || [];
  }

  async createSession(label) {
    const key = "dashboard-" + crypto.randomUUID().slice(0, 12);
    const res = await this.request("sessions.create", {
      key,
      agentId: "default",
      label: label || "New Chat",
    });
    return res;
  }

  async deleteSession(key) {
    return this.request("sessions.delete", {
      key,
      deleteTranscript: true,
      emitLifecycleHooks: true,
    });
  }

  async getHistory(sessionKey) {
    return this.request("chat.history", { sessionKey });
  }

  // --- Chat API ---

  async sendMessage(sessionKey, message) {
    const idempotencyKey = crypto.randomUUID();
    return this.request("chat.send", {
      sessionKey,
      message,
      idempotencyKey,
    });
  }

  async sendToolResult(sessionKey, toolCallId, result) {
    return this.request("chat.toolResult", {
      sessionKey,
      toolCallId,
      result,
    });
  }
}

// Singleton
const gateway = new GatewayClient();
