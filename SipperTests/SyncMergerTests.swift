import XCTest
@testable import Sipper

final class SyncMergerTests: XCTestCase {
    private func contact(_ name: String, id: UUID = UUID(), updated: TimeInterval) -> Contact {
        Contact(id: id, name: name, createdAt: Date(timeIntervalSince1970: 0), updatedAt: Date(timeIntervalSince1970: updated))
    }

    func testNewestUpdateWins() {
        let id = UUID()
        let local = [contact("Old", id: id, updated: 100)]
        let remote = [contact("New", id: id, updated: 200)]
        let outcome = SyncMerger.merge(local: local, localTombstones: [], remotes: [remote], remoteTombstones: [[]])
        XCTAssertEqual(outcome.items.map(\.name), ["New"])
        XCTAssertTrue(outcome.changedLocal)
        XCTAssertFalse(outcome.changedRemote)
    }

    func testTieKeepsLocal() {
        let id = UUID()
        let local = [contact("Local", id: id, updated: 100)]
        let remote = [contact("Remote", id: id, updated: 100)]
        let outcome = SyncMerger.merge(local: local, localTombstones: [], remotes: [remote], remoteTombstones: [[]])
        XCTAssertEqual(outcome.items.map(\.name), ["Local"])
        XCTAssertFalse(outcome.changedLocal)
        XCTAssertTrue(outcome.changedRemote)
    }

    func testUnionOfDisjointSets() {
        let local = [contact("A", updated: 10)]
        let remote = [contact("B", updated: 20)]
        let outcome = SyncMerger.merge(local: local, localTombstones: [], remotes: [remote], remoteTombstones: [[]])
        XCTAssertEqual(Set(outcome.items.map(\.name)), ["A", "B"])
        XCTAssertTrue(outcome.changedLocal)
        XCTAssertTrue(outcome.changedRemote)
    }

    func testRemoteTombstoneDeletesLocalRecord() {
        let id = UUID()
        let local = [contact("Gone", id: id, updated: 100)]
        let stone = SyncTombstone(id: id, deletedAt: Date(timeIntervalSince1970: 150))
        let outcome = SyncMerger.merge(local: local, localTombstones: [], remotes: [[]], remoteTombstones: [[stone]],
                                       now: Date(timeIntervalSince1970: 200))
        XCTAssertTrue(outcome.items.isEmpty)
        XCTAssertEqual(outcome.tombstones, [stone])
        XCTAssertTrue(outcome.changedLocal)
    }

    func testEditAfterDeleteResurrects() {
        let id = UUID()
        let local = [contact("Edited later", id: id, updated: 300)]
        let stone = SyncTombstone(id: id, deletedAt: Date(timeIntervalSince1970: 200))
        let outcome = SyncMerger.merge(local: local, localTombstones: [], remotes: [[]], remoteTombstones: [[stone]])
        XCTAssertEqual(outcome.items.map(\.name), ["Edited later"])
        XCTAssertTrue(outcome.tombstones.isEmpty)
    }

    func testConflictVersionsAreAllConsidered() {
        let id = UUID()
        let local = [contact("v1", id: id, updated: 10)]
        let remoteA = [contact("v2", id: id, updated: 20)]
        let remoteB = [contact("v3", id: id, updated: 30)]
        let outcome = SyncMerger.merge(local: local, localTombstones: [], remotes: [remoteA, remoteB], remoteTombstones: [[], []])
        XCTAssertEqual(outcome.items.map(\.name), ["v3"])
        XCTAssertTrue(outcome.changedRemote, "conflict versions must be collapsed by writing back")
    }

    func testOldTombstonesArePruned() {
        let now = Date(timeIntervalSince1970: 1_000_000_000)
        let fresh = SyncTombstone(id: UUID(), deletedAt: now.addingTimeInterval(-3600))
        let stale = SyncTombstone(id: UUID(), deletedAt: now.addingTimeInterval(-SyncMerger.tombstoneRetention - 1))
        let outcome = SyncMerger.merge(local: [Contact](), localTombstones: [fresh, stale], remotes: [[]], remoteTombstones: [[]], now: now)
        XCTAssertEqual(outcome.tombstones, [fresh])
    }

    func testIdenticalCopiesReportNoChange() {
        let id = UUID()
        let item = contact("Same", id: id, updated: 5)
        let outcome = SyncMerger.merge(local: [item], localTombstones: [], remotes: [[item]], remoteTombstones: [[]])
        XCTAssertFalse(outcome.changedLocal)
        XCTAssertFalse(outcome.changedRemote)
    }

    func testCallRecordsMergeByEndTime() {
        let id = UUID()
        let account = UUID()
        var local = CallRecord(id: id, accountID: account, direction: .outgoing, remoteNumber: "1002", startedAt: Date(timeIntervalSince1970: 0))
        local.endedAt = nil
        var remote = local
        remote.outcome = .completed
        remote.endedAt = Date(timeIntervalSince1970: 60)
        let outcome = SyncMerger.merge(local: [local], localTombstones: [], remotes: [[remote]], remoteTombstones: [[]])
        XCTAssertEqual(outcome.items.first?.outcome, .completed)
    }
}
