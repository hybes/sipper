import AppKit
import Combine
import SipperManaged
import CryptoKit

/// Coordinates managed access without starting the SIP engine or reading personal credentials.
@MainActor
final class ManagedAccountsController: ObservableObject {
    @Published private(set) var client: ManagedClient?
    @Published private(set) var isWorking = false
    @Published private(set) var message: String?
    @Published private(set) var organisationErrors: [UUID: String] = [:]
    @Published private(set) var refreshedAt: Date?
    @Published var setupLink = ""
    @Published private(set) var messageNotification: ManagedMessageNotification?
    @Published private(set) var messageNotificationError: String?
    @Published private(set) var requestingMessagePermission = false
    var messageNotificationsEnabled: Bool { state?.settings.messageNotifications == true }
    private weak var state: AppState?
    private var changes: AnyCancellable?
    private var refreshTask: Task<Void, Never>?
    private var lifecycle = 0
    private var stopped = false
    private var messageGeneration = 0
    private var messageSignature = ""
    private var messageSeen: [String: (sequence: Int64, expiresAt: Date)] = [:]
    private var messageCursors: [UUID: String] = [:]

    func start(state: AppState) {
        guard client == nil else { return }
        self.state = state
        do {
            var server = URL(string: "https://sipper.dev")!
            var local = false
            var storage = ManagedKeychainStore()
            var redirect = URL(string: "com.hybes.sipper:/oauth/callback")!
            #if DEBUG
            if let path = DevelopmentEnvironment.profileDirectory {
                let suffix = SHA256.hash(data: Data(path.utf8)).map { String(format: "%02x", $0) }.joined()
                storage = ManagedKeychainStore(service: "com.hybes.sipper.managed.development.\(suffix)")
                if let url = DevelopmentEnvironment.managedServer {
                    server = url; local = true
                }
                if Bundle.main.bundleIdentifier == "com.hybes.sipper.development" {
                    redirect = URL(string: "com.hybes.sipper.development:/oauth/callback")!
                }
            }
            #endif
            // Local HTTP is only allowed in debug builds with an explicit development URL.
            let selected = try ManagedClient(serverURL: server, clientID: "sipper-macos", storage: storage, allowLocalDevelopment: local, redirectURL: redirect)
            self.client = selected
            state.configureManagedCalls(client: selected)
            changes = selected.objectWillChange.sink { [weak self] _ in
                self?.objectWillChange.send()
                Task { @MainActor [weak self] in self?.reconcileMessageAccess() }
            }
            for enrollment in selected.enrollments {
                if let configuration = try? selected.cachedConfiguration(for: enrollment) {
                    try state.applyManagedConfiguration(configuration, profileID: enrollment.localProfileID)
                }
            }
            refreshTask = Task { [weak self] in
                var lastRefresh = Date.distantPast
                while !Task.isCancelled {
                    guard let self else { return }
                    self.state?.expireManagedAccounts()
                    do { try self.client?.expireDirectories() }
                    catch { self.message = error.localizedDescription }
                    if Date().timeIntervalSince(lastRefresh) >= 60 {
                        lastRefresh = Date()
                        await self.refresh()
                    }
                    await self.reportActivity()
                    await self.pollMessages()
                    try? await Task.sleep(for: .seconds(5))
                }
            }
        } catch { message = "Managed access could not start. \(error.localizedDescription)" }
    }

    func stop() { stopped = true; lifecycle += 1; clearMessageNotifications(); refreshTask?.cancel(); refreshTask = nil; client?.cancelSignIn() }

    private var messageConnections: [ManagedEnrollment] {
        guard !stopped, messageNotificationsEnabled, let client, client.isSignedIn, !client.isSigningIn else { return [] }
        return client.enrollments.filter { e in
            e.userID == client.identity?.id && client.organisations.contains { $0.id == e.organisationID && $0.status == "active" && $0.licensed }
        }
    }

    func clearMessageNotifications() {
        messageGeneration += 1; messageSeen = [:]; messageCursors = [:]; messageNotification = nil
        state?.notifications.removeMessages()
    }

    func messageNotificationsChanged() {
        objectWillChange.send(); clearMessageNotifications(); reconcileMessageAccess()
    }

    private func reconcileMessageAccess() {
        let signature = "\(client?.identity?.id ?? "")/" + messageConnections.map { "\($0.deviceID)/\($0.organisationID)" }.sorted().joined(separator: ",")
        if signature != messageSignature { messageSignature = signature; clearMessageNotifications() }
    }

    func setMessageNotifications(_ enabled: Bool) async {
        guard let state, !requestingMessagePermission else { return }
        messageNotificationError = nil
        if !enabled { state.settings.messageNotifications = false; return }
        guard client?.isSignedIn == true else { return }
        requestingMessagePermission = true
        defer { requestingMessagePermission = false }
        let attempt = lifecycle
        let granted = await withCheckedContinuation { continuation in
            state.notifications.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard attempt == lifecycle, client?.isSignedIn == true else { return }
        if granted { state.settings.messageNotifications = true }
        else { messageNotificationError = "Allow Sipper notifications in System Settings → Notifications, then try again." }
    }

    private func pollMessages() async {
        reconcileMessageAccess()
        guard let client, !isWorking, !Task.isCancelled else { return }
        let attempt = messageGeneration
        for enrollment in messageConnections {
            do {
                let page = try await client.messageAlerts(for: enrollment, after: messageCursors[enrollment.deviceID] ?? "0")
                reconcileMessageAccess()
                guard attempt == messageGeneration, !Task.isCancelled else { return }
                // Scan another page next tick, then restart at zero to catch late commits.
                // ponytail: 100 conversations per customer per five seconds; drain pages in one tick if measured traffic needs it.
                messageCursors[enrollment.deviceID] = page.nextCursor ?? "0"
                messageSeen = messageSeen.filter { $0.value.expiresAt > Date() }
                var latest: ManagedMessageAlert?
                for alert in page.alerts {
                    let key = "\(enrollment.deviceID)/\(alert.conversationId)", sequence = Int64(alert.sequence)!
                    if let seen = messageSeen[key], seen.sequence >= sequence { continue }
                    messageSeen[key] = (sequence, alert.expiresAt); latest = alert
                }
                if let latest {
                    state?.notifications.postMessage(ManagedMessageNotification(deviceId: enrollment.deviceID,
                        conversationId: latest.conversationId, expiresAt: latest.expiresAt))
                }
            } catch {
                guard attempt == messageGeneration else { return }
                if case ManagedError.accessUnavailable = error { clearMessageNotifications(); return }
                if error as? ManagedError == .signInRequired { clearMessageNotifications(); return }
                // Network failures keep no content; the next tick asks the server again.
            }
        }
    }

    func openMessageNotification(_ hint: ManagedMessageNotification) async {
        guard !stopped, messageNotificationsEnabled, let client, client.isSignedIn else { return }
        let attempt = lifecycle
        do {
            try await client.refreshOrganisations()
            reconcileMessageAccess()
            guard attempt == lifecycle, messageNotificationsEnabled, !Task.isCancelled,
                  messageConnections.contains(where: { $0.deviceID == hint.deviceId }) else { return }
            messageNotification = hint
            state?.notifications.removeMessages()
            state?.selection = .messages
            (NSApp.delegate as? AppDelegate)?.showMainWindow()
        } catch { clearMessageNotifications() }
    }

    func consumeMessageNotification(_ hint: ManagedMessageNotification) {
        if messageNotification == hint { messageNotification = nil }
    }

    func canPresentMessageNotification(_ hint: ManagedMessageNotification) -> Bool {
        hint.expiresAt > Date() && messageConnections.contains { $0.deviceID == hint.deviceId }
    }

    func signIn(useSystemBrowser: Bool = false) async {
        guard let client, let window = NSApp.keyWindow ?? NSApp.windows.first, !isWorking else { return }
        isWorking = true; message = nil
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        do { try await client.signIn(presenting: window, useSystemBrowser: useSystemBrowser) }
        catch { message = error.localizedDescription }
        isWorking = false
        if client.isSignedIn { await refresh() }
    }

    func refresh() async {
        guard let client, client.isSignedIn, !client.isSigningIn, !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        let attempt = lifecycle
        do {
            try await client.refreshOrganisations()
            guard attempt == lifecycle, !Task.isCancelled else { return }
            for enrollment in client.enrollments {
                let member = client.organisations.first { $0.id == enrollment.organisationID }
                if member?.status != "active" || member?.licensed != true {
                    revokeLocal(enrollment)
                    organisationErrors[enrollment.id] = "Your administrator needs to enable access and assign a licence."
                    continue
                }
                await refresh(enrollment, attempt: attempt)
            }
            refreshedAt = Date(); message = nil
        } catch {
            message = error.localizedDescription
            if error as? ManagedError == .signInRequired {
                for enrollment in client.enrollments { revokeLocal(enrollment) }
            }
        }
    }

    private func refresh(_ enrollment: ManagedEnrollment, attempt: Int) async {
        guard let client else { return }
        do {
            let configuration = try await client.configuration(for: enrollment)
            guard attempt == lifecycle, !Task.isCancelled else { return }
            guard let state else { return }
            let report = try await state.applyManagedConfigurationAndReport(configuration, profileID: enrollment.localProfileID)
            guard attempt == lifecycle, !Task.isCancelled else { return }
            organisationErrors[enrollment.id] = nil
            try await client.report(report, for: enrollment)
        } catch {
            guard attempt == lifecycle else { return }
            organisationErrors[enrollment.id] = error.localizedDescription
            if case ManagedError.accessUnavailable = error { revokeLocal(enrollment) }
            if error as? ManagedError == .signInRequired { revokeLocal(enrollment) }
            if error as? ManagedError == .unsupportedConfiguration { revokeLocal(enrollment) }
            // A network outage keeps only the previously verified, unexpired configuration.
        }
    }

    private func reportActivity() async {
        guard let client, let state, client.isSignedIn, !client.isSigningIn, !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        for enrollment in client.enrollments {
            do {
                guard let configuration = try client.cachedConfiguration(for: enrollment) else { continue }
                try await client.report(state.managedDeviceReport(configuration, profileID: enrollment.localProfileID), for: enrollment, onlyIfChanged: true)
            } catch {
                if error as? ManagedError == .configurationChanged { isWorking = false; await refresh(); return }
                if case ManagedError.accessUnavailable = error { revokeLocal(enrollment) }
                if error as? ManagedError == .signInRequired { revokeLocal(enrollment) }
                // Keep the last accepted observation; the next tick retries a failed change.
            }
        }
    }

    func connect(_ organisation: ManagedOrganisation) async {
        guard let client, !isWorking else { return }
        isWorking = true; message = nil
        defer { isWorking = false }
        do {
            let enrollment = try await client.enrol(organisation: organisation, name: "Sipper for Mac",
                appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "development",
                osVersion: ProcessInfo.processInfo.operatingSystemVersionString)
            await refresh(enrollment, attempt: lifecycle)
        } catch { message = error.localizedDescription }
    }

    func setAvailability(_ availability: ManagedAvailability, organisationID: UUID) async {
        guard let client, !isWorking else { return }
        isWorking = true; message = nil
        defer { isWorking = false }
        do { try await client.setAvailability(availability, organisationID: organisationID) }
        catch { message = error.localizedDescription }
    }
    func setDoNotDisturb(_ enabled: Bool, organisationID: UUID) async {
        guard let client, !isWorking else { return }
        isWorking = true; message = nil
        defer { isWorking = false }
        do {
            try await client.setDoNotDisturb(enabled, organisationID: organisationID)
            isWorking = false; await refresh()
        }
        catch { message = error.localizedDescription }
    }

    func connectSetupLink() async {
        guard let client, !isWorking else { return }
        isWorking = true; message = nil
        defer { isWorking = false }
        let attempt = lifecycle
        do {
            let organisation = try await client.redeemSetupLink(setupLink)
            guard attempt == lifecycle, !Task.isCancelled else { return }
            setupLink = ""
            let enrollment = try await client.enrol(organisation: organisation, name: "Sipper for Mac",
                appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "development",
                osVersion: ProcessInfo.processInfo.operatingSystemVersionString)
            await refresh(enrollment, attempt: attempt)
        } catch { message = error.localizedDescription }
    }

    private func revokeLocal(_ enrollment: ManagedEnrollment) {
        clearMessageNotifications()
        state?.removeManagedAccounts(deviceID: enrollment.deviceID, profileID: enrollment.localProfileID)
        do { try client?.forgetConfiguration(for: enrollment) }
        catch { message = "Stored managed settings could not be removed. \(error.localizedDescription)" }
    }

    func disconnect(_ enrollment: ManagedEnrollment) async {
        guard !isWorking else { return }
        isWorking = true; lifecycle += 1
        defer { isWorking = false }
        revokeLocal(enrollment)
        do { try await client?.disconnect(enrollment); organisationErrors[enrollment.id] = nil }
        catch { message = error.localizedDescription }
    }

    func signOut() async {
        guard let client, !isWorking else { return }
        isWorking = true; lifecycle += 1; setupLink = ""
        defer { isWorking = false }
        for enrollment in client.enrollments { revokeLocal(enrollment) }
        do { try await client.signOut(); organisationErrors = [:]; message = nil; refreshedAt = nil }
        catch { message = error.localizedDescription }
    }
}
