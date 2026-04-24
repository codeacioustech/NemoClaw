import Foundation
import Observation

enum BootstrapPhase: String {
    case idle, seedingConfig, startingOllama, pullingModel, startingGateway, startingProxies, ready, failed
}

@Observable
final class BootstrapModel {
    var phase: BootstrapPhase = .idle
    var progress: Double = 0
    var message: String = "Starting…"
    var error: String?

    private(set) var config = LauncherConfig()

    func run() async {
        do {
            try Paths.ensureDirectories()

            await setPhase(.seedingConfig, "Loading configuration…", 0.05)
            config = (try? LauncherConfigStore.load()) ?? LauncherConfig()
            try ConfigSeeder.seedIfNeeded()
            try await Bookmarks.shared.validateAtBoot()
            Credentials.migrateFromElectron()

            await setPhase(.startingOllama, "Starting local inference (Ollama)…", 0.15)
            try await ProcessSupervisor.shared.startOllama()
            try await OllamaClient.waitForReady()

            if await !OllamaClient.hasModel(config.model) {
                await setPhase(.pullingModel, "Pulling model \(config.model)…", 0.25)
                try await OllamaClient.pull(config.model) { [weak self] status, pct in
                    Task { @MainActor in
                        self?.message = "Pulling \(status)…"
                        self?.progress = 0.25 + pct * 0.4
                    }
                }
            }

            await setPhase(.startingGateway, "Starting OpenClaw gateway…", 0.7)
            try await ProcessSupervisor.shared.startGateway()
            try await ProcessSupervisor.shared.waitForGateway()

            await setPhase(.startingProxies, "Starting inference + connector proxies…", 0.9)
            try await InferenceProxy.shared.start()
            try await ConnectorProxy.shared.start()

            await setPhase(.ready, "Ready.", 1.0)
        } catch {
            self.error = String(describing: error)
            await setPhase(.failed, "Setup failed", progress)
        }
    }

    @MainActor
    private func setPhase(_ p: BootstrapPhase, _ msg: String, _ prog: Double) {
        phase = p
        message = msg
        progress = prog
    }
}
