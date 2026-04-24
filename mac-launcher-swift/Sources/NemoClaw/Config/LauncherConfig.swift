import Foundation

// Schema v3 (matches mac-launcher/lib/config-seeder.js). We read+write the
// same file so installs migrate between Electron and Swift builds.
struct LauncherConfig: Codable {
    var _version: Int = 3
    var onboardingComplete: Bool = false
    var launcherSetupComplete: Bool = false
    var onboarding: OnboardingData = .init()
    var mountedFolders: [MountedFolder] = []
    var model: String = "gemma4:e4b"

    struct OnboardingData: Codable {
        var workspaceType: String?
        var teamSize: String?
        var techExperience: String?
        var connectors: [String] = []
        var microapps: [String] = []
    }

    struct MountedFolder: Codable {
        var path: String
        var bookmark: Data
        var addedAt: String
        var stale: Bool?
    }
}

enum LauncherConfigStore {
    static func load() throws -> LauncherConfig {
        let url = Paths.launcherConfig
        guard FileManager.default.fileExists(atPath: url.path) else {
            return LauncherConfig()
        }
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(LauncherConfig.self, from: data)
    }

    static func save(_ cfg: LauncherConfig) throws {
        try Paths.ensureDirectories()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(cfg)
        let tmp = Paths.launcherConfig.appendingPathExtension("tmp.\(getpid())")
        try data.write(to: tmp, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tmp.path)
        _ = try FileManager.default.replaceItemAt(Paths.launcherConfig, withItemAt: tmp)
    }

    static func isFirstRun() -> Bool {
        !FileManager.default.fileExists(atPath: Paths.launcherConfig.path)
    }
}
