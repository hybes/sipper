import Foundation
import PushKit
import SipperManaged
import UIKit
import UserNotifications

/// Serial writes ensure a late response for an old token cannot overwrite its replacement.
@MainActor
final class MobilePushTokens {
    private var token: Data?
    private var tokenKnown = false
    private var eligible = Set<UUID>()
    private var acknowledged: [UUID: Data] = [:]
    private var pending = false
    private var task: Task<Void, Never>?
    private let enrollments: () -> [ManagedEnrollment]
    private let write: (Data?, ManagedEnrollment) async throws -> Void
    init(enrollments: @escaping () -> [ManagedEnrollment], write: @escaping (Data?, ManagedEnrollment) async throws -> Void) {
        self.enrollments = enrollments; self.write = write
    }
    func update(token: Data?) { self.token = token; tokenKnown = true; synchronise() }
    func update(eligible: Set<UUID>) { self.eligible = eligible; synchronise() }
    func synchronise() {
        pending = true
        guard task == nil else { return }
        task = Task { [weak self] in
            guard let self else { return }
            defer { self.task = nil }
            while self.pending && !Task.isCancelled {
                self.pending = false
                let entries = self.enrollments()
                self.acknowledged = self.acknowledged.filter { id, _ in entries.contains { $0.deviceID == id } }
                for entry in entries {
                    if self.eligible.contains(entry.deviceID) && !self.tokenKnown { continue }
                    let desired = self.eligible.contains(entry.deviceID) ? self.token : nil
                    guard self.acknowledged[entry.deviceID] != (desired ?? Data()) else { continue }
                    do {
                        try await self.write(desired, entry)
                        self.acknowledged[entry.deviceID] = desired ?? Data()
                    } catch { /* Retry at the next foreground/configuration refresh; other customers still sync. */ }
                }
            }
        }
    }
}

@MainActor
final class MobileMessageNotifications {
    private weak var client: ManagedClient?
    private var task: Task<Void, Never>?
    private(set) var allowed = false
    var enabled: Bool { UserDefaults.standard.bool(forKey: "messageNotificationsEnabled") }
    var updateStatus: (String) -> Void = { _ in }
    let tokens: MobilePushTokens
    private var configured: Bool { (Bundle.main.object(forInfoDictionaryKey: "SipperPushEnabled") as? String)?.uppercased() == "YES" }
    init(client: ManagedClient?) {
        self.client = client
        tokens = MobilePushTokens(enrollments: { [weak client] in client?.isSignedIn == true ? client?.enrollments ?? [] : [] },
            write: { [weak client] token, entry in
                guard let client else { throw ManagedError.signInRequired }
                try await client.setMessagePushToken(token, for: entry)
            })
    }
    func setEnabled(_ value: Bool) async {
        if value {
            guard configured else { updateStatus("Message notifications are unavailable in this build."); return }
            do {
                guard try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) else {
                    updateStatus("Allow notifications for Sipper in iOS Settings."); return
                }
            } catch { updateStatus("Notification permission could not be checked. Try again."); return }
        }
        UserDefaults.standard.set(value, forKey: "messageNotificationsEnabled")
        refresh()
    }
    func refresh() {
        task?.cancel()
        task = Task {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            guard !Task.isCancelled else { return }
            allowed = configured && enabled && [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus)
            let eligible = client?.isSignedIn == true ? Set((client?.enrollments ?? []).filter { entry in
                client?.organisations.contains { $0.id == entry.organisationID && $0.status == "active" && $0.licensed } == true
            }.map(\.deviceID)) : []
            tokens.update(eligible: allowed ? eligible : [])
            if allowed && !eligible.isEmpty { UIApplication.shared.registerForRemoteNotifications() }
            else { clearDelivered() }
            updateStatus(!configured ? "Message notifications are unavailable in this build." : !enabled ? "Message notifications are off."
                : !allowed ? "Allow notifications for Sipper in iOS Settings." : eligible.isEmpty ? "Connect a licensed customer to receive message notifications." : "Message notifications are allowed by iOS.")
        }
    }
    func owns(_ hint: ManagedMessageNotification) -> Bool {
        guard enabled, client?.isSignedIn == true, let entry = client?.enrollments.first(where: { $0.deviceID == hint.deviceId }) else { return false }
        return client?.organisations.contains { $0.id == entry.organisationID && $0.status == "active" && $0.licensed } == true
    }
    func resolve(_ hint: ManagedMessageNotification) async -> Bool {
        guard enabled, let client, client.isSignedIn, client.enrollments.contains(where: { $0.deviceID == hint.deviceId }) else { return false }
        // A cold launch restores enrolments, but access must be refreshed before routing.
        do { try await client.refreshOrganisations() } catch { return false }
        return !Task.isCancelled && owns(hint)
    }
    func clearDelivered() {
        UNUserNotificationCenter.current().getDeliveredNotifications { notifications in
            let ids = notifications.filter { ($0.request.content.userInfo["sipper"] as? [String: Any])?["type"] as? String == "message" }.map { $0.request.identifier }
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
        }
    }
}

@MainActor
final class MobilePush: NSObject, @preconcurrency PKPushRegistryDelegate {
    private var registry: PKPushRegistry?
    private let calls: CallKitBridge
    let tokens: MobilePushTokens
    init(client: ManagedClient?, calls: CallKitBridge) {
        self.calls = calls
        tokens = MobilePushTokens(enrollments: { [weak client] in client?.isSignedIn == true ? client?.enrollments ?? [] : [] },
            write: { [weak client] token, entry in
                guard let client else { throw ManagedError.signInRequired }
                try await client.setVoIPPushToken(token, for: entry)
            })
        super.init()
    }
    func start() {
        guard registry == nil else { return }
        guard (Bundle.main.object(forInfoDictionaryKey: "SipperPushEnabled") as? String)?.uppercased() == "YES" else { tokens.update(token: nil); return }
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        self.registry = registry
        registry.desiredPushTypes = [.voIP]
        if let token = registry.pushToken(for: .voIP) { tokens.update(token: token) }
    }
    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        tokens.update(token: pushCredentials.token)
    }
    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        tokens.update(token: nil)
    }
    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
        guard type == .voIP else { completion(); return }
        calls.incomingPush(IncomingManagedCall.parse(apns: payload.dictionaryPayload), completion: completion)
    }
    @available(iOS 26.4, *)
    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingVoIPPushWith payload: PKPushPayload, metadata: PKVoIPPushMetadata, withCompletionHandler completion: @escaping () -> Void) {
        // Foreground pushes can have mustReport=false and still announce a new call.
        calls.incomingPush(IncomingManagedCall.parse(apns: payload.dictionaryPayload), mustReport: metadata.mustReport, completion: completion)
    }
}
