import Foundation

/// Records that can be merged across devices: newest `updatedAt` wins.
protocol SyncRecord: Identifiable, Codable, Hashable where ID == UUID {
    var updatedAt: Date { get }
}

struct SyncTombstone: Codable, Hashable {
    var id: UUID
    var deletedAt: Date
}

enum SyncCollection: String, CaseIterable, Codable {
    case profiles
    case accounts
    case contacts
    case history

    var fileName: String { "\(rawValue).json" }
}

/// Envelope stored in the iCloud container, one file per collection.
struct SyncDocument<Item: Codable>: Codable {
    var version: Int
    var deviceID: String
    var writtenAt: Date
    var items: [Item]
    var tombstones: [SyncTombstone]

    init(deviceID: String, writtenAt: Date = Date(), items: [Item], tombstones: [SyncTombstone]) {
        self.version = 1
        self.deviceID = deviceID
        self.writtenAt = writtenAt
        self.items = items
        self.tombstones = tombstones
    }
}

enum SyncMerger {
    struct Outcome<T: SyncRecord>: Equatable {
        var items: [T]
        var tombstones: [SyncTombstone]
        /// The merged set differs from what this device had.
        var changedLocal: Bool
        /// The merged set differs from the (first) remote copy, so it should be written back.
        var changedRemote: Bool
    }

    /// How long deletions are remembered so a device that was offline still applies them.
    static let tombstoneRetention: TimeInterval = 90 * 24 * 3600

    /// Merges the local copy with one or more remote copies (extra copies are iCloud
    /// conflict versions). Per record the newest `updatedAt` wins; a tombstone wins
    /// when it is at least as new as the record.
    static func merge<T: SyncRecord>(local: [T],
                                     localTombstones: [SyncTombstone],
                                     remotes: [[T]],
                                     remoteTombstones: [[SyncTombstone]],
                                     now: Date = Date()) -> Outcome<T> {
        var tombstones: [UUID: Date] = [:]
        for list in [localTombstones] + remoteTombstones {
            for stone in list {
                tombstones[stone.id] = max(tombstones[stone.id] ?? .distantPast, stone.deletedAt)
            }
        }

        var winners: [UUID: T] = [:]
        // Local first so that ties keep the local copy.
        for list in [local] + remotes {
            for item in list {
                if let existing = winners[item.id], existing.updatedAt >= item.updatedAt { continue }
                winners[item.id] = item
            }
        }

        var items: [T] = []
        for (id, item) in winners {
            if let deletedAt = tombstones[id], deletedAt >= item.updatedAt {
                continue
            }
            if tombstones[id] != nil {
                // Edited after deletion elsewhere: the edit resurrects the record.
                tombstones[id] = nil
            }
            items.append(item)
        }
        items.sort { $0.updatedAt == $1.updatedAt ? $0.id.uuidString < $1.id.uuidString : $0.updatedAt < $1.updatedAt }

        let keptTombstones = tombstones
            .filter { now.timeIntervalSince($0.value) < tombstoneRetention }
            .map { SyncTombstone(id: $0.key, deletedAt: $0.value) }
            .sorted { $0.id.uuidString < $1.id.uuidString }

        let mergedSet = Set(items)
        let changedLocal = mergedSet != Set(local) || Set(keptTombstones) != Set(localTombstones)
        let changedRemote: Bool
        if let primary = remotes.first, let primaryStones = remoteTombstones.first {
            changedRemote = mergedSet != Set(primary) || Set(keptTombstones) != Set(primaryStones) || remotes.count > 1
        } else {
            changedRemote = true
        }
        return Outcome(items: items, tombstones: keptTombstones, changedLocal: changedLocal, changedRemote: changedRemote)
    }
}

extension Profile: SyncRecord {}
extension SIPAccount: SyncRecord {}
extension Contact: SyncRecord {}

extension CallRecord: SyncRecord {
    /// A history entry only changes when the call ends.
    var updatedAt: Date { endedAt ?? startedAt }
}
