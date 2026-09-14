import Foundation

/// A SIP registration. The password is kept in the Keychain (see `KeychainStore`),
/// never in this struct's persisted form.
struct SIPAccount: Identifiable, Codable, Hashable {
    var id: UUID
    var profileID: UUID
    /// Sidebar name. Empty means "username@domain".
    var label: String
    /// Display name sent in the From header.
    var displayName: String
    var username: String
    /// Empty means "same as username".
    var authUsername: String
    /// SIP domain / realm used in the address of record.
    var domain: String
    /// Registrar and outbound proxy host. Empty means "same as domain".
    var server: String
    /// nil means the transport's default port.
    var port: Int?
    var transport: SIPTransport
    var isEnabled: Bool
    var registrationExpiry: Int
    var srtp: SRTPMode
    var stunServer: String
    var useICE: Bool
    var voicemailNumber: String
    var callerIDName: String
    var callerIDNumber: String
    var notes: String
    var sortOrder: Int
    var createdAt: Date
    var updatedAt: Date
    /// Where the account came from ("manual", "fusionpbx", ...).
    var source: String

    init(id: UUID = UUID(),
         profileID: UUID,
         label: String = "",
         displayName: String = "",
         username: String,
         authUsername: String = "",
         domain: String,
         server: String = "",
         port: Int? = nil,
         transport: SIPTransport = .udp,
         isEnabled: Bool = true,
         registrationExpiry: Int = 300,
         srtp: SRTPMode = .disabled,
         stunServer: String = "",
         useICE: Bool = false,
         voicemailNumber: String = "*97",
         callerIDName: String = "",
         callerIDNumber: String = "",
         notes: String = "",
         sortOrder: Int = 0,
         createdAt: Date = Date.stamp(),
         updatedAt: Date? = nil,
         source: String = "manual") {
        self.id = id
        self.profileID = profileID
        self.label = label
        self.displayName = displayName
        self.username = username
        self.authUsername = authUsername
        self.domain = domain
        self.server = server
        self.port = port
        self.transport = transport
        self.isEnabled = isEnabled
        self.registrationExpiry = registrationExpiry
        self.srtp = srtp
        self.stunServer = stunServer
        self.useICE = useICE
        self.voicemailNumber = voicemailNumber
        self.callerIDName = callerIDName
        self.callerIDNumber = callerIDNumber
        self.notes = notes
        self.sortOrder = sortOrder
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
        self.source = source
    }

    private enum CodingKeys: String, CodingKey {
        case id, profileID, label, displayName, username, authUsername, domain, server, port
        case transport, isEnabled, registrationExpiry, srtp, stunServer
        case useICE, voicemailNumber, callerIDName, callerIDNumber, notes, sortOrder, createdAt, updatedAt, source
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        profileID = try c.decode(UUID.self, forKey: .profileID)
        label = c.decode(.label, default: "")
        displayName = c.decode(.displayName, default: "")
        username = try c.decode(String.self, forKey: .username)
        authUsername = c.decode(.authUsername, default: "")
        domain = try c.decode(String.self, forKey: .domain)
        server = c.decode(.server, default: "")
        port = c.decodeOptional(.port)
        transport = c.decode(.transport, default: SIPTransport.udp)
        isEnabled = c.decode(.isEnabled, default: true)
        registrationExpiry = c.decode(.registrationExpiry, default: 300)
        srtp = c.decode(.srtp, default: SRTPMode.disabled)
        stunServer = c.decode(.stunServer, default: "")
        useICE = c.decode(.useICE, default: false)
        voicemailNumber = c.decode(.voicemailNumber, default: "*97")
        callerIDName = c.decode(.callerIDName, default: "")
        callerIDNumber = c.decode(.callerIDNumber, default: "")
        notes = c.decode(.notes, default: "")
        sortOrder = c.decode(.sortOrder, default: 0)
        createdAt = c.decode(.createdAt, default: Date())
        updatedAt = c.decode(.updatedAt, default: createdAt)
        source = c.decode(.source, default: "manual")
    }

    // MARK: Derived values

    var effectiveAuthUsername: String { authUsername.isEmpty ? username : authUsername }
    var effectiveServer: String { server.isEmpty ? domain : server }
    var effectivePort: Int { port ?? transport.defaultPort }
    var usesSeparateServer: Bool { !server.isEmpty && server.caseInsensitiveCompare(domain) != .orderedSame }

    /// Name shown in lists.
    var displayLabel: String { label.isEmpty ? defaultLabel : label }
    var defaultLabel: String { "\(username)@\(domain)" }

    /// Address of record, e.g. `"Ben" <sip:1001@pbx.example.com>`.
    var addressOfRecord: String {
        let uri = "sip:\(username)@\(domain)"
        let name = displayName.trimmingCharacters(in: .whitespaces)
        if name.isEmpty { return uri }
        let escaped = name.replacingOccurrences(of: "\"", with: "'")
        return "\"\(escaped)\" <\(uri)>"
    }

    /// Registrar URI. Always the domain; the proxy carries the transport and host.
    var registrarURI: String {
        "sip:\(domain)\(transportParameter)"
    }

    /// Outbound proxy URI (`sip:host:port;transport=tcp;lr`).
    var proxyURI: String {
        "sip:\(bracketedHost(effectiveServer)):\(effectivePort)\(transportParameter);lr"
    }

    private var transportParameter: String {
        switch transport {
        case .udp: return ";transport=udp"
        case .tcp: return ";transport=tcp"
        case .tls: return ";transport=tls"
        }
    }

    private func bracketedHost(_ host: String) -> String {
        host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
    }

    /// Builds a dialable SIP URI for a number or address typed by the user.
    func callURI(for target: String) -> String {
        let trimmed = target.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.lowercased().hasPrefix("sip:") || trimmed.lowercased().hasPrefix("sips:") {
            return trimmed
        }
        if trimmed.contains("@") {
            return "sip:\(trimmed)"
        }
        let digits = SIPAccount.normaliseDialString(trimmed)
        return "sip:\(digits)@\(domain)\(transportParameter)"
    }

    /// Removes spaces, dashes, brackets and dots from a phone number while keeping
    /// `+`, `*` and `#`.
    static func normaliseDialString(_ raw: String) -> String {
        let allowed = Set("0123456789+*#ABCDabcd")
        return raw.filter { allowed.contains($0) }
    }

    /// Duplicate rule from docs/PROTOCOL.md: same username and (case-insensitive) domain.
    func matches(username other: String, domain otherDomain: String) -> Bool {
        username == other && domain.caseInsensitiveCompare(otherDomain) == .orderedSame
    }

    /// Validation errors for the editor and importer.
    var validationErrors: [String] {
        var errors: [String] = []
        if username.trimmingCharacters(in: .whitespaces).isEmpty { errors.append("Username is required.") }
        if domain.trimmingCharacters(in: .whitespaces).isEmpty { errors.append("Domain is required.") }
        if domain.contains(where: { $0.isWhitespace }) { errors.append("Domain must not contain spaces.") }
        if let port, !(1...65535).contains(port) { errors.append("Port must be between 1 and 65535.") }
        if !(60...86400).contains(registrationExpiry) { errors.append("Registration expiry must be between 60 and 86400 seconds.") }
        return errors
    }
}
