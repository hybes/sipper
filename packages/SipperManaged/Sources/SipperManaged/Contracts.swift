import Foundation

public struct ManagedIdentity: Codable, Equatable, Sendable {
    public let id: String
    public let email: String
}
public enum ManagedAvailability: String, Codable, CaseIterable, Sendable {
    case unset, available, away, busy
    public var label: String { self == .unset ? "Not set" : rawValue.capitalized }
}
public struct ManagedOrganisation: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let name: String
    public let status: String
    public let licensed: Bool
    /// Nil means the preference has not been confirmed by this server/session.
    public var doNotDisturb: Bool? = nil
    public var availability: ManagedAvailability? = nil
}
public struct OrganisationList: Codable, Sendable {
    public let user: ManagedIdentity
    public let organisations: [ManagedOrganisation]
}
public struct EnrolledDevice: Codable, Sendable {
    public let id: UUID
    public let name: String
    public let platform: String
}
public struct DeviceRegistration: Codable, Equatable, Sendable {
    public let installationId: UUID
    public let name: String
    public let platform: String
    public let appVersion: String
    public let osVersion: String

    public init(installationId: UUID, name: String, platform: String, appVersion: String, osVersion: String) {
        self.installationId = installationId; self.name = name; self.platform = platform
        self.appVersion = appVersion; self.osVersion = osVersion
    }
}
public struct ManagedConfiguration: Codable, Equatable, Sendable {
    public struct Organisation: Codable, Equatable, Sendable {
        public let id: UUID
        public let name: String
    }
    public let schemaVersion: Int
    public let organisation: Organisation
    public let deviceId: UUID
    public let revision: String
    public let expiresAt: Date
    public let accounts: [ManagedCallingAccount]

    public func validate(organisationID: UUID, deviceID: UUID, now: Date = Date()) throws {
        guard schemaVersion == 1 else { throw ManagedError.unsupportedConfiguration }
        guard organisation.id == organisationID, deviceId == deviceID else { throw ManagedError.invalidConfiguration }
        guard expiresAt > now, expiresAt.timeIntervalSince(now) <= 86400 + 60 else { throw ManagedError.expiredConfiguration }
        guard revision.count == 64, revision.allSatisfy({ $0.isHexDigit }), Set(accounts.map(\.id)).count == accounts.count else { throw ManagedError.invalidConfiguration }
        for account in accounts { try account.validate() }
    }
}
public struct ManagedCallingAccount: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let label: String
    public let mode: String
    public let revision: Int
    public let settings: ManagedSIPSettings
    public let password: String
    /// Absent on older servers. Only direct accounts use client-side admission.
    public var doNotDisturb: Bool? = nil

    private enum CodingKeys: String, CodingKey { case id, label, mode, revision, settings, password, doNotDisturb }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id); label = try c.decode(String.self, forKey: .label)
        mode = try c.decode(String.self, forKey: .mode); revision = try c.decode(Int.self, forKey: .revision)
        settings = try c.decode(ManagedSIPSettings.self, forKey: .settings); password = try c.decode(String.self, forKey: .password)
        doNotDisturb = c.contains(.doNotDisturb) ? try c.decode(Bool.self, forKey: .doNotDisturb) : nil
    }

    public func validate() throws {
        guard ["direct", "gateway"].contains(mode), revision > 0, !password.isEmpty, password.utf8.count <= 4096 else { throw ManagedError.invalidConfiguration }
        try settings.validate()
        guard mode != "gateway" || (settings.transport == "tls" && settings.srtp == "required") else {
            throw ManagedError.invalidConfiguration
        }
    }
}
public struct ManagedSIPSettings: Codable, Equatable, Sendable {
    public let username: String
    public let authUsername: String
    public let domain: String
    public let server: String
    public let port: Int?
    public let transport: String
    public let srtp: String
    public let displayName: String
    public let voicemailNumber: String
    public let useICE: Bool
    public let stunServer: String

    public func validate() throws {
        let hostCharacters = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.:-[]")
        func host(_ value: String) -> Bool { !value.isEmpty && value.count <= 253 && value.unicodeScalars.allSatisfy(hostCharacters.contains) }
        guard !username.isEmpty, host(domain), host(server), port.map({ (1...65535).contains($0) }) ?? true,
              ["udp", "tcp", "tls"].contains(transport), ["disabled", "optional", "required"].contains(srtp),
              stunServer.isEmpty || host(stunServer) else { throw ManagedError.invalidConfiguration }
        for value in [username, authUsername, displayName, voicemailNumber] {
            guard value.count <= 512, value.rangeOfCharacter(from: .controlCharacters) == nil else { throw ManagedError.invalidConfiguration }
        }
    }
}
public struct ManagedDeviceReport: Encodable, Sendable, Equatable {
    public struct DirectCalls: Encodable, Sendable, Equatable {
        public let accountId: UUID
        public var ringing = 0, dialling = 0, connected = 0, held = 0
        public init(accountID: UUID) { self.accountId = accountID }
    }
    public struct Registration: Encodable, Sendable, Equatable {
        public let accountId: UUID
        public let state: String
        public let sipCode: Int?
        public init(accountID: UUID, state: String, sipCode: Int? = nil) {
            self.accountId = accountID; self.state = state; self.sipCode = sipCode
        }
    }
    public let appliedRevision: String?
    public let registrations: [Registration]?
    public let directCalls: [DirectCalls]?
    public let configurationError: String?
    public init(appliedRevision: String? = nil, registrations: [Registration]? = nil, directCalls: [DirectCalls]? = nil, configurationError: String? = nil) {
        self.appliedRevision = appliedRevision; self.registrations = registrations; self.configurationError = configurationError
        self.directCalls = directCalls
    }
}
public enum ManagedError: Error, LocalizedError, Equatable {
    case signInRequired, cancelled, invalidServer, invalidConfiguration, unsupportedConfiguration, expiredConfiguration
    case storageUnavailable, requestFailed, accessUnavailable(String), serverUnavailable, callUnavailable, invalidSetupLink
    case invalidDirectory, directoryChanged, directoryTooLarge, configurationChanged
    case invalidMessages, invalidMessageInput, messagesChanged, messageRateLimit
    case invalidMeeting, meetingUnavailable, meetingChanged, meetingRateLimit
    public var errorDescription: String? {
        switch self {
        case .signInRequired: return "Sign in to refresh your managed accounts."
        case .cancelled: return "Sign-in was cancelled."
        case .invalidServer: return "Use a secure Sipper server address."
        case .invalidSetupLink: return "Use a setup link from your Sipper administrator for this management server."
        case .invalidDirectory: return "The company directory could not be verified. Refresh it and try again."
        case .invalidMessages: return "These messages could not be verified. Refresh the conversation."
        case .invalidMessageInput: return "Choose active colleagues and enter plain text within the message limit."
        case .messagesChanged: return "This message or conversation has changed. Reload the latest messages."
        case .messageRateLimit: return "Wait before sending another message or starting a conversation."
        case .invalidMeeting: return "This meeting response could not be verified. Refresh the meeting."
        case .meetingUnavailable: return "Meetings are unavailable for this customer or conversation."
        case .meetingChanged: return "This meeting has changed. Refresh it before trying again."
        case .meetingRateLimit: return "Wait before starting or joining another meeting."
        case .directoryChanged: return "The company directory changed while loading. Refresh it and try again."
        case .configurationChanged: return "Your managed settings changed. Refresh them and try again."
        case .directoryTooLarge: return "This company directory exceeds this app’s local limit. Contact your administrator."
        case .invalidConfiguration: return "The managed calling configuration could not be verified."
        case .unsupportedConfiguration: return "Update Sipper to use this managed configuration."
        case .expiredConfiguration: return "Your managed configuration has expired. Connect to refresh it."
        case .storageUnavailable: return "Sipper could not save credentials securely on this device."
        case .requestFailed: return "Sipper could not complete this request."
        case .accessUnavailable(let message): return message
        case .serverUnavailable: return "The management service is unavailable. Try again shortly."
        case .callUnavailable: return "This incoming call is no longer available."
        }
    }
}
