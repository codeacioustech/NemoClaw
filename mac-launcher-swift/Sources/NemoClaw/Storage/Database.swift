import Foundation
import GRDB

// Single shared DatabaseQueue over ~/Library/Application Support/NemoClaw/chat_history.db.
// Both chat and workflow tables live in the same file — matches the Electron build
// (mac-launcher/lib/workflow-db.js opens chat_history.db and adds workflow_* tables).
actor Database {
    static let shared = Database()
    private var queue: DatabaseQueue?

    func queueRef() throws -> DatabaseQueue {
        if let q = queue { return q }
        try Paths.ensureDirectories()
        var cfg = Configuration()
        cfg.foreignKeysEnabled = true
        let q = try DatabaseQueue(path: Paths.chatDB.path, configuration: cfg)
        try q.write { db in
            try db.execute(sql: """
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
            """)
        }
        queue = q
        return q
    }
}
