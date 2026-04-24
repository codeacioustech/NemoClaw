import Foundation

// Thin client for the local Ollama HTTP API (http://127.0.0.1:11434).
enum OllamaClient {
    static let baseURL = URL(string: "http://127.0.0.1:11434")!

    static func waitForReady(timeout: TimeInterval = 30) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let (_, resp) = try? await URLSession.shared.data(from: baseURL.appending(path: "/api/tags")),
               (resp as? HTTPURLResponse)?.statusCode == 200 {
                return
            }
            try await Task.sleep(for: .milliseconds(500))
        }
        throw OllamaError.notReady
    }

    struct TagsResponse: Decodable { let models: [Model]; struct Model: Decodable { let name: String } }

    static func hasModel(_ name: String) async -> Bool {
        guard let (data, _) = try? await URLSession.shared.data(from: baseURL.appending(path: "/api/tags")),
              let resp = try? JSONDecoder().decode(TagsResponse.self, from: data) else { return false }
        return resp.models.contains { $0.name == name || $0.name.hasPrefix(name + ":") }
    }

    // Streams /api/pull progress as (status, completed/total) tuples.
    static func pull(_ name: String, onProgress: @escaping (String, Double) -> Void) async throws {
        var req = URLRequest(url: baseURL.appending(path: "/api/pull"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["name": name, "stream": true])

        let (bytes, _) = try await URLSession.shared.bytes(for: req)
        for try await line in bytes.lines {
            guard let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            let status = obj["status"] as? String ?? ""
            let completed = (obj["completed"] as? Double) ?? 0
            let total = (obj["total"] as? Double) ?? 0
            let pct = total > 0 ? min(1.0, completed / total) : 0
            onProgress(status, pct)
        }
    }
}

enum OllamaError: Error { case notReady }
