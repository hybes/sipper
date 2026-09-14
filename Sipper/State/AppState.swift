import Foundation
import Combine
import AppKit

enum SidebarItem: Hashable {
    case dialer
    case history
    case contacts
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
    @Published var dialerAccountID: UUID?
    @Published var pendingImport: ImportRequest?
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
        let value = profiles
        scheduleSave(StoreFile.profiles) { [store] in try? store.save(value, to: StoreFile.profiles) }
        if push { pushCloud(.profiles) }
    }

    private func persistAccounts(push: Bool = true) {
        let value = accounts
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
        try? store.save(profiles, to: StoreFile.profiles)
        try? store.save(accounts, to: StoreFile.accounts)
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
        ringer.stop()
        incomingPanel?.close()
        engine.stop()
        flush()
    }

    /// Accounts that should be live in pjsua: enabled and in an enabled profile.
    private var activeAccounts: [SIPAccount] {
        accounts.filter { account in
            account.isEnabled && (profiles.first { $0.id == account.profileID }?.isEnabled ?? false)
        }
    }

    private var accountSyncGeneration = 0

    /// Reads passwords off the main thread (a Keychain prompt can block the call for
    /// as long as the user takes) and then hands the active set to the engine.
    private func syncEngineAccounts() {
        guard engineIsRunning else { return }
        let active = activeAccounts
        for account in active where registrations[account.id] == nil {
            registrations[account.id] = .registering
        }
        for account in accounts where !active.contains(where: { $0.id == account.id }) {
            registrations[account.id] = .unregistered
        }
        accountSyncGeneration += 1
        let generation = accountSyncGeneration
        let passwords = self.passwords
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let lookups = active.map { ($0, passwords.lookup(for: $0.id)) }
            Task { @MainActor [weak self] in
                guard let self, generation == self.accountSyncGeneration else { return }
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
            }
        }
    }

    private func settingsDidChange(from old: AppSettings) {
        persistSettings()
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
        for account in accounts {
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
        let wasEnabled = profiles[index].isEnabled
        var updated = profile
        updated.updatedAt = Date.stamp()
        profiles[index] = updated
        persistProfiles()
        if wasEnabled != profile.isEnabled { syncEngineAccounts() }
    }

    func setProfileEnabled(_ id: UUID, enabled: Bool) {
        guard var profile = profile(for: id) else { return }
        profile.isEnabled = enabled
        updateProfile(profile)
    }

    /// Deletes a profile. Accounts move to `destination` or are deleted when nil.
    func deleteProfile(_ id: UUID, moveAccountsTo destination: UUID?) {
        guard profiles.count > 1, let index = profiles.firstIndex(where: { $0.id == id }) else { return }
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

    func registration(for id: UUID) -> RegistrationState { registrations[id] ?? .unregistered }

    func password(for accountID: UUID) -> String { passwords.password(for: accountID) ?? "" }

    var registeredAccounts: [SIPAccount] { accounts.filter { registration(for: $0.id).isRegistered } }

    func duplicateAccount(username: String, domain: String, excluding: UUID? = nil) -> SIPAccount? {
        accounts.first { $0.id != excluding && $0.matches(username: username, domain: domain) }
    }

    @discardableResult
    func addAccount(_ draft: SIPAccount, password: String) throws -> SIPAccount {
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
        account.profileID = profileID
        account.sortOrder = (accounts(in: profileID).map(\.sortOrder).max() ?? -1) + 1
        replaceAccount(account)
        syncEngineAccounts()
    }

    func reRegister(_ id: UUID) {
        registrations[id] = .registering
        engine.setRegistration(accountID: id, enabled: true)
    }

    func reRegisterAll() {
        for account in activeAccounts { registrations[account.id] = .registering }
        engine.reRegisterAll()
    }

    // MARK: Calls

    var activeCall: CallSnapshot? {
        if let selectedCallID, let call = calls.first(where: { $0.id == selectedCallID }) { return call }
        return calls.first
    }

    var hasActiveCalls: Bool { !calls.isEmpty }

    /// The account the dialer should use.
    var dialerAccount: SIPAccount? {
        if let dialerAccountID, let account = account(for: dialerAccountID) { return account }
        return registeredAccounts.first ?? accounts.first
    }

    func call(_ target: String, from accountID: UUID? = nil) {
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
        guard registration(for: account.id).isRegistered || !account.usesSeparateServer else {
            alert = AppAlert(title: "Account not registered",
                             message: "\(account.displayLabel) is not registered: \(registration(for: account.id).detail)")
            return
        }

        let uri = account.callURI(for: trimmed)
        MicrophoneAccess.request { [weak self] granted in
            guard let self else { return }
            if !granted {
                self.alert = AppAlert(title: "Microphone access needed",
                                      message: "Allow Sipper to use the microphone in System Settings › Privacy & Security › Microphone.")
            }
            do {
                // Put other calls on hold before dialling.
                for other in self.calls where other.state == .confirmed && !other.isOnHold {
                    self.engine.setHold(callID: other.id, onHold: true)
                }
                var snapshot = try self.engine.makeCall(accountID: account.id, uri: uri)
                let contact = self.contact(forNumber: snapshot.remoteNumber)
                if snapshot.remoteName.isEmpty, let contact { snapshot.remoteName = contact.name }
                self.upsert(snapshot)
                self.selectedCallID = snapshot.id
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
        let target = record.remoteURI.isEmpty ? record.remoteNumber : record.remoteNumber
        call(target, from: accountID)
    }

    func answer(callID: Int) {
        guard calls.contains(where: { $0.id == callID && $0.state == .incoming }) else { return }
        ringer.stop()
        incomingPanel?.dismiss(callID: callID)
        for other in calls where other.id != callID && other.state == .confirmed && !other.isOnHold {
            engine.setHold(callID: other.id, onHold: true)
        }
        MicrophoneAccess.request { [weak self] _ in
            guard let self else { return }
            self.engine.answer(callID: callID, code: 200)
            if self.settings.muteMicrophoneOnAnswer {
                self.engine.setMuted(callID: callID, muted: true)
            }
            self.selectedCallID = callID
            self.selection = .dialer
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func decline(callID: Int) {
        guard calls.contains(where: { $0.id == callID && $0.state == .incoming }) else { return }
        declinedCallIDs.insert(callID)
        ringer.stop()
        incomingPanel?.dismiss(callID: callID)
        engine.hangup(callID: callID, code: 486)
    }

    func hangup(callID: Int) {
        engine.hangup(callID: callID, code: 0)
    }

    func hangupActiveCall() {
        guard let call = activeCall else { return }
        if call.state == .incoming { decline(callID: call.id) } else { hangup(callID: call.id) }
    }

    func toggleMute(callID: Int) {
        guard let call = calls.first(where: { $0.id == callID }) else { return }
        engine.setMuted(callID: callID, muted: !call.isMuted)
    }

    func toggleHold(callID: Int) {
        guard let call = calls.first(where: { $0.id == callID }) else { return }
        engine.setHold(callID: callID, onHold: !call.isOnHold)
    }

    func swapToCall(_ callID: Int) {
        for other in calls where other.id != callID && other.state == .confirmed && !other.isOnHold {
            engine.setHold(callID: other.id, onHold: true)
        }
        if let call = calls.first(where: { $0.id == callID }), call.isOnHold {
            engine.setHold(callID: callID, onHold: false)
        }
        selectedCallID = callID
    }

    func sendDTMF(_ digits: String, callID: Int) {
        let cleaned = digits.filter { "0123456789*#ABCDabcd".contains($0) }
        guard !cleaned.isEmpty else { return }
        engine.sendDTMF(callID: callID, digits: cleaned)
    }

    func transfer(callID: Int, to target: String) {
        guard let call = calls.first(where: { $0.id == callID }), let account = account(for: call.accountID) else { return }
        let uri = account.callURI(for: target)
        do {
            try engine.transfer(callID: callID, to: uri)
            transferStatus = "Transferring to \(target)…"
        } catch {
            alert = AppAlert(title: "Transfer failed", message: error.localizedDescription)
        }
    }

    func attendedTransfer(callID: Int, toCallID otherID: Int) {
        do {
            try engine.attendedTransfer(callID: callID, toCallID: otherID)
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
                                startedAt: call.startedAt)
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
                                    remoteURI: call.remoteURI, startedAt: call.startedAt)
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
        selection = .dialer
        // Never dial unattended: any web page can open a sip: link. Pre-fill and pick
        // the account on that domain; the user presses Call.
        dialString = target
        if let onDomain = accounts.first(where: { !address.host.isEmpty && $0.domain.caseInsensitiveCompare(address.host) == .orderedSame }) {
            dialerAccountID = onDomain.id
        }
        NotificationCenter.default.post(name: .sipperFocusDialer, object: nil)
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
            profileID = profiles.contains(where: { $0.id == id }) ? id : profiles[0].id
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

    private func encodeCloudDocument(_ collection: SyncCollection) -> Data? {
        let stones = tombstones[collection] ?? []
        switch collection {
        case .profiles:
            return try? cloudEncoder.encode(SyncDocument(deviceID: cloudSync.deviceID, items: profiles, tombstones: stones))
        case .accounts:
            return try? cloudEncoder.encode(SyncDocument(deviceID: cloudSync.deviceID, items: accounts, tombstones: stones))
        case .contacts:
            return try? cloudEncoder.encode(SyncDocument(deviceID: cloudSync.deviceID, items: contacts, tombstones: stones))
        case .history:
            return try? cloudEncoder.encode(SyncDocument(deviceID: cloudSync.deviceID, items: Array(history.prefix(5000)), tombstones: stones))
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
            let outcome = SyncMerger.merge(local: profiles, localTombstones: tombstones[.profiles] ?? [],
                                           remotes: docs.map(\.items), remoteTombstones: docs.map(\.tombstones))
            tombstones[.profiles] = outcome.tombstones
            if outcome.changedLocal {
                profiles = outcome.items.sorted { ($0.sortOrder, $0.createdAt) < ($1.sortOrder, $1.createdAt) }
                if profiles.isEmpty { profiles = [Profile(name: Profile.defaultName)] }
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
            let outcome = SyncMerger.merge(local: accounts, localTombstones: tombstones[.accounts] ?? [],
                                           remotes: docs.map(\.items), remoteTombstones: docs.map(\.tombstones))
            tombstones[.accounts] = outcome.tombstones
            if outcome.changedLocal {
                let removed = Set(accounts.map(\.id)).subtracting(outcome.items.map(\.id))
                for id in removed {
                    registrations[id] = nil
                    voicemail[id] = nil
                    if dialerAccountID == id { dialerAccountID = nil }
                }
                accounts = outcome.items.sorted { ($0.sortOrder, $0.createdAt) < ($1.sortOrder, $1.createdAt) }
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
            let outcome = SyncMerger.merge(local: history, localTombstones: tombstones[.history] ?? [],
                                           remotes: docs.map(\.items), remoteTombstones: docs.map(\.tombstones))
            tombstones[.history] = outcome.tombstones
            if outcome.changedLocal {
                history = Array(outcome.items.sorted { $0.startedAt > $1.startedAt }.prefix(5000))
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
            self.registrations[accountID] = state
        }
    }

    nonisolated func sipEngine(_ engine: SIPEngine, didReceiveIncomingCall call: CallSnapshot) {
        Task { @MainActor in
            var call = call
            if let contact = self.contact(forNumber: call.remoteNumber), call.remoteName.isEmpty {
                call.remoteName = contact.name
            }
            if self.settings.doNotDisturb {
                self.declinedCallIDs.insert(call.id)
                self.engine.hangup(callID: call.id, code: 486)
                self.upsert(call)
                return
            }
            self.upsert(call)
            self.beginRecord(for: call)
            if self.selectedCallID == nil { self.selectedCallID = call.id }
            self.presentIncomingCall(call)
            let delay = self.settings.autoAnswerSeconds
            if delay > 0 {
                let callID = call.id
                DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(delay)) { [weak self] in
                    guard let self, self.calls.contains(where: { $0.id == callID && $0.state == .incoming }) else { return }
                    self.answer(callID: callID)
                }
            }
        }
    }

    nonisolated func sipEngine(_ engine: SIPEngine, callDidChange call: CallSnapshot) {
        Task { @MainActor in
            var call = call
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
            var call = call
            if let existing = self.calls.first(where: { $0.id == call.id }), call.remoteName.isEmpty {
                call.remoteName = existing.remoteName
            }
            self.calls.removeAll { $0.id == call.id }
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
                self.transferStatus = code / 100 == 2 ? "Transfer completed" : "Transfer failed: \(code) \(text)"
                if code / 100 == 2 {
                    self.engine.hangup(callID: callID)
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
                    self?.transferStatus = nil
                }
            } else {
                self.transferStatus = "Transfer: \(code) \(text)"
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
