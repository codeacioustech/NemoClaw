import Foundation
import Network

// Local HTTP endpoint at 127.0.0.1:11437 that forwards third-party API
// calls (Slack, GitHub, Google Drive, Notion, OneDrive) from the sandboxed
// agent process, injecting bearer credentials from Keychain so the agent
// never sees them.
// Port of mac-launcher/lib/connector-proxy.js — simplified to the
// credential-injection core; workflow runs SSE is deferred.
actor ConnectorProxy {
    static let shared = ConnectorProxy()
    private let listenPort: UInt16 = 11437
    private var listener: NWListener?

    struct Route {
        let pathPrefix: String
        let upstream: URL
        let credentialKey: String
        let headerName: String
        let scheme: String // "Bearer", "token", etc.
    }

    private let routes: [Route] = [
        .init(pathPrefix: "/slack/",   upstream: URL(string: "https://slack.com/api/")!,
              credentialKey: "SLACK_BOT_TOKEN", headerName: "Authorization", scheme: "Bearer"),
        .init(pathPrefix: "/github/",  upstream: URL(string: "https://api.github.com/")!,
              credentialKey: "GITHUB_TOKEN", headerName: "Authorization", scheme: "token"),
        .init(pathPrefix: "/notion/",  upstream: URL(string: "https://api.notion.com/")!,
              credentialKey: "NOTION_TOKEN", headerName: "Authorization", scheme: "Bearer"),
        .init(pathPrefix: "/gdrive/",  upstream: URL(string: "https://www.googleapis.com/drive/v3/")!,
              credentialKey: "GDRIVE_TOKEN", headerName: "Authorization", scheme: "Bearer"),
        .init(pathPrefix: "/onedrive/", upstream: URL(string: "https://graph.microsoft.com/v1.0/")!,
              credentialKey: "ONEDRIVE_TOKEN", headerName: "Authorization", scheme: "Bearer")
    ]

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

    private func handle(_ conn: NWConnection) async {
        defer { conn.cancel() }
        guard let raw = await readAll(conn) else { return }
        guard let (method, path, headers, body) = parseRequest(raw) else {
            await writeStatus(conn, 400, "bad request"); return
        }
        guard let route = routes.first(where: { path.hasPrefix($0.pathPrefix) }) else {
            await writeStatus(conn, 404, "no route"); return
        }
        let suffix = String(path.dropFirst(route.pathPrefix.count))
        let upstreamURL = route.upstream.appending(path: suffix)

        var req = URLRequest(url: upstreamURL)
        req.httpMethod = method
        req.httpBody = body.isEmpty ? nil : body
        for (k, v) in headers where !["authorization", "host", "connection"].contains(k.lowercased()) {
            req.setValue(v, forHTTPHeaderField: k)
        }
        if let token = try? Credentials.read(key: route.credentialKey), let token {
            req.setValue("\(route.scheme) \(token)", forHTTPHeaderField: route.headerName)
        }

        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 502
            await writeResponse(conn, status: status, body: data,
                                contentType: (resp as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type")
                                             ?? "application/octet-stream")
        } catch {
            await writeStatus(conn, 502, "upstream error: \(error.localizedDescription)")
        }
    }

    // MARK: - Minimal HTTP parsing

    private func readAll(_ conn: NWConnection) async -> Data? {
        var buf = Data()
        while true {
            let chunk: Data? = await withCheckedContinuation { cont in
                conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { d, _, isComplete, err in
                    if err != nil || (d?.isEmpty ?? true && isComplete) { cont.resume(returning: nil) }
                    else { cont.resume(returning: d) }
                }
            }
            guard let c = chunk, !c.isEmpty else { break }
            buf.append(c)
            if let r = buf.range(of: Data("\r\n\r\n".utf8)) {
                let headStr = String(data: buf.subdata(in: 0..<r.lowerBound), encoding: .utf8) ?? ""
                let len = contentLength(headStr)
                let have = buf.count - r.upperBound
                if have >= len { break }
            }
            if buf.count > 10_000_000 { return nil }
        }
        return buf
    }

    private func contentLength(_ head: String) -> Int {
        for l in head.components(separatedBy: "\r\n") where l.lowercased().hasPrefix("content-length:") {
            return Int(l.split(separator: ":").last?.trimmingCharacters(in: .whitespaces) ?? "") ?? 0
        }
        return 0
    }

    private func parseRequest(_ raw: Data) -> (String, String, [String: String], Data)? {
        guard let sep = raw.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let headStr = String(data: raw.subdata(in: 0..<sep.lowerBound), encoding: .utf8) ?? ""
        let body = raw.subdata(in: sep.upperBound..<raw.count)
        let lines = headStr.components(separatedBy: "\r\n")
        guard let first = lines.first else { return nil }
        let parts = first.split(separator: " ")
        guard parts.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for l in lines.dropFirst() {
            if let c = l.firstIndex(of: ":") {
                let k = String(l[..<c]).trimmingCharacters(in: .whitespaces)
                let v = String(l[l.index(after: c)...]).trimmingCharacters(in: .whitespaces)
                headers[k] = v
            }
        }
        return (String(parts[0]), String(parts[1]), headers, body)
    }

    private func writeStatus(_ conn: NWConnection, _ code: Int, _ text: String) async {
        await writeResponse(conn, status: code, body: Data(text.utf8), contentType: "text/plain")
    }

    private func writeResponse(_ conn: NWConnection, status: Int, body: Data, contentType: String) async {
        let head = "HTTP/1.1 \(status) OK\r\nContent-Type: \(contentType)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        var out = Data(head.utf8); out.append(body)
        await withCheckedContinuation { cont in
            conn.send(content: out, completion: .contentProcessed { _ in cont.resume() })
        }
    }
}
