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

  // Initialize schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      role TEXT,
      content TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
    );
  `);
  return db;
}

function createSession(title = 'New Chat') {
  initDb();
  const id = crypto.randomUUID();
  const stmt = db.prepare('INSERT INTO sessions (id, title) VALUES (?, ?)');
  stmt.run(id, title);
  return { id, title };
}

function getSessions() {
  initDb();
  const stmt = db.prepare('SELECT * FROM sessions ORDER BY created_at DESC');
  return stmt.all();
}

function saveMessage(sessionId, role, content) {
  initDb();
  const id = crypto.randomUUID();
  const stmt = db.prepare('INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)');
  stmt.run(id, sessionId, role, content);
  return { id, sessionId, role, content };
}

function getMessages(sessionId) {
  initDb();
  if (!sessionId) return [];
  const stmt = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC');
  return stmt.all(sessionId);
}

function updateSessionTitle(sessionId, title) {
  initDb();
  db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, sessionId);
  return { id: sessionId, title };
}

module.exports = {
  createSession,
  getSessions,
  saveMessage,
  getMessages,
  updateSessionTitle
};
