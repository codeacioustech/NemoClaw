import Foundation

// Manages long-running child processes (Ollama, OpenClaw gateway via bundled node).
// Inherits the app sandbox; the helper binaries must be codesigned with
// entitlements.mac.inherit.plist at build time.
actor ProcessSupervisor {
    static let shared = ProcessSupervisor()

    private var ollama: Process?
    private var gateway: Process?
    private var logHandlers: [String: (String) -> Void] = [:]

    // MARK: - Ollama

    func startOllama() throws {
        if ollama?.isRunning == true { return }
        let binary = try resolveOllamaBinary()
        let proc = Process()
        proc.executableURL = binary
        proc.arguments = ["serve"]
        proc.environment = [
            "OLLAMA_HOST": "127.0.0.1:11434",
            "HOME": Paths.home.path,
            "PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"
        ]
        attachPipes(proc, tag: "ollama")
        try proc.run()
        ollama = proc
    }

    func stopOllama() {
        ollama?.terminate()
        ollama = nil
    }

    private func resolveOllamaBinary() throws -> URL {
        if let bundled = Paths.bundledOllama,
           FileManager.default.isExecutableFile(atPath: bundled.path) {
            return bundled
        }
        let cached = Paths.cachedOllama
        if FileManager.default.isExecutableFile(atPath: cached.path) {
            return cached
        }
        for candidate in ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama"] {
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return URL(fileURLWithPath: candidate)
            }
        }
        throw SupervisorError.ollamaNotFound
    }

    // MARK: - OpenClaw gateway (bundled node)

    func startGateway() throws {
        if gateway?.isRunning == true { return }
        guard let node = Paths.bundledNode,
              FileManager.default.isExecutableFile(atPath: node.path) else {
            throw SupervisorError.bundledNodeMissing
        }
        guard let openclawMjs = Paths.bundledOpenclawEntry else {
            throw SupervisorError.openclawPayloadMissing
        }

        let proc = Process()
        proc.executableURL = node
        proc.arguments = [
            openclawMjs.path,
            "gateway", "run",
            "--port", String(ConfigSeeder.gatewayPort),
            "--auth", "none",
            "--allow-unconfigured",
            "--bind", "loopback",
            "--verbose"
        ]
        var env = ProcessInfo.processInfo.environment
        env["OPENCLAW_GATEWAY_PORT"] = String(ConfigSeeder.gatewayPort)
        env["NODE_OPTIONS"] = ""
        env["HOME"] = Paths.home.path
        proc.environment = env
        proc.currentDirectoryURL = Paths.openclawDir

        attachPipes(proc, tag: "gateway")
        try proc.run()
        gateway = proc
    }

    func stopGateway() {
        gateway?.terminate()
        gateway = nil
    }

    func waitForGateway(timeout: TimeInterval = 30) async throws {
        let url = URL(string: "http://127.0.0.1:\(ConfigSeeder.gatewayPort)/")!
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            do {
                let (_, resp) = try await URLSession.shared.data(from: url)
                if (resp as? HTTPURLResponse) != nil { return }
            } catch { /* retry */ }
            try await Task.sleep(for: .milliseconds(500))
        }
        throw SupervisorError.gatewayTimeout
    }

    // MARK: - Logging

    func setLogHandler(tag: String, _ handler: @escaping (String) -> Void) {
        logHandlers[tag] = handler
    }

    private func attachPipes(_ proc: Process, tag: String) {
        let outPipe = Pipe(); let errPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = errPipe
        let handler: (FileHandle) -> Void = { [weak self] h in
            let data = h.availableData
            guard !data.isEmpty, let s = String(data: data, encoding: .utf8) else { return }
            Task { await self?.emit(tag: tag, s) }
        }
        outPipe.fileHandleForReading.readabilityHandler = handler
        errPipe.fileHandleForReading.readabilityHandler = handler
    }

    private func emit(tag: String, _ line: String) {
        if let h = logHandlers[tag] { h(line) }
        else { FileHandle.standardError.write(Data("[\(tag)] \(line)".utf8)) }
    }

    // MARK: - Shutdown

    func stopAll() {
        stopGateway()
        stopOllama()
    }
}

enum SupervisorError: Error, LocalizedError {
    case ollamaNotFound
    case bundledNodeMissing
    case openclawPayloadMissing
    case gatewayTimeout

    var errorDescription: String? {
        switch self {
        case .ollamaNotFound: "Ollama binary not found (bundle, cache, or system)"
        case .bundledNodeMissing: "Bundled node binary missing from Frameworks/"
        case .openclawPayloadMissing: "OpenClaw payload (openclaw.mjs) missing from Resources/"
        case .gatewayTimeout: "OpenClaw gateway did not respond in time"
        }
    }
}
