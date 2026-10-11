import AVFoundation
import Combine
import Foundation
import Network
import SipperManaged
import UIKit

@MainActor
final class MobileState: ObservableObject, @preconcurrency SIPEngineDelegate {
    @Published private(set) var accounts: [SIPAccount] = []
    @Published private(set) var registrations: [UUID: RegistrationState] = [:]
    @Published private(set) var calls: [CallSnapshot] = []
    @Published private(set) var history: [CallRecord] = []
    @Published var selectedAccountID: UUID?
    @Published var selectedTab = 0
    @Published private(set) var messageNavigationLocked = false
    @Published var dialTarget = ""
    @Published var setupLink = ""
    @Published var importing = false
    @Published private(set) var importReview: MobileImportReview?
    @Published var error: String?
    @Published private(set) var managedBusy = false
    @Published private(set) var meetingAudioClaimed = false
    var meetingPhoneBusy: Bool { !calls.isEmpty || callKit.hasPhoneAudioWork }
    func claimMeetingAudio() -> Bool {
        guard !meetingAudioClaimed, !meetingPhoneBusy, engine.activeCalls().isEmpty else { return false }
        meetingAudioClaimed = true
        return true
    }
    func releaseMeetingAudio() { meetingAudioClaimed = false }
    @Published private(set) var managedMessage: String?
    @Published private(set) var messageNotification: ManagedMessageNotification?
    @Published private(set) var messageNotificationsEnabled = UserDefaults.standard.bool(forKey: "messageNotificationsEnabled")
    @Published private(set) var messageNotificationStatus = "Message notifications are off."
    private(set) var managed: ManagedClient?
    let engine = SIPEngine()
    lazy var callKit: CallKitBridge = {
        let bridge = CallKitBridge(engine: engine)
        bridge.canUsePhoneAudio = { [weak self] in self?.meetingAudioClaimed == false }
        callChanges = bridge.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        return bridge
    }()
    private var manual: MobileAccountStore?
    private var configurations: [UUID: (ManagedEnrollment, ManagedConfiguration)] = [:]
    private var timer: Task<Void, Never>?
    private var managedChanges: AnyCancellable?
    private var callChanges: AnyCancellable?
    private let network = NWPathMonitor()
    private var networkUpdate: Task<Void, Never>?
    private var receivedNetworkPath = false
    private var lifecycle = 0
    private var lastRefresh = Date.distantPast
    private var active = true
    private var managedCalls = Set<Int>()
    private var managedCallControl: ManagedCallControl?
    private var incomingTasks: [Int: Task<Void, Never>] = [:]
    private var push: MobilePush?
    private var messageNotifications: MobileMessageNotifications?
    private var messageNavigation: Task<Void, Never>?
    private var accountsNavigationPending = false
    private let historyURL: URL
    private let isTesting = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil

    init(personalStore: MobileAccountStore? = nil, managedClient: ManagedClient? = nil) {
        let identifier = Bundle.main.bundleIdentifier ?? "com.hybes.sipper.ios"
        historyURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Sipper/history.json")
        if isTesting && managedClient == nil {
            manual = personalStore
            accounts = personalStore?.entries.map(\.account) ?? []
            return
        }
        do {
            manual = try personalStore ?? MobileAccountStore(storage: ManagedKeychainStore(service: identifier + ".personal"))
            var settings = AppSettings()
            settings.userAgent = "Sipper/0.1.0 (iOS)"
            settings.sipLogLevel = 2
            try engine.start(settings: settings)
            engine.setCodecPreferences(CodecDefaults.seed(from: engine.codecs()))
            engine.delegate = self
            callKit.canUseAccount = { [weak self] id in self?.canUse(id) ?? false }
            callKit.onStarted = { [weak self] call in self?.update(call) }
            callKit.onError = { [weak self] message in self?.error = message }
            if FileManager.default.fileExists(atPath: historyURL.path) {
                history = try JSONDecoder().decode([CallRecord].self, from: Data(contentsOf: historyURL))
            }
            syncAccounts()
        } catch { self.error = "Sipper could not load your calling accounts. \(error.localizedDescription)" }
        do {
            var url = URL(string: "https://sipper.dev")!, local = false
            #if DEBUG
            if let value = ProcessInfo.processInfo.environment["SIPPER_MANAGEMENT_URL"], let development = URL(string: value) {
                url = development; local = true
            }
            #endif
            let client = try managedClient ?? ManagedClient(serverURL: url, clientID: "sipper-ios", storage: ManagedKeychainStore(service: identifier + ".managed"), allowLocalDevelopment: local)
            managed = client
            let control = ManagedCallControl(engine: engine, client: client)
            managedCallControl = control
            callKit.claimAnswer = { [weak control] call in
                guard let control else { throw ManagedError.callUnavailable }
                return try await control.claim(call)
            }
            callKit.onDeclined = { [weak control] call in Task { await control?.decline(call) } }
            callKit.onPushDeclined = { [weak control] hint in Task { await control?.decline(hint) } }
            callKit.wake = { [weak self, weak control] hint in
                guard let self, let control else { return nil }
                let attempt = self.lifecycle
                return try await control.wake(hint) { enrollment in
                    try await self.refresh(enrollment, attempt: attempt)
                }
            }
            managedChanges = client.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
            for enrollment in client.enrollments {
                if let config = try? client.cachedConfiguration(for: enrollment) {
                    configurations[enrollment.deviceID] = (enrollment, config)
                }
            }
            syncAccounts()
        } catch { managedMessage = error.localizedDescription }
        if isTesting { return } // Integration tests explicitly drive refresh and CallKit; no background timers or push.
        // A cold/background launch must register its delegate even if Keychain is unavailable.
        let push = MobilePush(client: managed, calls: callKit)
        self.push = push
        let messages = MobileMessageNotifications(client: managed)
        messageNotifications = messages
        messages.updateStatus = { [weak self] in self?.messageNotificationStatus = $0 }
        syncPushTokens()
        push.start()
        network.pathUpdateHandler = { [weak self] path in
            let available = path.status == .satisfied
            Task { @MainActor in self?.networkPathChanged(available: available) }
        }
        network.start(queue: DispatchQueue(label: "com.hybes.sipper.ios.network"))
        timer = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                self.expireConfigurations()
                if self.active && Date().timeIntervalSince(self.lastRefresh) >= 60 { await self.refreshManaged() }
                await self.reportActivity()
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }
    func networkPathChanged(available: Bool) {
        if !receivedNetworkPath {
            receivedNetworkPath = true
            // PJSIP already started on this route; recovery would cancel a new outgoing call.
            if available { return }
        }
        networkUpdate?.cancel()
        if !available { engine.networkChanged(available: false); return }
        // Link changes can arrive in a burst while Wi-Fi/mobile routes settle.
        networkUpdate = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
            guard let self else { return }
            self.engine.networkChanged(available: true)
            if self.active { await self.refreshManaged() }
        }
    }
    func foreground(_ value: Bool) {
        active = value
        guard value, !isTesting else { return }
        messageNotifications?.refresh()
        expireConfigurations()
        engine.reRegisterAll()
        Task { await refreshManaged() }
    }
    func canUse(_ id: UUID) -> Bool {
        accounts.contains { $0.id == id && $0.isEnabled && ($0.managed.map { $0.expiresAt > Date() && managed?.isSignedIn == true } ?? true) }
    }

    func selectTab(_ tab: Int) {
        guard !messageNavigationLocked else { return }
        selectedTab = tab
    }
    func setMessageNavigationLocked(_ locked: Bool) {
        messageNavigationLocked = locked
        if !locked && accountsNavigationPending { showAccountSetup() }
    }
    private func showAccountSetup() {
        guard !messageNavigationLocked, calls.isEmpty else { accountsNavigationPending = true; return }
        accountsNavigationPending = false; selectedTab = 2
    }

    func canTransfer(_ call: CallSnapshot) -> Bool {
        call.state == .confirmed && call.conferenceID == nil && !call.isTransferring && !callKit.changingCalls && canUse(call.accountID)
    }
    func prepareNewCall(_ call: CallSnapshot) {
        guard calls.count == 1, let current = calls.first,
              current.id == call.id, current.startedAt == call.startedAt,
              current.accountID == call.accountID, canTransfer(current) else { return }
        selectedAccountID = current.accountID
        dialTarget = ""
        selectedTab = 0
    }
    func saved(_ id: UUID) -> SavedMobileAccount? { manual?.entries.first { $0.account.id == id } }
    func save(_ account: SIPAccount, password: String) throws {
        guard let manual else { throw ManagedError.storageUnavailable }
        guard !calls.contains(where: { $0.accountID == account.id }) else { throw MobileError.accountUnavailable }
        try manual.save(account, password: password)
        syncAccounts()
    }
    func remove(_ account: SIPAccount) throws {
        guard account.managed == nil, let manual, !calls.contains(where: { $0.accountID == account.id }) else { throw MobileError.accountUnavailable }
        try manual.remove(account.id)
        syncAccounts()
    }
    func reviewImport(_ link: String) throws {
        guard let manual else { throw ManagedError.storageUnavailable }
        guard importReview == nil else { throw MobileImportError.changed }
        importReview = try manual.reviewImport(link)
        importing = true; showAccountSetup()
    }
    func cancelImport() {
        importReview = nil; importing = false
        if setupLink.isEmpty { accountsNavigationPending = false }
    }
    func importAccounts(selected: Set<UUID>) throws {
        guard let manual, let importReview else { throw ManagedError.storageUnavailable }
        try manual.importAccounts(importReview, selected: selected, activeAccounts: Set(calls.map(\.accountID)))
        cancelImport()
        syncAccounts()
    }
    private func mapped(_ enrollment: ManagedEnrollment, _ config: ManagedConfiguration) -> [(account: SIPAccount, password: String)] {
        config.accounts.map { (ManagedAccountMapper.account($0, configuration: config, profileID: enrollment.localProfileID), $0.password) }
    }
    private func syncAccounts() {
        var values = manual?.entries.map { (account: $0.account, password: $0.password) } ?? []
        for (enrollment, config) in configurations.values where config.expiresAt > Date() { values += mapped(enrollment, config) }
        accounts = values.map(\.account).sorted { $0.displayLabel.localizedStandardCompare($1.displayLabel) == .orderedAscending }
        if !accounts.contains(where: { $0.id == selectedAccountID && $0.isEnabled }) { selectedAccountID = accounts.first(where: \.isEnabled)?.id }
        engine.syncAccounts(values.filter { $0.account.isEnabled })
        syncPushTokens()
    }
    private func syncPushTokens() {
        messageNotifications?.refresh()
        if managed?.isSignedIn != true || messageNotification.map({ messageNotifications?.owns($0) != true }) == true { messageNotification = nil }
        push?.tokens.update(eligible: Set(configurations.compactMap { device, entry in
            entry.1.expiresAt > Date() && entry.1.accounts.contains(where: { $0.mode == "gateway" }) ? device : nil
        }))
    }
    func setMessageNotifications(_ value: Bool) async {
        await messageNotifications?.setEnabled(value)
        messageNotificationsEnabled = messageNotifications?.enabled == true
    }
    func messagePushToken(_ token: Data?) { messageNotifications?.tokens.update(token: token) }
    func ownsMessageNotification(_ hint: ManagedMessageNotification) -> Bool { messageNotifications?.owns(hint) == true }
    func openMessageNotification(_ hint: ManagedMessageNotification) {
        messageNavigation?.cancel()
        messageNavigation = Task { [weak self] in
            guard let self, await messageNotifications?.resolve(hint) == true else { return }
            messageNotification = hint; selectedTab = 3
            messageNotifications?.clearDelivered()
        }
    }
    func consumeMessageNotification(_ hint: ManagedMessageNotification) { if messageNotification == hint { messageNotification = nil } }
    private func expireConfigurations() {
        do { try managed?.expireDirectories() } catch { managedMessage = error.localizedDescription }
        let expired = configurations.filter { $0.value.1.expiresAt <= Date() || managed?.isSignedIn != true }.map(\.key)
        guard !expired.isEmpty else { return }
        for id in expired {
            callKit.withdrawPushCalls(deviceID: id)
            if let enrollment = configurations[id]?.0 { try? managed?.forgetConfiguration(for: enrollment) }
            configurations[id] = nil
        }
        syncAccounts()
    }
    func callDirectory(_ number: String, contactID: UUID, enrollment: ManagedEnrollment, accountID: UUID) async throws {
        guard let managed, let account = accounts.first(where: { $0.id == accountID }), canUse(accountID),
              ManagedAccountMapper.directoryAccount(account)?.belongs(to: enrollment) == true else {
            throw ManagedError.accessUnavailable("This customer’s calling account is unavailable.")
        }
        let verified = try managed.directoryNumber(number, contactID: contactID, for: enrollment)
        try await callKit.start(account: account, target: verified)
    }
    private func withdraw(_ enrollment: ManagedEnrollment) {
        callKit.withdrawPushCalls(deviceID: enrollment.deviceID)
        configurations[enrollment.deviceID] = nil
        syncAccounts()
        do { try managed?.forgetConfiguration(for: enrollment) }
        catch { managedMessage = "Stored managed settings could not be removed. Unlock this device and try again." }
    }
    func signIn() async {
        guard let managed, !managedBusy,
              let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first(where: { $0.activationState == .foregroundActive }),
              var controller = scene.windows.first(where: \.isKeyWindow)?.rootViewController else { return }
        while let presented = controller.presentedViewController { controller = presented }
        managedBusy = true; managedMessage = nil
        do { try await managed.signIn(presenting: controller) }
        catch ManagedError.cancelled { }
        catch { managedMessage = error.localizedDescription }
        managedBusy = false
        if managed.isSignedIn { await refreshManaged() }
    }
    func handle(url: URL) {
        if managed?.resumeSignIn(url: url) == true { return }
        if ImportParser.isImportURL(url) {
            do { try reviewImport(url.absoluteString) } catch { self.error = error.localizedDescription }
            return
        }
        guard url.scheme == "sipper", url.host == "setup" else { return }
        do {
            guard let managed else { throw ManagedError.serverUnavailable }
            _ = try ManagedSetupLink(url: url, serverURL: managed.serverURL)
            setupLink = url.absoluteString; showAccountSetup()
        } catch { self.error = error.localizedDescription }
    }
    func connectSetupLink() async {
        guard let managed, !managedBusy else { return }
        managedBusy = true; managedMessage = nil
        defer { managedBusy = false }
        let attempt = lifecycle
        do {
            let organisation = try await managed.redeemSetupLink(setupLink)
            guard attempt == lifecycle, !Task.isCancelled else { return }
            setupLink = ""
            let enrollment = try await managed.enrol(organisation: organisation, name: "Sipper for iOS", appVersion: "0.1.0", osVersion: UIDevice.current.systemVersion)
            try await refresh(enrollment, attempt: attempt)
        } catch { managedMessage = error.localizedDescription }
    }
    func connect(_ organisation: ManagedOrganisation) async {
        guard let managed, !managedBusy else { return }
        managedBusy = true; defer { managedBusy = false }
        let attempt = lifecycle
        do {
            let enrollment = try await managed.enrol(organisation: organisation, name: "Sipper for iOS", appVersion: "0.1.0", osVersion: UIDevice.current.systemVersion)
            try await refresh(enrollment, attempt: attempt)
        } catch { managedMessage = error.localizedDescription }
    }
    func disconnect(_ enrollment: ManagedEnrollment) async {
        guard let managed, !managedBusy else { return }
        managedBusy = true; lifecycle += 1
        defer { managedBusy = false }
        withdraw(enrollment)
        do { try await managed.disconnect(enrollment) }
        catch { managedMessage = error.localizedDescription }
        syncPushTokens()
    }
    func setAvailability(_ availability: ManagedAvailability, organisationID: UUID) async {
        guard let managed, !managedBusy else { return }
        managedBusy = true; managedMessage = nil
        defer { managedBusy = false }
        do { try await managed.setAvailability(availability, organisationID: organisationID) }
        catch { managedMessage = error.localizedDescription }
    }
    func setDoNotDisturb(_ enabled: Bool, organisationID: UUID) async {
        guard let managed, !managedBusy else { return }
        managedBusy = true; managedMessage = nil
        defer { managedBusy = false }
        do {
            try await managed.setDoNotDisturb(enabled, organisationID: organisationID)
            managedBusy = false; await refreshManaged()
        }
        catch { managedMessage = error.localizedDescription }
    }
    func signOut() async {
        guard let managed, !managedBusy else { return }
        managedBusy = true; lifecycle += 1; setupLink = ""
        if !importing { accountsNavigationPending = false }
        defer { managedBusy = false }
        for enrollment in managed.enrollments { withdraw(enrollment) }
        do { try await managed.signOut() }
        catch { managedMessage = error.localizedDescription }
        syncPushTokens()
    }
    func refreshManaged() async {
        guard let managed, managed.isSignedIn, !managed.isSigningIn, !managedBusy else { return }
        managedBusy = true; lastRefresh = Date()
        defer { managedBusy = false; syncPushTokens() }
        let attempt = lifecycle
        do {
            try await managed.refreshOrganisations()
            guard attempt == lifecycle else { return }
            managedMessage = nil
            for enrollment in managed.enrollments {
                guard managed.organisations.contains(where: { $0.id == enrollment.organisationID && $0.status == "active" && $0.licensed }) else { withdraw(enrollment); continue }
                do { try await refresh(enrollment, attempt: attempt) }
                catch {
                    managedMessage = error.localizedDescription
                    if case ManagedError.accessUnavailable = error { withdraw(enrollment) }
                    if error as? ManagedError == .signInRequired { withdraw(enrollment) }
                }
            }
        } catch {
            managedMessage = error.localizedDescription
            if error as? ManagedError == .signInRequired { for enrollment in managed.enrollments { withdraw(enrollment) } }
        }
    }
    private func refresh(_ enrollment: ManagedEnrollment, attempt: Int) async throws {
        guard let managed else { return }
        let config = try await managed.configuration(for: enrollment)
        try Task.checkCancellation()
        guard lifecycle == attempt, managed.isSignedIn, managed.enrollments.contains(enrollment) else { throw ManagedError.cancelled }
        configurations[enrollment.deviceID] = (enrollment, config)
        syncAccounts()
        let values = mapped(enrollment, config)
        try await managed.report(ManagedAccountMapper.deviceReport(config, expected: values, engine: engine), for: enrollment)
    }
    private func reportActivity() async {
        guard let managed, managed.isSignedIn, !managed.isSigningIn, !managedBusy else { return }
        managedBusy = true
        defer { managedBusy = false }
        let attempt = lifecycle
        for (enrollment, config) in Array(configurations.values) where config.expiresAt > Date() {
            guard attempt == lifecycle else { return }
            do {
                let report = ManagedAccountMapper.deviceReport(config, expected: mapped(enrollment, config), engine: engine)
                try await managed.report(report, for: enrollment, onlyIfChanged: true)
            } catch {
                if error as? ManagedError == .configurationChanged { managedBusy = false; await refreshManaged(); return }
                if case ManagedError.accessUnavailable = error { withdraw(enrollment) }
                if error as? ManagedError == .signInRequired { withdraw(enrollment) }
            }
        }
    }

    private func update(_ call: CallSnapshot) {
        let isNew = !calls.contains { $0.id == call.id && $0.startedAt == call.startedAt }
        if call.isActive && accounts.first(where: { $0.id == call.accountID })?.managed != nil { managedCalls.insert(call.id) }
        calls.removeAll { $0.id == call.id }
        if call.isActive { calls.append(call) }
        if call.isActive && isNew { selectedTab = 4 }
        if calls.isEmpty {
            if accountsNavigationPending && !messageNavigationLocked { showAccountSetup() }
            else if selectedTab == 4 { selectedTab = 0 }
        }
    }
    func sipEngine(_ engine: SIPEngine, registrationDidChange accountID: UUID, state: RegistrationState) { registrations[accountID] = state }
    func sipEngine(_ engine: SIPEngine, didReceiveIncomingCall call: CallSnapshot) {
        guard call.gatewayCallID != nil else { update(call); callKit.incoming(call); return }
        incomingTasks[call.id]?.cancel()
        incomingTasks[call.id] = Task { [weak self] in
            guard let self, let control = self.managedCallControl else { engine.hangup(call, code: 480); return }
            do {
                let verified = try await control.prepare(call)
                try Task.checkCancellation()
                self.update(verified); self.callKit.incoming(verified)
                await control.monitor(verified)
            } catch { engine.hangup(call, code: 480, onlyIfRinging: true) }
        }
    }
    func sipEngine(_ engine: SIPEngine, callDidChange call: CallSnapshot) { update(call); callKit.changed(call) }
    func sipEngine(_ engine: SIPEngine, callDidEnd call: CallSnapshot) {
        incomingTasks.removeValue(forKey: call.id)?.cancel()
        update(call); callKit.ended(call)
        let outcome: CallOutcome = call.connectedAt != nil ? .completed : call.direction == .incoming ? (call.lastStatusCode == 603 ? .declined : .missed) : .noAnswer
        let record = CallRecord(accountID: call.accountID, direction: call.direction, outcome: outcome, remoteNumber: call.remoteNumber,
            remoteName: call.remoteName, remoteURI: call.remoteURI, startedAt: call.startedAt, connectedAt: call.connectedAt,
            endedAt: call.endedAt, statusCode: call.lastStatusCode, isManaged: managedCalls.remove(call.id) != nil)
        history.insert(record, at: 0); history = Array(history.prefix(500))
        do {
            try FileManager.default.createDirectory(at: historyURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(history).write(to: historyURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch { self.error = "The call ended, but Sipper could not save it to Recents." }
    }
    func sipEngine(_ engine: SIPEngine, voicemailDidChange accountID: UUID, info: VoicemailInfo) {}
    func sipEngine(_ engine: SIPEngine, transferStatusDidChange callID: Int, code: Int, text: String, isFinal: Bool) {}
    func sipEngineDidStop(_ engine: SIPEngine, error: Error?) { if error != nil { self.error = "The calling service stopped. Reopen Sipper to reconnect." } }
}
