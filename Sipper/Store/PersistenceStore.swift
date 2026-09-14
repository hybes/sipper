import Foundation

/// JSON-file persistence in ~/Library/Application Support/Sipper. Writes are atomic.
final class PersistenceStore {
    let directory: URL

    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        e.dateEncodingStrategy = JSONDates.encoding
        return e
    }()

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = JSONDates.decoding
        return d
    }()

    init(directory: URL? = nil) {
        self.directory = directory ?? PersistenceStore.defaultDirectory
        try? FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
    }

    static var defaultDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Sipper", isDirectory: true)
    }

    func url(for file: String) -> URL {
        directory.appendingPathComponent(file)
    }

    func load<T: Decodable>(_ type: T.Type, from file: String) -> T? {
        let url = url(for: file)
        guard let data = try? Data(contentsOf: url) else { return nil }
        do {
            return try decoder.decode(type, from: data)
        } catch {
            // Keep the unreadable file for inspection instead of silently overwriting it.
            let backup = url.appendingPathExtension("corrupt-\(Int(Date().timeIntervalSince1970))")
            try? FileManager.default.moveItem(at: url, to: backup)
            NSLog("Sipper: could not decode \(file): \(error). Moved to \(backup.lastPathComponent)")
            return nil
        }
    }

    func save<T: Encodable>(_ value: T, to file: String) throws {
        let data = try encoder.encode(value)
        try data.write(to: url(for: file), options: [.atomic])
    }

    func remove(_ file: String) {
        try? FileManager.default.removeItem(at: url(for: file))
    }
}

enum StoreFile {
    static let profiles = "profiles.json"
    static let accounts = "accounts.json"
    static let history = "history.json"
    static let contacts = "contacts.json"
    static let settings = "settings.json"
    static let tombstones = "tombstones.json"
}
