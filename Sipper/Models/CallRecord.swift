import Foundation

enum CallDirection: String, Codable, Hashable {
    case incoming
    case outgoing
}

enum CallOutcome: String, Codable, Hashable, CaseIterable {
    case completed
    case missed
    case declined
    case busy
    case noAnswer
    case failed
    case cancelled

    var displayName: String {
        switch self {
        case .completed: return "Completed"
        case .missed: return "Missed"
        case .declined: return "Declined"
        case .busy: return "Busy"
        case .noAnswer: return "No answer"
        case .failed: return "Failed"
        case .cancelled: return "Cancelled"
        }
    }
}

struct CallRecord: Identifiable, Codable, Hashable {
    var id: UUID
    var accountID: UUID
    var direction: CallDirection
    var outcome: CallOutcome
    var remoteNumber: String
    var remoteName: String
    var remoteURI: String
    var startedAt: Date
    var connectedAt: Date?
    var endedAt: Date?
    var statusCode: Int
    var statusText: String
    /// Local path of the call recording, if one was made on this Mac.
    var recordingPath: String?

    init(id: UUID = UUID(),
         accountID: UUID,
         direction: CallDirection,
         outcome: CallOutcome = .failed,
         remoteNumber: String,
         remoteName: String = "",
         remoteURI: String = "",
         startedAt: Date = Date(),
         connectedAt: Date? = nil,
         endedAt: Date? = nil,
         statusCode: Int = 0,
         statusText: String = "",
         recordingPath: String? = nil) {
        self.id = id
        self.accountID = accountID
        self.direction = direction
        self.outcome = outcome
        self.remoteNumber = remoteNumber
        self.remoteName = remoteName
        self.remoteURI = remoteURI
        self.startedAt = startedAt
        self.connectedAt = connectedAt
        self.endedAt = endedAt
        self.statusCode = statusCode
        self.statusText = statusText
        self.recordingPath = recordingPath
    }

    private enum CodingKeys: String, CodingKey {
        case id, accountID, direction, outcome, remoteNumber, remoteName, remoteURI
        case startedAt, connectedAt, endedAt, statusCode, statusText, recordingPath
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        accountID = try c.decode(UUID.self, forKey: .accountID)
        direction = c.decode(.direction, default: CallDirection.outgoing)
        outcome = c.decode(.outcome, default: CallOutcome.failed)
        remoteNumber = c.decode(.remoteNumber, default: "")
        remoteName = c.decode(.remoteName, default: "")
        remoteURI = c.decode(.remoteURI, default: "")
        startedAt = c.decode(.startedAt, default: Date())
        connectedAt = c.decodeOptional(.connectedAt)
        endedAt = c.decodeOptional(.endedAt)
        statusCode = c.decode(.statusCode, default: 0)
        statusText = c.decode(.statusText, default: "")
        recordingPath = c.decodeOptional(.recordingPath)
    }

    /// Talk time in seconds (zero when the call never connected).
    var duration: TimeInterval {
        guard let connectedAt else { return 0 }
        return max(0, (endedAt ?? Date()).timeIntervalSince(connectedAt))
    }

    var wasMissed: Bool { direction == .incoming && outcome == .missed }

    /// Recording file, when it still exists on this Mac.
    var recordingURL: URL? {
        guard let recordingPath, FileManager.default.fileExists(atPath: recordingPath) else { return nil }
        return URL(fileURLWithPath: recordingPath)
    }

    /// True while the call this record describes is still running.
    var isInProgress: Bool { endedAt == nil }

    var displayName: String { remoteName.isEmpty ? remoteNumber : remoteName }
}
