import Foundation
import GRDB

struct ChatSession: Codable, FetchableRecord, PersistableRecord, Identifiable {
    var id: String
    var title: String?
    var created_at: String?
    static let databaseTableName = "sessions"
}

struct ChatMessage: Codable, FetchableRecord, PersistableRecord, Identifiable {
    var id: String
    var session_id: String
    var role: String
    var content: String
    var created_at: String?
    static let databaseTableName = "messages"
}

enum ChatStore {
    static func createSession(title: String = "New Chat") async throws -> ChatSession {
        let s = ChatSession(id: UUID().uuidString, title: title, created_at: nil)
        try await Database.shared.queueRef().write { try s.insert($0) }
        return s
    }

    static func sessions() async throws -> [ChatSession] {
        try await Database.shared.queueRef().read { db in
            try ChatSession.order(sql: "created_at DESC").fetchAll(db)
        }
    }

    static func saveMessage(sessionId: String, role: String, content: String) async throws -> ChatMessage {
        let m = ChatMessage(id: UUID().uuidString, session_id: sessionId, role: role,
                            content: content, created_at: nil)
        try await Database.shared.queueRef().write { try m.insert($0) }
        return m
    }

    static func messages(sessionId: String) async throws -> [ChatMessage] {
        try await Database.shared.queueRef().read { db in
            try ChatMessage
                .filter(Column("session_id") == sessionId)
                .order(sql: "created_at ASC")
                .fetchAll(db)
        }
    }

    static func updateSessionTitle(sessionId: String, title: String) async throws {
        try await Database.shared.queueRef().write { db in
            try db.execute(sql: "UPDATE sessions SET title = ? WHERE id = ?",
                           arguments: [title, sessionId])
        }
    }

    static func deleteSession(sessionId: String) async throws {
        try await Database.shared.queueRef().write { db in
            try db.execute(sql: "DELETE FROM messages WHERE session_id = ?", arguments: [sessionId])
            try db.execute(sql: "DELETE FROM sessions WHERE id = ?", arguments: [sessionId])
        }
    }
}
