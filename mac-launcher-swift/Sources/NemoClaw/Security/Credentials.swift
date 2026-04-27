import Foundation
import Security

// Keychain-backed credential store. Replaces mac-launcher/lib/secure-credentials.js
// (which used Electron's safeStorage + a JSON file). Each credential becomes
// a generic-password item in the shared access group so NemoClaw helpers
// (signed with inherit entitlements) can read them.
//
// Migration from Electron: safeStorage-encrypted blobs in
// ~/.nemoclaw/credentials.json can't be decrypted from native code
// (the key is stored by Electron's Chromium osCrypt namespace), so we
// import only plaintext entries and leave a marker asking the user to
// re-enter the encrypted ones.
enum CredentialsError: Error, LocalizedError {
    case invalidKey
    case invalidValue
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .invalidKey: "invalid_key"
        case .invalidValue: "invalid_value_type"
        case .keychain(let s): "keychain error: \(s)"
        }
    }
}

enum Credentials {
    private static let service = "com.nemoclaw.launcher.credentials"
    private static let hiddenKeys: Set<String> = ["OPENAI_API_KEY"]

    static func write(key: String, value: String) throws {
        guard !key.isEmpty else { throw CredentialsError.invalidKey }

        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]

        let updateStatus = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        switch updateStatus {
        case errSecSuccess: return
        case errSecItemNotFound:
            var addQuery = query
            addQuery.merge(attrs) { _, new in new }
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            if addStatus != errSecSuccess { throw CredentialsError.keychain(addStatus) }
        default:
            throw CredentialsError.keychain(updateStatus)
        }
    }

    static func read(key: String) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var out: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        switch status {
        case errSecSuccess:
            return (out as? Data).flatMap { String(data: $0, encoding: .utf8) }
        case errSecItemNotFound:
            return nil
        default:
            throw CredentialsError.keychain(status)
        }
    }

    static func delete(key: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            throw CredentialsError.keychain(status)
        }
    }

    static func has(key: String) -> Bool {
        (try? read(key: key)) != nil
    }

    static func listKeys() throws -> [String] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll
        ]
        var out: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        switch status {
        case errSecSuccess:
            let items = (out as? [[String: Any]]) ?? []
            return items
                .compactMap { $0[kSecAttrAccount as String] as? String }
                .filter { !hiddenKeys.contains($0) }
                .sorted()
        case errSecItemNotFound:
            return []
        default:
            throw CredentialsError.keychain(status)
        }
    }

    // One-shot import from an Electron install's credentials.json. Keeps
    // only plaintext entries — encrypted blobs require safeStorage to read.
    static func migrateFromElectron() {
        let url = Paths.nemoclawDir.appending(path: "credentials.json")
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let entries = obj["entries"] as? [String: [String: Any]] else { return }

        for (key, entry) in entries {
            let encrypted = entry["_encrypted"] as? Bool ?? false
            if encrypted { continue }
            guard let value = entry["value"] as? String else { continue }
            if key == "OPENAI_API_KEY" && value == "ollama" { continue }
            try? write(key: key, value: value)
        }
    }
}
