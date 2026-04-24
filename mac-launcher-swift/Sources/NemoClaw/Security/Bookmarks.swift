import Foundation
import AppKit

// Port of mac-launcher/lib/bookmarks.js. Every fs op against a user-mounted
// folder MUST go through Bookmarks.withAccess — otherwise the macOS sandbox
// denies with EPERM. Persisted bookmarks survive relaunch; startAccessing
// returns false (Swift) / nil (JS) if the OS has dropped them, at which
// point we mark the entry stale and the UI surfaces a re-auth button.
enum BookmarksError: Error, LocalizedError {
    case pathRequired
    case pathNotAbsolute(String)
    case pathTraversal
    case notInMountedFolder(String)
    case staleBookmark(String)
    case startAccessFailed(String)

    var errorDescription: String? {
        switch self {
        case .pathRequired: "Path required"
        case .pathNotAbsolute(let p): "Absolute path required: \(p)"
        case .pathTraversal: "Path traversal not allowed"
        case .notInMountedFolder(let p): "Path is not within a mounted folder: \(p)"
        case .staleBookmark(let p): "Mounted folder is stale; re-authorize before reading: \(p)"
        case .startAccessFailed(let p): "Failed to start security-scoped access: \(p)"
        }
    }
}

actor Bookmarks {
    static let shared = Bookmarks()

    // Tracks live access sessions per folder so unmount can release them
    // eagerly rather than waiting for URL deinit.
    private var liveHandles: [String: Int] = [:]

    struct ResolvedFolder {
        let path: String
        let url: URL
        let stale: Bool
    }

    // MARK: - Public API

    func withAccess<T>(path filePath: String, _ body: () async throws -> T) async throws -> T {
        let folder = try await validatePathInMountedFolders(filePath)
        let started = folder.url.startAccessingSecurityScopedResource()
        if started { liveHandles[folder.path, default: 0] += 1 }
        defer {
            if started {
                folder.url.stopAccessingSecurityScopedResource()
                if let count = liveHandles[folder.path] {
                    if count <= 1 { liveHandles.removeValue(forKey: folder.path) }
                    else { liveHandles[folder.path] = count - 1 }
                }
            }
        }
        return try await body()
    }

    // Probes each persisted bookmark. Marks entries stale if the OS has
    // dropped them. Call once at app launch.
    func validateAtBoot() throws {
        var cfg = (try? LauncherConfigStore.load()) ?? LauncherConfig()
        for i in cfg.mountedFolders.indices {
            let folder = cfg.mountedFolders[i]
            var isStale = false
            do {
                let url = try URL(resolvingBookmarkData: folder.bookmark,
                                  options: .withSecurityScope,
                                  relativeTo: nil,
                                  bookmarkDataIsStale: &isStale)
                let started = url.startAccessingSecurityScopedResource()
                if started { url.stopAccessingSecurityScopedResource() }
                cfg.mountedFolders[i].stale = (!started || isStale) ? true : nil
            } catch {
                cfg.mountedFolders[i].stale = true
            }
        }
        try LauncherConfigStore.save(cfg)
    }

    func mount(_ url: URL) throws -> LauncherConfig.MountedFolder {
        let data = try url.bookmarkData(options: .withSecurityScope,
                                        includingResourceValuesForKeys: nil,
                                        relativeTo: nil)
        let folder = LauncherConfig.MountedFolder(
            path: url.path,
            bookmark: data,
            addedAt: ISO8601DateFormatter().string(from: Date()),
            stale: nil
        )
        var cfg = (try? LauncherConfigStore.load()) ?? LauncherConfig()
        cfg.mountedFolders.removeAll { $0.path == folder.path }
        cfg.mountedFolders.append(folder)
        try LauncherConfigStore.save(cfg)
        return folder
    }

    func unmount(_ folderPath: String) throws {
        var cfg = (try? LauncherConfigStore.load()) ?? LauncherConfig()
        cfg.mountedFolders.removeAll { $0.path == folderPath }
        try LauncherConfigStore.save(cfg)
        liveHandles.removeValue(forKey: folderPath)
    }

    func listPublic() -> [(path: String, addedAt: String, stale: Bool)] {
        let cfg = (try? LauncherConfigStore.load()) ?? LauncherConfig()
        return cfg.mountedFolders.map { ($0.path, $0.addedAt, $0.stale ?? false) }
    }

    // MARK: - Internal

    private func validatePathInMountedFolders(_ filePath: String) async throws -> ResolvedFolder {
        guard !filePath.isEmpty else { throw BookmarksError.pathRequired }
        guard filePath.hasPrefix("/") else { throw BookmarksError.pathNotAbsolute(filePath) }
        guard !filePath.contains("..") else { throw BookmarksError.pathTraversal }

        let resolved = (try? URL(fileURLWithPath: filePath).resolvingSymlinksInPath().path)
            ?? (filePath as NSString).standardizingPath

        let cfg = (try? LauncherConfigStore.load()) ?? LauncherConfig()
        var staleMatch: LauncherConfig.MountedFolder?

        for folder in cfg.mountedFolders {
            let root = (try? URL(fileURLWithPath: folder.path).resolvingSymlinksInPath().path)
                ?? (folder.path as NSString).standardizingPath
            let within = resolved == root || resolved.hasPrefix(root + "/")
            guard within else { continue }

            if folder.stale == true { staleMatch = folder; continue }

            var isStale = false
            let url = try URL(resolvingBookmarkData: folder.bookmark,
                              options: .withSecurityScope,
                              relativeTo: nil,
                              bookmarkDataIsStale: &isStale)
            return ResolvedFolder(path: folder.path, url: url, stale: isStale)
        }

        if let stale = staleMatch {
            throw BookmarksError.staleBookmark(stale.path)
        }
        throw BookmarksError.notInMountedFolder(filePath)
    }
}
