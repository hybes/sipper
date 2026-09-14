import Foundation
import Security

enum PasswordLookup: Equatable {
    case found(String)
    case missing
    case denied(OSStatus)

    var value: String? {
        if case .found(let password) = self { return password }
        return nil
    }
}

protocol PasswordStore: AnyObject {
    func lookup(for accountID: UUID) -> PasswordLookup
    func setPassword(_ password: String, for accountID: UUID) throws
    func removePassword(for accountID: UUID)
    /// Whether new items should be carried by iCloud Keychain.
    var synchronizable: Bool { get set }
}

extension PasswordStore {
    func password(for accountID: UUID) -> String? { lookup(for: accountID).value }
}

enum PasswordStoreError: LocalizedError {
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .keychain(let status):
            let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
            return "Keychain error: \(message)"
        }
    }
}

/// Stores SIP passwords as generic password items in the login keychain. With
/// `synchronizable` on, items are written as iCloud Keychain items so they follow
/// the accounts to the user's other Macs.
///
/// Note on prompts: macOS ties each item to the code signature of the app that
/// created it. Ad-hoc signed builds get a new signature on every build, so each
/// rebuild triggers a "Sipper wants to use your confidential information" prompt.
/// Signing with a stable identity (`make app TEAM=…`) avoids that.
final class KeychainPasswordStore: PasswordStore {
    private let service: String
    var synchronizable = false

    init(service: String = "com.hybes.sipper.sip-account") {
        self.service = service
    }

    private func baseQuery(for accountID: UUID) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: accountID.uuidString,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ]
    }

    func lookup(for accountID: UUID) -> PasswordLookup {
        var query = baseQuery(for: accountID)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data, let password = String(data: data, encoding: .utf8) else { return .missing }
            return .found(password)
        case errSecItemNotFound:
            return .missing
        default:
            return .denied(status)
        }
    }

    func setPassword(_ password: String, for accountID: UUID) throws {
        let data = Data(password.utf8)
        // Local and iCloud items are distinct; write the wanted one first and only then
        // remove the other kind, so a failure never leaves the account without a password.
        var wanted: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: accountID.uuidString,
            kSecAttrSynchronizable as String: synchronizable,
        ]
        let update: [String: Any] = [kSecValueData as String: data, kSecAttrLabel as String: "Sipper SIP account"]
        var status = SecItemUpdate(wanted as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            wanted[kSecValueData as String] = data
            wanted[kSecAttrLabel as String] = "Sipper SIP account"
            status = SecItemAdd(wanted as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw PasswordStoreError.keychain(status) }
        var other: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: accountID.uuidString,
            kSecAttrSynchronizable as String: !synchronizable,
        ]
        other.removeValue(forKey: "")
        SecItemDelete(other as CFDictionary)
    }

    func removePassword(for accountID: UUID) {
        SecItemDelete(baseQuery(for: accountID) as CFDictionary)
    }
}

/// Used by unit tests and previews.
final class InMemoryPasswordStore: PasswordStore {
    private var passwords: [UUID: String] = [:]
    private let lock = NSLock()
    var synchronizable = false

    func lookup(for accountID: UUID) -> PasswordLookup {
        lock.lock(); defer { lock.unlock() }
        return passwords[accountID].map { .found($0) } ?? .missing
    }

    func setPassword(_ password: String, for accountID: UUID) throws {
        lock.lock(); defer { lock.unlock() }
        passwords[accountID] = password
    }

    func removePassword(for accountID: UUID) {
        lock.lock(); defer { lock.unlock() }
        passwords[accountID] = nil
    }
}
