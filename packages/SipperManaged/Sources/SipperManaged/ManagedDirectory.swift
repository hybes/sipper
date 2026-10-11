import Foundation

public struct ManagedDirectoryContact: Codable, Equatable, Identifiable, Sendable {
    public struct Number: Codable, Equatable, Hashable, Sendable {
        public let label: String
        public let number: String
    }
    public let id: UUID
    public let name: String
    public let company: String
    public let numbers: [Number]
    public let revision: Int
    public let updatedAt: Date

    func validate() throws {
        guard validDirectoryText(name, limit: 160), validDirectoryText(company, limit: 160, empty: true),
              revision > 0, revision <= 2_147_483_647, updatedAt.timeIntervalSince1970.isFinite,
              (1...5).contains(numbers.count), Set(numbers.map(\.number)).count == numbers.count else { throw ManagedError.invalidDirectory }
        for item in numbers {
            let digits = item.number.hasPrefix("+") ? String(item.number.dropFirst()) : item.number
            guard validDirectoryText(item.label, limit: 32), (1...64).contains(digits.utf8.count),
                  digits.utf8.allSatisfy({ (48...57).contains($0) || $0 == 42 || $0 == 35 }) else { throw ManagedError.invalidDirectory }
        }
    }

    public func matches(_ search: String) -> Bool {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        if query.isEmpty || name.localizedCaseInsensitiveContains(query) || company.localizedCaseInsensitiveContains(query) { return true }
        let phone = query.filter { !"(). -".contains($0) }
        return !phone.isEmpty && numbers.contains { $0.number.contains(phone) }
    }
}

private func validDirectoryText(_ value: String, limit: Int, empty: Bool = false) -> Bool {
    (empty || !value.isEmpty) && value.utf16.count <= limit
        && value == value.trimmingCharacters(in: .whitespacesAndNewlines)
        && !value.unicodeScalars.contains { $0.value < 32 || (127...159).contains($0.value) }
}

/// A complete snapshot, kept separately from personal contacts and bound to one enrolment.
public struct ManagedDirectory: Codable, Equatable, Sendable {
    public let organisation: ManagedConfiguration.Organisation
    public let deviceId: UUID
    public let revision: UUID
    public let expiresAt: Date
    public let contacts: [ManagedDirectoryContact]

    func validate(organisationID: UUID, deviceID: UUID, now: Date = Date()) throws {
        guard organisation.id == organisationID, deviceId == deviceID,
              validDirectoryText(organisation.name, limit: 160),
              expiresAt > now, expiresAt.timeIntervalSince(now) <= 86_460,
              contacts.count <= 10_000, Set(contacts.map(\.id)).count == contacts.count else { throw ManagedError.invalidDirectory }
        for contact in contacts { try contact.validate() }
    }
}

struct ManagedDirectoryPage: Decodable {
    let organisation: ManagedConfiguration.Organisation
    let deviceId: UUID
    let revision: UUID
    let expiresAt: Date
    let contacts: [ManagedDirectoryContact]
    let nextCursor: UUID?

    func validate(for enrollment: ManagedEnrollment) throws {
        guard contacts.count <= 100,
              nextCursor == nil || (contacts.count == 100 && nextCursor == contacts.last?.id) else { throw ManagedError.invalidDirectory }
        try ManagedDirectory(organisation: organisation, deviceId: deviceId, revision: revision, expiresAt: expiresAt, contacts: contacts)
            .validate(organisationID: enrollment.organisationID, deviceID: enrollment.deviceID)
    }
}

/// Short-lived, voluntary preferences. Never written to the directory archive.
public struct ManagedDirectoryStatus: Decodable, Equatable, Sendable {
    public struct Activity: Decodable, Equatable, Sendable {
        public enum State: String, Decodable, Sendable { case inCall = "in_call", onHold = "on_hold", ringing, dialling }
        public enum Source: String, Decodable, Sendable { case device, gateway }
        public let state: State
        public let source: Source
        public let observedAt: Date
        var label: String {
            let state = switch self.state { case .inCall: "In a call"; case .onHold: "On hold"; case .ringing: "Ringing"; case .dialling: "Dialling" }
            return "\(state) · \(source == .device ? "App report" : "Gateway report")"
        }
    }
    public struct Contact: Decodable, Equatable, Sendable {
        public let contactId: UUID
        public let availability: ManagedAvailability?
        public let doNotDisturb: Bool?
        public let activity: Activity?
        private enum CodingKeys: String, CodingKey { case contactId, availability, doNotDisturb, activity }
        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            contactId = try values.decode(UUID.self, forKey: .contactId)
            availability = try values.decode(ManagedAvailability?.self, forKey: .availability)
            doNotDisturb = try values.decode(Bool?.self, forKey: .doNotDisturb)
            activity = try values.decodeIfPresent(Activity.self, forKey: .activity)
            guard (availability == nil) == (doNotDisturb == nil) else { throw ManagedError.invalidDirectory }
        }
    }
    public let deviceId: UUID
    public let organisationId: UUID
    public let revision: UUID
    public internal(set) var expiresAt: Date
    public let contacts: [Contact]

    func validate(directory: ManagedDirectory, contactIDs: [UUID], now: Date = Date()) throws {
        guard deviceId == directory.deviceId, organisationId == directory.organisation.id, revision == directory.revision,
              expiresAt > now, expiresAt.timeIntervalSince(now) <= 60,
              contacts.count == contactIDs.count, Set(contacts.map(\.contactId)) == Set(contactIDs) else { throw ManagedError.invalidDirectory }
        for contact in contacts {
            if let activity = contact.activity {
                guard activity.observedAt <= now.addingTimeInterval(60), activity.observedAt > now.addingTimeInterval(-180),
                      expiresAt <= activity.observedAt.addingTimeInterval(180) else { throw ManagedError.invalidDirectory }
            }
        }
    }
    public func label(for contactID: UUID, now: Date = Date()) -> String {
        guard expiresAt > now, let contact = contacts.first(where: { $0.contactId == contactID }) else { return "Status unavailable" }
        var labels: [String] = []
        if let availability = contact.availability {
            labels.append(availability == .unset ? "Availability not set" : availability.label)
            if contact.doNotDisturb == true { labels.append("Do Not Disturb") }
        }
        if let activity = contact.activity { labels.append(activity.label) }
        return labels.isEmpty ? "Status unavailable" : labels.joined(separator: " · ")
    }
}
