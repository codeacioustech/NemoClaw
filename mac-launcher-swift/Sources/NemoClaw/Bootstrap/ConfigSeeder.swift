import Foundation

// Port of mac-launcher/lib/config-seeder.js — writes ~/.openclaw/openclaw.json
// and ~/.nemoclaw/{config,onboard-session,credentials}.json on first run.
// Keep the schema byte-compatible with the Electron build so installs can
// switch between the two without re-onboarding.
enum ConfigSeeder {
    static let gatewayPort = 18789
    static let model = "gemma4:e4b"

    static func seedIfNeeded() throws {
        try seedOpenclawConfig()
        try seedNemoclawConfig()
    }

    private static func seedOpenclawConfig() throws {
        let fm = FileManager.default
        try fm.createDirectory(at: Paths.openclawDir.appending(path: "extensions"),
                               withIntermediateDirectories: true,
                               attributes: [.posixPermissions: 0o700])

        let cfg: [String: Any] = [
            "gateway": [
                "mode": "local",
                "bind": "loopback",
                "port": gatewayPort,
                "auth": ["mode": "none"],
                "controlUi": [
                    "dangerouslyDisableDeviceAuth": true,
                    "allowedOrigins": ["file://", "null"]
                ]
            ],
            "models": [
                "mode": "merge",
                "providers": [
                    "ollama": [
                        "baseUrl": "http://127.0.0.1:11435",
                        "apiKey": "OLLAMA_API_KEY",
                        "api": "ollama",
                        "models": [[
                            "id": model,
                            "name": "Gemma 4 E4B",
                            "reasoning": false,
                            "input": ["text"],
                            "cost": ["input": 0, "output": 0],
                            "contextWindow": 32768,
                            "maxTokens": 8192
                        ]]
                    ]
                ]
            ],
            "agents": [
                "defaults": [
                    "model": ["primary": "ollama/\(model)"],
                    "models": ["ollama/\(model)": [:]],
                    "skipBootstrap": true,
                    "llm": ["idleTimeoutSeconds": 600],
                    "heartbeat": [:]
                ]
            ]
        ]

        try writeSecureJSON(cfg, to: Paths.openclawConfig)
    }

    private static func seedNemoclawConfig() throws {
        try FileManager.default.createDirectory(at: Paths.nemoclawDir,
                                                withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])

        let now = ISO8601DateFormatter().string(from: Date())

        let config: [String: Any] = [
            "endpointType": "ollama",
            "endpointUrl": "http://localhost:11435/v1",
            "ncpPartner": NSNull(),
            "model": model,
            "profile": "inference-local",
            "credentialEnv": "OPENAI_API_KEY",
            "provider": "ollama-local",
            "providerLabel": "NemoClaw Mac",
            "onboardedAt": now
        ]
        try writeSecureJSON(config, to: Paths.nemoclawDir.appending(path: "config.json"))

        let sessionId = "\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString.prefix(8).lowercased())"
        let stepComplete: [String: Any] = [
            "status": "complete", "startedAt": now, "completedAt": now, "error": NSNull()
        ]
        let stepSkipped: [String: Any] = [
            "status": "skipped", "startedAt": NSNull(), "completedAt": NSNull(), "error": NSNull()
        ]
        let session: [String: Any] = [
            "version": 1,
            "sessionId": sessionId,
            "resumable": false,
            "status": "complete",
            "mode": "non-interactive",
            "startedAt": now,
            "updatedAt": now,
            "lastStepStarted": "policies",
            "lastCompletedStep": "policies",
            "failure": NSNull(),
            "sandboxName": NSNull(),
            "provider": "ollama-local",
            "model": model,
            "endpointUrl": "http://localhost:11435/v1",
            "credentialEnv": "OPENAI_API_KEY",
            "preferredInferenceApi": NSNull(),
            "nimContainer": NSNull(),
            "policyPresets": NSNull(),
            "metadata": ["gatewayName": "nemoclaw"],
            "steps": [
                "preflight": stepComplete,
                "gateway": stepComplete,
                "sandbox": stepSkipped,
                "provider_selection": stepComplete,
                "inference": stepComplete,
                "openclaw": stepComplete,
                "policies": stepComplete
            ]
        ]
        try writeSecureJSON(session, to: Paths.nemoclawDir.appending(path: "onboard-session.json"))

        let credentials: [String: Any] = [
            "_version": 1,
            "entries": [
                "OPENAI_API_KEY": ["value": "ollama", "_encrypted": false]
            ]
        ]
        try writeSecureJSON(credentials, to: Paths.nemoclawDir.appending(path: "credentials.json"))
    }

    private static func writeSecureJSON(_ obj: Any, to url: URL) throws {
        let data = try JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])
        let tmp = url.appendingPathExtension("tmp.\(getpid())")
        try data.write(to: tmp, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tmp.path)
        _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
    }
}
