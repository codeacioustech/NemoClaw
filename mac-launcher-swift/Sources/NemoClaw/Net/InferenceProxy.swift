import Foundation
import Network

// HTTP reverse proxy: 127.0.0.1:11435 -> 127.0.0.1:11434 (Ollama).
// Injects the NemoClaw system instruction into /api/chat requests so the
// local model behaves consistently regardless of which agent is calling.
// Port of mac-launcher/lib/ollama-proxy.js (core behavior only; session
// KV-cache tracking and SSE thinking stream are deferred).
actor InferenceProxy {
    static let shared = InferenceProxy()

    private let listenPort: UInt16 = 11435
    private let upstream = URL(string: "http://127.0.0.1:11434")!
    private var listener: NWListener?

    private let systemInstruction = """
    You are a helpful assistant running inside the NemoClaw desktop app. \
    You must use the following tools to interact with the filesystem:
    - `read`: to read a file OR to list the contents of a directory (e.g. pass "." or a folder path).
    - `edit`: to modify existing files.
    - `write`: to create or completely overwrite files.
    - `exex`: to run shell commands. Use this for listing processes, running scripts, git operations, package managers, etc.
    Whenever you're going to run a shell command, output the user the exact command and a short description does before running itask the user for confirmation for the command along with the command description then prompt the user to confirm and wait, if the user says yes, run the command and continue, if the user says no, stop and don't run the command,You are NOT allowed to run any commands that require sudo accessALWAYS wait for the tool result before replying. \
    For non-file questions, answer in plain text. \
    Never read, list, edit, or write any file under `~/.nemoclaw/` or `~/.openclaw/`. \
    Those directories hold system credentials and launcher config; the user does not want them accessed. If a user request requires credentials, inform them that connector integrations are managed through the launcher UI.
    """

    func start() throws {
        if listener != nil { return }
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        let l = try NWListener(using: params, on: NWEndpoint.Port(rawValue: listenPort)!)
        l.newConnectionHandler = { [weak self] conn in
            conn.start(queue: .global(qos: .userInitiated))
            Task { await self?.handle(conn) }
        }
        l.start(queue: .global(qos: .userInitiated))
        listener = l
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    // MARK: - Connection handling

    private func handle(_ conn: NWConnection) async {
        guard let (head, body) = await readHTTPRequest(conn) else {
            conn.cancel(); return
        }
        let patched = injectSystemPromptIfNeeded(head: head, body: body)
        await forward(to: conn, reqHead: patched.head, reqBody: patched.body)
        conn.cancel()
    }

    // Reads the request head + body. Supports Content-Length; chunked TE
    // is rare for Ollama clients so we don't special-case it.
    private func readHTTPRequest(_ conn: NWConnection) async -> (String, Data)? {
        var buffer = Data()
        while true {
            guard let chunk = await recv(conn, max: 65536) else { return nil }
            buffer.append(chunk)
            if let range = buffer.range(of: Data("\r\n\r\n".utf8)) {
                let headData = buffer.subdata(in: 0..<range.lowerBound)
                let head = String(data: headData, encoding: .utf8) ?? ""
                let contentLength = parseContentLength(head)
                var body = buffer.subdata(in: range.upperBound..<buffer.count)
                while body.count < contentLength {
                    guard let more = await recv(conn, max: 65536) else { return nil }
                    body.append(more)
                }
                return (head, body.prefix(contentLength))
            }
            if buffer.count > 1_000_000 { return nil }
        }
    }

    private func parseContentLength(_ head: String) -> Int {
        for line in head.split(separator: "\r\n") {
            let lower = line.lowercased()
            if lower.hasPrefix("content-length:") {
                return Int(line.split(separator: ":").last?.trimmingCharacters(in: .whitespaces) ?? "") ?? 0
            }
        }
        return 0
    }

    private func injectSystemPromptIfNeeded(head: String, body: Data) -> (head: String, body: Data) {
        guard head.contains("POST /api/chat") || head.contains("POST /v1/chat/completions") else {
            return (head, body)
        }
        guard var obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else {
            return (head, body)
        }
        var messages = (obj["messages"] as? [[String: Any]]) ?? []
        if !messages.contains(where: { ($0["role"] as? String) == "system" }) {
            messages.insert(["role": "system", "content": systemInstruction], at: 0)
            obj["messages"] = messages
        }
        guard let newBody = try? JSONSerialization.data(withJSONObject: obj) else {
            return (head, body)
        }
        let newHead = rewriteContentLength(head, newLength: newBody.count)
        return (newHead, newBody)
    }

    private func rewriteContentLength(_ head: String, newLength: Int) -> String {
        var lines = head.components(separatedBy: "\r\n")
        var found = false
        for i in lines.indices where lines[i].lowercased().hasPrefix("content-length:") {
            lines[i] = "Content-Length: \(newLength)"
            found = true
        }
        if !found { lines.append("Content-Length: \(newLength)") }
        return lines.joined(separator: "\r\n")
    }

    // MARK: - Upstream forwarding

    private func forward(to client: NWConnection, reqHead: String, reqBody: Data) async {
        let upstreamConn = NWConnection(
            host: NWEndpoint.Host("127.0.0.1"),
            port: NWEndpoint.Port(rawValue: 11434)!,
            using: .tcp)
        upstreamConn.start(queue: .global(qos: .userInitiated))

        var out = Data((reqHead + "\r\n\r\n").utf8)
        out.append(reqBody)
        await send(upstreamConn, out)

        // Stream upstream → client until upstream closes.
        while true {
            guard let chunk = await recv(upstreamConn, max: 65536), !chunk.isEmpty else { break }
            await send(client, chunk)
        }
        upstreamConn.cancel()
    }

    private func recv(_ conn: NWConnection, max: Int) async -> Data? {
        await withCheckedContinuation { (cont: CheckedContinuation<Data?, Never>) in
            conn.receive(minimumIncompleteLength: 1, maximumLength: max) { data, _, _, err in
                if err != nil { cont.resume(returning: nil) }
                else { cont.resume(returning: data ?? Data()) }
            }
        }
    }

    private func send(_ conn: NWConnection, _ data: Data) async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            conn.send(content: data, completion: .contentProcessed { _ in cont.resume() })
        }
    }
}
