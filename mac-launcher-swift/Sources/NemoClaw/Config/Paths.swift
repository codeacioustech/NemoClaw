import Foundation

enum Paths {
    static let home = FileManager.default.homeDirectoryForCurrentUser

    static var nemoclawDir: URL { home.appending(path: ".nemoclaw", directoryHint: .isDirectory) }
    static var openclawDir: URL { home.appending(path: ".openclaw", directoryHint: .isDirectory) }

    static var launcherConfig: URL { nemoclawDir.appending(path: "launcher_config.json") }
    static var openclawConfig: URL { openclawDir.appending(path: "openclaw.json") }

    // Matches Electron's app.getPath('userData') — ~/Library/Application Support/NemoClaw
    static var userData: URL {
        home.appending(path: "Library/Application Support/NemoClaw", directoryHint: .isDirectory)
    }
    static var chatDB: URL { userData.appending(path: "chat_history.db") }
    static var workflowDB: URL { userData.appending(path: "workflows.db") }

    static var bundledOllama: URL? {
        Bundle.main.url(forResource: "ollama", withExtension: nil, subdirectory: "ollama-mac")
    }

    static var cachedOllama: URL {
        nemoclawDir.appending(path: "ollama-mac/ollama")
    }

    static var bundledNode: URL? {
        guard let frameworks = Bundle.main.privateFrameworksURL else { return nil }
        return frameworks.appending(path: "node")
    }

    static var bundledOpenclawEntry: URL? {
        Bundle.main.url(forResource: "openclaw", withExtension: "mjs", subdirectory: "openclaw")
    }

    static func ensureDirectories() throws {
        let fm = FileManager.default
        for (dir, mode) in [(nemoclawDir, 0o700), (openclawDir, 0o700), (userData, 0o755)] {
            if !fm.fileExists(atPath: dir.path) {
                try fm.createDirectory(at: dir, withIntermediateDirectories: true,
                                       attributes: [.posixPermissions: mode])
            }
        }
    }
}
