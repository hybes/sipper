import Foundation

enum CloudSyncStatus: Equatable {
    case off
    case unavailable(String)
    case starting
    case idle(lastSync: Date?)
    case syncing
    case error(String)

    /// Connected (or trying); errors are transient and still accept writes for retry.
    var isActive: Bool {
        switch self {
        case .starting, .idle, .syncing, .error: return true
        default: return false
        }
    }

    var description: String {
        switch self {
        case .off: return "Off"
        case .unavailable(let reason): return reason
        case .starting: return "Connecting to iCloud…"
        case .idle(let last):
            guard let last else { return "Waiting for changes" }
            let formatter = RelativeDateTimeFormatter()
            formatter.unitsStyle = .short
            return "Last synced \(formatter.localizedString(for: last, relativeTo: Date()))"
        case .syncing: return "Syncing…"
        case .error(let message): return message
        }
    }
}

@MainActor
protocol CloudSyncDelegate: AnyObject {
    /// Raw document payloads for one collection: the current file plus any unresolved
    /// iCloud conflict versions. The delegate decodes, merges and pushes back.
    func cloudSync(_ service: CloudSyncService, didReceive collection: SyncCollection, payloads: [Data])
    func cloudSync(_ service: CloudSyncService, statusDidChange status: CloudSyncStatus)
}

/// Keeps one JSON document per collection in the app's iCloud container
/// (`<container>/Sipper/v1/`), watches it with NSMetadataQuery and resolves
/// conflict versions by merging. Requires the app to be signed with an iCloud
/// container entitlement (see Sipper/Sipper-iCloud.entitlements).
final class CloudSyncService: NSObject {
    static let containerSubpath = "Sipper/v1"

    weak var delegate: CloudSyncDelegate?

    let deviceID: String
    /// Main-thread only.
    private(set) var status: CloudSyncStatus = .off {
        didSet {
            guard status != oldValue else { return }
            let status = status
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.delegate?.cloudSync(self, statusDidChange: status)
            }
        }
    }

    private func setStatus(_ new: CloudSyncStatus) {
        if Thread.isMainThread { status = new } else { DispatchQueue.main.async { self.status = new } }
    }

    private let queue = DispatchQueue(label: "com.hybes.sipper.cloud-sync", qos: .utility)
    private var containerURL: URL?
    private var query: NSMetadataQuery?
    private var observers: [NSObjectProtocol] = []
    private var lastWrittenHashes: [SyncCollection: Int] = [:]
    private var pendingWrites: [SyncCollection: Data] = [:]
    private var writeWork: DispatchWorkItem?
    private var running = false

    override init() {
        let key = "com.hybes.sipper.sync-device-id"
        if let existing = UserDefaults.standard.string(forKey: key) {
            deviceID = existing
        } else {
            let id = UUID().uuidString
            UserDefaults.standard.set(id, forKey: key)
            deviceID = id
        }
        super.init()
    }

    // MARK: Lifecycle

    /// True when the app is entitled for iCloud and the user is signed in.
    static var isEntitledAndSignedIn: Bool {
        FileManager.default.ubiquityIdentityToken != nil
    }

    func start() {
        guard !running else { return }
        running = true
        status = .starting
        queue.async { [weak self] in
            guard let self else { return }
            guard FileManager.default.ubiquityIdentityToken != nil else {
                DispatchQueue.main.async { self.finishUnavailable("Sign in to iCloud in System Settings to sync.") }
                return
            }
            guard let base = FileManager.default.url(forUbiquityContainerIdentifier: nil) else {
                DispatchQueue.main.async { self.finishUnavailable("iCloud is not available to this build. The app must be signed with a team that has an iCloud container (see README).") }
                return
            }
            let url = base.appendingPathComponent(CloudSyncService.containerSubpath, isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            } catch {
                DispatchQueue.main.async { self.finishUnavailable("Could not create the iCloud folder: \(error.localizedDescription)") }
                return
            }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.running else { return }
                self.containerURL = url
                self.startQuery()
            }
        }
    }

    func stop() {
        running = false
        query?.stop()
        query = nil
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers.removeAll()
        writeWork?.cancel()
        writeWork = nil
        containerURL = nil
        status = .off
    }

    private func finishUnavailable(_ reason: String) {
        running = false
        status = .unavailable(reason)
    }

    private func startQuery() {
        guard running, let containerURL else { return }
        let query = NSMetadataQuery()
        query.searchScopes = [NSMetadataQueryUbiquitousDataScope, NSMetadataQueryUbiquitousDocumentsScope]
        query.predicate = NSPredicate(format: "%K LIKE '*.json' AND %K BEGINSWITH %@",
                                      NSMetadataItemFSNameKey, NSMetadataItemPathKey, containerURL.path)
        query.notificationBatchingInterval = 1
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: .NSMetadataQueryDidFinishGathering, object: query, queue: .main) { [weak self] _ in
            self?.handleQueryUpdate()
        })
        observers.append(center.addObserver(forName: .NSMetadataQueryDidUpdate, object: query, queue: .main) { [weak self] _ in
            self?.handleQueryUpdate()
        })
        self.query = query
        query.start()
        status = .idle(lastSync: nil)
        pullAll()
    }

    // MARK: Reading

    private func handleQueryUpdate() {
        guard let query else { return }
        query.disableUpdates()
        defer { query.enableUpdates() }
        var collections: Set<SyncCollection> = []
        for case let item as NSMetadataItem in query.results {
            guard let url = item.value(forAttribute: NSMetadataItemURLKey) as? URL,
                  let collection = SyncCollection.allCases.first(where: { $0.fileName == url.lastPathComponent }) else { continue }
            let downloadStatus = item.value(forAttribute: NSMetadataUbiquitousItemDownloadingStatusKey) as? String
            if downloadStatus != NSMetadataUbiquitousItemDownloadingStatusCurrent {
                try? FileManager.default.startDownloadingUbiquitousItem(at: url)
                continue
            }
            collections.insert(collection)
        }
        for collection in collections {
            read(collection)
        }
    }

    /// Reads every collection once (used after start and by "Sync now").
    func pullAll() {
        guard running else { return }
        for collection in SyncCollection.allCases {
            read(collection)
        }
    }

    private func read(_ collection: SyncCollection) {
        guard let url = fileURL(for: collection) else { return }
        let expectedHash = lastWrittenHashes[collection]
        queue.async { [weak self] in
            guard let self else { return }
            var payloads: [Data] = []
            var coordinatorError: NSError?
            let coordinator = NSFileCoordinator(filePresenter: nil)
            coordinator.coordinate(readingItemAt: url, options: [], error: &coordinatorError) { readURL in
                if let data = try? Data(contentsOf: readURL) {
                    payloads.append(data)
                }
                for version in NSFileVersion.unresolvedConflictVersionsOfItem(at: readURL) ?? [] {
                    if let data = try? Data(contentsOf: version.url) {
                        payloads.append(data)
                    }
                }
            }
            if let coordinatorError {
                self.setStatus(.error(coordinatorError.localizedDescription))
                return
            }
            guard !payloads.isEmpty else { return }
            if payloads.count == 1, let expectedHash, expectedHash == payloads[0].hashValue {
                return // our own write echoed back
            }
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.delegate?.cloudSync(self, didReceive: collection, payloads: payloads)
            }
        }
    }

    // MARK: Writing

    /// Queues a document for writing; writes are coalesced per collection.
    func push(_ collection: SyncCollection, data: Data) {
        guard running else { return }
        pendingWrites[collection] = data
        writeWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.flushWrites() }
        writeWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: work)
    }

    private func flushWrites() {
        let writes = pendingWrites
        pendingWrites.removeAll()
        guard !writes.isEmpty, running, let containerURL else { return }
        status = .syncing
        let targets = writes.map { (collection: $0.key, data: $0.value, url: containerURL.appendingPathComponent($0.key.fileName)) }
        queue.async { [weak self] in
            guard let self else { return }
            var failure: String?
            var written: [SyncCollection: Int] = [:]
            for (collection, data, url) in targets {
                var coordinatorError: NSError?
                let coordinator = NSFileCoordinator(filePresenter: nil)
                coordinator.coordinate(writingItemAt: url, options: [.forReplacing], error: &coordinatorError) { writeURL in
                    do {
                        try data.write(to: writeURL, options: [.atomic])
                        written[collection] = data.hashValue
                        for version in NSFileVersion.unresolvedConflictVersionsOfItem(at: writeURL) ?? [] {
                            version.isResolved = true
                        }
                        try? NSFileVersion.removeOtherVersionsOfItem(at: writeURL)
                    } catch {
                        failure = error.localizedDescription
                    }
                }
                if let coordinatorError { failure = coordinatorError.localizedDescription }
            }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                for (collection, hash) in written { self.lastWrittenHashes[collection] = hash }
                if let failure {
                    self.status = .error("Could not write to iCloud: \(failure)")
                } else {
                    self.status = .idle(lastSync: Date())
                }
            }
        }
    }

    func fileURL(for collection: SyncCollection) -> URL? {
        containerURL?.appendingPathComponent(collection.fileName)
    }
}
