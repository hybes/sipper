import Foundation

/// Wire format described in docs/PROTOCOL.md.
struct ImportDocument: Codable {
    struct Source: Codable {
        var provider: String?
        var url: String?
        var title: String?
    }

    struct ProfileHint: Codable {
        var name: String?
    }

    struct Account: Codable {
        var label: String?
        var displayName: String?
        var username: String?
        var authUsername: String?
        var password: String?
        var domain: String?
        var server: String?
        var port: Int?
        var transport: String?
        var callerIdName: String?
        var callerIdNumber: String?
        var voicemailNumber: String?
        var notes: String?
    }

    var version: Int
    var source: Source?
    var profile: ProfileHint?
    var accounts: [Account]
}

enum ImportError: LocalizedError, Equatable {
    case notAnImportURL
    case missingPayload
    case payloadTooLarge
    case invalidBase64
    case invalidJSON(String)
    case unsupportedVersion(Int)
    case noAccounts

    var errorDescription: String? {
        switch self {
        case .notAnImportURL: return "This link is not a Sipper import link."
        case .missingPayload: return "The import link has no payload."
        case .payloadTooLarge: return "The import payload is too large."
        case .invalidBase64: return "The import payload is not valid base64url."
        case .invalidJSON(let detail): return "The import payload is not valid JSON (\(detail))."
        case .unsupportedVersion(let v): return "Import format version \(v) is not supported by this version of Sipper."
        case .noAccounts: return "The import contains no accounts."
        }
    }
}

/// One account from an import, validated and ready to become a `SIPAccount`.
struct ImportCandidate: Identifiable, Hashable {
    let id = UUID()
    var account: SIPAccount
    var password: String
    var validationErrors: [String]
    /// Set by the app when an account with the same username and domain exists.
    var existingAccountID: UUID?

    var isValid: Bool { validationErrors.isEmpty }
    var isUpdate: Bool { existingAccountID != nil }
}

struct ImportRequest {
    var provider: String
    var sourceURL: String?
    var sourceTitle: String?
    var profileName: String?
    var candidates: [ImportCandidate]

    var validCount: Int { candidates.filter(\.isValid).count }
}

enum ImportParser {
    static let scheme = "sipper"
    static let action = "add-accounts"
    static let maxPayloadBytes = 512 * 1024

    static func isImportURL(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == scheme else { return false }
        return actionName(of: url) == action
    }

    private static func actionName(of url: URL) -> String {
        if let host = url.host, !host.isEmpty { return host.lowercased() }
        return url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")).lowercased()
    }

    static func parse(url: URL) throws -> ImportRequest {
        guard isImportURL(url) else { throw ImportError.notAnImportURL }
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        guard let payload = components?.queryItems?.first(where: { $0.name == "payload" })?.value,
              !payload.isEmpty else {
            throw ImportError.missingPayload
        }
        guard payload.utf8.count <= maxPayloadBytes * 2 else { throw ImportError.payloadTooLarge }
        guard let data = decodeBase64URL(payload) else { throw ImportError.invalidBase64 }
        return try parse(json: data)
    }

    static func parse(json data: Data) throws -> ImportRequest {
        guard data.count <= maxPayloadBytes else { throw ImportError.payloadTooLarge }
        let document: ImportDocument
        do {
            document = try JSONDecoder().decode(ImportDocument.self, from: data)
        } catch {
            throw ImportError.invalidJSON(describe(error))
        }
        return try request(from: document)
    }

    static func request(from document: ImportDocument) throws -> ImportRequest {
        guard document.version == 1 else { throw ImportError.unsupportedVersion(document.version) }
        guard !document.accounts.isEmpty else { throw ImportError.noAccounts }

        let provider = clean(document.source?.provider) ?? "manual"
        let candidates = document.accounts.map { candidate(from: $0, provider: provider) }
        return ImportRequest(provider: provider,
                             sourceURL: clean(document.source?.url),
                             sourceTitle: clean(document.source?.title),
                             profileName: clean(document.profile?.name),
                             candidates: candidates)
    }

    private static func candidate(from raw: ImportDocument.Account, provider: String) -> ImportCandidate {
        var errors: [String] = []

        let username = clean(raw.username) ?? ""
        let domain = clean(raw.domain) ?? ""
        // Passwords are kept verbatim; only an empty or whitespace-only password is invalid.
        let password = (raw.password ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : (raw.password ?? "")
        if username.isEmpty { errors.append("Username is missing.") }
        if domain.isEmpty { errors.append("Domain is missing.") }
        if password.isEmpty { errors.append("Password is missing.") }

        var transport = SIPTransport.udp
        if let rawTransport = clean(raw.transport) {
            if let parsed = SIPTransport(loosely: rawTransport) {
                transport = parsed
            } else {
                errors.append("Unknown transport “\(rawTransport)”.")
            }
        }

        var port: Int? = nil
        if let rawPort = raw.port {
            if (1...65535).contains(rawPort) {
                port = rawPort == transport.defaultPort ? nil : rawPort
            } else {
                errors.append("Port \(rawPort) is out of range.")
            }
        }

        let server = clean(raw.server) ?? ""
        let account = SIPAccount(
            profileID: UUID(),
            label: clean(raw.label) ?? "",
            displayName: clean(raw.displayName) ?? "",
            username: username,
            authUsername: clean(raw.authUsername).flatMap { $0 == username ? nil : $0 } ?? "",
            domain: domain,
            server: server.caseInsensitiveCompare(domain) == .orderedSame ? "" : server,
            port: port,
            transport: transport,
            voicemailNumber: clean(raw.voicemailNumber) ?? "*97",
            callerIDName: clean(raw.callerIdName) ?? "",
            callerIDNumber: clean(raw.callerIdNumber) ?? "",
            notes: clean(raw.notes) ?? "",
            source: provider
        )
        return ImportCandidate(account: account, password: password, validationErrors: errors)
    }

    // MARK: Helpers

    static func clean(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func decodeBase64URL(_ input: String) -> Data? {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        s = s.replacingOccurrences(of: "=", with: "")
        let remainder = s.count % 4
        if remainder == 1 { return nil }
        if remainder > 0 { s += String(repeating: "=", count: 4 - remainder) }
        return Data(base64Encoded: s)
    }

    static func encodeBase64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Builds an import URL; used by tests and by the native messaging host.
    static func makeURL(jsonData: Data) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = action
        components.queryItems = [URLQueryItem(name: "payload", value: encodeBase64URL(jsonData))]
        return components.url
    }

    private static func describe(_ error: Error) -> String {
        if let decoding = error as? DecodingError {
            switch decoding {
            case .keyNotFound(let key, _): return "missing key “\(key.stringValue)”"
            case .typeMismatch(_, let ctx), .valueNotFound(_, let ctx), .dataCorrupted(let ctx):
                return ctx.debugDescription
            @unknown default: return String(describing: decoding)
            }
        }
        return error.localizedDescription
    }
}
