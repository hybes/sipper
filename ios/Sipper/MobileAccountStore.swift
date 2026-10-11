import Foundation
import SipperManaged

struct SavedMobileAccount: Codable {
    var account: SIPAccount
    var password: String
}

struct MobileImportReview: Identifiable {
    let id = UUID()
    let revision: Int
    var candidates: [ImportCandidate]
}

enum MobileImportError: LocalizedError {
    case invalidLink, changed, selection, activeCall
    var errorDescription: String? {
        switch self {
        case .invalidLink: return "Enter a valid Sipper account import link (version 1, up to 512 KiB)."
        case .changed: return "Accounts changed while you were reviewing. Cancel and open the import again."
        case .selection: return "Select at least one valid account."
        case .activeCall: return "Finish this account’s call before replacing its settings."
        }
    }
}

/// One atomic, device-only Keychain item; no SIP secrets in preferences or exported JSON.
final class MobileAccountStore {
    private let storage: ManagedSecretStore
    private(set) var entries: [SavedMobileAccount] = []
    private var revision = 0
    init(storage: ManagedSecretStore) throws {
        self.storage = storage
        if let data = try storage.read("manual-accounts") {
            entries = try JSONDecoder().decode([SavedMobileAccount].self, from: data)
            guard Set(entries.map(\.account.id)).count == entries.count else { throw MobileError.invalidAccount }
        }
    }
    static func validate(_ account: SIPAccount, password: String) throws {
        let hosts = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.:-[]")
        let users = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+_.-!~*'%")
        guard account.managed == nil, account.validationErrors.isEmpty, password.utf8.count <= 4096, !password.contains("\0"),
              account.username.count <= 256, account.username.unicodeScalars.allSatisfy(users.contains),
              account.authUsername.count <= 256, account.authUsername.rangeOfCharacter(from: .controlCharacters) == nil,
              account.label.count <= 160, account.displayName.count <= 160,
              account.label.rangeOfCharacter(from: .controlCharacters) == nil,
              account.displayName.rangeOfCharacter(from: .controlCharacters) == nil,
              [account.domain, account.effectiveServer].allSatisfy({ !$0.isEmpty && $0.count <= 253 && $0.unicodeScalars.allSatisfy(hosts.contains) })
        else { throw MobileError.invalidAccount }
    }
    func save(_ account: SIPAccount, password: String) throws {
        try Self.validate(account, password: password)
        var next = entries.filter { $0.account.id != account.id }
        guard next.count < 16 else { throw MobileError.accountLimit }
        next.append(SavedMobileAccount(account: account, password: password))
        try commit(next)
    }
    func remove(_ id: UUID) throws { try commit(entries.filter { $0.account.id != id }) }
    func reviewImport(_ link: String) throws -> MobileImportReview {
        guard link.utf8.count <= ImportParser.maxPayloadBytes * 2 + 1024, let url = URL(string: link.trimmingCharacters(in: .whitespacesAndNewlines)) else { throw MobileImportError.invalidLink }
        let request: ImportRequest
        do { request = try ImportParser.parse(url: url) } catch { throw MobileImportError.invalidLink }
        guard request.candidates.count <= 16 else { throw MobileError.accountLimit }
        func identity(_ account: SIPAccount) -> String { account.username + "\0" + account.domain.lowercased() }
        let counts = Dictionary(grouping: request.candidates, by: { identity($0.account) })
        let candidates = request.candidates.map { original -> ImportCandidate in
            var candidate = original
            let matches = entries.filter { identity($0.account) == identity(candidate.account) }
            if counts[identity(candidate.account)]!.count > 1 || matches.count > 1 {
                candidate.validationErrors = ["This SIP account appears more than once. Import one copy at a time."]
            } else if let saved = matches.first {
                candidate.existingAccountID = saved.account.id
                var account = saved.account
                let draft = candidate.account
                account.authUsername = draft.authUsername; account.server = draft.server
                account.port = draft.port; account.transport = draft.transport
                account.voicemailNumber = draft.voicemailNumber
                account.callerIDName = draft.callerIDName; account.callerIDNumber = draft.callerIDNumber
                if !draft.displayName.isEmpty { account.displayName = draft.displayName }
                if account.label.isEmpty { account.label = draft.label }
                if !draft.notes.isEmpty { account.notes = draft.notes }
                account.source = draft.source; account.updatedAt = Date()
                candidate.account = account
            }
            do { try Self.validate(candidate.account, password: candidate.password) }
            catch { candidate.validationErrors.append("Invalid settings") }
            if !candidate.validationErrors.isEmpty && matches.count <= 1 && counts[identity(original.account)]!.count == 1 {
                candidate.validationErrors = ["Check this account’s username, password and connection settings."]
            }
            return candidate
        }
        return MobileImportReview(revision: revision, candidates: candidates)
    }
    func importAccounts(_ review: MobileImportReview, selected: Set<UUID>, activeAccounts: Set<UUID>) throws {
        guard review.revision == revision else { throw MobileImportError.changed }
        let candidates = review.candidates.filter { selected.contains($0.id) }
        guard !candidates.isEmpty, candidates.count == selected.count, candidates.allSatisfy(\.isValid) else { throw MobileImportError.selection }
        var next = entries
        for candidate in candidates {
            guard !activeAccounts.contains(candidate.account.id) else { throw MobileImportError.activeCall }
            try Self.validate(candidate.account, password: candidate.password)
            next.removeAll { $0.account.id == candidate.account.id }
            next.append(SavedMobileAccount(account: candidate.account, password: candidate.password))
        }
        guard next.count <= 16 else { throw MobileError.accountLimit }
        try commit(next)
    }
    private func commit(_ next: [SavedMobileAccount]) throws {
        try storage.write(JSONEncoder().encode(next), key: "manual-accounts")
        entries = next // A failed Keychain write must not change the active credentials.
        revision += 1
    }
}

enum MobileError: Error, LocalizedError {
    case invalidAccount, accountLimit, microphoneDenied, accountUnavailable, callUnavailable, invalidNumber
    var errorDescription: String? {
        switch self {
        case .invalidAccount: return "Check the username, password, domain and server. Use a valid port and remove spaces from addresses."
        case .accountLimit: return "You can save up to 16 personal accounts on this device."
        case .microphoneDenied: return "Allow microphone access for Sipper in Settings to make or answer calls."
        case .accountUnavailable: return "This calling account is unavailable. Check its registration or contact your administrator."
        case .callUnavailable: return "Finish connecting or transferring your call before starting another. Sipper supports two calls at a time."
        case .invalidNumber: return "Enter a phone number or SIP address."
        }
    }
}
