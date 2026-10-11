import Foundation

public enum ManagedCallAction: String, Sendable { case status, wake, answer, decline }

public struct ManagedCall: Decodable, Equatable, Sendable {
    public enum State: String, Decodable, Sendable { case ringing, answering, answered, ended }
    public struct Caller: Decodable, Equatable, Sendable {
        public let name: String
        public let number: String
        public var label: String { !name.isEmpty ? name : !number.isEmpty ? number : "Unknown caller" }
    }
    public let id: UUID
    public let configurationId: UUID
    public let state: State
    public let version: Int
    public let expiresAt: Date
    public let claimedByThisDevice: Bool
    public let caller: Caller?

    public func isUnavailable(now: Date = Date()) -> Bool {
        state == .ended || ((state == .answering || state == .answered) && !claimedByThisDevice)
            || ((state == .ringing || state == .answering) && expiresAt <= now)
    }
    func validate(callID: UUID) throws {
        guard id == callID, version > 0, version <= Int32.max,
              caller != nil || (state != .ringing && state != .answering) else { throw ManagedError.invalidConfiguration }
        if let caller {
            for value in [caller.name, caller.number] {
                guard value.count <= 160, value.rangeOfCharacter(from: .controlCharacters) == nil else { throw ManagedError.invalidConfiguration }
            }
        }
    }
}

/// An opaque wake hint. The authenticated device API supplies caller identity and call authority.
public struct IncomingManagedCall: Decodable, Equatable, Sendable {
    private let schemaVersion: Int
    public let deviceId: UUID
    public let callId: UUID
    public let expiresAt: Date

    public static func parse(apns payload: [AnyHashable: Any], now: Date = Date()) -> Self? {
        guard let value = payload["sipper"] as? [String: Any],
              Set(value.keys) == ["schemaVersion", "deviceId", "callId", "expiresAt"],
              ["deviceId", "callId", "expiresAt"].allSatisfy({ (value[$0] as? String).map { $0.utf8.count <= 128 } == true }),
              JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value),
              let hint = try? ManagedClient.configurationDecoder().decode(Self.self, from: data),
              hint.schemaVersion == 1, hint.expiresAt > now, hint.expiresAt.timeIntervalSince(now) <= 120 else { return nil }
        return hint
    }
}
