// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const http = require('http');
const fs = require('fs');
const path = require('path');
const wfDb = require('./workflow-db');
const { withBookmarkAccess } = require('./bookmarks');

const RUNS_PORT = 11437;
const HOST = '127.0.0.1';
const PROXY_URL = 'http://127.0.0.1:11435';
const _subscribers = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const sub of _subscribers) {
    try { sub.res.write(payload); } catch {}
  }
}

function startRunsSSE() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.url === '/runs' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      const sub = { res };
      _subscribers.add(sub);
      const hb = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { clearInterval(hb); _subscribers.delete(sub); }
      }, 15000);
      req.on('close', () => { clearInterval(hb); _subscribers.delete(sub); });
      return;
    }
    res.writeHead(404); res.end();
  });
  server.on('error', (e) => console.error('[runs-sse]', e.message));
  server.listen(RUNS_PORT, HOST, () => console.log(`[runs-sse] Listening on ${HOST}:${RUNS_PORT}`));
  return server;
}

function renderTemplate(str, ctx) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (ctx[k] != null ? String(ctx[k]) : ''));
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'Authorization': 'Bearer auth-ollama-local' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        try { resolve(JSON.parse(text)); } catch { resolve({ raw: text }); }
      });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

async function execPrompt(step, ctx) {
  const prompt = renderTemplate(step.config?.prompt || '', ctx);
  const model = step.config?.model || 'gemma4:e4b';
  const resp = await postJson(`${PROXY_URL}/api/chat`, {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
  });
  const content = resp?.message?.content ?? resp?.choices?.[0]?.message?.content ?? '';
  return { output: content };
}

async function execTool(step, ctx) {
  const { op, path: p, content } = step.config || {};
  if (!op || !p) throw new Error('tool step requires { op, path }');
  const abs = path.resolve(p);
  // All fs ops must go through withBookmarkAccess — it validates the path is
  // inside a mounted folder and brackets the op with
  // start/stopAccessingSecurityScopedResource. Raw fs.* calls here would be
  // denied by the macOS sandbox with EPERM.
  if (op === 'read') {
    const output = await withBookmarkAccess(abs, () => fs.promises.readFile(abs, 'utf8'));
    return { output };
  }
  if (op === 'write') {
    await withBookmarkAccess(abs, async () => {
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, renderTemplate(content || '', ctx), 'utf8');
    });
    return { output: `wrote ${abs}` };
  }
  if (op === 'edit') {
    const { find, replace } = step.config;
    const output = await withBookmarkAccess(abs, async () => {
      const cur = await fs.promises.readFile(abs, 'utf8');
      if (!cur.includes(find)) throw new Error(`edit: find-string not found in ${abs}`);
      await fs.promises.writeFile(abs, cur.replace(find, renderTemplate(replace || '', ctx)), 'utf8');
      return `edited ${abs}`;
    });
    return { output };
  }
  throw new Error(`unknown tool op: ${op}`);
}

function execBranch(step, ctx) {
  const needle = step.config?.contains ?? '';
  const last = ctx.lastOutput || '';
  const matched = typeof last === 'string' && last.includes(needle);
  return { output: matched ? 'branch:then' : 'branch:continue', jumpOrdinal: matched ? step.config?.then_ordinal : null };
}

function execWait(step) {
  const ms = Math.max(0, step.config?.ms | 0);
  return new Promise((r) => setTimeout(() => r({ output: `waited ${ms}ms` }), ms));
}

async function runWorkflow(workflowId) {
  const wf = wfDb.getWorkflow(workflowId);
  if (!wf) throw new Error(`workflow ${workflowId} not found`);
  const run = wfDb.createRun(workflowId);
  broadcast('run.started', { runId: run.id, workflowId });

  const ctx = { lastOutput: '' };
  const steps = wf.steps || [];
  let i = 0;
  let finalStatus = 'success';

  try {
    while (i < steps.length) {
      const step = steps[i];
      wfDb.appendRunStepLog(run.id, step.id, { status: 'running' });
      broadcast('run.step.started', { runId: run.id, stepId: step.id, ordinal: step.ordinal, kind: step.kind });
      try {
        let result;
        if (step.kind === 'prompt') result = await execPrompt(step, ctx);
        else if (step.kind === 'tool') result = await execTool(step, ctx);
        else if (step.kind === 'branch') result = execBranch(step, ctx);
        else if (step.kind === 'wait') result = await execWait(step);
        else throw new Error(`unknown step kind: ${step.kind}`);

        ctx.lastOutput = result.output;
        wfDb.appendRunStepLog(run.id, step.id, { status: 'success', log: String(result.output ?? '').slice(0, 4000), finish: true });
        broadcast('run.step.finished', { runId: run.id, stepId: step.id, status: 'success', output: result.output });

        if (step.kind === 'branch' && result.jumpOrdinal != null) {
          const target = steps.findIndex((s) => s.ordinal === result.jumpOrdinal);
          if (target >= 0) { i = target; continue; }
        }
        i += 1;
      } catch (err) {
        wfDb.appendRunStepLog(run.id, step.id, { status: 'failed', log: String(err.message || err), finish: true });
        broadcast('run.step.finished', { runId: run.id, stepId: step.id, status: 'failed', error: String(err.message || err) });
        finalStatus = 'failed';
        break;
      }
    }
  } finally {
    wfDb.updateRunStatus(run.id, finalStatus, ctx.lastOutput);
    broadcast('run.finished', { runId: run.id, workflowId, status: finalStatus });
  }
  return { runId: run.id, status: finalStatus };
}

module.exports = { runWorkflow, startRunsSSE, RUNS_PORT };
