import Foundation
import Combine
import AppKit
import SipperManaged

enum SidebarItem: Hashable {
    case dialer
    case history
    case contacts
    case messages
    case account(UUID)
    case profile(UUID)
}

struct AppAlert: Identifiable, Equatable {
    let id = UUID()
    var title: String
    var message: String
}

/// Central observable model. Owns persistence, the SIP engine and runtime state.
/// Everything here runs on the main thread.
@MainActor
final class AppState: ObservableObject {
    // MARK: Persisted state
    @Published private(set) var profiles: [Profile] = []
    @Published private(set) var accounts: [SIPAccount] = []
    @Published private(set) var history: [CallRecord] = []
    @Published private(set) var contacts: [Contact] = []
    @Published var settings = AppSettings() {
        didSet { settingsDidChange(from: oldValue) }
    }

    // MARK: Runtime state
    @Published private(set) var registrations: [UUID: RegistrationState] = [:]
    @Published private(set) var voicemail: [UUID: VoicemailInfo] = [:]
    @Published private(set) var calls: [CallSnapshot] = []
    @Published var selectedCallID: Int?
    @Published var selection: SidebarItem? = .dialer
    @Published var dialString = ""
    @Published var showingNewCall = false
    @Published var dialerAccountID: UUID?
    @Published var pendingImport: ImportRequest?
    @Published var managedSetupURL: URL?
    @Published var alert: AppAlert?
    @Published private(set) var audioDevices: [AudioDevice] = []
    @Published private(set) var codecs: [CodecInfo] = []
    @Published private(set) var engineIsRunning = false
    @Published private(set) var engineError: String?
    @Published private(set) var unseenMissedCalls = 0
    @Published private(set) var transferStatus: String?
    @Published private(set) var lastEndedCall: CallSnapshot?
    @Published private(set) var cloudSyncStatus: CloudSyncStatus = .off

    let engine: SIPEngine
    let store: PersistenceStore
    let passwords: PasswordStore
    let ringer = Ringer()
    let notifications = NotificationManager()
    let cloudSync = CloudSyncService()
    let managedAccounts = ManagedAccountsController()
    private var managedPasswords: [UUID: String] = [:]
    private var managedAccountIDs = Set<UUID>()
    private var managedCallControl: ManagedCallControl?
    private var incomingTasks: [Int: (call: CallSnapshot, task: Task<Void, Never>)] = [:]
    @Published private(set) var changingAudio = false
    @Published private(set) var meetingAudioClaimed = false
    var meetingPhoneBusy: Bool { changingAudio || !calls.isEmpty }
    func claimMeetingAudio() -> Bool {
        guard !meetingAudioClaimed, !meetingPhoneBusy, engine.activeCalls().isEmpty else { return false }
        meetingAudioClaimed = true
        return true
    }
    func releaseMeetingAudio() { meetingAudioClaimed = false }
    private var answerTasks: [Int: (call: CallSnapshot, task: Task<Void, Never>)] = [:]
    private var verifiedManagedCalls: [Int: CallSnapshot] = [:]
    var requestMicrophone: () async -> Bool = {
        await withCheckedContinuation { continuation in
            MicrophoneAccess.request { continuation.resume(returning: $0) }
        }
    }

    private var tombstones: [SyncCollection: [SyncTombstone]] = [:]
    private let cloudEncoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = JSONDates.encoding
        e.outputFormatting = [.sortedKeys]
        return e
    }()
    private let cloudDecoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = JSONDates.decoding
        return d
    }()

    private var declinedCallIDs: Set<Int> = []
    private var callRecordIDs: [Int: UUID] = [:]
    /// Calls the user asked to record (or stopped recording) by hand.
    private var recordingRequests: Set<Int> = []
    private var recordingOptOuts: Set<Int> = []
    /// Recording files per call, oldest first; a call can be recorded in several pieces.
    private var recordingURLs: [Int: [URL]] = [:]
    private var saveWork: [String: DispatchWorkItem] = [:]
    private var incomingPanel: IncomingCallPanelController?
    private var networkAvailable = true
    private var receivedNetworkPath = false
    private var networkRecovery: Task<Void, Never>?

    init(store: PersistenceStore = PersistenceStore(),
         passwords: PasswordStore = KeychainPasswordStore(),
         engine: SIPEngine = SIPEngine(),
         startEngine: Bool = true) {
        self.store = store
        self.passwords = passwords
        self.engine = engine
        engine.delegate = self
        notifications.delegate = self
        cloudSync.delegate = self
        load()
        passwords.synchronizable = settings.iCloudSync
        if startEngine {
            startEngineIfNeeded()
        }
        if settings.iCloudSync {
            cloudSync.start()
        }
    }

    // MARK: Loading and saving

    private func load() {
        profiles = store.load([Profile].self, from: StoreFile.profiles) ?? []
        accounts = store.load([SIPAccount].self, from: StoreFile.accounts) ?? []
        history = store.load([CallRecord].self, from: StoreFile.history) ?? []
        contacts = store.load([Contact].self, from: StoreFile.contacts) ?? []
        settings = store.load(AppSettings.self, from: StoreFile.settings) ?? AppSettings()
        tombstones = store.load([SyncCollection: [SyncTombstone]].self, from: StoreFile.tombstones) ?? [:]

        if profiles.isEmpty {
            let profile = Profile(name: Profile.defaultName)
            profiles = [profile]
            // Adopt orphaned accounts.
            for index in accounts.indices where !profiles.contains(where: { $0.id == accounts[index].profileID }) {
                accounts[index].profileID = profile.id
            }
            persistProfiles()
            persistAccounts()
        } else {
            let fallback = profiles[0].id
            var changed = false
            for index in accounts.indices where !profiles.contains(where: { $0.id == accounts[index].profileID }) {
                accounts[index].profileID = fallback
                changed = true
            }
            if changed { persistAccounts() }
        }
        profiles.sort { ($0.sortOrder, $0.createdAt) < ($1.sortOrder, $1.createdAt) }
        accounts.sort { ($0.sortOrder, $0.createdAt) < ($1.sortOrder, $1.createdAt) }
        history.sort { $0.startedAt > $1.startedAt }
        if history.count > 5000 { history = Array(history.prefix(5000)) }
        for index in history.indices where history[index].endedAt == nil {
            // Left over from a crash or forced quit while a call was in progress.
            history[index].endedAt = history[index].connectedAt ?? history[index].startedAt
            if history[index].outcome == .failed, history[index].connectedAt != nil { history[index].outcome = .completed }
        }
        unseenMissedCalls = 0

        dialerAccountID = settings.lastUsedAccountID.flatMap { id in accounts.first { $0.id == id }?.id }
            ?? accounts.first(where: \.isEnabled)?.id
    }

    private func scheduleSave(_ file: String, _ block: @escaping () -> Void) {
        saveWork[file]?.cancel()
        let work = DispatchWorkItem(block: block)
        saveWork[file] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    private func persistProfiles(push: Bool = true) {
        let value = manualProfiles
        scheduleSave(StoreFile.profiles) { [store] in try? store.save(value, to: StoreFile.profiles) }
        if push { pushCloud(.profiles) }
    }

    private func persistAccounts(push: Bool = true) {
        let value = accounts.filter { $0.managed == nil }
        scheduleSave(StoreFile.accounts) { [store] in try? store.save(value, to: StoreFile.accounts) }
        if push { pushCloud(.accounts) }
    }

    private func persistHistory(push: Bool = true) {
        let value = history
        scheduleSave(StoreFile.history) { [store] in try? store.save(value, to: StoreFile.history) }
        if push { pushCloud(.history) }
    }

    private func persistContacts(push: Bool = true) {
        let value = contacts
        scheduleSave(StoreFile.contacts) { [store] in try? store.save(value, to: StoreFile.contacts) }
        if push { pushCloud(.contacts) }
    }

    private func persistTombstones() {
        let value = tombstones
        scheduleSave(StoreFile.tombstones) { [store] in try? store.save(value, to: StoreFile.tombstones) }
    }

    private func addTombstone(_ collection: SyncCollection, _ id: UUID) {
        tombstones[collection, default: []].removeAll { $0.id == id }
        tombstones[collection, default: []].append(SyncTombstone(id: id, deletedAt: Date.stamp()))
        persistTombstones()
    }

    private func persistSettings() {
        let value = settings
        scheduleSave(StoreFile.settings) { [store] in try? store.save(value, to: StoreFile.settings) }
    }

    /// Flushes pending writes synchronously (used at termination).
    func flush() {
        for (_, work) in saveWork { work.cancel() }
        saveWork.removeAll()
        try? store.save(manualProfiles, to: StoreFile.profiles)
        try? store.save(accounts.filter { $0.managed == nil }, to: StoreFile.accounts)
        try? store.save(history, to: StoreFile.history)
        try? store.save(contacts, to: StoreFile.contacts)
        try? store.save(settings, to: StoreFile.settings)
        try? store.save(tombstones, to: StoreFile.tombstones)
    }

    // MARK: Engine lifecycle

    func startEngineIfNeeded() {
        guard !engine.isRunning else { return }
        do {
            try engine.start(settings: settings)
            if !networkAvailable { engine.networkChanged(available: false) }
            engineIsRunning = true
            engineError = nil
            refreshAudioDevices()
            refreshCodecs()
            syncEngineAccounts()
        } catch {
            engineIsRunning = false
            engineError = error.localizedDescription
            for account in accounts {
                registrations[account.id] = .failed(code: 0, reason: "Engine not running")
            }
        }
    }

    func restartEngine() {
        do {
            try engine.restart(settings: settings)
            if !networkAvailable { engine.networkChanged(available: false) }
            engineIsRunning = true
            engineError = nil
            refreshAudioDevices()
            refreshCodecs()
            syncEngineAccounts()
        } catch {
            engineIsRunning = false
            engineError = error.localizedDescription
            alert = AppAlert(title: "Could not restart the SIP engine", message: error.localizedDescription)
        }
    }

    func shutdown() {
        networkRecovery?.cancel()
        networkRecovery = nil
        managedAccounts.stop()
        for entry in incomingTasks.values { entry.task.cancel() }
        for entry in answerTasks.values { entry.task.cancel() }
        incomingTasks.removeAll(); answerTasks.removeAll(); verifiedManagedCalls.removeAll()
        ringer.stop()
        incomingPanel?.close()
        engine.stop()
        flush()
    }

    /// Accounts that should be live in pjsua: enabled and in an enabled profile.
    private var activeAccounts: [SIPAccount] {
        accounts.filter { canUseAccount($0) }
    }

    func canUseAccount(_ account: SIPAccount, now: Date = Date()) -> Bool {
        account.isEnabled && (profile(for: account.profileID)?.isEnabled ?? false)
            && (account.managed.map { $0.expiresAt > now } ?? true)
    }

    private var accountSyncGeneration = 0

    /// Reads passwords off the main thread (a Keychain prompt can block the call for
    /// as long as the user takes) and then hands the active set to the engine.
    private func syncEngineAccounts(completion: ((Bool) -> Void)? = nil) {
        // Withdrawal may arrive while caller lookup, microphone permission or an answer
        // reservation is pending. Established calls retain their existing conversation.
        for entry in Array(incomingTasks.values) + Array(answerTasks.values) {
            if account(for: entry.call.accountID).map({ canUseAccount($0) }) != true {
                entry.task.cancel()
                engine.hangup(entry.call, code: 480, onlyIfRinging: true)
            }
        }
        guard engineIsRunning else { completion?(false); return }
        let active = activeAccounts
        engine.retainManagedAccounts(Set(active.filter { $0.managed != nil }.map(\.id)))
        for account in active where registrations[account.id] == nil {
            registrations[account.id] = .registering
        }
        for account in accounts where !active.contains(where: { $0.id == account.id }) {
            registrations[account.id] = .unregistered
        }
        accountSyncGeneration += 1
        let generation = accountSyncGeneration
        let passwords = self.passwords
        let managedPasswords = self.managedPasswords
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let lookups = active.map { account in
                (account, account.managed == nil ? passwords.lookup(for: account.id)
                    : managedPasswords[account.id].map(PasswordLookup.found) ?? .missing)
            }
            Task { @MainActor [weak self] in
                guard let self, generation == self.accountSyncGeneration else { completion?(false); return }
                var entries: [(account: SIPAccount, password: String)] = []
                for (account, lookup) in lookups {
                    switch lookup {
                    case .found(let password):
                        entries.append((account, password))
                    case .missing:
                        self.registrations[account.id] = .failed(code: 0, reason: "No password stored. Edit the account to enter it.")
                    case .denied(let status):
                        let detail = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
                        self.registrations[account.id] = .failed(code: 0, reason: "Keychain access denied (\(detail)). Allow Sipper in the Keychain prompt, or build with a stable signing identity.")
                    }
                }
                self.engine.syncAccounts(entries)
                completion?(true)
            }
        }
    }

    private func settingsDidChange(from old: AppSettings) {
        persistSettings()
        if old.messageNotifications != settings.messageNotifications { managedAccounts.messageNotificationsChanged() }
        guard engineIsRunning else { return }
        let networkChanged = old.localUDPPort != settings.localUDPPort
            || old.localTCPPort != settings.localTCPPort
            || old.localTLSPort != settings.localTLSPort
            || old.userAgent != settings.userAgent
            || old.verifyTLSCertificates != settings.verifyTLSCertificates
            || old.sipLogLevel != settings.sipLogLevel
            || old.stunServer != settings.stunServer
        if networkChanged {
            restartEngine()
            return
        }
        if old.inputDeviceName != settings.inputDeviceName || old.outputDeviceName != settings.outputDeviceName {
            engine.setAudioDevices(input: settings.inputDeviceName, output: settings.outputDeviceName)
        }
        if old.codecs != settings.codecs {
            engine.setCodecPreferences(settings.codecs)
        }
        if old.echoMode != settings.echoMode || old.echoTailMilliseconds != settings.echoTailMilliseconds {
            engine.setEchoCancellation(mode: settings.echoMode, tailMilliseconds: settings.echoTailMilliseconds)
        }
        if old.launchAtLogin != settings.launchAtLogin {
            LaunchAtLogin.set(enabled: settings.launchAtLogin) { [weak self] error in
                if let error { self?.alert = AppAlert(title: "Launch at login", message: error.localizedDescription) }
            }
        }
        if old.showNotifications != settings.showNotifications, settings.showNotifications {
            notifications.requestAuthorization()
        }
        if old.iCloudSync != settings.iCloudSync {
            passwords.synchronizable = settings.iCloudSync
            if settings.iCloudSync {
                migratePasswordsToCurrentKeychainMode()
                cloudSync.start()
            } else {
                cloudSync.stop()
            }
        }
        if old.iCloudSyncHistory != settings.iCloudSyncHistory {
            pushCloud(.history)
        }
    }

    /// Re-saves every password so the items match the current iCloud Keychain setting.
    private func migratePasswordsToCurrentKeychainMode() {
        var failures: [String] = []
        for account in accounts where account.managed == nil {
            if case .found(let password) = passwords.lookup(for: account.id) {
                do { try passwords.setPassword(password, for: account.id) } catch { failures.append("\(account.displayLabel): \(error.localizedDescription)") }
            }
        }
        if !failures.isEmpty {
            alert = AppAlert(title: "Some passwords could not be moved to iCloud Keychain",
                             message: failures.joined(separator: "\n") + "\n\nThe existing passwords are unchanged.")
        }
    }

    func refreshAudioDevices() {
        audioDevices = engine.audioDevices()
    }

    func refreshCodecs() {
        let live = engine.codecs()
        codecs = live
        if settings.codecs.isEmpty, !live.isEmpty {
            settings.codecs = CodecDefaults.seed(from: live)
            engine.setCodecPreferences(settings.codecs)
        } else if !live.isEmpty {
            // Add codecs that appeared since the list was saved.
            let known = Set(settings.codecs.map(\.codecID))
            let missing = live.filter { !known.contains($0.id) }
            if !missing.isEmpty {
                settings.codecs += missing.map { CodecPreference(codecID: $0.id, isEnabled: $0.priority > 0) }
            }
        }
    }

    // MARK: Profiles

    var manualProfiles: [Profile] { profiles.filter { $0.managedOrganisationID == nil } }

    func configureManagedCalls(client: ManagedClient) {
        managedCallControl = ManagedCallControl(engine: engine, client: client)
    }

    /// The configuration stays in memory; its encrypted cache belongs to the managed SDK.
    func applyManagedConfiguration(_ configuration: ManagedConfiguration, profileID: UUID,
                                   afterSync: (([(account: SIPAccount, password: String)], Bool) -> Void)? = nil) throws {
        try configuration.validate(organisationID: configuration.organisation.id, deviceID: configuration.deviceId)
        if let existing = profile(for: profileID), existing.managedOrganisationID != configuration.organisation.id {
            throw ManagedError.invalidConfiguration
        }
        let mapped = configuration.accounts.map { ManagedAccountMapper.account($0, configuration: configuration, profileID: profileID) }
        for account in mapped {
            if let existing = self.account(for: account.id), existing.managed?.deviceID != configuration.deviceId {
                throw ManagedError.invalidConfiguration
            }
        }
        let previous = Dictionary(uniqueKeysWithValues: accounts.filter { $0.managed?.deviceID == configuration.deviceId }.map { ($0.id, $0) })
        var profile = profile(for: profileID) ?? Profile(id: profileID, name: configuration.organisation.name, colorName: .teal, iconName: "building.2.crop.circle", sortOrder: profiles.count)
        profile.name = configuration.organisation.name
        profile.managedOrganisationID = configuration.organisation.id
        profiles.removeAll { $0.id == profileID }; profiles.append(profile)
        let wanted = Set(mapped.map(\.id))
        for id in previous.keys where !wanted.contains(id) { managedPasswords[id] = nil; registrations[id] = nil; voicemail[id] = nil }
        accounts.removeAll { $0.managed?.deviceID == configuration.deviceId }
        var expected: [(account: SIPAccount, password: String)] = []
        for (index, var account) in mapped.enumerated() {
            account.sortOrder = index
            account.isEnabled = previous[account.id]?.isEnabled ?? true
            accounts.append(account)
            managedAccountIDs.insert(account.id)
            managedPasswords[account.id] = configuration.accounts[index].password
            expected.append((account, configuration.accounts[index].password))
        }
        if dialerAccountID == nil { dialerAccountID = activeAccounts.first?.id }
        syncEngineAccounts { ready in afterSync?(expected, ready) }
    }

    /// Password lookup and engine reconciliation must finish before reporting an applied revision.
    func applyManagedConfigurationAndReport(_ configuration: ManagedConfiguration, profileID: UUID) async throws -> ManagedDeviceReport {
        try await withCheckedThrowingContinuation { continuation in
            do {
                try applyManagedConfiguration(configuration, profileID: profileID) { expected, ready in
                    continuation.resume(returning: ManagedAccountMapper.deviceReport(configuration, expected: expected, engine: self.engine, ready: ready))
                }
            } catch { continuation.resume(throwing: error) }
        }
    }

    /// Observe the already applied settings without reapplying accounts or fetching provisioning.
    func managedDeviceReport(_ configuration: ManagedConfiguration, profileID: UUID) -> ManagedDeviceReport {
        let expected = configuration.accounts.enumerated().map { index, value in
            var account = ManagedAccountMapper.account(value, configuration: configuration, profileID: profileID)
            account.sortOrder = index; account.isEnabled = self.account(for: account.id)?.isEnabled ?? true
            return (account: account, password: value.password)
        }
        return ManagedAccountMapper.deviceReport(configuration, expected: expected, engine: engine)
    }

    func removeManagedAccounts(deviceID: UUID, profileID: UUID? = nil) {
        let removed = accounts.filter { $0.managed?.deviceID == deviceID }
        for account in removed { managedPasswords[account.id] = nil; registrations[account.id] = nil; voicemail[account.id] = nil }
        accounts.removeAll { $0.managed?.deviceID == deviceID }
        let profileIDs = Set(removed.map(\.profileID) + (profileID.map { [$0] } ?? []))
        let usedProfiles = Set(accounts.map(\.profileID))
        profiles.removeAll { profileIDs.contains($0.id) && $0.managedOrganisationID != nil && !usedProfiles.contains($0.id) }
        if let id = dialerAccountID, removed.contains(where: { $0.id == id }) { dialerAccountID = activeAccounts.first?.id }
        syncEngineAccounts()
    }

    func expireManagedAccounts(now: Date = Date()) {
        let expired = accounts.filter { $0.managed.map({ $0.expiresAt <= now }) == true && managedPasswords[$0.id] != nil }
        guard !expired.isEmpty else { return }
        for account in expired { managedPasswords[account.id] = nil }
        syncEngineAccounts()
        for account in expired { registrations[account.id] = .failed(code: 0, reason: "Managed settings expired. Connect to refresh them.") }
    }

    var sortedProfiles: [Profile] { profiles }

    func profile(for id: UUID) -> Profile? { profiles.first { $0.id == id } }

    func accounts(in profileID: UUID) -> [SIPAccount] { accounts.filter { $0.profileID == profileID } }

    @discardableResult
    func addProfile(name: String, color: ProfileColor = .blue, icon: String = "building.2") -> Profile {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        let profile = Profile(name: trimmed.isEmpty ? "Profile" : trimmed,
                              colorName: color,
                              iconName: icon,
                              sortOrder: (profiles.map(\.sortOrder).max() ?? -1) + 1)
        profiles.append(profile)
        persistProfiles()
        return profile
    }

    func updateProfile(_ profile: Profile) {
        guard let index = profiles.firstIndex(where: { $0.id == profile.id }) else { return }
        guard profiles[index].managedOrganisationID == nil else { return }
        let wasEnabled = profiles[index].isEnabled
        var updated = profile
        updated.updatedAt = Date.stamp()
        profiles[index] = updated
        persistProfiles()
        if wasEnabled != profile.isEnabled { syncEngineAccounts() }
    }

    func setProfileEnabled(_ id: UUID, enabled: Bool) {
        guard var profile = profile(for: id) else { return }
        if profile.managedOrganisationID != nil {
            profiles[profiles.firstIndex(where: { $0.id == id })!].isEnabled = enabled
            syncEngineAccounts()
            return
        }
        profile.isEnabled = enabled
        updateProfile(profile)
    }

    /// Deletes a profile. Accounts move to `destination` or are deleted when nil.
    func deleteProfile(_ id: UUID, moveAccountsTo destination: UUID?) {
        guard manualProfiles.count > 1, let index = profiles.firstIndex(where: { $0.id == id }) else { return }
        guard profiles[index].managedOrganisationID == nil,
              destination.map({ profile(for: $0)?.managedOrganisationID == nil }) ?? true else { return }
        let members = accounts(in: id)
        if let destination, profiles.contains(where: { $0.id == destination }) {
            for member in members {
                var moved = member
                moved.profileID = destination
                replaceAccount(moved)
            }
        } else {
            for member in members { deleteAccount(member.id) }
        }
        profiles.remove(at: index)
        addTombstone(.profiles, id)
        persistProfiles()
        if case .profile(id) = selection { selection = .dialer }
        syncEngineAccounts()
    }

    func moveProfiles(fromOffsets: IndexSet, toOffset: Int) {
        profiles.move(fromOffsets: fromOffsets, toOffset: toOffset)
        for index in profiles.indices where profiles[index].sortOrder != index {
            profiles[index].sortOrder = index
            profiles[index].updatedAt = Date.stamp()
        }
        persistProfiles()
    }

    // MARK: Accounts

    func account(for id: UUID) -> SIPAccount? { accounts.first { $0.id == id } }

    func registration(for id: UUID) -> RegistrationState {
        if account(for: id)?.managed.map({ $0.expiresAt <= Date() }) == true {
            return .failed(code: 0, reason: "Managed settings expired. Connect to refresh them.")
        }
        if !networkAvailable, let account = account(for: id), canUseAccount(account) {
            return .failed(code: 0, reason: "No network connection")
        }
        return registrations[id] ?? .unregistered
    }

    func password(for accountID: UUID) -> String {
        guard account(for: accountID)?.managed == nil else { return "" }
        return passwords.password(for: accountID) ?? ""
    }

    var registeredAccounts: [SIPAccount] { activeAccounts.filter { registration(for: $0.id).isRegistered } }

    func duplicateAccount(username: String, domain: String, excluding: UUID? = nil) -> SIPAccount? {
        accounts.first { $0.managed == nil && $0.id != excluding && $0.matches(username: username, domain: domain) }
    }

    @discardableResult
    func addAccount(_ draft: SIPAccount, password: String) throws -> SIPAccount {
        guard draft.managed == nil, account(for: draft.id) == nil,
              profile(for: draft.profileID)?.managedOrganisationID == nil else { throw ManagedError.invalidConfiguration }
        var account = draft
        if !profiles.contains(where: { $0.id == account.profileID }) {
            account.profileID = profiles[0].id
        }
        account.sortOrder = (accounts(in: account.profileID).map(\.sortOrder).max() ?? -1) + 1
        try passwords.setPassword(password, for: account.id)
        accounts.append(account)
        persistAccounts()
        if dialerAccountID == nil { dialerAccountID = account.id }
        syncEngineAccounts()
        return account
    }

    func updateAccount(_ account: SIPAccount, password: String?) throws {
        guard account.managed == nil, self.account(for: account.id)?.managed == nil,
              profile(for: account.profileID)?.managedOrganisationID == nil else { throw ManagedError.accessUnavailable("Your administrator manages these settings.") }
        if let password {
            try passwords.setPassword(password, for: account.id)
        }
        replaceAccount(account)
        syncEngineAccounts()
    }

    private func replaceAccount(_ account: SIPAccount) {
        guard let index = accounts.firstIndex(where: { $0.id == account.id }) else { return }
        var updated = account
        updated.updatedAt = Date.stamp()
        accounts[index] = updated
        persistAccounts()
    }

    func setAccountEnabled(_ id: UUID, enabled: Bool) {
        guard var account = account(for: id) else { return }
        account.isEnabled = enabled
        replaceAccount(account)
        syncEngineAccounts()
    }

    func deleteAccount(_ id: UUID) {
        guard account(for: id)?.managed == nil else { return }
        accounts.removeAll { $0.id == id }
        addTombstone(.accounts, id)
        passwords.removePassword(for: id)
        registrations[id] = nil
        voicemail[id] = nil
        persistAccounts()
        if dialerAccountID == id { dialerAccountID = accounts.first(where: \.isEnabled)?.id }
        if case .account(id) = selection { selection = .dialer }
        syncEngineAccounts()
    }

    func moveAccounts(in profileID: UUID, fromOffsets: IndexSet, toOffset: Int) {
        var members = accounts(in: profileID)
        members.move(fromOffsets: fromOffsets, toOffset: toOffset)
        for (order, member) in members.enumerated() {
            if let index = accounts.firstIndex(where: { $0.id == member.id }), accounts[index].sortOrder != order {
                accounts[index].sortOrder = order
                accounts[index].updatedAt = Date.stamp()
            }
        }
        accounts.sort { ($0.sortOrder, $0.createdAt) < ($1.sortOrder, $1.createdAt) }
        persistAccounts()
    }

    func moveAccount(_ id: UUID, to profileID: UUID) {
        guard var account = account(for: id), profiles.contains(where: { $0.id == profileID }) else { return }
        guard account.managed == nil, profile(for: profileID)?.managedOrganisationID == nil else { return }
        account.profileID = profileID
        account.sortOrder = (accounts(in: profileID).map(\.sortOrder).max() ?? -1) + 1
        replaceAccount(account)
        syncEngineAccounts()
    }

    func reRegister(_ id: UUID) {
        guard activeAccounts.contains(where: { $0.id == id }) else { return }
        guard networkAvailable else {
            registrations[id] = .failed(code: 0, reason: "No network connection")
            return
        }
        registrations[id] = .registering
        engine.setRegistration(accountID: id, enabled: true)
    }

    func reRegisterAll() {
        for account in activeAccounts { reRegister(account.id) }
    }

    func networkPathChanged(available: Bool) {
        if !receivedNetworkPath {
            receivedNetworkPath = true
            // The first connected path describes startup, not a route change.
            // PJSIP recovery would cancel any outgoing call still connecting.
            if available && networkAvailable { return }
        }
        networkChanged(available: available)
    }

    func networkChanged(available: Bool) {
        networkAvailable = available
        networkRecovery?.cancel()
        guard engine.isRunning else { return }
        if !available {
            for account in activeAccounts { registrations[account.id] = .failed(code: 0, reason: "No network connection") }
            engine.networkChanged(available: false)
            return
        }
        // Coalesce route changes and wake notifications without restarting the engine.
        networkRecovery = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
            guard let self else { return }
            self.engine.networkChanged(available: true)
            await self.managedAccounts.refresh()
        }
    }

    // MARK: Calls

    var activeCall: CallSnapshot? {
        if let selectedCallID, let call = calls.first(where: { $0.id == selectedCallID }) { return call }
        return calls.first
    }

    var hasActiveCalls: Bool { !calls.isEmpty }

    func prepareNewCall(_ target: String = "", from accountID: UUID? = nil) {
        dialString = target
        dialerAccountID = accountID ?? activeCall?.accountID ?? dialerAccount?.id
        showingNewCall = hasActiveCalls
        selection = .dialer
        NotificationCenter.default.post(name: .sipperFocusDialer, object: nil)
    }

    /// The account the dialer should use.
    var dialerAccount: SIPAccount? {
        if let dialerAccountID, let account = account(for: dialerAccountID) { return account }
        return registeredAccounts.first ?? accounts.first
    }

    func callDirectory(_ number: String, contactID: UUID, enrollment: ManagedEnrollment, accountID: UUID) throws {
        guard let client = managedAccounts.client, let account = account(for: accountID), canUseAccount(account),
              ManagedAccountMapper.directoryAccount(account)?.belongs(to: enrollment) == true else {
            throw ManagedError.accessUnavailable("This customer’s calling account is unavailable.")
        }
        let verified = try client.directoryNumber(number, contactID: contactID, for: enrollment)
        call(verified, from: account.id)
    }

    func call(_ target: String, from accountID: UUID? = nil) {
        guard !meetingAudioClaimed else {
            alert = AppAlert(title: "Meeting in progress", message: "Leave your meeting before making a phone call.")
            return
        }
        let trimmed = target.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard engineIsRunning else {
            alert = AppAlert(title: "Cannot place call", message: engineError ?? "The SIP engine is not running.")
            return
        }
        guard let account = accountID.flatMap(account(for:)) ?? dialerAccount else {
            alert = AppAlert(title: "No account", message: "Add a SIP account before placing a call.")
            return
        }
        guard canUseAccount(account) else {
            alert = AppAlert(title: "Account unavailable", message: account.managed == nil ? "Enable this account and its profile before calling." : "Enable this account and refresh its managed settings before calling.")
            return
        }
        guard registration(for: account.id).isRegistered || !account.usesSeparateServer else {
            alert = AppAlert(title: "Account not registered",
                             message: "\(account.displayLabel) is not registered: \(registration(for: account.id).detail)")
            return
        }

        Task { [weak self] in
            guard let self, !self.changingAudio, !self.meetingAudioClaimed else { return }
            self.changingAudio = true
            defer { self.changingAudio = false }
            let granted = await self.requestMicrophone()
            guard let current = self.account(for: account.id), self.canUseAccount(current) else { return }
            if !granted {
                self.alert = AppAlert(title: "Microphone access needed",
                                      message: "Allow Sipper to use the microphone in System Settings › Privacy & Security › Microphone.")
                return
            }
            do {
                guard self.calls.allSatisfy({ $0.state == .incoming || ($0.state == .confirmed && !$0.isTransferring) }) else { throw SIPEngineError.holdUpdating }
                // Put other calls on hold before dialling.
                try await self.holdCalls()
                try Task.checkCancellation()
                guard let current = self.account(for: account.id), self.canUseAccount(current) else { throw SIPEngineError.unknownAccount }
                var snapshot = try self.engine.makeCall(accountID: account.id, uri: current.callURI(for: trimmed))
                let contact = self.contact(forNumber: snapshot.remoteNumber)
                if snapshot.remoteName.isEmpty, let contact { snapshot.remoteName = contact.name }
                self.upsert(snapshot)
                self.selectedCallID = snapshot.id
                self.showingNewCall = false
                self.settings.lastUsedAccountID = account.id
                self.dialerAccountID = account.id
                self.dialString = ""
                self.selection = .dialer
                self.beginRecord(for: snapshot)
            } catch {
                self.alert = AppAlert(title: "Call failed", message: error.localizedDescription)
            }
        }
    }

    func callVoicemail(for accountID: UUID? = nil) {
        guard let account = accountID.flatMap(account(for:)) ?? dialerAccount else { return }
        let number = account.voicemailNumber.isEmpty ? "*97" : account.voicemailNumber
        call(number, from: account.id)
    }

    func callBack(_ record: CallRecord) {
        let accountID = accounts.contains(where: { $0.id == record.accountID }) ? record.accountID : nil
        guard !record.isManaged || accountID != nil else {
            alert = AppAlert(title: "Account unavailable", message: "Reconnect the managed account used for this call before calling back.")
            return
        }
        call(record.remoteNumber, from: accountID)
    }

    private func receiveIncoming(_ call: CallSnapshot) {
        guard let account = account(for: call.accountID), canUseAccount(account) else {
            engine.hangup(call, code: 480, onlyIfRinging: true)
            return
        }
        guard call.gatewayCallID != nil else { presentVerifiedIncoming(call); return }
        guard let control = managedCallControl else {
            engine.hangup(call, code: 480, onlyIfRinging: true)
            return
        }
        if incomingTasks[call.id]?.call.startedAt == call.startedAt { return }
        incomingTasks[call.id]?.task.cancel()
        let task = Task { [weak self] in
            guard let self else { return }
            defer { if self.incomingTasks[call.id]?.call.startedAt == call.startedAt { self.incomingTasks[call.id] = nil } }
            do {
                let verified = try await control.prepare(call)
                try Task.checkCancellation()
                guard let current = self.account(for: call.accountID), self.canUseAccount(current) else { throw ManagedError.callUnavailable }
                self.verifiedManagedCalls[call.id] = verified
                self.presentVerifiedIncoming(verified)
                await control.monitor(verified)
            } catch { self.engine.hangup(call, code: 480, onlyIfRinging: true) }
        }
        incomingTasks[call.id] = (call, task)
    }

    private func presentVerifiedIncoming(_ incoming: CallSnapshot) {
        var call = incoming
        if let contact = contact(forNumber: call.remoteNumber), call.remoteName.isEmpty { call.remoteName = contact.name }
        if settings.doNotDisturb {
            upsert(call)
            decline(callID: call.id)
            return
        }
        upsert(call)
        beginRecord(for: call)
        if selectedCallID == nil { selectedCallID = call.id }
        presentIncomingCall(call)
        let delay = settings.autoAnswerSeconds
        if delay > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(delay)) { [weak self] in
                guard let self, self.calls.contains(where: { $0.id == call.id && $0.startedAt == call.startedAt && $0.state == .incoming }) else { return }
                self.answer(callID: call.id)
            }
        }
    }

    private func verifiedCaller(_ snapshot: CallSnapshot) -> CallSnapshot? {
        guard snapshot.gatewayCallID != nil else { return snapshot }
        guard let verified = verifiedManagedCalls[snapshot.id], verified.startedAt == snapshot.startedAt,
              verified.accountID == snapshot.accountID, verified.gatewayCallID == snapshot.gatewayCallID else { return nil }
        // A native status update may have been queued before the authenticated
        // lookup finished. Keep its state, but never restore its placeholder caller.
        var call = snapshot
        call.remoteName = verified.remoteName
        call.remoteNumber = verified.remoteNumber
        call.remoteURI = verified.remoteURI
        return call
    }

    func answer(callID: Int) {
        guard !meetingAudioClaimed else {
            alert = AppAlert(title: "Meeting in progress", message: "Leave your meeting before answering this phone call.")
            return
        }
        guard let call = calls.first(where: { $0.id == callID && $0.state == .incoming }),
              let account = account(for: call.accountID), canUseAccount(account), answerTasks[callID] == nil else { return }
        let task = Task { [weak self] in
            guard let self else { return }
            defer { if self.answerTasks[callID]?.call.startedAt == call.startedAt { self.answerTasks[callID] = nil } }
            guard !self.changingAudio, !self.meetingAudioClaimed else { return }
            self.changingAudio = true
            defer { self.changingAudio = false }
            do {
                guard self.calls.allSatisfy({ $0.id == callID || $0.state == .incoming || ($0.state == .confirmed && !$0.isTransferring) }) else { throw SIPEngineError.holdUpdating }
                let granted = await self.requestMicrophone()
                try Task.checkCancellation()
                guard granted else {
                    throw NSError(domain: "Sipper", code: 1, userInfo: [NSLocalizedDescriptionKey: "Allow Sipper to use the microphone in System Settings › Privacy & Security › Microphone."])
                }
                var claim: UUID?
                if call.gatewayCallID != nil {
                    guard let control = self.managedCallControl else { throw ManagedError.callUnavailable }
                    claim = try await control.claim(call)
                }
                try Task.checkCancellation()
                guard let current = self.account(for: call.accountID), self.canUseAccount(current),
                      self.calls.contains(where: { $0.id == call.id && $0.startedAt == call.startedAt && $0.state == .incoming }) else { throw ManagedError.callUnavailable }
                try await self.holdCalls(except: call)
                try Task.checkCancellation()
                try self.engine.answer(call, claimedGatewayCallID: claim)
                self.ringer.stop()
                self.incomingPanel?.dismiss(callID: callID)
                if self.settings.muteMicrophoneOnAnswer { self.engine.setMuted(callID: callID, muted: true) }
                self.selectedCallID = callID
                self.showingNewCall = false
                self.selection = .dialer
                NSApp.activate(ignoringOtherApps: true)
            } catch {
                if !Task.isCancelled { self.alert = AppAlert(title: "Could not answer call", message: error.localizedDescription) }
                self.engine.hangup(call, code: 480, onlyIfRinging: true)
                let control = self.managedCallControl
                Task { await control?.decline(call) }
            }
        }
        answerTasks[callID] = (call, task)
    }

    func decline(callID: Int) {
        guard let call = calls.first(where: { $0.id == callID && $0.state == .incoming }) else { return }
        answerTasks[callID]?.task.cancel()
        declinedCallIDs.insert(callID)
        ringer.stop()
        incomingPanel?.dismiss(callID: callID)
        engine.hangup(call, code: 486, onlyIfRinging: true)
        let control = managedCallControl
        Task { await control?.decline(call) }
    }

    func hangup(callID: Int) {
        guard let call = calls.first(where: { $0.id == callID }) else { return }
        if call.state == .incoming { decline(callID: callID); return }
        answerTasks[callID]?.task.cancel()
        engine.hangup(call)
    }

    func hangupActiveCall() {
        guard let call = activeCall else { return }
        if call.conferenceID != nil { engine.hangupConference(call) }
        else if call.state == .incoming { decline(callID: call.id) }
        else { hangup(callID: call.id) }
    }

    func toggleMute(callID: Int) {
        guard let call = calls.first(where: { $0.id == callID }) else { return }
        engine.setMuted(callID: callID, muted: !call.isMuted)
    }

    func toggleHold(callID: Int) {
        guard let call = calls.first(where: { $0.id == callID }) else { return }
        if call.isOnHold { swapToCall(callID); return }
        Task { [weak self] in
            guard let self, !self.changingAudio else { return }
            self.changingAudio = true
            defer { self.changingAudio = false }
            do {
                if call.conferenceID != nil { try await self.engine.setConferenceHold(call, onHold: true) }
                else { try await self.engine.setHold(call, onHold: true) }
            }
            catch {
                if self.calls.contains(where: { $0.id == call.id && $0.startedAt == call.startedAt }) {
                    self.alert = AppAlert(title: "Could not change hold", message: error.localizedDescription)
                }
            }
        }
    }

    func swapToCall(_ callID: Int) {
        guard !meetingAudioClaimed else { return }
        guard let call = calls.first(where: { $0.id == callID }) else { return }
        Task { [weak self] in
            guard let self, !self.changingAudio, !self.meetingAudioClaimed else { return }
            self.changingAudio = true
            defer { self.changingAudio = false }
            do {
                try await self.holdCalls(except: call)
                if call.conferenceID != nil { try await self.engine.setConferenceHold(call, onHold: false) }
                else if call.isOnHold { try await self.engine.setHold(call, onHold: false) }
                guard self.calls.contains(where: { $0.id == call.id && $0.startedAt == call.startedAt }) else { return }
                self.selectedCallID = callID
                self.showingNewCall = false
            } catch {
                if !Task.isCancelled { self.alert = AppAlert(title: "Could not switch calls", message: error.localizedDescription) }
            }
        }
    }

    private func holdCalls(except selected: CallSnapshot? = nil) async throws {
        var heldGroups = Set<UUID>()
        for other in engine.activeCalls() where other.state == .confirmed && !other.isOnHold {
            if other.id == selected?.id && other.startedAt == selected?.startedAt { continue }
            if let group = other.conferenceID {
                if group == selected?.conferenceID || !heldGroups.insert(group).inserted { continue }
                try await engine.setConferenceHold(other, onHold: true)
            } else { try await engine.setHold(other, onHold: true) }
        }
    }

    func mergeConference(_ call: CallSnapshot, with other: CallSnapshot) {
        Task { [weak self] in
            guard let self, !self.changingAudio else { return }
            self.changingAudio = true
            defer { self.changingAudio = false }
            do {
                try await self.engine.mergeConference(call, with: other)
                self.selectedCallID = call.id
                self.showingNewCall = false
            } catch { self.alert = AppAlert(title: "Could not merge calls", message: error.localizedDescription) }
        }
    }

    func separateConference(_ call: CallSnapshot) {
        Task { [weak self] in
            guard let self, !self.changingAudio else { return }
            self.changingAudio = true
            defer { self.changingAudio = false }
            do {
                // Put both people on hold before removing their shared audio, then resume the selected person.
                try await self.engine.setConferenceHold(call, onHold: true)
                try self.engine.splitConference(call)
                try await self.engine.setHold(call, onHold: false)
                self.selectedCallID = call.id
            } catch { self.alert = AppAlert(title: "Could not separate calls", message: error.localizedDescription) }
        }
    }

    func sendDTMF(_ digits: String, callID: Int) {
        let cleaned = digits.filter { "0123456789*#ABCDabcd".contains($0) }
        guard !cleaned.isEmpty else { return }
        engine.sendDTMF(callID: callID, digits: cleaned)
    }

    func transfer(_ call: CallSnapshot, to target: String) {
        do {
            guard !changingAudio else { throw SIPEngineError.holdUpdating }
            try engine.transfer(call, to: target)
            transferStatus = "Transferring to \(target)…"
        } catch {
            alert = AppAlert(title: "Transfer failed", message: error.localizedDescription)
        }
    }

    func attendedTransfer(_ call: CallSnapshot, to other: CallSnapshot) {
        do {
            guard !changingAudio else { throw SIPEngineError.holdUpdating }
            try engine.attendedTransfer(call, to: other)
            transferStatus = "Completing transfer…"
        } catch {
            alert = AppAlert(title: "Transfer failed", message: error.localizedDescription)
        }
    }

    private func upsert(_ snapshot: CallSnapshot) {
        if let index = calls.firstIndex(where: { $0.id == snapshot.id }) {
            calls[index] = snapshot
        } else {
            calls.append(snapshot)
        }
    }

    // MARK: History

    private func beginRecord(for call: CallSnapshot) {
        let record = CallRecord(accountID: call.accountID,
                                direction: call.direction,
                                outcome: .failed,
                                remoteNumber: call.remoteNumber,
                                remoteName: call.remoteName,
                                remoteURI: call.remoteURI,
                                startedAt: call.startedAt, isManaged: managedAccountIDs.contains(call.accountID))
        callRecordIDs[call.id] = record.id
        history.insert(record, at: 0)
        persistHistory()
    }

    private func finishRecord(for call: CallSnapshot) {
        let outcome = outcome(for: call)
        guard let recordID = callRecordIDs[call.id],
              let index = history.firstIndex(where: { $0.id == recordID }) else {
            var record = CallRecord(accountID: call.accountID, direction: call.direction, outcome: outcome,
                                    remoteNumber: call.remoteNumber, remoteName: call.remoteName,
                                    remoteURI: call.remoteURI, startedAt: call.startedAt, isManaged: managedAccountIDs.contains(call.accountID))
            record.connectedAt = call.connectedAt
            record.endedAt = call.endedAt ?? Date()
            record.statusCode = call.lastStatusCode
            record.statusText = call.lastStatusText
            history.insert(record, at: 0)
            persistHistory()
            if record.wasMissed { noteMissed(record) }
            return
        }
        history[index].outcome = outcome
        history[index].connectedAt = call.connectedAt
        history[index].endedAt = call.endedAt ?? Date()
        history[index].statusCode = call.lastStatusCode
        history[index].statusText = call.lastStatusText
        if history[index].remoteName.isEmpty { history[index].remoteName = call.remoteName }
        if let url = recordingURLs[call.id]?.last {
            history[index].recordingPath = url.path
        }
        callRecordIDs[call.id] = nil
        persistHistory()
        if history[index].wasMissed { noteMissed(history[index]) }
    }

    // MARK: Recording

    /// Folder for call recordings (Settings › Recording).
    var recordingsDirectory: URL {
        let custom = settings.recordingsFolderPath.trimmingCharacters(in: .whitespaces)
        if !custom.isEmpty { return URL(fileURLWithPath: (custom as NSString).expandingTildeInPath, isDirectory: true) }
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Documents")
        return documents.appendingPathComponent("Sipper Recordings", isDirectory: true)
    }

    func isRecording(callID: Int) -> Bool {
        calls.first { $0.id == callID }?.isRecording ?? false
    }

    /// Starts or stops recording the given call by hand.
    func toggleRecording(callID: Int) {
        guard let call = calls.first(where: { $0.id == callID }) else { return }
        if call.isRecording {
            recordingRequests.remove(callID)
            recordingOptOuts.insert(callID)
            engine.stopRecording(callID: callID)
        } else if settings.recordCalls && !recordingOptOuts.contains(callID) {
            // Auto-record is on and a recording is about to start; nothing to do.
        } else {
            recordingOptOuts.remove(callID)
            recordingRequests.insert(callID)
            startRecordingIfReady(call)
        }
    }

    private func shouldRecord(_ call: CallSnapshot) -> Bool {
        if recordingOptOuts.contains(call.id) { return false }
        return settings.recordCalls || recordingRequests.contains(call.id)
    }

    /// Begins the recorder once the call has audio. Safe to call repeatedly.
    private func startRecordingIfReady(_ call: CallSnapshot) {
        guard call.state == .confirmed, call.hasActiveMedia, !call.isRecording else { return }
        let directory = recordingsDirectory
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent(recordingFileName(for: call))
            try engine.startRecording(callID: call.id, to: url)
            recordingURLs[call.id, default: []].append(url)
        } catch {
            recordingRequests.remove(call.id)
            alert = AppAlert(title: "Could not start recording", message: error.localizedDescription)
        }
    }

    private func recordingFileName(for call: CallSnapshot) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH.mm.ss"
        let who = call.remoteName.isEmpty ? call.remoteNumber : "\(call.remoteName) \(call.remoteNumber)"
        let accountLabel = account(for: call.accountID)?.displayLabel ?? "unknown account"
        let raw = "\(formatter.string(from: Date())) \(call.direction == .incoming ? "from" : "to") \(who) via \(accountLabel)"
        let forbidden = CharacterSet(charactersIn: "/:\\?%*|\"<>")
        let safe = raw.unicodeScalars.map { forbidden.contains($0) ? "-" : Character($0) }
        return String(safe) + ".wav"
    }

    /// Called when a recorded call ends: converts to M4A when enabled and updates history.
    private func finishRecording(for call: CallSnapshot) {
        recordingRequests.remove(call.id)
        recordingOptOuts.remove(call.id)
        guard let urls = recordingURLs.removeValue(forKey: call.id), let url = urls.last else { return }
        guard settings.convertRecordingsToM4A else { return }
        for earlier in urls.dropLast() { convertInPlace(earlier) }
        engine.log.append("Sipper: converting recording \(url.lastPathComponent) to M4A")
        RecordingConverter.convertToM4A(url) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let converted):
                try? FileManager.default.removeItem(at: url)
                if let index = self.history.firstIndex(where: { $0.recordingPath == url.path }) {
                    self.history[index].recordingPath = converted.path
                    self.persistHistory()
                }
                self.engine.log.append("Sipper: recording saved as \(converted.lastPathComponent)")
            case .failure(let error):
                self.engine.log.append("Sipper: keeping WAV recording, conversion failed: \(error.localizedDescription)")
            }
        }
    }

    /// Converts an extra segment that is not linked from history.
    private func convertInPlace(_ url: URL) {
        RecordingConverter.convertToM4A(url) { result in
            if case .success = result { try? FileManager.default.removeItem(at: url) }
        }
    }

    func openRecording(_ record: CallRecord) {
        guard let url = record.recordingURL else { return }
        NSWorkspace.shared.open(url)
    }

    func revealRecording(_ record: CallRecord) {
        guard let url = record.recordingURL else { return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    func deleteRecording(for recordID: UUID) {
        guard let index = history.firstIndex(where: { $0.id == recordID }), let path = history[index].recordingPath else { return }
        try? FileManager.default.removeItem(atPath: path)
        history[index].recordingPath = nil
        persistHistory()
    }

    func revealRecordingsFolder() {
        let directory = recordingsDirectory
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        NSWorkspace.shared.activateFileViewerSelecting([directory])
    }

    private func noteMissed(_ record: CallRecord) {
        unseenMissedCalls += 1
        if settings.showNotifications {
            notifications.postMissedCall(record)
        }
    }

    func outcome(for call: CallSnapshot) -> CallOutcome {
        if call.connectedAt != nil { return .completed }
        switch call.direction {
        case .outgoing:
            switch call.lastStatusCode {
            case 486, 600: return .busy
            case 480, 408: return .noAnswer
            case 487: return .cancelled
            case 603, 403: return .declined
            default: return .failed
            }
        case .incoming:
            if declinedCallIDs.contains(call.id) { return .declined }
            return .missed
        }
    }

    func markMissedCallsSeen() {
        unseenMissedCalls = 0
    }

    func deleteHistory(ids: Set<UUID>) {
        history.removeAll { ids.contains($0.id) }
        for id in ids { addTombstone(.history, id) }
        persistHistory()
    }

    func clearHistory() {
        let ids = history.map(\.id)
        history.removeAll()
        let now = Date.stamp()
        tombstones[.history] = ids.map { SyncTombstone(id: $0, deletedAt: now) }
        persistTombstones()
        persistHistory()
    }

    // MARK: Contacts

    func contact(for id: UUID) -> Contact? { contacts.first { $0.id == id } }

    func contact(forNumber number: String) -> Contact? {
        contacts.first { $0.matches(number: number) }
    }

    @discardableResult
    func addContact(_ contact: Contact) -> Contact {
        contacts.append(contact)
        contacts.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        persistContacts()
        return contact
    }

    func updateContact(_ contact: Contact) {
        guard let index = contacts.firstIndex(where: { $0.id == contact.id }) else { return }
        var updated = contact
        updated.updatedAt = Date.stamp()
        contacts[index] = updated
        contacts.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        persistContacts()
    }

    func deleteContact(_ id: UUID) {
        contacts.removeAll { $0.id == id }
        addTombstone(.contacts, id)
        persistContacts()
    }

    func toggleFavorite(_ id: UUID) {
        guard var contact = contact(for: id) else { return }
        contact.isFavorite.toggle()
        updateContact(contact)
    }

    // MARK: Import

    func handle(url: URL) {
        if ["sipper", "sipper-development"].contains(url.scheme ?? ""), url.host == "setup" {
            // Opening a setup link only presents a form. Connecting requires an explicit action.
            managedSetupURL = url
            (NSApp.delegate as? AppDelegate)?.showMainWindow()
            return
        }
        if url.scheme == managedAccounts.client?.redirectURL.scheme {
            _ = managedAccounts.client?.resumeSignIn(url: url)
            return
        }
        if let scheme = url.scheme?.lowercased(), ["sip", "sips", "tel"].contains(scheme) {
            dial(link: url)
            return
        }
        guard ImportParser.isImportURL(url) else {
            alert = AppAlert(title: "Unsupported link", message: "Sipper does not know how to open \(url.absoluteString).")
            return
        }
        do {
            var request = try ImportParser.parse(url: url)
            annotateDuplicates(&request)
            pendingImport = request
            (NSApp.delegate as? AppDelegate)?.showMainWindow()
        } catch {
            alert = AppAlert(title: "Import failed", message: error.localizedDescription)
        }
    }

    /// Dials a sip:, sips: or tel: link. Prefers an account on the link's domain, then
    /// the dialer's account; falls back to pre-filling the dialer when nothing is registered.
    private func dial(link url: URL) {
        let address = SIPAddress.parse(url.absoluteString)
        let scheme = url.scheme?.lowercased() ?? "sip"
        let target: String
        if scheme == "tel" {
            target = address.user.isEmpty ? url.absoluteString.dropFirst(4).description : address.user
        } else {
            target = address.user.isEmpty ? url.absoluteString : "\(address.user)@\(address.host)"
        }
        (NSApp.delegate as? AppDelegate)?.showMainWindow()
        // Never dial unattended: any web page can open a sip: link. Pre-fill and pick
        // the account on that domain; the user presses Call.
        let onDomain = accounts.first(where: { !address.host.isEmpty && $0.domain.caseInsensitiveCompare(address.host) == .orderedSame })
        prepareNewCall(target, from: onDomain?.id ?? dialerAccount?.id)
    }



    private func annotateDuplicates(_ request: inout ImportRequest) {
        for index in request.candidates.indices {
            let candidate = request.candidates[index]
            if let existing = duplicateAccount(username: candidate.account.username, domain: candidate.account.domain) {
                request.candidates[index].existingAccountID = existing.id
            }
        }
    }

    enum ImportProfileChoice: Hashable {
        case existing(UUID)
        case new(String)
    }

    /// Adds or updates the selected candidates. Returns the number imported.
    @discardableResult
    func commitImport(_ request: ImportRequest, selected: Set<UUID>, profile choice: ImportProfileChoice) -> Int {
        let profileID: UUID
        switch choice {
        case .existing(let id):
            profileID = manualProfiles.contains(where: { $0.id == id }) ? id : manualProfiles[0].id
        case .new(let name):
            profileID = addProfile(name: name, color: nextProfileColor()).id
        }

        var imported = 0
        for candidate in request.candidates where selected.contains(candidate.id) && candidate.isValid {
            do {
                if let existingID = candidate.existingAccountID, var existing = account(for: existingID) {
                    let draft = candidate.account
                    existing.displayName = draft.displayName.isEmpty ? existing.displayName : draft.displayName
                    existing.authUsername = draft.authUsername
                    existing.server = draft.server
                    existing.port = draft.port
                    existing.transport = draft.transport
                    existing.voicemailNumber = draft.voicemailNumber
                    existing.callerIDName = draft.callerIDName
                    existing.callerIDNumber = draft.callerIDNumber
                    if !draft.notes.isEmpty { existing.notes = draft.notes }
                    if !draft.label.isEmpty { existing.label = draft.label }
                    existing.source = draft.source
                    existing.isEnabled = true
                    try updateAccount(existing, password: candidate.password)
                } else {
                    var draft = candidate.account
                    draft.profileID = profileID
                    try addAccount(draft, password: candidate.password)
                }
                imported += 1
            } catch {
                alert = AppAlert(title: "Could not save account", message: error.localizedDescription)
            }
        }
        pendingImport = nil
        if imported > 0 {
            selection = .profile(profileID)
        }
        return imported
    }

    func cancelImport() {
        pendingImport = nil
    }

    private func nextProfileColor() -> ProfileColor {
        let used = Set(profiles.map(\.colorName))
        return ProfileColor.allCases.first { !used.contains($0) } ?? .blue
    }

    // MARK: Do not disturb

    func toggleDoNotDisturb() {
        settings.doNotDisturb.toggle()
    }

    // MARK: Incoming call UI

    private func presentIncomingCall(_ call: CallSnapshot) {
        if settings.showIncomingCallAlert {
            if incomingPanel == nil {
                incomingPanel = IncomingCallPanelController(state: self)
            }
            incomingPanel?.present(call: call)
        }
        if !calls.contains(where: { $0.id != call.id && $0.state == .confirmed }) {
            ringer.play(settings.ringtone, volume: settings.ringVolume)
        }
        if settings.showNotifications {
            notifications.postIncomingCall(call, accountLabel: account(for: call.accountID)?.displayLabel ?? "")
        }
    }
}

// MARK: - iCloud sync

extension AppState {
    /// Uploads the local copy of a collection when sync is on.
    fileprivate func pushCloud(_ collection: SyncCollection) {
        guard settings.iCloudSync, cloudSync.status.isActive else { return }
        if collection == .history, !settings.iCloudSyncHistory { return }
        guard let data = encodeCloudDocument(collection) else { return }
        cloudSync.push(collection, data: data)
    }

    func encodeCloudDocument(_ collection: SyncCollection) -> Data? {
        let stones = tombstones[collection] ?? []
        switch collection {
        case .profiles:
            return try? cloudEncoder.encode(SyncDocument(deviceID: cloudSync.deviceID, items: manualProfiles, tombstones: stones))
        case .accounts:
            return try? cloudEncoder.encode(SyncDocument(deviceID: cloudSync.deviceID, items: accounts.filter { $0.managed == nil }, tombstones: stones))
        case .contacts:
            return try? cloudEncoder.encode(SyncDocument(deviceID: cloudSync.deviceID, items: contacts, tombstones: stones))
        case .history:
            return try? cloudEncoder.encode(SyncDocument(deviceID: cloudSync.deviceID, items: Array(history.filter { !$0.isManaged }.prefix(5000)), tombstones: stones))
        }
    }

    func syncNow() {
        guard settings.iCloudSync else { return }
        if case .error = cloudSync.status {
            cloudSync.stop()
            cloudSync.start()
            return
        }
        if !cloudSync.status.isActive { cloudSync.start() }
        cloudSync.pullAll()
        for collection in SyncCollection.allCases { pushCloud(collection) }
    }

    private func decodeDocuments<T: Decodable>(_ type: T.Type, from payloads: [Data]) -> [SyncDocument<T>] {
        payloads.compactMap { try? cloudDecoder.decode(SyncDocument<T>.self, from: $0) }
            .filter { $0.version == 1 }
    }

    /// Merges a remote collection into local state and pushes the result back when
    /// the cloud copy is behind.
    fileprivate func applyRemote(_ collection: SyncCollection, payloads: [Data]) {
        switch collection {
        case .profiles:
            let docs = decodeDocuments(Profile.self, from: payloads)
            guard !docs.isEmpty else { return }
            let managed = profiles.filter { $0.managedOrganisationID != nil }
            let reserved = Set(managed.map(\.id))
            let outcome = SyncMerger.merge(local: manualProfiles, localTombstones: tombstones[.profiles] ?? [],
                                           remotes: docs.map { $0.items.filter { !reserved.contains($0.id) } },
                                           remoteTombstones: docs.map { $0.tombstones.filter { !reserved.contains($0.id) } })
            tombstones[.profiles] = outcome.tombstones
            if outcome.changedLocal {
                profiles = (outcome.items + managed).sorted { ($0.sortOrder, $0.createdAt) < ($1.sortOrder, $1.createdAt) }
                if manualProfiles.isEmpty { profiles.insert(Profile(name: Profile.defaultName), at: 0) }
                ensureAccountsHaveProfiles()
                persistProfiles(push: outcome.changedRemote)
                syncEngineAccounts()
            } else if outcome.changedRemote {
                pushCloud(.profiles)
            }
            persistTombstones()
        case .accounts:
            let docs = decodeDocuments(SIPAccount.self, from: payloads)
            guard !docs.isEmpty else { return }
            let managed = accounts.filter { $0.managed != nil }
            let reserved = Set(managed.map(\.id))
            let reservedProfiles = Set(profiles.filter { $0.managedOrganisationID != nil }.map(\.id))
            let outcome = SyncMerger.merge(local: accounts.filter { $0.managed == nil }, localTombstones: tombstones[.accounts] ?? [],
                                           remotes: docs.map { $0.items.filter { !reserved.contains($0.id) && !reservedProfiles.contains($0.profileID) } },
                                           remoteTombstones: docs.map { $0.tombstones.filter { !reserved.contains($0.id) } })
            tombstones[.accounts] = outcome.tombstones
            if outcome.changedLocal {
                let removed = Set(accounts.filter { $0.managed == nil }.map(\.id)).subtracting(outcome.items.map(\.id))
                for id in removed {
                    registrations[id] = nil
                    voicemail[id] = nil
                    if dialerAccountID == id { dialerAccountID = nil }
                }
                accounts = (outcome.items + managed).sorted { ($0.sortOrder, $0.createdAt) < ($1.sortOrder, $1.createdAt) }
                ensureAccountsHaveProfiles()
                persistAccounts(push: outcome.changedRemote)
                if dialerAccountID == nil { dialerAccountID = accounts.first(where: \.isEnabled)?.id }
                syncEngineAccounts()
            } else if outcome.changedRemote {
                pushCloud(.accounts)
            }
            persistTombstones()
        case .contacts:
            let docs = decodeDocuments(Contact.self, from: payloads)
            guard !docs.isEmpty else { return }
            let outcome = SyncMerger.merge(local: contacts, localTombstones: tombstones[.contacts] ?? [],
                                           remotes: docs.map(\.items), remoteTombstones: docs.map(\.tombstones))
            tombstones[.contacts] = outcome.tombstones
            if outcome.changedLocal {
                contacts = outcome.items.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
                persistContacts(push: outcome.changedRemote)
            } else if outcome.changedRemote {
                pushCloud(.contacts)
            }
            persistTombstones()
        case .history:
            guard settings.iCloudSyncHistory else { return }
            let docs = decodeDocuments(CallRecord.self, from: payloads)
            guard !docs.isEmpty else { return }
            let managed = history.filter(\.isManaged)
            let reserved = Set(managed.map(\.id))
            let outcome = SyncMerger.merge(local: history.filter { !$0.isManaged }, localTombstones: tombstones[.history] ?? [],
                                           remotes: docs.map { $0.items.filter { !$0.isManaged && !reserved.contains($0.id) } },
                                           remoteTombstones: docs.map { $0.tombstones.filter { !reserved.contains($0.id) } })
            tombstones[.history] = outcome.tombstones
            if outcome.changedLocal {
                history = Array((outcome.items + managed).sorted { $0.startedAt > $1.startedAt }.prefix(5000))
                persistHistory(push: outcome.changedRemote)
            } else if outcome.changedRemote {
                pushCloud(.history)
            }
            persistTombstones()
        }
    }

    /// Accounts can arrive before the profile they belong to; give them a placeholder
    /// that the real profile replaces when it syncs (it carries a newer updatedAt).
    private func ensureAccountsHaveProfiles() {
        var added = false
        for account in accounts where !profiles.contains(where: { $0.id == account.profileID }) {
            profiles.append(Profile(id: account.profileID, name: "Synced profile", colorName: .gray, iconName: "icloud",
                                    sortOrder: Int.max, createdAt: .distantPast, updatedAt: .distantPast))
            added = true
        }
        if added { persistProfiles(push: false) }
    }
}

extension AppState: CloudSyncDelegate {
    func cloudSync(_ service: CloudSyncService, didReceive collection: SyncCollection, payloads: [Data]) {
        applyRemote(collection, payloads: payloads)
    }

    func cloudSync(_ service: CloudSyncService, statusDidChange status: CloudSyncStatus) {
        let wasStarting: Bool
        if case .starting = cloudSyncStatus { wasStarting = true } else { wasStarting = false }
        cloudSyncStatus = status
        if wasStarting, case .idle = status {
            // First connection: upload what this Mac has so the other devices can merge it.
            for collection in SyncCollection.allCases { pushCloud(collection) }
        }
    }
}

// MARK: - SIPEngineDelegate

extension AppState: SIPEngineDelegate {
    nonisolated func sipEngine(_ engine: SIPEngine, registrationDidChange accountID: UUID, state: RegistrationState) {
        Task { @MainActor in
            guard self.account(for: accountID) != nil else { return }
            self.registrations[accountID] = state
        }
    }

    nonisolated func sipEngine(_ engine: SIPEngine, didReceiveIncomingCall call: CallSnapshot) {
        Task { @MainActor in self.receiveIncoming(call) }
    }

    nonisolated func sipEngine(_ engine: SIPEngine, callDidChange call: CallSnapshot) {
        Task { @MainActor in
            // Gateway SIP headers never supply the displayed caller. Wait for the
            // authenticated lookup before publishing its state to any view.
            guard var call = self.verifiedCaller(call) else { return }
            if call.remoteName.isEmpty, let contact = self.contact(forNumber: call.remoteNumber) {
                call.remoteName = contact.name
            } else if let existing = self.calls.first(where: { $0.id == call.id }), call.remoteName.isEmpty {
                call.remoteName = existing.remoteName
            }
            self.upsert(call)
            if call.state == .confirmed || call.state == .connecting {
                self.ringer.stop()
                self.incomingPanel?.dismiss(callID: call.id)
            }
            if self.shouldRecord(call) {
                self.startRecordingIfReady(call)
            }
        }
    }

    nonisolated func sipEngine(_ engine: SIPEngine, callDidEnd call: CallSnapshot) {
        Task { @MainActor in
            if self.incomingTasks[call.id]?.call.startedAt == call.startedAt { self.incomingTasks.removeValue(forKey: call.id)?.task.cancel() }
            if self.answerTasks[call.id]?.call.startedAt == call.startedAt { self.answerTasks.removeValue(forKey: call.id)?.task.cancel() }
            let verified = self.verifiedCaller(call)
            if self.verifiedManagedCalls[call.id]?.startedAt == call.startedAt { self.verifiedManagedCalls[call.id] = nil }
            guard !self.calls.contains(where: { $0.id == call.id && $0.startedAt != call.startedAt }) else { return }
            var call = verified ?? call
            if call.gatewayCallID != nil && verified == nil {
                call.remoteName = ""; call.remoteNumber = "Incoming managed call"; call.remoteURI = ""
            }
            if let existing = self.calls.first(where: { $0.id == call.id }), call.remoteName.isEmpty {
                call.remoteName = existing.remoteName
            }
            self.calls.removeAll { $0.id == call.id }
            if self.calls.isEmpty { self.showingNewCall = false }
            self.incomingPanel?.dismiss(callID: call.id)
            if !self.calls.contains(where: { $0.state == .incoming }) {
                self.ringer.stop()
            }
            self.notifications.removeIncomingCall(call.id)
            self.finishRecord(for: call)
            self.finishRecording(for: call)
            self.declinedCallIDs.remove(call.id)
            self.lastEndedCall = call
            self.transferStatus = nil
            if self.selectedCallID == call.id {
                self.selectedCallID = self.calls.first?.id
            }
        }
    }

    nonisolated func sipEngine(_ engine: SIPEngine, voicemailDidChange accountID: UUID, info: VoicemailInfo) {
        Task { @MainActor in
            self.voicemail[accountID] = info
        }
    }

    nonisolated func sipEngine(_ engine: SIPEngine, transferStatusDidChange callID: Int, code: Int, text: String, isFinal: Bool) {
        Task { @MainActor in
            if isFinal {
                self.transferStatus = text
                DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
                    self?.transferStatus = nil
                }
            } else {
                self.transferStatus = text
            }
        }
    }

    nonisolated func sipEngineDidStop(_ engine: SIPEngine, error: Error?) {
        Task { @MainActor in
            self.engineIsRunning = false
            self.engineError = error?.localizedDescription
        }
    }
}

// MARK: - NotificationManagerDelegate

extension AppState: NotificationManagerDelegate {
    nonisolated func notificationManager(_ manager: NotificationManager, shouldPresentMessage hint: ManagedMessageNotification, completion: @escaping (Bool) -> Void) {
        Task { @MainActor in completion(self.managedAccounts.canPresentMessageNotification(hint)) }
    }
    nonisolated func notificationManager(_ manager: NotificationManager, didOpenMessage hint: ManagedMessageNotification) {
        Task { @MainActor in await self.managedAccounts.openMessageNotification(hint) }
    }
    nonisolated func notificationManager(_ manager: NotificationManager, didChooseAnswerFor callID: Int) {
        Task { @MainActor in self.answer(callID: callID) }
    }

    nonisolated func notificationManager(_ manager: NotificationManager, didChooseDeclineFor callID: Int) {
        Task { @MainActor in self.decline(callID: callID) }
    }

    nonisolated func notificationManagerDidRequestShowApp(_ manager: NotificationManager) {
        Task { @MainActor in
            NSApp.activate(ignoringOtherApps: true)
            self.selection = .history
        }
    }
}
