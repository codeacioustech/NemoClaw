import Foundation
import Observation

@Observable
@MainActor
final class ChatViewModel {
    var sessions: [ChatSession] = []
    var currentSessionId: String?
    var messages: [ChatMessage] = []
    var input: String = ""
    var streaming: String = ""
    var isStreaming: Bool = false

    private var gatewayStream: AsyncStream<String>?

    func loadSessions() async {
        sessions = (try? await ChatStore.sessions()) ?? []
        if currentSessionId == nil, let first = sessions.first {
            await select(session: first.id)
        }
    }

    func newSession() async {
        guard let s = try? await ChatStore.createSession() else { return }
        sessions.insert(s, at: 0)
        await select(session: s.id)
    }

    func select(session id: String) async {
        currentSessionId = id
        messages = (try? await ChatStore.messages(sessionId: id)) ?? []
    }

    func send() async {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let sid = currentSessionId else { return }
        input = ""
        if let m = try? await ChatStore.saveMessage(sessionId: sid, role: "user", content: text) {
            messages.append(m)
        }
        isStreaming = true; streaming = ""
        if gatewayStream == nil {
            gatewayStream = await GatewayClient.shared.connect()
        }
        try? await GatewayClient.shared.send(text)
        if let stream = gatewayStream {
            for await chunk in stream {
                streaming += chunk
                if chunk.contains("\"done\":true") { break }
            }
        }
        let reply = streaming
        streaming = ""; isStreaming = false
        if !reply.isEmpty,
           let m = try? await ChatStore.saveMessage(sessionId: sid, role: "assistant", content: reply) {
            messages.append(m)
        }
    }
}
