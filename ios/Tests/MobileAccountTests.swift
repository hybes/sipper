import XCTest
import SipperManaged
@testable import SipperIOS

final class MobileAccountTests: XCTestCase {
    @MainActor
    func testMessageDraftGuardDefersAccountLinksAndKeepsCallsInControl() throws {
        let store = try MobileAccountStore(storage: TestSecretStore())
        let client = try ManagedClient(serverURL: URL(string: "https://sipper.example.invalid")!, clientID: "sipper-ios", storage: TestSecretStore())
        let state = MobileState(personalStore: store, managedClient: client)
        defer { state.engine.stop() }
        state.selectedTab = 3
        state.setMessageNavigationLocked(true)
        for tab in [0, 1, 2] { state.selectTab(tab); XCTAssertEqual(state.selectedTab, 3) }
        let link = "sipper://setup?server=https%3A%2F%2Fsipper.example.invalid&reference=\(String(repeating: "a", count: 43))"
        state.handle(url: URL(string: link)!)
        XCTAssertEqual(state.selectedTab, 3); XCTAssertEqual(state.setupLink, link)
        state.handle(url: URL(string: link.replacingOccurrences(of: "sipper.example", with: "other.example"))!)
        XCTAssertNotNil(state.error); XCTAssertEqual(state.setupLink, link); XCTAssertEqual(state.selectedTab, 3)
        state.error = nil
        state.setMessageNavigationLocked(false)
        XCTAssertEqual(state.selectedTab, 2)
        state.setupLink = ""; state.selectedTab = 3

        let importing = try importLink([["username": "100", "domain": "example.invalid", "password": "fictional-import"]])
        state.setMessageNavigationLocked(true)
        state.handle(url: URL(string: importing)!)
        XCTAssertEqual(state.selectedTab, 3); XCTAssertTrue(state.importing)
        XCTAssertEqual(state.importReview?.candidates.count, 1); XCTAssertTrue(state.accounts.isEmpty)
        state.cancelImport(); state.setMessageNavigationLocked(false)
        XCTAssertEqual(state.selectedTab, 3, "Cancelled imports must not leave queued navigation")

        state.setMessageNavigationLocked(true); state.handle(url: URL(string: importing)!)
        var call = CallSnapshot(id: 1, accountID: UUID(), direction: .outgoing, state: .confirmed,
            remoteURI: "sip:200@example.invalid", remoteNumber: "200", remoteName: "Navigation fixture",
            isMuted: false, isOnHold: false, isRemoteHold: false, hasActiveMedia: false,
            startedAt: Date(), connectedAt: Date(), lastStatusCode: 200, lastStatusText: "OK")
        state.sipEngine(state.engine, callDidChange: call)
        XCTAssertEqual(state.selectedTab, 4, "New calls take priority over a message draft")
        state.setMessageNavigationLocked(false)
        XCTAssertEqual(state.selectedTab, 4, "Deferred setup cannot replace the call screen")
        call.state = .disconnected; state.sipEngine(state.engine, callDidChange: call)
        XCTAssertEqual(state.selectedTab, 2); XCTAssertTrue(state.importing); XCTAssertTrue(state.accounts.isEmpty)
        state.cancelImport(); state.selectTab(1)
        XCTAssertEqual(state.selectedTab, 1)
    }
    @MainActor
    func testConsultationEntrySelectsTheSourceAccountAndPreservesTheCall() throws {
        let store = try MobileAccountStore(storage: TestSecretStore())
        let account = SIPAccount(profileID: UUID(), username: "100", domain: "example.invalid")
        try store.save(account, password: "fixture")
        let state = MobileState(personalStore: store)
        var call = CallSnapshot(id: 1, accountID: account.id, direction: .outgoing, state: .confirmed,
            remoteURI: "sip:200@example.invalid", remoteNumber: "200", remoteName: "Consultation fixture",
            isMuted: false, isOnHold: false, isRemoteHold: false, hasActiveMedia: false,
            startedAt: Date(), connectedAt: Date(), lastStatusCode: 200, lastStatusText: "OK")
        state.sipEngine(state.engine, callDidChange: call)
        XCTAssertEqual(state.selectedTab, 4)
        state.dialTarget = "old number"
        var stale = call; stale.startedAt = call.startedAt.addingTimeInterval(-1)
        state.prepareNewCall(stale)
        XCTAssertEqual(state.selectedTab, 4)
        state.prepareNewCall(call)
        XCTAssertEqual(state.selectedTab, 0); XCTAssertEqual(state.selectedAccountID, account.id)
        XCTAssertEqual(state.dialTarget, ""); XCTAssertEqual(state.calls, [call])
        state.selectedTab = 4 // Return to call has no telephony side effect.
        XCTAssertEqual(state.calls, [call])
        var second = call; second.id = 2
        state.sipEngine(state.engine, callDidChange: second)
        state.prepareNewCall(call)
        XCTAssertEqual(state.selectedTab, 4, "Two calls must not offer a third consultation")
        second.state = .disconnected
        state.sipEngine(state.engine, callDidChange: second)
        call.isTransferring = true
        state.sipEngine(state.engine, callDidChange: call)
        state.prepareNewCall(call)
        XCTAssertEqual(state.selectedTab, 4)
        call.state = .disconnected
        state.sipEngine(state.engine, callDidChange: call)
        XCTAssertTrue(state.calls.isEmpty); XCTAssertEqual(state.selectedTab, 0)
    }
    private func importLink(_ accounts: [[String: Any]]) throws -> String {
        ImportParser.makeURL(jsonData: try JSONSerialization.data(withJSONObject: ["version": 1, "accounts": accounts]))!.absoluteString
    }
    func testImportsRequireReviewAndPreserveIdentityWithAnAtomicSecureWrite() throws {
        let secrets = TestSecretStore(), password = "  fictional password  "
        let store = try MobileAccountStore(storage: secrets)
        let old = SIPAccount(profileID: UUID(), label: "My account", username: "100", domain: "example.invalid", transport: .tls,
                             isEnabled: false, srtp: .mandatory, useICE: true)
        try store.save(old, password: "previous")
        let link = try importLink([
            ["username": "100", "domain": "EXAMPLE.invalid", "password": password, "label": "Imported", "server": "sip.example.invalid", "transport": "TCP"],
            ["username": "200", "domain": "example.invalid", "password": "new"]])
        let review = try store.reviewImport(link)
        XCTAssertEqual(store.entries.count, 1); XCTAssertEqual(store.entries[0].password, "previous")
        let update = review.candidates[0]
        XCTAssertEqual(update.existingAccountID, old.id); XCTAssertEqual(update.account.id, old.id)
        XCTAssertEqual(update.account.profileID, old.profileID); XCTAssertEqual(update.account.label, "My account")
        XCTAssertFalse(update.account.isEnabled); XCTAssertTrue(update.account.useICE); XCTAssertEqual(update.account.srtp, .mandatory)
        let selected = Set(review.candidates.map(\.id))
        XCTAssertThrowsError(try store.importAccounts(review, selected: selected, activeAccounts: [old.id]))
        secrets.failWrites = true
        XCTAssertThrowsError(try store.importAccounts(review, selected: selected, activeAccounts: []))
        XCTAssertEqual(store.entries.count, 1); XCTAssertEqual(store.entries[0].password, "previous")
        secrets.failWrites = false
        try store.importAccounts(review, selected: selected, activeAccounts: [])
        let loaded = try MobileAccountStore(storage: secrets)
        XCTAssertEqual(loaded.entries.count, 2); XCTAssertEqual(loaded.entries[0].password, password)
        XCTAssertEqual(loaded.entries[0].account.id, old.id); XCTAssertEqual(loaded.entries[0].account.server, "sip.example.invalid")
        XCTAssertThrowsError(try store.importAccounts(review, selected: selected, activeAccounts: []))
        let fresh = try store.reviewImport(link)
        try store.remove(old.id)
        XCTAssertThrowsError(try store.importAccounts(fresh, selected: Set(fresh.candidates.map(\.id)), activeAccounts: []))
    }
    func testImportsRejectInvalidDuplicateOversizedAndExcessAccountsWithoutLeakingInput() throws {
        let store = try MobileAccountStore(storage: TestSecretStore())
        let valid: [String: Any] = ["username": "100", "domain": "example.invalid", "password": "fictional-secret"]
        for link in ["sipper://setup?payload=fictional-secret", "sipper://add-accounts?payload=fictional-secret!", String(repeating: "x", count: ImportParser.maxPayloadBytes * 2 + 1025)] {
            XCTAssertThrowsError(try store.reviewImport(link)) { XCTAssertFalse($0.localizedDescription.contains("fictional-secret")) }
        }
        let duplicate = try store.reviewImport(importLink([valid, valid]))
        XCTAssertEqual(duplicate.candidates.filter(\.isValid).count, 0)
        XCTAssertThrowsError(try store.importAccounts(duplicate, selected: Set(duplicate.candidates.map(\.id)), activeAccounts: []))
        let invalid = try store.reviewImport(importLink([valid.merging(["username": "injected\r\nheader"], uniquingKeysWith: { _, b in b }), valid.merging(["password": "a\0b"], uniquingKeysWith: { _, b in b })]))
        XCTAssertTrue(invalid.candidates.allSatisfy { !$0.isValid })
        XCTAssertThrowsError(try store.reviewImport(importLink(Array(repeating: valid, count: 17))))
        for i in 0..<16 { try store.save(SIPAccount(profileID: UUID(), username: String(i), domain: "existing.invalid"), password: "fixture") }
        let full = try store.reviewImport(importLink([valid]))
        XCTAssertThrowsError(try store.importAccounts(full, selected: Set(full.candidates.map(\.id)), activeAccounts: []))
        XCTAssertEqual(store.entries.count, 16)
    }
    func testPersonalAccountsRoundTripOnlyThroughSecureStorage() throws {
        let secrets = TestSecretStore()
        let store = try MobileAccountStore(storage: secrets)
        let account = SIPAccount(profileID: UUID(), username: "100", domain: "pbx.example.invalid", transport: .tls)
        try store.save(account, password: "synthetic-password")
        let restored = try MobileAccountStore(storage: secrets)
        XCTAssertEqual(restored.entries.first?.account, account)
        XCTAssertEqual(restored.entries.first?.password, "synthetic-password")
        XCTAssertEqual(Set(secrets.values.keys), ["manual-accounts"])
        try restored.remove(account.id)
        XCTAssertTrue(try MobileAccountStore(storage: secrets).entries.isEmpty)
    }
    func testStorageFailureDoesNotReplaceOrRemoveActiveCredentials() throws {
        let secrets = TestSecretStore()
        let store = try MobileAccountStore(storage: secrets)
        var account = SIPAccount(profileID: UUID(), username: "100", domain: "pbx.example.invalid")
        try store.save(account, password: "old-synthetic-password")
        secrets.failWrites = true
        account.domain = "other.example.invalid"
        XCTAssertThrowsError(try store.save(account, password: "new-synthetic-password"))
        XCTAssertEqual(store.entries.first?.account.domain, "pbx.example.invalid")
        XCTAssertEqual(store.entries.first?.password, "old-synthetic-password")
        XCTAssertThrowsError(try store.remove(account.id))
        XCTAssertEqual(store.entries.count, 1)
    }
    @MainActor
    func testDiallingPreservesSIPAddressesAndRejectsNumbersThatWouldBeSilentlyChanged() throws {
        let account = SIPAccount(profileID: UUID(), username: "100", domain: "pbx.example.invalid", transport: .udp)
        XCTAssertEqual(try CallKitBridge.destination("+44 (20) 1234-5678", account: account), "sip:+442012345678@pbx.example.invalid;transport=udp")
        XCTAssertEqual(try CallKitBridge.destination("*97", account: account), "sip:*97@pbx.example.invalid;transport=udp")
        XCTAssertEqual(try CallKitBridge.destination("reception@pbx.example.invalid", account: account), "sip:reception@pbx.example.invalid")
        XCTAssertEqual(try CallKitBridge.destination("sip:*echo@pbx.example.invalid", account: account), "sip:*echo@pbx.example.invalid")
        for invalid in ["", "...", "*echo", "123ext45", "sip:100@pbx.example.invalid\r\nInjected: yes"] {
            XCTAssertThrowsError(try CallKitBridge.destination(invalid, account: account))
        }
        // Some standalone providers authenticate by network rather than a SIP password.
        XCTAssertNoThrow(try MobileAccountStore.validate(account, password: ""))
    }
    func testManagedAccountsAndMalformedSIPInputCannotBeSavedAsPersonal() throws {
        var account = SIPAccount(profileID: UUID(), username: "100", domain: "pbx.example.invalid")
        account.managed = ManagedAccountBinding(organisationID: UUID(), deviceID: UUID(), accountID: UUID(), expiresAt: Date().addingTimeInterval(60))
        XCTAssertThrowsError(try MobileAccountStore.validate(account, password: "synthetic"))
        account.managed = nil
        account.username = "100@other.example.invalid;transport=udp"
        XCTAssertThrowsError(try MobileAccountStore.validate(account, password: "synthetic"))
        account.username = "100"
        account.domain = "pbx.example.invalid\r\nInjected: true"
        XCTAssertThrowsError(try MobileAccountStore.validate(account, password: "synthetic"))
        account.domain = "pbx.example.invalid"
        account.port = 65536
        XCTAssertThrowsError(try MobileAccountStore.validate(account, password: "synthetic"))
    }
    func testCallKitIDsCannotControlAReusedSIPCallID() {
        var calls = MobileCallIDs()
        let previous = UUID(), current = UUID()
        var call = CallSnapshot(id: 1, accountID: UUID(), direction: .outgoing, state: .confirmed,
            remoteURI: "sip:100@sipper.test", remoteNumber: "100", remoteName: "",
            isMuted: false, isOnHold: false, isRemoteHold: false, hasActiveMedia: true,
            startedAt: Date(), connectedAt: Date(), endedAt: nil, lastStatusCode: 200, lastStatusText: "OK")
        calls.bind(previous, to: call)
        let original = call
        call.startedAt = call.startedAt.addingTimeInterval(1)
        XCTAssertEqual(calls.call(previous)?.startedAt, original.startedAt, "The system action retains its captured identity until a new bind")
        calls.bind(current, to: call)
        XCTAssertNil(calls.sipID(previous))
        XCTAssertNil(calls.call(previous))
        XCTAssertEqual(calls.call(current)?.startedAt, call.startedAt)
        XCTAssertEqual(calls.sipID(current), 1)
        calls.remove(previous)
        XCTAssertEqual(calls.uuid(1), current)
        calls.remove(current)
        XCTAssertNil(calls.uuid(1))
    }
    @MainActor
    func testGatewayDiallingCannotOverrideItsProxyOrTransport() throws {
        var account = SIPAccount(profileID: UUID(), username: "fixture", domain: "gateway.example.invalid", transport: .tls, srtp: .mandatory)
        account.managed = ManagedAccountBinding(organisationID: UUID(), deviceID: UUID(), accountID: UUID(), expiresAt: Date().addingTimeInterval(60), mode: .gateway)
        XCTAssertEqual(try CallKitBridge.destination("+44 (20) 1234-5678", account: account), "sip:+442012345678@gateway.example.invalid;transport=tls")
        XCTAssertEqual(try CallKitBridge.destination("*97", account: account), "sip:*97@gateway.example.invalid;transport=tls")
        for value in ["sip:100@other.example.invalid", "100@other.example.invalid", "100;transport=udp", "100?Route=bad", "A100", "", String(repeating: "1", count: 129)] {
            XCTAssertThrowsError(try CallKitBridge.destination(value, account: account))
        }
    }
}

private final class TestSecretStore: ManagedSecretStore {
    var values: [String: Data] = [:]
    var failWrites = false
    func read(_ key: String) throws -> Data? { values[key] }
    func write(_ data: Data, key: String) throws {
        if failWrites { throw ManagedError.storageUnavailable }
        values[key] = data
    }
    func remove(_ key: String) throws { values[key] = nil }
}
