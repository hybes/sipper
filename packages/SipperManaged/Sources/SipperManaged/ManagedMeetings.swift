import Foundation

/// Meeting responses and media grants are deliberately Decodable only and remain in memory.
public struct ManagedMeeting: Decodable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let conversationId: UUID
    public let createdBy: String?
    public let createdAt: Date
    public let expiresAt: Date
    public let endedAt: Date?
    public let controlConfirmedAt: Date?

    func validate() throws {
        guard createdBy == nil || messagingText(createdBy!, limit: 128),
              expiresAt > createdAt, expiresAt.timeIntervalSince(createdAt) <= 86_401,
              controlConfirmedAt == nil || endedAt != nil else { throw ManagedError.invalidMeeting }
    }
}

public struct ManagedCurrentMeeting: Decodable, Sendable {
    public internal(set) var scope: ManagedMessageScope
    public let available: Bool
    public let meeting: ManagedMeeting?
    private enum CodingKeys: String, CodingKey { case available, meeting }
    public init(from decoder: Decoder) throws {
        scope = try ManagedMessageScope(from: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        available = try values.decode(Bool.self, forKey: .available)
        meeting = try values.decode(ManagedMeeting?.self, forKey: .meeting)
    }
    mutating func validate(for enrollment: ManagedEnrollment, conversationID: UUID) throws {
        try scope.validate(for: enrollment)
        try meeting?.validate()
        guard meeting == nil || meeting?.conversationId == conversationID else { throw ManagedError.invalidMeeting }
    }
}

public struct ManagedMeetingDetails: Decodable, Sendable {
    public struct Session: Decodable, Equatable, Identifiable, Sendable {
        public let id: UUID
        public let userId: String
        public let name: String?
        public let deviceId: UUID?
        public let revokedAt: Date?
        public let admittedAt: Date?
        public let controlConfirmedAt: Date?
    }
    public internal(set) var scope: ManagedMessageScope
    public let available: Bool
    public let canJoin: Bool
    public let title: String
    public let hostName: String?
    public let meeting: ManagedMeeting
    public let sessions: [Session]
    private enum CodingKeys: String, CodingKey { case available, canJoin, title, hostName, meeting, sessions }
    public init(from decoder: Decoder) throws {
        scope = try ManagedMessageScope(from: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        available = try values.decode(Bool.self, forKey: .available)
        canJoin = try values.decode(Bool.self, forKey: .canJoin)
        title = try values.decode(String.self, forKey: .title)
        hostName = try values.decode(String?.self, forKey: .hostName)
        meeting = try values.decode(ManagedMeeting.self, forKey: .meeting)
        sessions = try values.decode([Session].self, forKey: .sessions)
    }
    mutating func validate(for enrollment: ManagedEnrollment, meetingID: UUID, now: Date = Date()) throws {
        try scope.validate(for: enrollment, now: now); try meeting.validate()
        guard meeting.id == meetingID, messagingText(title, limit: 160),
              hostName == nil || messagingText(hostName!, limit: 160),
              sessions.count <= 100, Set(sessions.map(\.id)).count == sessions.count,
              !canJoin || (available && meeting.endedAt == nil && meeting.expiresAt > now) else { throw ManagedError.invalidMeeting }
        for session in sessions {
            guard messagingText(session.userId, limit: 128), session.name == nil || messagingText(session.name!, limit: 160),
                  session.controlConfirmedAt == nil || session.revokedAt != nil else { throw ManagedError.invalidMeeting }
        }
    }
}

struct ManagedMeetingResult: Decodable {
    var scope: ManagedMessageScope
    let meeting: ManagedMeeting
    private enum CodingKeys: String, CodingKey { case meeting }
    init(from decoder: Decoder) throws {
        scope = try ManagedMessageScope(from: decoder)
        meeting = try decoder.container(keyedBy: CodingKeys.self).decode(ManagedMeeting.self, forKey: .meeting)
    }
}

struct ManagedMeetingAcknowledgement: Decodable {
    var scope: ManagedMessageScope
    let meetingId: UUID
    let sessionId: UUID?
    let targetUserId: String?
    let leaveRequested: Bool?
    let removalRequested: Bool?
    private enum CodingKeys: String, CodingKey { case meetingId, sessionId, targetUserId, leaveRequested, removalRequested }
    init(from decoder: Decoder) throws {
        scope = try ManagedMessageScope(from: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        meetingId = try values.decode(UUID.self, forKey: .meetingId)
        sessionId = try values.decodeIfPresent(UUID.self, forKey: .sessionId)
        targetUserId = try values.decodeIfPresent(String.self, forKey: .targetUserId)
        leaveRequested = try values.decodeIfPresent(Bool.self, forKey: .leaveRequested)
        removalRequested = try values.decodeIfPresent(Bool.self, forKey: .removalRequested)
    }
}

public struct ManagedMeetingGrant: Decodable, Sendable {
    public let schemaVersion: Int
    public let organisationId: UUID
    public let meetingId: UUID
    public let sessionId: UUID
    public let identity: String
    public let url: URL
    public let token: String
    public let expiresAt: Date

    private struct Claims: Decodable {
        struct Video: Decodable {
            let room: String
            let roomJoin: Bool
            let canSubscribe: Bool
            let canPublish: Bool
            let canPublishSources: [String]
            let canPublishData: Bool
            let canUpdateOwnMetadata: Bool
        }
        let sub: String
        let iss: String
        let exp: Int
        let nbf: Int
        let video: Video
    }
    func validate(for enrollment: ManagedEnrollment, meetingID: UUID, sessionID: UUID, allowLocalDevelopment: Bool, now: Date = Date()) throws {
        let local = allowLocalDevelopment && url.scheme == "ws" && ["localhost", "127.0.0.1", "[::1]"].contains(url.host ?? "")
        let tokenCharacters = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.")
        guard (url.scheme == "wss" || local), url.host?.isEmpty == false, url.user == nil, url.password == nil,
              url.path.isEmpty || url.path == "/", url.query == nil, url.fragment == nil,
              schemaVersion == 1, organisationId == enrollment.organisationID, meetingId == meetingID, sessionId == sessionID,
              identity == "sipper:\(sessionID.uuidString.lowercased())", expiresAt > now, expiresAt.timeIntervalSince(now) <= 120,
              token.utf8.count <= 8192, token.unicodeScalars.allSatisfy({ tokenCharacters.contains($0) }) else { throw ManagedError.invalidMeeting }
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, let header = base64URL(parts[0]), let payload = base64URL(parts[1]), let signature = base64URL(parts[2]), signature.count == 32,
              let h = try? JSONSerialization.jsonObject(with: header) as? [String: Any], h["alg"] as? String == "HS256", h["typ"] == nil || h["typ"] as? String == "JWT",
              Set(h.keys).isSubset(of: ["alg", "typ"]),
              let raw = try? JSONSerialization.jsonObject(with: payload) as? [String: Any], let video = raw["video"] as? [String: Any],
              Set(raw.keys).isSubset(of: ["iss", "sub", "name", "metadata", "attributes", "exp", "nbf", "video"]),
              Set(video.keys) == ["room", "roomJoin", "canSubscribe", "canPublish", "canPublishSources", "canPublishData", "canUpdateOwnMetadata"],
              let claims = try? JSONDecoder().decode(Claims.self, from: payload) else { throw ManagedError.invalidMeeting }
        let sources = ["microphone", "camera", "screen_share", "screen_share_audio"]
        guard claims.sub == identity, messagingText(claims.iss, limit: 128), claims.video.room == "sipper-\(meetingID.uuidString.lowercased())",
              claims.video.roomJoin, claims.video.canSubscribe, claims.video.canPublish, !claims.video.canPublishData, !claims.video.canUpdateOwnMetadata,
              claims.video.canPublishSources.count == 4, Set(claims.video.canPublishSources) == Set(sources),
              Double(claims.exp) > now.timeIntervalSince1970, Double(claims.exp) <= now.timeIntervalSince1970 + 120,
              Double(claims.nbf) <= now.timeIntervalSince1970 + 30,
              abs(Double(claims.exp) - expiresAt.timeIntervalSince1970) <= 1.5 else { throw ManagedError.invalidMeeting }
        // Binding/privilege checks are not signature verification. The authenticated
        // portal supplies the grant; the Sipper proxy and SFU verify its signature.
    }
    private func base64URL(_ value: Substring) -> Data? {
        let base = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        return Data(base64Encoded: base + String(repeating: "=", count: (4 - base.count % 4) % 4))
    }
}
