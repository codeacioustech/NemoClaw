// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const Database = require('better-sqlite3');
const { app } = require('electron');
const crypto = require('crypto');
const path = require('path');

let db = null;

function initDb() {
  if (db) return db;
  const dbPath = path.join(app.getPath('userData'), 'chat_history.db');
  db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      trigger_kind TEXT DEFAULT 'manual',
      trigger_config TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS workflow_steps (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL,
      config TEXT,
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME,
      output TEXT,
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS workflow_run_steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT,
      status TEXT DEFAULT 'pending',
      started_at DATETIME,
      finished_at DATETIME,
      log TEXT,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
    );
  `);
  return db;
}

const j = (v) => (v == null ? null : JSON.stringify(v));
const p = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };

function createWorkflow({ name, description = '', trigger_kind = 'manual', trigger_config = null } = {}) {
  initDb();
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO workflows (id, name, description, trigger_kind, trigger_config) VALUES (?, ?, ?, ?, ?)`)
    .run(id, name || 'Untitled Workflow', description, trigger_kind, j(trigger_config));
  return getWorkflow(id);
}

function listWorkflows() {
  initDb();
  return db.prepare(`SELECT * FROM workflows ORDER BY updated_at DESC`).all()
    .map((w) => ({ ...w, trigger_config: p(w.trigger_config) }));
}

function getWorkflow(id) {
  initDb();
  const wf = db.prepare(`SELECT * FROM workflows WHERE id = ?`).get(id);
  if (!wf) return null;
  const steps = db.prepare(`SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY ordinal ASC`).all(id)
    .map((s) => ({ ...s, config: p(s.config) }));
  return { ...wf, trigger_config: p(wf.trigger_config), steps };
}

function updateWorkflow(id, patch = {}) {
  initDb();
  const cur = db.prepare(`SELECT * FROM workflows WHERE id = ?`).get(id);
  if (!cur) return null;
  const next = {
    name: patch.name ?? cur.name,
    description: patch.description ?? cur.description,
    trigger_kind: patch.trigger_kind ?? cur.trigger_kind,
    trigger_config: 'trigger_config' in patch ? j(patch.trigger_config) : cur.trigger_config,
  };
  db.prepare(`UPDATE workflows SET name=?, description=?, trigger_kind=?, trigger_config=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(next.name, next.description, next.trigger_kind, next.trigger_config, id);
  return getWorkflow(id);
}

function deleteWorkflow(id) {
  initDb();
  db.prepare(`DELETE FROM workflows WHERE id = ?`).run(id);
  return { id };
}

function addStep(workflowId, { kind, config = null, ordinal = null } = {}) {
  initDb();
  const id = crypto.randomUUID();
  const ord = ordinal != null
    ? ordinal
    : (db.prepare(`SELECT COALESCE(MAX(ordinal), -1) AS m FROM workflow_steps WHERE workflow_id = ?`).get(workflowId).m + 1);
  db.prepare(`INSERT INTO workflow_steps (id, workflow_id, ordinal, kind, config) VALUES (?, ?, ?, ?, ?)`)
    .run(id, workflowId, ord, kind, j(config));
  db.prepare(`UPDATE workflows SET updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(workflowId);
  const s = db.prepare(`SELECT * FROM workflow_steps WHERE id=?`).get(id);
  return { ...s, config: p(s.config) };
}

function updateStep(id, patch = {}) {
  initDb();
  const cur = db.prepare(`SELECT * FROM workflow_steps WHERE id=?`).get(id);
  if (!cur) return null;
  const next = {
    kind: patch.kind ?? cur.kind,
    config: 'config' in patch ? j(patch.config) : cur.config,
    ordinal: patch.ordinal ?? cur.ordinal,
  };
  db.prepare(`UPDATE workflow_steps SET kind=?, config=?, ordinal=? WHERE id=?`)
    .run(next.kind, next.config, next.ordinal, id);
  const s = db.prepare(`SELECT * FROM workflow_steps WHERE id=?`).get(id);
  return { ...s, config: p(s.config) };
}

function deleteStep(id) {
  initDb();
  db.prepare(`DELETE FROM workflow_steps WHERE id=?`).run(id);
  return { id };
}

function reorderSteps(workflowId, orderedIds = []) {
  initDb();
  const tx = db.transaction((ids) => {
    ids.forEach((sid, i) => {
      db.prepare(`UPDATE workflow_steps SET ordinal=? WHERE id=? AND workflow_id=?`).run(i, sid, workflowId);
    });
  });
  tx(orderedIds);
  return getWorkflow(workflowId);
}

function createRun(workflowId) {
  initDb();
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO workflow_runs (id, workflow_id, status) VALUES (?, ?, 'running')`).run(id, workflowId);
  return { id, workflow_id: workflowId, status: 'running' };
}

function updateRunStatus(runId, status, output = null) {
  initDb();
  db.prepare(`UPDATE workflow_runs SET status=?, finished_at=CASE WHEN ? IN ('success','failed','cancelled') THEN CURRENT_TIMESTAMP ELSE finished_at END, output=COALESCE(?, output) WHERE id=?`)
    .run(status, status, output == null ? null : (typeof output === 'string' ? output : JSON.stringify(output)), runId);
  return { id: runId, status };
}

function appendRunStepLog(runId, stepId, { status = 'running', log = null, finish = false } = {}) {
  initDb();
  const existing = db.prepare(`SELECT * FROM workflow_run_steps WHERE run_id=? AND step_id=?`).get(runId, stepId);
  if (!existing) {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO workflow_run_steps (id, run_id, step_id, status, started_at, log) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`)
      .run(id, runId, stepId, status, log);
    return { id };
  }
  db.prepare(`UPDATE workflow_run_steps SET status=?, log=COALESCE(?, log), finished_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE finished_at END WHERE id=?`)
    .run(status, log, finish ? 1 : 0, existing.id);
  return { id: existing.id };
}

function listRuns(workflowId) {
  initDb();
  const rows = workflowId
    ? db.prepare(`SELECT * FROM workflow_runs WHERE workflow_id=? ORDER BY started_at DESC`).all(workflowId)
    : db.prepare(`SELECT * FROM workflow_runs ORDER BY started_at DESC`).all();
  return rows;
}

function getRun(runId) {
  initDb();
  const run = db.prepare(`SELECT * FROM workflow_runs WHERE id=?`).get(runId);
  if (!run) return null;
  const run_steps = db.prepare(`SELECT * FROM workflow_run_steps WHERE run_id=? ORDER BY started_at ASC`).all(runId);
  return { ...run, run_steps };
}

module.exports = {
  initDb,
  createWorkflow, listWorkflows, getWorkflow, updateWorkflow, deleteWorkflow,
  addStep, updateStep, deleteStep, reorderSteps,
  createRun, updateRunStatus, appendRunStepLog, listRuns, getRun,
};
