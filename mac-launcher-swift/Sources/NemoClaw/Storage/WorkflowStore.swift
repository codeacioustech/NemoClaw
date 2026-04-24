import Foundation
import GRDB

struct Workflow: Codable, Identifiable {
    var id: String
    var name: String
    var description: String?
    var trigger_kind: String
    var trigger_config: Data?
    var created_at: String?
    var updated_at: String?
    var steps: [WorkflowStep] = []
}

struct WorkflowStep: Codable, Identifiable {
    var id: String
    var workflow_id: String
    var ordinal: Int
    var kind: String
    var config: Data?
}

struct WorkflowRun: Codable, Identifiable {
    var id: String
    var workflow_id: String
    var status: String
    var started_at: String?
    var finished_at: String?
    var output: String?
}

struct WorkflowRunStep: Codable, Identifiable {
    var id: String
    var run_id: String
    var step_id: String?
    var status: String
    var started_at: String?
    var finished_at: String?
    var log: String?
}

enum WorkflowStore {
    // MARK: - Workflows
    static func create(name: String, description: String = "", triggerKind: String = "manual",
                       triggerConfig: Data? = nil) async throws -> Workflow {
        let id = UUID().uuidString
        try await Database.shared.queueRef().write { db in
            try db.execute(sql: """
                INSERT INTO workflows (id, name, description, trigger_kind, trigger_config)
                VALUES (?, ?, ?, ?, ?)
            """, arguments: [id, name.isEmpty ? "Untitled Workflow" : name,
                             description, triggerKind, triggerConfig])
        }
        return try await get(id)!
    }

    static func list() async throws -> [Workflow] {
        try await Database.shared.queueRef().read { db in
            try Row.fetchAll(db, sql: "SELECT * FROM workflows ORDER BY updated_at DESC")
                .map { Self.decodeWorkflow($0) }
        }
    }

    static func get(_ id: String) async throws -> Workflow? {
        try await Database.shared.queueRef().read { db in
            guard let row = try Row.fetchOne(db, sql: "SELECT * FROM workflows WHERE id = ?",
                                             arguments: [id]) else { return nil }
            var wf = Self.decodeWorkflow(row)
            wf.steps = try Row.fetchAll(db,
                sql: "SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY ordinal ASC",
                arguments: [id]).map { Self.decodeStep($0) }
            return wf
        }
    }

    static func delete(_ id: String) async throws {
        try await Database.shared.queueRef().write { db in
            try db.execute(sql: "DELETE FROM workflows WHERE id = ?", arguments: [id])
        }
    }

    // MARK: - Steps
    static func addStep(workflowId: String, kind: String, config: Data? = nil) async throws -> WorkflowStep {
        let id = UUID().uuidString
        return try await Database.shared.queueRef().write { db in
            let maxOrd = try Int.fetchOne(db,
                sql: "SELECT COALESCE(MAX(ordinal), -1) FROM workflow_steps WHERE workflow_id = ?",
                arguments: [workflowId]) ?? -1
            try db.execute(sql: """
                INSERT INTO workflow_steps (id, workflow_id, ordinal, kind, config)
                VALUES (?, ?, ?, ?, ?)
            """, arguments: [id, workflowId, maxOrd + 1, kind, config])
            try db.execute(sql: "UPDATE workflows SET updated_at=CURRENT_TIMESTAMP WHERE id=?",
                           arguments: [workflowId])
            return WorkflowStep(id: id, workflow_id: workflowId, ordinal: maxOrd + 1,
                                kind: kind, config: config)
        }
    }

    static func deleteStep(_ id: String) async throws {
        try await Database.shared.queueRef().write { db in
            try db.execute(sql: "DELETE FROM workflow_steps WHERE id = ?", arguments: [id])
        }
    }

    // MARK: - Runs
    static func createRun(workflowId: String) async throws -> WorkflowRun {
        let id = UUID().uuidString
        try await Database.shared.queueRef().write { db in
            try db.execute(sql: """
                INSERT INTO workflow_runs (id, workflow_id, status) VALUES (?, ?, 'running')
            """, arguments: [id, workflowId])
        }
        return WorkflowRun(id: id, workflow_id: workflowId, status: "running",
                           started_at: nil, finished_at: nil, output: nil)
    }

    static func updateRunStatus(runId: String, status: String, output: String? = nil) async throws {
        try await Database.shared.queueRef().write { db in
            try db.execute(sql: """
                UPDATE workflow_runs
                SET status=?,
                    finished_at = CASE WHEN ? IN ('success','failed','cancelled') THEN CURRENT_TIMESTAMP ELSE finished_at END,
                    output = COALESCE(?, output)
                WHERE id=?
            """, arguments: [status, status, output, runId])
        }
    }

    // MARK: - Decoding helpers
    private static func decodeWorkflow(_ row: Row) -> Workflow {
        Workflow(
            id: row["id"], name: row["name"], description: row["description"],
            trigger_kind: row["trigger_kind"] ?? "manual",
            trigger_config: (row["trigger_config"] as String?).flatMap { $0.data(using: .utf8) },
            created_at: row["created_at"], updated_at: row["updated_at"], steps: []
        )
    }

    private static func decodeStep(_ row: Row) -> WorkflowStep {
        WorkflowStep(
            id: row["id"], workflow_id: row["workflow_id"], ordinal: row["ordinal"],
            kind: row["kind"],
            config: (row["config"] as String?).flatMap { $0.data(using: .utf8) }
        )
    }
}
