import Foundation
import XCTest
@testable import Sipper

enum TestSupport {
    /// A unique, empty directory that is deleted when the test finishes.
    static func makeTemporaryDirectory(for testCase: XCTestCase) -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("SipperTests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        testCase.addTeardownBlock {
            try? FileManager.default.removeItem(at: url)
        }
        return url
    }

    /// A date with whole-second precision so ISO 8601 round trips compare equal.
    static let fixedDate = Date(timeIntervalSince1970: 1_700_000_000)

    /// Polls `condition` on the main actor until it is true or `timeout` elapses.
    @MainActor
    static func waitUntil(timeout: TimeInterval = 3, _ condition: @escaping @MainActor () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return condition()
    }
}

extension CallSnapshot {
    static func fixture(id: Int = 1,
                        accountID: UUID,
                        direction: CallDirection = .incoming,
                        state: CallState = .incoming,
                        remoteNumber: String = "2001",
                        remoteName: String = "",
                        remoteURI: String = "",
                        startedAt: Date = Date(),
                        connectedAt: Date? = nil,
                        endedAt: Date? = nil,
                        statusCode: Int = 0,
                        statusText: String = "") -> CallSnapshot {
        CallSnapshot(id: id,
                     accountID: accountID,
                     direction: direction,
                     state: state,
                     remoteURI: remoteURI.isEmpty ? "sip:\(remoteNumber)@pbx.example.com" : remoteURI,
                     remoteNumber: remoteNumber,
                     remoteName: remoteName,
                     isMuted: false,
                     isOnHold: false,
                     isRemoteHold: false,
                     hasActiveMedia: false,
                     startedAt: startedAt,
                     connectedAt: connectedAt,
                     endedAt: endedAt,
                     lastStatusCode: statusCode,
                     lastStatusText: statusText)
    }

    /// The same call after it has ended.
    func ended(statusCode: Int = 0, statusText: String = "", connectedAt: Date? = nil) -> CallSnapshot {
        var copy = self
        copy.state = .disconnected
        copy.connectedAt = connectedAt ?? self.connectedAt
        copy.endedAt = Date()
        copy.lastStatusCode = statusCode
        copy.lastStatusText = statusText
        return copy
    }
}
