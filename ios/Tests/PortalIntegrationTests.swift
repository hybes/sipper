import XCTest
import AppAuth
import CallKit
import Security
@testable import SipperManaged
@testable import SipperIOS

/// Actual AppAuth, Keychain, MobileState and SIP against the isolated built portal.
/// The companion replaces browser gestures; CallKit's system transaction boundary is recorded.
@MainActor
final class PortalIntegrationTests: XCTestCase {
    private struct Fixture: Decodable {
        let origin: URL; let sipPort: Int; let vaultName: String; let organisationId: UUID; let userId: String
        let messageUserIds: [String]
    }
    private struct Reply: Decodable { let phase: String; let callback: URL? }
    private func until(_ step: String, _ check: () -> Bool) async throws {
        for _ in 0..<200 {
            if check() { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        throw NSError(domain: "PortalIntegration", code: 1, userInfo: [NSLocalizedDescriptionKey: step])
    }
    func testPortalIdentityDirectoryCallingAndWithdrawal() async throws {
        guard let path = ProcessInfo.processInfo.environment["SIPPER_TEST_PORTAL_FILE"], path.hasPrefix("/"),
              path.contains("sipper-ios-portal-") else { throw XCTSkip("Run pnpm test:ios-portal in portal/") }
        let file = URL(fileURLWithPath: path), directory = file.deletingLastPathComponent()
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: file))
        XCTAssertEqual(fixture.origin.scheme, "http"); XCTAssertEqual(fixture.origin.host, "127.0.0.1")
        XCTAssertNotNil(fixture.vaultName.range(of: "^portal-test-[a-f0-9]{24}$", options: .regularExpression))
        func checkpoint(_ phase: String, values: [String: String] = [:]) async throws -> Reply {
            let reply = directory.appendingPathComponent("portal-test-reply.json")
            try? FileManager.default.removeItem(at: reply)
            try JSONSerialization.data(withJSONObject: values.merging(["phase":phase]) { _, value in value })
                .write(to: directory.appendingPathComponent("portal-test-phase.json"), options: .atomic)
            try await until("Companion did not complete \(phase)") { FileManager.default.fileExists(atPath: reply.path) }
            let result = try JSONDecoder().decode(Reply.self, from: Data(contentsOf: reply))
            XCTAssertEqual(result.phase, phase)
            return result
        }
        let service = "com.hybes.sipper.portal-test.\(fixture.vaultName)"
        let keychainStatus = SecItemCopyMatching([kSecClass:kSecClassGenericPassword, kSecAttrService:service,
            kSecAttrAccount:"fresh-store-check"] as CFDictionary, nil)
        guard keychainStatus == errSecItemNotFound else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(keychainStatus),
                          userInfo: [NSLocalizedDescriptionKey:"The test host must have working Keychain entitlements (OSStatus \(keychainStatus))."])
        }
        let secure = ManagedKeychainStore(service: service)
        func newClient() throws -> ManagedClient {
            try ManagedClient(serverURL: fixture.origin, clientID: "sipper-ios", storage: secure, allowLocalDevelopment: true)
        }
        let client = try newClient()
        let agent = PortalBrowser { request in
            let reply = try await checkpoint("authorise", values: ["url":request.absoluteString])
            return try XCTUnwrap(reply.callback)
        }
        try await client.signIn(userAgent: agent)
        XCTAssertTrue(client.isSignedIn); XCTAssertEqual(client.identity?.id, fixture.userId)
        let organisation = try XCTUnwrap(client.organisations.first { $0.id == fixture.organisationId })
        let personalStore = try MobileAccountStore(storage: secure)
        let personal = SIPAccount(profileID: UUID(), label: "Personal fixture", username: "personal", domain: "sipper.test",
            server: "127.0.0.1", port: fixture.sipPort, transport: .udp, srtp: .disabled, useICE: false)
        try personalStore.save(personal, password: "fixture-personal")
        let state = MobileState(personalStore: personalStore, managedClient: client)
        defer { state.engine.stop(); try? secure.remove("manual-accounts") }
        XCTAssertNil(state.error); XCTAssertNil(state.managedMessage)
        try state.engine.useNullAudioForTesting()
        let provider = CXProvider(configuration: CXProviderConfiguration()), recorder = RecordingCalls()
        var bridge: CallKitBridge!
        bridge = CallKitBridge(engine: state.engine, reporter: recorder, requestTransaction: { transaction in
            for action in transaction.actions {
                if let start = action as? CXStartCallAction { bridge.provider(provider, perform: start) }
                else if let end = action as? CXEndCallAction { bridge.provider(provider, perform: end) }
                else { XCTFail("Unexpected CallKit action") }
            }
        })
        bridge.canUseAccount = { state.canUse($0) }; bridge.requestMicrophone = { true }
        bridge.onStarted = { state.sipEngine(state.engine, callDidChange: $0) }
        bridge.onError = { XCTFail($0) }
        state.callKit = bridge
        await state.connect(organisation)
        XCTAssertNil(state.managedMessage)
        let enrollment = try XCTUnwrap(client.enrollments.first)
        let account = try XCTUnwrap(state.accounts.first { $0.managed != nil })
        try await until("Both accounts must register") {
            state.engine.currentRegistration(accountID: account.id).isRegistered && state.engine.currentRegistration(accountID: personal.id).isRegistered
        }
        await state.setAvailability(.away, organisationID: organisation.id)
        XCTAssertEqual(client.organisations.first?.availability, .away); XCTAssertEqual(client.organisations.first?.doNotDisturb, false)
        let contacts = try await client.directory(for: enrollment)
        XCTAssertEqual(contacts.contacts.count, 3)
        let contact = try XCTUnwrap(contacts.contacts.first { $0.matches("Alex") })
        let restored = try newClient()
        XCTAssertTrue(restored.isSignedIn); XCTAssertEqual(restored.enrollments, [enrollment])
        let cached = try XCTUnwrap(restored.directories[enrollment.deviceID])
        XCTAssertEqual(cached.deviceId, contacts.deviceId); XCTAssertEqual(cached.revision, contacts.revision)
        XCTAssertEqual(cached.organisation.id, contacts.organisation.id)
        XCTAssertEqual(cached.contacts.map(\.id), contacts.contacts.map(\.id))
        XCTAssertEqual(cached.contacts.map(\.name), contacts.contacts.map(\.name))
        XCTAssertEqual(cached.contacts.map(\.company), contacts.contacts.map(\.company))
        XCTAssertEqual(cached.contacts.map(\.numbers), contacts.contacts.map(\.numbers))
        XCTAssertEqual(cached.contacts.map(\.revision), contacts.contacts.map(\.revision))
        // The existing cache stores whole seconds. Restoring must never extend authority.
        XCTAssertLessThanOrEqual(cached.expiresAt, contacts.expiresAt)
        XCTAssertLessThan(contacts.expiresAt.timeIntervalSince(cached.expiresAt), 1)
        XCTAssertEqual(try restored.cachedConfiguration(for: enrollment)?.accounts.first?.id, account.managed?.accountID)
        let shared = try await client.directoryStatus(contactIDs: [contact.id], for: enrollment)
        XCTAssertEqual(shared.contacts.first?.availability, .away); XCTAssertEqual(shared.contacts.first?.doNotDisturb, false)
        _ = try await checkpoint("status-shared")
        let hidden = try await client.directoryStatus(contactIDs: [contact.id], for: enrollment)
        XCTAssertNil(hidden.contacts.first?.availability); XCTAssertNil(hidden.contacts.first?.doNotDisturb)
        XCTAssertEqual(fixture.messageUserIds.count, 2)
        let colleagues = try await client.messagePeople(for: enrollment)
        XCTAssertEqual(Set(colleagues.people.map(\.id)), Set(fixture.messageUserIds))
        let direct = try await client.createConversation(id: UUID(), userIDs: [fixture.messageUserIds[0]], for: enrollment)
        let group = try await client.createConversation(id: UUID(), userIDs: fixture.messageUserIds, title: "Native calling team", for: enrollment)
        let nonce = UUID(), text = "From iOS: <b>literal text</b>\n🌱"
        let sent = try await client.sendMessage(id: nonce, text: text, conversationID: direct.id, for: enrollment)
        let retry = try await client.sendMessage(id: nonce, text: text, conversationID: direct.id, for: enrollment)
        XCTAssertEqual(retry, sent)
        let groupSent = try await client.sendMessage(id: UUID(), text: "Native group text", conversationID: group.id, for: enrollment)
        let threads = try await client.conversations(for: enrollment)
        XCTAssertEqual(Set(threads.conversations.map(\.id)), Set([direct.id, group.id]))
        XCTAssertEqual(threads.scope.deviceId, enrollment.deviceID); XCTAssertEqual(threads.scope.userId, fixture.userId)
        try await client.setMessagePushToken(Data(repeating: 10, count: 32), for: enrollment)
        do {
            let key = "messageNotificationsEnabled", previous = UserDefaults.standard.object(forKey: "messageNotificationsEnabled")
            defer { if let previous { UserDefaults.standard.set(previous, forKey: key) } else { UserDefaults.standard.removeObject(forKey: key) } }
            UserDefaults.standard.set(true, forKey: key)
            let notice = try XCTUnwrap(ManagedMessageNotification.parse(apns: ["sipper": ["schemaVersion": 1, "type": "message",
                "deviceId": enrollment.deviceID.uuidString, "conversationId": direct.id.uuidString,
                "expiresAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(60))]]))
            XCTAssertTrue(restored.organisations.isEmpty)
            let notifications = MobileMessageNotifications(client: restored)
            XCTAssertFalse(notifications.owns(notice))
            let resolved = await notifications.resolve(notice)
            XCTAssertTrue(resolved, "A cold notification tap refreshes customer access without starting another SIP engine")
            UserDefaults.standard.set(false, forKey: key)
            let disabled = await notifications.resolve(notice)
            XCTAssertFalse(disabled)
        }
        _ = try await checkpoint("messaging", values: ["conversationId": direct.id.uuidString.lowercased(), "groupId": group.id.uuidString.lowercased(), "deviceId": enrollment.deviceID.uuidString.lowercased()])
        let alerts = try await client.messageAlerts(for: enrollment)
        XCTAssertEqual(Set(alerts.alerts.map(\.conversationId)), Set([direct.id, group.id]), "Apple's desktop alert feed uses the same owned-device HTTP boundary")
        let reply = try await client.conversationMessages(direct.id, for: enrollment, after: sent.sequence)
        XCTAssertEqual(reply.messages.count, 1); XCTAssertEqual(reply.messages[0].text, "Reply from a fictional colleague.")
        XCTAssertEqual(reply.messages[0].senderId, fixture.messageUserIds[0])
        try await client.markConversationRead(direct.id, sequence: reply.messages[0].sequence, for: enrollment)
        let groupReply = try await client.conversationMessages(group.id, for: enrollment, after: groupSent.sequence)
        XCTAssertEqual(groupReply.messages.count, 1); XCTAssertEqual(groupReply.messages[0].text, "Reply to the native group.")
        try await client.markConversationRead(group.id, sequence: groupReply.messages[0].sequence, for: enrollment)
        let readAlerts = try await client.messageAlerts(for: enrollment)
        XCTAssertTrue(readAlerts.alerts.isEmpty)
        _ = try await checkpoint("messages-read")
        let peers = fixture.messageUserIds
        let changed = try await client.updateMessageGroup(group.id, revision: groupReply.conversation.revision!, title: "Updated native group", userIDs: [enrollment.userID] + peers, ownerID: peers[0], for: enrollment)
        XCTAssertEqual(changed.ownerId, peers[0])
        let retryGroup = try await client.updateMessageGroup(group.id, revision: groupReply.conversation.revision!, title: "Updated native group", userIDs: [enrollment.userID] + peers, ownerID: peers[0], for: enrollment)
        XCTAssertEqual(changed, retryGroup)
        try await client.leaveMessageGroup(group.id, for: enrollment); try await client.leaveMessageGroup(group.id, for: enrollment)
        do { _ = try await client.conversationMessages(group.id, for: enrollment); XCTFail("Left group must be unavailable") } catch {}
        _ = try await checkpoint("groups-left", values: ["deviceId": enrollment.deviceID.uuidString])
        let rejoinedGroup = try await client.conversationMessages(group.id, for: enrollment)
        XCTAssertEqual(rejoinedGroup.messages.count, 1); XCTAssertEqual(rejoinedGroup.messages.first?.text, "After rejoining the group.")
        try await client.markConversationRead(group.id, sequence: rejoinedGroup.messages.last!.sequence, for: enrollment)
        do { try await state.callDirectory("*97", contactID: contact.id, enrollment: enrollment, accountID: personal.id); XCTFail("Personal account must not take a managed directory call") } catch {}
        try await state.callDirectory("*97", contactID: contact.id, enrollment: enrollment, accountID: account.id)
        try await until("Directory call connected") { state.calls.count == 1 && state.calls.first?.connectedAt != nil }
        await state.refreshManaged() // Reports the actual registration and connected call through MobileState.
        XCTAssertNil(state.managedMessage)
        let activity = try await client.directoryStatus(contactIDs: [contact.id], for: enrollment)
        XCTAssertEqual(activity.contacts.first?.activity?.state, .inCall); XCTAssertEqual(activity.contacts.first?.activity?.source, .device)
        _ = try await checkpoint("activity-shared")
        let privateActivity = try await client.directoryStatus(contactIDs: [contact.id], for: enrollment)
        XCTAssertNil(privateActivity.contacts.first?.activity)
        _ = try await checkpoint("calling", values: ["deviceId":enrollment.deviceID.uuidString.lowercased()])
        await state.refreshManaged()
        XCTAssertEqual(client.organisations.first?.status, "suspended")
        XCTAssertEqual(state.accounts.map(\.id), [personal.id]); XCTAssertTrue(client.directories.isEmpty)
        XCTAssertFalse(state.engine.currentRegistration(accountID: account.id).isRegistered)
        XCTAssertTrue(state.engine.currentRegistration(accountID: personal.id).isRegistered)
        XCTAssertEqual(state.calls.count, 1); XCTAssertNotNil(state.calls.first?.connectedAt)
        XCTAssertThrowsError(try client.directoryNumber("*97", contactID: contact.id, for: enrollment))
        XCTAssertNil(try client.cachedConfiguration(for: enrollment))
        do { _ = try await client.conversationMessages(direct.id, for: enrollment); XCTFail("Suspension must block messaging") } catch {}
        _ = try await checkpoint("suspended")
        await state.refreshManaged()
        try await until("Managed registration restored") { state.engine.currentRegistration(accountID: account.id).isRegistered }
        _ = try await client.directory(for: enrollment)
        bridge.end(try XCTUnwrap(state.calls.first))
        try await until("Call ended") { state.calls.isEmpty }
        await state.setAvailability(.unset, organisationID: organisation.id)
        await state.disconnect(enrollment)
        XCTAssertTrue(client.enrollments.isEmpty); XCTAssertTrue(client.directories.isEmpty)
        XCTAssertEqual(state.accounts.map(\.id), [personal.id])
        _ = try await checkpoint("disconnected", values: ["deviceId":enrollment.deviceID.uuidString.lowercased()])
        await state.connect(try XCTUnwrap(client.organisations.first))
        let replacement = try XCTUnwrap(client.enrollments.first)
        XCTAssertNotEqual(replacement.deviceID, enrollment.deviceID)
        let reconnected = try await client.conversationMessages(direct.id, for: replacement)
        XCTAssertEqual(reconnected.messages.count, 2); XCTAssertEqual(reconnected.conversation.unread, 0)
        await state.signOut()
        XCTAssertFalse(client.isSignedIn); XCTAssertTrue(client.enrollments.isEmpty); XCTAssertTrue(client.directories.isEmpty)
        XCTAssertEqual(state.accounts.map(\.id), [personal.id])
        XCTAssertTrue(state.engine.currentRegistration(accountID: personal.id).isRegistered)
        let signedOut = try newClient()
        XCTAssertFalse(signedOut.isSignedIn); XCTAssertTrue(signedOut.enrollments.isEmpty)
        XCTAssertEqual(try MobileAccountStore(storage: secure).entries.map(\.account.id), [personal.id])
        _ = try await checkpoint("signed-out", values: ["deviceId":replacement.deviceID.uuidString.lowercased()])
    }
}

private final class PortalBrowser: NSObject, OIDExternalUserAgent {
    let callback: @MainActor (URL) async throws -> URL
    init(callback: @escaping @MainActor (URL) async throws -> URL) { self.callback = callback }
    func present(_ request: OIDExternalUserAgentRequest, session: OIDExternalUserAgentSession) -> Bool {
        guard let url = request.externalUserAgentRequestURL() else { return false }
        Task { @MainActor in
            do { try session.resumeExternalUserAgentFlow(try await callback(url)) }
            catch { session.failExternalUserAgentFlowWithError(error) }
        }
        return true
    }
    func dismiss(animated: Bool, completion: @escaping () -> Void) { completion() }
}
