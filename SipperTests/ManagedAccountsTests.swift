import XCTest
import SipperManaged
@testable import Sipper

@MainActor
final class ManagedAccountsTests: XCTestCase {
    private let organisationID = UUID(), deviceID = UUID(), remoteAccountID = UUID(), profileID = UUID()

    private func configuration(expiresAt: Date = Date().addingTimeInterval(3600), password: String = "fictional-managed-password", accounts: Bool = true, mode: String = "direct") throws -> ManagedConfiguration {
        let settings: [String: Any] = ["username": "100", "authUsername": "", "domain": "pbx.example.invalid", "server": "sip.example.invalid", "port": 5061,
            "transport": "tls", "srtp": "required", "displayName": "Example", "voicemailNumber": "*97", "useICE": true, "stunServer": ""]
        let account: [String: Any] = ["id": remoteAccountID.uuidString, "label": "Managed example", "mode": mode, "revision": 1, "password": password, "settings": settings]
        let object: [String: Any] = ["schemaVersion": 1, "organisation": ["id": organisationID.uuidString, "name": "Example organisation"],
            "deviceId": deviceID.uuidString, "revision": String(repeating: "a", count: 64), "expiresAt": ISO8601DateFormatter().string(from: expiresAt), "accounts": accounts ? [account] : []]
        return try ManagedClient.configurationDecoder().decode(ManagedConfiguration.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func harness() -> (AppState, InMemoryPasswordStore) {
        let passwords = InMemoryPasswordStore()
        let state = AppState(store: PersistenceStore(directory: TestSupport.makeTemporaryDirectory(for: self)), passwords: passwords, startEngine: false)
        state.settings.ringtone = .silent
        return (state, passwords)
    }

    func testSetupLinkOnlyOpensManagedFormWithoutImportingOrCalling() throws {
        let (state, _) = harness()
        let accounts = state.accounts
        let url = try XCTUnwrap(URL(string: "sipper://setup?server=https%3A%2F%2Fsipper.dev&reference=\(String(repeating: "a", count: 43))"))
        state.handle(url: url)
        XCTAssertEqual(state.managedSetupURL, url)
        XCTAssertNil(state.pendingImport)
        XCTAssertEqual(state.accounts, accounts)
        XCTAssertTrue(state.calls.isEmpty)
    }

    func testGatewayConfigurationKeepsItsManagedIdentityAndMandatoryEncryption() throws {
        let (state, _) = harness()
        try state.applyManagedConfiguration(configuration(mode: "gateway"), profileID: profileID)
        let account = try XCTUnwrap(state.accounts.first)
        XCTAssertEqual(account.managed?.mode, .gateway)
        XCTAssertEqual(account.managed?.deviceID, deviceID)
        XCTAssertEqual(account.managed?.accountID, remoteAccountID)
        XCTAssertEqual(account.transport, .tls)
        XCTAssertEqual(account.srtp, .mandatory)
        XCTAssertEqual(state.password(for: account.id), "")
    }

    func testDirectCallingPreferenceMapsToRuntimeOnlyManagedPolicy() throws {
        let config = try configuration()
        var remote = config.accounts[0]; remote.doNotDisturb = true
        let account = ManagedAccountMapper.account(remote, configuration: config, profileID: profileID)
        XCTAssertEqual(account.managed?.doNotDisturb, true)
        XCTAssertEqual(account.managed?.mode, .direct)
        XCTAssertNil(try JSONDecoder().decode(SIPAccount.self, from: JSONEncoder().encode(account)).managed)
    }

    func testManagedHistoryCannotFallBackToPersonalAccountAfterDisconnect() throws {
        let (state, _) = harness()
        let personal = try state.addAccount(SIPAccount(profileID: state.manualProfiles[0].id, username: "personal", domain: "sip.example.invalid"), password: "fictional")
        try state.applyManagedConfiguration(configuration(), profileID: profileID)
        let managed = try XCTUnwrap(state.accounts.first { $0.managed != nil })
        let record = CallRecord(accountID: managed.id, direction: .incoming, remoteNumber: "100", isManaged: true)
        state.removeManagedAccounts(deviceID: deviceID, profileID: profileID)
        XCTAssertEqual(state.dialerAccount?.id, personal.id)
        state.callBack(record)
        XCTAssertEqual(state.alert?.title, "Account unavailable")
        XCTAssertTrue(state.calls.isEmpty)
    }

    func testUnauthenticatedGatewayCallerNeverAppearsInViewsOrHistory() async throws {
        let (state, _) = harness()
        try state.applyManagedConfiguration(configuration(mode: "gateway"), profileID: profileID)
        let account = try XCTUnwrap(state.accounts.first)
        var incoming = CallSnapshot.fixture(accountID: account.id, remoteNumber: "unverified", remoteName: "Untrusted SIP name")
        incoming.gatewayCallID = UUID(); incoming.managedAccount = account.managed
        state.sipEngine(state.engine, didReceiveIncomingCall: incoming)
        state.sipEngine(state.engine, callDidChange: incoming)
        state.sipEngine(state.engine, callDidEnd: incoming.ended())
        let recorded = await TestSupport.waitUntil { !state.history.isEmpty }
        XCTAssertTrue(recorded)
        XCTAssertTrue(state.calls.isEmpty)
        XCTAssertEqual(state.history.first?.remoteNumber, "Incoming managed call")
        XCTAssertEqual(state.history.first?.remoteName, "")
        XCTAssertEqual(state.history.first?.remoteURI, "")
        XCTAssertEqual(state.history.first?.isManaged, true)
    }

    func testEndingPendingAnswerPreventsLatePermissionFromAnsweringReusedCallID() async throws {
        let (state, _) = harness()
        let account = try state.addAccount(SIPAccount(profileID: state.manualProfiles[0].id, username: "personal", domain: "sip.example.invalid"), password: "fictional")
        var permission: CheckedContinuation<Bool, Never>?
        var requested = 0
        state.requestMicrophone = { requested += 1; return await withCheckedContinuation { permission = $0 } }
        let incoming = CallSnapshot.fixture(id: 10, accountID: account.id)
        state.sipEngine(state.engine, didReceiveIncomingCall: incoming)
        let displayed = await TestSupport.waitUntil { state.calls.count == 1 }
        XCTAssertTrue(displayed)
        state.answer(callID: incoming.id)
        let waiting = await TestSupport.waitUntil { permission != nil }
        XCTAssertTrue(waiting)
        state.answer(callID: incoming.id)
        XCTAssertEqual(requested, 1, "A second answer must not replace the pending one")
        state.decline(callID: incoming.id)
        state.sipEngine(state.engine, callDidEnd: incoming.ended())
        let ended = await TestSupport.waitUntil { state.calls.isEmpty }
        XCTAssertTrue(ended)
        let next = CallSnapshot.fixture(id: 10, accountID: account.id, startedAt: incoming.startedAt.addingTimeInterval(1))
        state.sipEngine(state.engine, didReceiveIncomingCall: next)
        let reused = await TestSupport.waitUntil { state.calls.first?.startedAt == next.startedAt }
        XCTAssertTrue(reused)
        permission?.resume(returning: true)
        await Task.yield()
        XCTAssertNil(state.alert, "Deliberately ending the previous call is not an answer failure")
        XCTAssertEqual(state.calls.first?.startedAt, next.startedAt)
    }

    func testMatchingManualAccountIsNeverAdoptedAndDisconnectPreservesIt() throws {
        let (state, passwords) = harness()
        let manual = try state.addAccount(SIPAccount(profileID: state.manualProfiles[0].id, username: "100", domain: "pbx.example.invalid"), password: "fictional-personal-password")
        try state.applyManagedConfiguration(configuration(), profileID: profileID)
        let managed = try XCTUnwrap(state.accounts.first { $0.managed != nil })
        XCTAssertNotEqual(managed.id, manual.id)
        XCTAssertEqual(state.duplicateAccount(username: "100", domain: "pbx.example.invalid")?.id, manual.id)
        XCTAssertEqual(state.password(for: managed.id), "")
        XCTAssertNil(passwords.password(for: managed.id))
        state.removeManagedAccounts(deviceID: deviceID, profileID: profileID)
        XCTAssertEqual(state.accounts, [manual])
        XCTAssertEqual(passwords.password(for: manual.id), "fictional-personal-password")
        XCTAssertNil(state.profile(for: profileID))
    }

    func testManagedSettingsNeverEnterPersonalFilesOrCloudDocuments() throws {
        let (state, _) = harness()
        try state.applyManagedConfiguration(configuration(), profileID: profileID)
        state.flush()
        XCTAssertTrue(try XCTUnwrap(state.store.load([SIPAccount].self, from: StoreFile.accounts)).isEmpty)
        XCTAssertEqual(try XCTUnwrap(state.store.load([Profile].self, from: StoreFile.profiles)).count, 1)
        for collection in [SyncCollection.accounts, .profiles] {
            let json = String(data: try XCTUnwrap(state.encodeCloudDocument(collection)), encoding: .utf8)!
            XCTAssertFalse(json.contains("pbx.example.invalid"))
            XCTAssertFalse(json.contains("Example organisation"))
            XCTAssertFalse(json.contains("fictional-managed-password"))
        }
    }

    func testEditorImporterAndProfileActionsCannotChangeManagedAccounts() throws {
        let (state, passwords) = harness()
        try state.applyManagedConfiguration(configuration(), profileID: profileID)
        let managed = try XCTUnwrap(state.accounts.first)
        var forged = managed; forged.managed = nil; forged.domain = "wrong.example.invalid"
        XCTAssertThrowsError(try state.updateAccount(forged, password: "must-not-save"))
        XCTAssertThrowsError(try state.addAccount(forged, password: "must-not-save"))
        state.moveAccount(managed.id, to: state.manualProfiles[0].id)
        state.deleteAccount(managed.id)
        state.deleteProfile(profileID, moveAccountsTo: state.manualProfiles[0].id)
        XCTAssertEqual(state.account(for: managed.id), managed)
        XCTAssertNil(passwords.password(for: managed.id))
        XCTAssertNil(state.duplicateAccount(username: "100", domain: "pbx.example.invalid"))
    }

    func testCloudCannotReplaceManagedAccountsOrDeleteTheirProfile() throws {
        let (state, _) = harness()
        try state.applyManagedConfiguration(configuration(), profileID: profileID)
        let managed = try XCTUnwrap(state.accounts.first)
        var impostor = managed; impostor.managed = nil; impostor.username = "wrong"; impostor.updatedAt = .distantFuture
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = JSONDates.encoding
        let accounts = SyncDocument(deviceID: "fixture", items: [impostor], tombstones: [SyncTombstone(id: managed.id, deletedAt: .distantFuture)])
        state.cloudSync(state.cloudSync, didReceive: .accounts, payloads: [try encoder.encode(accounts)])
        let profiles = SyncDocument<Profile>(deviceID: "fixture", items: [], tombstones: [SyncTombstone(id: profileID, deletedAt: .distantFuture)])
        state.cloudSync(state.cloudSync, didReceive: .profiles, payloads: [try encoder.encode(profiles)])
        XCTAssertEqual(state.account(for: managed.id), managed)
        XCTAssertEqual(state.profile(for: profileID)?.managedOrganisationID, organisationID)
    }

    func testRenewalKeepsLocalIDsAndExpiredSettingsCannotBeUsed() throws {
        let (state, _) = harness()
        try state.applyManagedConfiguration(configuration(), profileID: profileID)
        let first = try XCTUnwrap(state.accounts.first)
        try state.applyManagedConfiguration(configuration(expiresAt: Date().addingTimeInterval(7200), password: "fictional-rotated-password"), profileID: profileID)
        let renewed = try XCTUnwrap(state.accounts.first)
        XCTAssertEqual(first.id, renewed.id)
        XCTAssertEqual(renewed.srtp, .mandatory)
        XCTAssertTrue(state.canUseAccount(renewed))
        XCTAssertFalse(state.canUseAccount(renewed, now: Date().addingTimeInterval(7300)))
        XCTAssertThrowsError(try state.applyManagedConfiguration(configuration(expiresAt: Date().addingTimeInterval(-10)), profileID: profileID))
    }

    func testDisconnectRemovesAnEmptyManagedProfile() throws {
        let (state, _) = harness()
        try state.applyManagedConfiguration(configuration(accounts: false), profileID: profileID)
        XCTAssertNotNil(state.profile(for: profileID))
        state.removeManagedAccounts(deviceID: deviceID, profileID: profileID)
        XCTAssertNil(state.profile(for: profileID))
        XCTAssertEqual(state.manualProfiles.count, 1)
    }

    func testStoppedEngineCannotAcknowledgeSettingsOrReportCachedRegistration() async throws {
        let (state, _) = harness()
        let report = try await state.applyManagedConfigurationAndReport(configuration(), profileID: profileID)
        XCTAssertNil(report.appliedRevision)
        XCTAssertEqual(report, state.managedDeviceReport(try configuration(), profileID: profileID))
        let registrations = try XCTUnwrap(report.registrations)
        XCTAssertEqual(registrations.count, 1)
        XCTAssertEqual(registrations.first?.state, "unknown")
        XCTAssertNil(registrations.first?.sipCode)
    }

    func testManagedCallHistoryStaysOutOfPersonalCloudAfterDisconnect() async throws {
        let (state, _) = harness()
        try state.applyManagedConfiguration(configuration(), profileID: profileID)
        let account = try XCTUnwrap(state.accounts.first)
        state.removeManagedAccounts(deviceID: deviceID, profileID: profileID)
        let ended = CallSnapshot.fixture(accountID: account.id, direction: .outgoing, state: .disconnected)
        state.sipEngine(state.engine, callDidEnd: ended)
        let saved = await TestSupport.waitUntil { !state.history.isEmpty }
        XCTAssertTrue(saved)
        XCTAssertEqual(state.history.first?.isManaged, true)
        let data = try XCTUnwrap(state.encodeCloudDocument(.history))
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = JSONDates.decoding
        XCTAssertTrue(try decoder.decode(SyncDocument<CallRecord>.self, from: data).items.isEmpty)
    }
}
