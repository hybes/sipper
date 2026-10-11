import Foundation

/// A navigation hint only. Message access always comes from authenticated HTTP.
public struct ManagedMessageNotification: Decodable, Equatable, Sendable {
    private let schemaVersion: Int
    private let type: String
    public let deviceId: UUID
    public let conversationId: UUID
    public let expiresAt: Date
    public init(deviceId: UUID, conversationId: UUID, expiresAt: Date) {
        schemaVersion = 1; type = "message"; self.deviceId = deviceId; self.conversationId = conversationId; self.expiresAt = expiresAt
    }
    public var payload: [String: Any] {
        ["schemaVersion": 1, "type": "message", "deviceId": deviceId.uuidString, "conversationId": conversationId.uuidString,
         "expiresAt": ISO8601DateFormatter().string(from: expiresAt)]
    }
    public static func parse(apns payload: [AnyHashable: Any], now: Date = Date(), forRouting: Bool = false) -> Self? {
        guard let value = payload["sipper"] as? [String: Any],
              Set(value.keys) == ["schemaVersion", "type", "deviceId", "conversationId", "expiresAt"],
              ["type", "deviceId", "conversationId", "expiresAt"].allSatisfy({ (value[$0] as? String).map { $0.utf8.count <= 128 } == true }),
              JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value),
              let hint = try? ManagedClient.configurationDecoder().decode(Self.self, from: data),
              hint.schemaVersion == 1, hint.type == "message", hint.expiresAt.timeIntervalSince(now) <= 300,
              forRouting || hint.expiresAt > now else { return nil }
        return hint
    }
}

public struct ManagedMessageAlert: Decodable, Equatable, Sendable {
    public let conversationId: UUID
    public let sequence: String
    public let expiresAt: Date
}
public struct ManagedMessageAlerts: Decodable, Sendable {
    public internal(set) var scope: ManagedMessageScope
    public let alerts: [ManagedMessageAlert]
    public let nextCursor: String?
    private enum CodingKeys: String, CodingKey { case alerts, nextCursor }
    public init(from decoder: Decoder) throws {
        scope = try ManagedMessageScope(from: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        alerts = try values.decode([ManagedMessageAlert].self, forKey: .alerts)
        nextCursor = try values.decode(String?.self, forKey: .nextCursor)
    }
    mutating func validate(for enrollment: ManagedEnrollment, after: String) throws {
        try scope.validate(for: enrollment)
        guard alerts.count <= 100, Set(alerts.map(\.conversationId)).count == alerts.count,
              nextCursor == nil || (alerts.count == 100 && nextCursor == alerts.last?.sequence) else { throw ManagedError.invalidMessages }
        var previous = messagingSequence(after)!
        let now = Date()
        for alert in alerts {
            guard let sequence = messagingSequence(alert.sequence), sequence > previous,
                  alert.expiresAt > now, alert.expiresAt.timeIntervalSince(now) <= 300 else { throw ManagedError.invalidMessages }
            previous = sequence
        }
    }
}

/// Message history is deliberately Decodable only: no offline message archive.
public struct ManagedMessageScope: Decodable, Equatable, Sendable {
    public let schemaVersion: Int
    public let organisation: ManagedConfiguration.Organisation
    public let userId: String
    public let deviceId: UUID
    public internal(set) var expiresAt: Date
    public let retentionDays: Int

    mutating func validate(for enrollment: ManagedEnrollment, now: Date = Date()) throws {
        guard schemaVersion == 1, organisation.id == enrollment.organisationID,
              deviceId == enrollment.deviceID, userId == enrollment.userID,
              messagingText(organisation.name, limit: 160), (1...3650).contains(retentionDays),
              expiresAt > now, expiresAt.timeIntervalSince(now) <= 60 else { throw ManagedError.invalidMessages }
        expiresAt = min(expiresAt, now.addingTimeInterval(30))
    }
}
public struct ManagedMessagePerson: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    func validate() throws {
        guard messagingText(id, limit: 128), messagingText(name, limit: 160) else { throw ManagedError.invalidMessages }
    }
}
public struct ManagedConversation: Decodable, Equatable, Identifiable, Sendable {
    public enum Kind: String, Decodable, Sendable { case direct, group }
    public struct Participant: Decodable, Equatable, Identifiable, Sendable {
        public let id: String
        public let name: String
        public let lastReadSequence: String
        public let joinedSequence: String?
    }
    public let id: UUID
    public let kind: Kind
    public let title: String
    public let createdAt: Date
    public let updatedAt: Date
    public let participants: [Participant]
    public let unread: Int
    public let lastSequence: String
    public let revision: String?
    public let ownerId: String?

    func validate(userID: String) throws {
        guard messagingText(title, limit: 160), unread >= 0, messagingSequence(lastSequence) != nil,
              (1...20).contains(participants.count), kind != .direct || participants.count <= 2,
              Set(participants.map(\.id)).count == participants.count,
              participants.contains(where: { $0.id == userID }), updatedAt >= createdAt else { throw ManagedError.invalidMessages }
        for person in participants {
            guard messagingText(person.id, limit: 128), messagingText(person.name, limit: 160),
                  messagingSequence(person.lastReadSequence) != nil else { throw ManagedError.invalidMessages }
            if let joined = person.joinedSequence {
                guard let joined = messagingSequence(joined), joined <= messagingSequence(lastSequence)!,
                      messagingSequence(person.lastReadSequence)! >= joined else { throw ManagedError.invalidMessages }
            }
        }
        if let revision { guard messagingSequence(revision).map({ $0 > 0 }) == true else { throw ManagedError.invalidMessages } }
        guard kind == .direct ? ownerId == nil : revision == nil ? ownerId == nil : participants.contains(where: { $0.id == ownerId }) else { throw ManagedError.invalidMessages }
    }
}
public struct ManagedTextMessage: Decodable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let sequence: String
    public let senderId: String?
    public let senderName: String
    public let text: String
    public let createdAt: Date
    func validate() throws {
        guard let sequence = messagingSequence(sequence), sequence > 0,
              senderId == nil || messagingText(senderId!, limit: 128),
              messagingText(senderName, limit: 160), validMessageBody(text) else { throw ManagedError.invalidMessages }
    }
}
public struct ManagedConversationPage: Decodable, Sendable {
    public internal(set) var scope: ManagedMessageScope
    public let conversations: [ManagedConversation]
    public let nextCursor: String?
    private enum CodingKeys: String, CodingKey { case conversations, nextCursor }
    public init(from decoder: Decoder) throws {
        scope = try ManagedMessageScope(from: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        conversations = try values.decode([ManagedConversation].self, forKey: .conversations)
        nextCursor = try values.decode(String?.self, forKey: .nextCursor)
    }
    mutating func validate(for enrollment: ManagedEnrollment) throws {
        try scope.validate(for: enrollment)
        guard conversations.count <= 100, Set(conversations.map(\.id)).count == conversations.count,
              nextCursor == nil || (conversations.count == 100 && validConversationCursor(nextCursor!)) else { throw ManagedError.invalidMessages }
        for conversation in conversations { try conversation.validate(userID: scope.userId) }
    }
}
public struct ManagedMessagePage: Decodable, Sendable {
    public internal(set) var scope: ManagedMessageScope
    public let conversation: ManagedConversation
    public let messages: [ManagedTextMessage]
    public let nextCursor: String?
    private enum CodingKeys: String, CodingKey { case conversation, messages, nextCursor }
    public init(from decoder: Decoder) throws {
        scope = try ManagedMessageScope(from: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        conversation = try values.decode(ManagedConversation.self, forKey: .conversation)
        messages = try values.decode([ManagedTextMessage].self, forKey: .messages)
        nextCursor = try values.decode(String?.self, forKey: .nextCursor)
    }
    mutating func validate(for enrollment: ManagedEnrollment, conversationID: UUID, after: Bool = false) throws {
        try scope.validate(for: enrollment); try conversation.validate(userID: scope.userId)
        guard conversation.id == conversationID, messages.count <= 100,
              Set(messages.map(\.id)).count == messages.count,
              nextCursor == nil || (messages.count == 100 && nextCursor == (after ? messages.last?.sequence : messages.first?.sequence)) else { throw ManagedError.invalidMessages }
        var previous = messagingSequence(conversation.participants.first { $0.id == scope.userId }?.joinedSequence ?? "0")!
        for message in messages {
            try message.validate()
            guard let sequence = messagingSequence(message.sequence), sequence > previous else { throw ManagedError.invalidMessages }
            previous = sequence
        }
    }
}
public struct ManagedMessagePeople: Decodable, Sendable {
    public internal(set) var scope: ManagedMessageScope
    public let people: [ManagedMessagePerson]
    public let nextCursor: String?
    private enum CodingKeys: String, CodingKey { case people, nextCursor }
    public init(from decoder: Decoder) throws {
        scope = try ManagedMessageScope(from: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        people = try values.decode([ManagedMessagePerson].self, forKey: .people)
        nextCursor = try values.decode(String?.self, forKey: .nextCursor)
    }
    mutating func validate(for enrollment: ManagedEnrollment) throws {
        try scope.validate(for: enrollment)
        guard people.count <= 100, Set(people.map(\.id)).count == people.count,
              !people.contains(where: { $0.id == scope.userId }),
              nextCursor == nil || (people.count == 100 && nextCursor == people.last?.id) else { throw ManagedError.invalidMessages }
        for person in people { try person.validate() }
    }
}
struct ManagedConversationResult: Decodable {
    var scope: ManagedMessageScope
    let conversation: ManagedConversation
    private enum CodingKeys: String, CodingKey { case conversation }
    init(from decoder: Decoder) throws {
        scope = try ManagedMessageScope(from: decoder)
        conversation = try decoder.container(keyedBy: CodingKeys.self).decode(ManagedConversation.self, forKey: .conversation)
    }
}
struct ManagedMessageResult: Decodable {
    var scope: ManagedMessageScope
    let message: ManagedTextMessage
    private enum CodingKeys: String, CodingKey { case message }
    init(from decoder: Decoder) throws {
        scope = try ManagedMessageScope(from: decoder)
        message = try decoder.container(keyedBy: CodingKeys.self).decode(ManagedTextMessage.self, forKey: .message)
    }
}
struct ManagedMessageReadResult: Decodable {
    var scope: ManagedMessageScope
    let sequence: String
    private enum CodingKeys: String, CodingKey { case sequence }
    init(from decoder: Decoder) throws {
        scope = try ManagedMessageScope(from: decoder)
        sequence = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .sequence)
    }
}
struct ManagedMessageLeaveResult: Decodable {
    var scope: ManagedMessageScope
    let conversationId: UUID
    let left: Bool
    private enum CodingKeys: String, CodingKey { case conversationId, left }
    init(from decoder: Decoder) throws {
        scope = try ManagedMessageScope(from: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        conversationId = try values.decode(UUID.self, forKey: .conversationId)
        left = try values.decode(Bool.self, forKey: .left)
    }
}
func messagingText(_ value: String, limit: Int) -> Bool {
    !value.isEmpty && value.utf16.count <= limit && !value.unicodeScalars.contains { $0.value < 32 || (127...159).contains($0.value) }
}
func validMessageBody(_ value: String) -> Bool {
    (1...4096).contains(value.utf16.count) && !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && !value.unicodeScalars.contains { ($0.value < 32 && ![9, 10, 13].contains($0.value)) || (127...159).contains($0.value) }
}
func messagingSequence(_ value: String) -> Int64? {
    guard value.utf8.count <= 19, value == "0" || value.first != "0",
          value.utf8.allSatisfy({ (48...57).contains($0) }), let sequence = Int64(value), sequence >= 0 else { return nil }
    return sequence
}
func validConversationCursor(_ value: String) -> Bool {
    (1...512).contains(value.utf8.count) && value.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }
}
