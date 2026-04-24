// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// YAML <-> DB sync for workflows. YAML files in <dir>/<id>.yaml are the
// source of truth; on startup they're upserted into the sqlite workflow_db
// so the existing runner (which reads from DB) keeps working unchanged.
// Writes from the UI builder also dump back to YAML so the files stay in
// sync and can be committed / diffed.

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const { app } = require('electron');

const wfDb = require('./workflow-db');

function yamlDir() {
  const dir = path.join(app.getPath('userData'), 'workflows');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function parseFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const doc = yaml.parse(raw);
    if (!doc || typeof doc !== 'object') return null;
    if (!doc.id || !doc.name) return null;
    return {
      id: String(doc.id),
      name: String(doc.name),
      description: doc.description ?? '',
      trigger_kind: doc.trigger_kind || 'manual',
      trigger_config: doc.trigger_config ?? null,
      steps: Array.isArray(doc.steps) ? doc.steps.map((s, i) => ({
        id: s.id || `${doc.id}-step-${i}`,
        ordinal: typeof s.ordinal === 'number' ? s.ordinal : i,
        kind: s.kind || s.type,
        config: s.config ?? null,
      })) : [],
    };
  } catch (e) {
    console.warn(`[wf-yaml] failed to parse ${file}:`, e.message);
    return null;
  }
}

function loadYamlDir(dir = yamlDir()) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /\.ya?ml$/i.test(f))
    .map((f) => parseFile(path.join(dir, f)))
    .filter(Boolean);
}

function upsertWorkflow(wf) {
  const db = wfDb.initDb();
  const existing = db.prepare(`SELECT id FROM workflows WHERE id=?`).get(wf.id);
  const triggerCfg = wf.trigger_config == null ? null : JSON.stringify(wf.trigger_config);
  if (existing) {
    db.prepare(`UPDATE workflows SET name=?, description=?, trigger_kind=?, trigger_config=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(wf.name, wf.description, wf.trigger_kind, triggerCfg, wf.id);
  } else {
    db.prepare(`INSERT INTO workflows (id, name, description, trigger_kind, trigger_config) VALUES (?, ?, ?, ?, ?)`)
      .run(wf.id, wf.name, wf.description, wf.trigger_kind, triggerCfg);
  }
  // Replace steps wholesale — YAML is the source of truth.
  db.prepare(`DELETE FROM workflow_steps WHERE workflow_id=?`).run(wf.id);
  const ins = db.prepare(`INSERT INTO workflow_steps (id, workflow_id, ordinal, kind, config) VALUES (?, ?, ?, ?, ?)`);
  wf.steps.forEach((s, i) => {
    ins.run(s.id, wf.id, typeof s.ordinal === 'number' ? s.ordinal : i, s.kind,
      s.config == null ? null : JSON.stringify(s.config));
  });
}

function syncYamlToDb(dir = yamlDir()) {
  const loaded = loadYamlDir(dir);
  for (const wf of loaded) {
    try { upsertWorkflow(wf); }
    catch (e) { console.warn(`[wf-yaml] upsert ${wf.id} failed:`, e.message); }
  }
  return loaded.length;
}

function dumpWorkflow(workflowId, dir = yamlDir()) {
  const wf = wfDb.getWorkflow(workflowId);
  if (!wf) return null;
  const doc = {
    id: wf.id,
    name: wf.name,
    description: wf.description || '',
    trigger_kind: wf.trigger_kind || 'manual',
    ...(wf.trigger_config ? { trigger_config: wf.trigger_config } : {}),
    steps: (wf.steps || []).map((s) => ({
      id: s.id,
      ordinal: s.ordinal,
      kind: s.kind,
      config: s.config ?? null,
    })),
  };
  const file = path.join(dir, `${wf.id}.yaml`);
  fs.writeFileSync(file, yaml.stringify(doc), 'utf8');
  return file;
}

function deleteWorkflowYaml(workflowId, dir = yamlDir()) {
  const file = path.join(dir, `${workflowId}.yaml`);
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
}

module.exports = {
  yamlDir,
  loadYamlDir,
  syncYamlToDb,
  upsertWorkflow,
  dumpWorkflow,
  deleteWorkflowYaml,
};
