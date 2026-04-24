import Foundation

// WebSocket client to the OpenClaw gateway at ws://127.0.0.1:18789/agent.
// Port of renderer/gateway-client.js — streams agent messages back via AsyncStream.
actor GatewayClient {
    static let shared = GatewayClient()

    private var task: URLSessionWebSocketTask?
    private var continuation: AsyncStream<String>.Continuation?

    func connect() -> AsyncStream<String> {
        let url = URL(string: "ws://127.0.0.1:\(ConfigSeeder.gatewayPort)/agent")!
        let t = URLSession.shared.webSocketTask(with: url)
        task = t
        t.resume()

        let (stream, cont) = AsyncStream<String>.makeStream()
        self.continuation = cont
        Task { await receiveLoop() }
        return stream
    }

    func send(_ text: String) async throws {
        guard let t = task else { throw GatewayError.notConnected }
        try await t.send(.string(text))
    }

    func disconnect() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        continuation?.finish()
        continuation = nil
    }

    private func receiveLoop() async {
        guard let t = task else { return }
        while true {
            do {
                let msg = try await t.receive()
                switch msg {
                case .string(let s): continuation?.yield(s)
                case .data(let d): continuation?.yield(String(data: d, encoding: .utf8) ?? "")
                @unknown default: break
                }
            } catch {
                continuation?.finish()
                return
            }
        }
    }
}

enum GatewayError: Error { case notConnected }
