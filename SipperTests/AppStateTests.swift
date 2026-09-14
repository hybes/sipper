import XCTest
@testable import Sipper

/// Exercises AppState against a temporary store, an in-memory password store and an
/// engine that is never started (so nothing touches pjsua or the network).
@MainActor
final class AppStateTests: XCTestCase {
    private struct Harness {
        let state: AppState
        let directory: URL
        let passwords: InMemoryPasswordStore
    }

    private func makeHarness(directory: URL? = nil, passwords: InMemoryPasswordStore? = nil) -> Harness {
        let directory = directory ?? TestSupport.makeTemporaryDirectory(for: self)
        let passwords = passwords ?? InMemoryPasswordStore()
        let state = AppState(store: PersistenceStore(directory: directory),
                             passwords: passwords,
                             engine: SIPEngine(),
                             startEngine: false)
        // Keep the test run quiet: a ringing call would otherwise play audio.
        state.settings.ringtone = .silent
        return Harness(state: state, directory: directory, passwords: passwords)
    }

    private func draft(_ username: String, domain: String = "pbx.example.com", profileID: UUID, label: String = "") -> SIPAccount {
        SIPAccount(profileID: profileID, label: label, username: username, domain: domain)
    }

    private func importRequest(_ accountsJSON: String, provider: String = "fusionpbx") throws -> ImportRequest {
        try ImportParser.parse(json: Data(#"{"version":1,"source":{"provider":"\#(provider)"},"accounts":[\#(accountsJSON)]}"#.utf8))
    }

    /// Delegate callbacks hop to the main actor asynchronously; wait for their effect.
    private func expectEventually(file: StaticString = #filePath, line: UInt = #line,
                                  _ condition: @escaping @MainActor () -> Bool) async {
        let satisfied = await TestSupport.waitUntil(condition)
        XCTAssertTrue(satisfied, "timed out waiting for the main-actor update", file: file, line: line)
    }

    // MARK: First launch and loading

    func testFirstLaunchCreatesTheDefaultProfile() {
        let h = makeHarness()
        XCTAssertEqual(h.state.profiles.count, 1)
        XCTAssertEqual(h.state.profiles[0].name, Profile.defaultName)
        XCTAssertTrue(h.state.profiles[0].isEnabled)
        XCTAssertTrue(h.state.accounts.isEmpty)
        XCTAssertTrue(h.state.history.isEmpty)
        XCTAssertTrue(h.state.contacts.isEmpty)
        XCTAssertNil(h.state.dialerAccountID)
        XCTAssertFalse(h.state.engineIsRunning)
        XCTAssertEqual(h.state.unseenMissedCalls, 0)
        XCTAssertNil(h.state.pendingImport)
    }

    func testOrphanedAccountsAreAdoptedByTheDefaultProfile() throws {
        let directory = TestSupport.makeTemporaryDirectory(for: self)
        let store = PersistenceStore(directory: directory)
        let orphan = SIPAccount(profileID: UUID(), username: "1001", domain: "pbx.example.com")
        try store.save([orphan], to: StoreFile.accounts)

        let h = makeHarness(directory: directory)
        XCTAssertEqual(h.state.accounts.map(\.id), [orphan.id])
        XCTAssertEqual(h.state.accounts[0].profileID, h.state.profiles[0].id)
        XCTAssertEqual(h.state.dialerAccountID, orphan.id, "the first enabled account becomes the dialer account")
    }

    func testStateSurvivesARestartThroughTheStore() throws {
        let first = makeHarness()
        let work = first.state.addProfile(name: "Work", color: .green)
        let account = try first.state.addAccount(draft("1001", profileID: work.id, label: "Desk"), password: "pw")
        let disabled = try first.state.addAccount(draft("1002", profileID: work.id), password: "pw2")
        first.state.setAccountEnabled(disabled.id, enabled: false)
        let contact = first.state.addContact(Contact(name: "Alice", numbers: [ContactNumber(number: "2001")]))
        first.state.settings.ringVolume = 0.25
        first.state.settings.lastUsedAccountID = account.id
        first.state.flush()

        let second = makeHarness(directory: first.directory, passwords: first.passwords)
        XCTAssertEqual(second.state.profiles.map(\.name), [Profile.defaultName, "Work"])
        XCTAssertEqual(second.state.accounts.map(\.id), [account.id, disabled.id])
        XCTAssertEqual(second.state.account(for: account.id)?.label, "Desk")
        XCTAssertEqual(second.state.account(for: disabled.id)?.isEnabled, false)
        XCTAssertEqual(second.state.contacts.map(\.id), [contact.id])
        XCTAssertEqual(second.state.settings.ringVolume, 0.25)
        XCTAssertEqual(second.state.dialerAccountID, account.id)
        XCTAssertEqual(second.state.password(for: account.id), "pw")
    }

    // MARK: Profiles

    func testAddProfileAssignsIncreasingSortOrderAndTrimsNames() {
        let h = makeHarness()
        let work = h.state.addProfile(name: "  Work  ", color: .orange, icon: "briefcase")
        XCTAssertEqual(work.name, "Work")
        XCTAssertEqual(work.colorName, .orange)
        XCTAssertEqual(work.iconName, "briefcase")
        XCTAssertEqual(work.sortOrder, 1)
        XCTAssertEqual(h.state.addProfile(name: "   ").name, "Profile")
        XCTAssertEqual(h.state.profiles.map(\.sortOrder), [0, 1, 2])
        XCTAssertEqual(h.state.profile(for: work.id)?.name, "Work")
    }

    func testDeleteProfileMovesAccountsToTheDestination() throws {
        let h = makeHarness()
        let personal = h.state.profiles[0]
        let work = h.state.addProfile(name: "Work")
        let moved = try h.state.addAccount(draft("2001", domain: "work.example.com", profileID: work.id), password: "pw")

        h.state.deleteProfile(work.id, moveAccountsTo: personal.id)

        XCTAssertEqual(h.state.profiles.map(\.id), [personal.id])
        XCTAssertEqual(h.state.account(for: moved.id)?.profileID, personal.id)
        XCTAssertEqual(h.passwords.password(for: moved.id), "pw", "moving keeps the password")
        XCTAssertEqual(h.state.accounts(in: personal.id).map(\.id), [moved.id])
    }

    func testDeleteProfileWithoutDestinationDeletesItsAccounts() throws {
        let h = makeHarness()
        let personal = h.state.profiles[0]
        let old = h.state.addProfile(name: "Old")
        let kept = try h.state.addAccount(draft("1001", profileID: personal.id), password: "keep")
        let gone = try h.state.addAccount(draft("3001", domain: "old.example.com", profileID: old.id), password: "pw3")
        h.state.selection = .profile(old.id)

        h.state.deleteProfile(old.id, moveAccountsTo: nil)

        XCTAssertEqual(h.state.profiles.map(\.id), [personal.id])
        XCTAssertNil(h.state.account(for: gone.id))
        XCTAssertNil(h.passwords.password(for: gone.id), "deleting an account removes its password")
        XCTAssertEqual(h.state.account(for: kept.id)?.id, kept.id)
        XCTAssertEqual(h.state.selection, .dialer, "selection leaves the deleted profile")
    }

    func testDeleteProfileFallsBackToDeletingWhenDestinationIsUnknown() throws {
        let h = makeHarness()
        let old = h.state.addProfile(name: "Old")
        let gone = try h.state.addAccount(draft("3001", profileID: old.id), password: "pw")
        h.state.deleteProfile(old.id, moveAccountsTo: UUID())
        XCTAssertNil(h.state.account(for: gone.id))
    }

    func testTheLastProfileCannotBeDeleted() throws {
        let h = makeHarness()
        let only = h.state.profiles[0]
        let account = try h.state.addAccount(draft("1001", profileID: only.id), password: "pw")
        h.state.deleteProfile(only.id, moveAccountsTo: nil)
        XCTAssertEqual(h.state.profiles.map(\.id), [only.id])
        XCTAssertNotNil(h.state.account(for: account.id))
    }

    func testMoveProfilesRewritesSortOrder() {
        let h = makeHarness()
        let a = h.state.profiles[0]
        let b = h.state.addProfile(name: "B")
        let c = h.state.addProfile(name: "C")
        h.state.moveProfiles(fromOffsets: IndexSet(integer: 2), toOffset: 0)
        XCTAssertEqual(h.state.profiles.map(\.id), [c.id, a.id, b.id])
        XCTAssertEqual(h.state.profiles.map(\.sortOrder), [0, 1, 2])
    }

    // MARK: Accounts

    func testAddAccountStoresPasswordAssignsSortOrderAndSelectsDialerAccount() throws {
        let h = makeHarness()
        let profile = h.state.profiles[0]

        let first = try h.state.addAccount(draft("1001", profileID: profile.id), password: "s3cret")
        XCTAssertEqual(h.passwords.password(for: first.id), "s3cret")
        XCTAssertEqual(h.state.password(for: first.id), "s3cret")
        XCTAssertEqual(first.sortOrder, 0)
        XCTAssertEqual(h.state.dialerAccountID, first.id)

        let second = try h.state.addAccount(draft("1002", profileID: UUID()), password: "other")
        XCTAssertEqual(second.profileID, profile.id, "an unknown profile id is replaced by the first profile")
        XCTAssertEqual(second.sortOrder, 1)
        XCTAssertEqual(h.state.dialerAccountID, first.id, "the dialer account does not change once set")
        XCTAssertEqual(h.state.accounts.map(\.id), [first.id, second.id])

        let work = h.state.addProfile(name: "Work")
        let third = try h.state.addAccount(draft("2001", profileID: work.id), password: "x")
        XCTAssertEqual(third.sortOrder, 0, "sort order is per profile")
        XCTAssertEqual(h.state.accounts(in: work.id).map(\.id), [third.id])
        XCTAssertEqual(h.state.registration(for: third.id), .unregistered)
    }

    func testDuplicateAccountDetectionIgnoresDomainCase() throws {
        let h = makeHarness()
        let account = try h.state.addAccount(draft("1001", profileID: h.state.profiles[0].id), password: "pw")

        XCTAssertEqual(h.state.duplicateAccount(username: "1001", domain: "PBX.Example.COM")?.id, account.id)
        XCTAssertNil(h.state.duplicateAccount(username: "1001", domain: "other.example.com"))
        XCTAssertNil(h.state.duplicateAccount(username: "1002", domain: "pbx.example.com"))
        XCTAssertNil(h.state.duplicateAccount(username: "1001", domain: "pbx.example.com", excluding: account.id),
                     "an account is not its own duplicate when editing")
    }

    func testUpdateAccountReplacesFieldsAndOptionallyThePassword() throws {
        let h = makeHarness()
        var account = try h.state.addAccount(draft("1001", profileID: h.state.profiles[0].id), password: "old")
        account.label = "Renamed"
        account.transport = .tls
        try h.state.updateAccount(account, password: nil)
        XCTAssertEqual(h.state.account(for: account.id)?.label, "Renamed")
        XCTAssertEqual(h.state.account(for: account.id)?.transport, .tls)
        XCTAssertEqual(h.passwords.password(for: account.id), "old", "nil keeps the stored password")

        try h.state.updateAccount(account, password: "new")
        XCTAssertEqual(h.passwords.password(for: account.id), "new")
    }

    func testDeleteAccountClearsPasswordAndMovesDialerSelection() throws {
        let h = makeHarness()
        let profile = h.state.profiles[0]
        let first = try h.state.addAccount(draft("1001", profileID: profile.id), password: "a")
        let second = try h.state.addAccount(draft("1002", profileID: profile.id), password: "b")
        h.state.selection = .account(first.id)

        h.state.deleteAccount(first.id)

        XCTAssertEqual(h.state.accounts.map(\.id), [second.id])
        XCTAssertNil(h.passwords.password(for: first.id))
        XCTAssertEqual(h.state.dialerAccountID, second.id)
        XCTAssertEqual(h.state.selection, .dialer)
    }

    func testMoveAccountBetweenProfiles() throws {
        let h = makeHarness()
        let personal = h.state.profiles[0]
        let work = h.state.addProfile(name: "Work")
        _ = try h.state.addAccount(draft("2000", profileID: work.id), password: "x")
        let account = try h.state.addAccount(draft("1001", profileID: personal.id), password: "x")

        h.state.moveAccount(account.id, to: work.id)
        XCTAssertEqual(h.state.account(for: account.id)?.profileID, work.id)
        XCTAssertEqual(h.state.account(for: account.id)?.sortOrder, 1, "appended after the existing member")

        h.state.moveAccount(account.id, to: UUID())
        XCTAssertEqual(h.state.account(for: account.id)?.profileID, work.id, "unknown destinations are ignored")
    }

    // MARK: Import

    func testCommitImportIntoANewProfileCreatesProfileAndAccounts() throws {
        let h = makeHarness()
        let request = try importRequest(#"""
            {"username":"1001","domain":"pbx.example.com","password":"a","label":"Alex"},
            {"username":"1002","domain":"pbx.example.com","password":"b","transport":"tls"}
        """#)

        let imported = h.state.commitImport(request, selected: Set(request.candidates.map(\.id)), profile: .new("PBX"))

        XCTAssertEqual(imported, 2)
        let profile = try XCTUnwrap(h.state.profiles.first { $0.name == "PBX" })
        XCTAssertNotEqual(profile.colorName, h.state.profiles[0].colorName, "a fresh profile gets an unused colour")
        let accounts = h.state.accounts(in: profile.id)
        XCTAssertEqual(accounts.map(\.username), ["1001", "1002"])
        XCTAssertEqual(accounts.map(\.sortOrder), [0, 1])
        XCTAssertEqual(accounts.map(\.source), ["fusionpbx", "fusionpbx"])
        XCTAssertEqual(accounts.map { h.passwords.password(for: $0.id) }, ["a", "b"])
        XCTAssertEqual(h.state.selection, .profile(profile.id))
        XCTAssertNil(h.state.pendingImport)
        XCTAssertNil(h.state.alert)
    }

    func testCommitImportSkipsUnselectedAndInvalidCandidates() throws {
        let h = makeHarness()
        let request = try importRequest(#"""
            {"username":"1001","domain":"pbx.example.com","password":"a"},
            {"username":"1002","domain":"pbx.example.com","password":"b"},
            {"username":"1003","domain":"pbx.example.com","password":""}
        """#)
        let selected: Set<UUID> = [request.candidates[0].id, request.candidates[2].id]

        let imported = h.state.commitImport(request, selected: selected, profile: .existing(h.state.profiles[0].id))

        XCTAssertEqual(imported, 1)
        XCTAssertEqual(h.state.accounts.map(\.username), ["1001"])
        XCTAssertEqual(h.state.profiles.count, 1, "importing into an existing profile creates none")
    }

    func testCommitImportIntoUnknownExistingProfileFallsBackToTheFirst() throws {
        let h = makeHarness()
        let request = try importRequest(#"{"username":"1001","domain":"pbx.example.com","password":"a"}"#)
        h.state.commitImport(request, selected: Set(request.candidates.map(\.id)), profile: .existing(UUID()))
        XCTAssertEqual(h.state.accounts.first?.profileID, h.state.profiles[0].id)
    }

    func testCommitImportUpdatesDuplicatesInPlace() throws {
        let h = makeHarness()
        let personal = h.state.profiles[0]
        var original = draft("1001", profileID: personal.id, label: "Desk")
        original.notes = "keep me"
        original.isEnabled = false
        let existing = try h.state.addAccount(original, password: "old")
        let other = h.state.addProfile(name: "Other")

        var request = try importRequest(#"{"username":"1001","domain":"PBX.example.com","password":"new","transport":"tls","server":"edge.example.com","port":5080,"displayName":"Alex"}"#)
        request.candidates[0].existingAccountID = existing.id
        XCTAssertTrue(request.candidates[0].isUpdate)

        let imported = h.state.commitImport(request, selected: [request.candidates[0].id], profile: .existing(other.id))

        XCTAssertEqual(imported, 1)
        XCTAssertEqual(h.state.accounts.count, 1, "no second account is created")
        let updated = try XCTUnwrap(h.state.account(for: existing.id))
        XCTAssertEqual(updated.id, existing.id)
        XCTAssertEqual(updated.profileID, personal.id, "the account stays in its profile")
        XCTAssertEqual(updated.label, "Desk", "a label is kept when the import has none")
        XCTAssertEqual(updated.notes, "keep me")
        XCTAssertEqual(updated.domain, "pbx.example.com", "the stored domain is not rewritten")
        XCTAssertEqual(updated.displayName, "Alex")
        XCTAssertEqual(updated.transport, .tls)
        XCTAssertEqual(updated.server, "edge.example.com")
        XCTAssertEqual(updated.port, 5080)
        XCTAssertTrue(updated.isEnabled, "re-importing re-enables the account")
        XCTAssertEqual(h.passwords.password(for: existing.id), "new")
    }

    func testHandleURLAnnotatesDuplicatesAndPresentsTheImport() throws {
        let h = makeHarness()
        let existing = try h.state.addAccount(draft("1001", profileID: h.state.profiles[0].id), password: "old")
        let json = #"{"version":1,"accounts":[{"username":"1001","domain":"PBX.EXAMPLE.COM","password":"x"},{"username":"1002","domain":"pbx.example.com","password":"y"}]}"#
        let url = try XCTUnwrap(ImportParser.makeURL(jsonData: Data(json.utf8)))

        h.state.handle(url: url)

        let pending = try XCTUnwrap(h.state.pendingImport)
        XCTAssertEqual(pending.candidates.map(\.existingAccountID), [existing.id, nil])
        XCTAssertNil(h.state.alert)

        h.state.cancelImport()
        XCTAssertNil(h.state.pendingImport)
    }

    func testHandleURLReportsProblemsAsAlerts() throws {
        let h = makeHarness()
        h.state.handle(url: URL(string: "sipper://unknown-action")!)
        XCTAssertEqual(h.state.alert?.title, "Unsupported link")
        XCTAssertNil(h.state.pendingImport)

        h.state.alert = nil
        let badPayload = try XCTUnwrap(ImportParser.makeURL(jsonData: Data("{}".utf8)))
        h.state.handle(url: badPayload)
        XCTAssertEqual(h.state.alert?.title, "Import failed")
        XCTAssertTrue(h.state.alert?.message.contains("version") == true, "the alert should carry the parser detail")
        XCTAssertNil(h.state.pendingImport)
    }

    // MARK: Outcomes

    func testOutcomeMapping() {
        let h = makeHarness()
        let accountID = UUID()
        func outgoing(_ code: Int) -> CallOutcome {
            h.state.outcome(for: CallSnapshot.fixture(accountID: accountID, direction: .outgoing, state: .disconnected, statusCode: code))
        }
        XCTAssertEqual(outgoing(486), .busy)
        XCTAssertEqual(outgoing(600), .busy)
        XCTAssertEqual(outgoing(480), .noAnswer)
        XCTAssertEqual(outgoing(408), .noAnswer)
        XCTAssertEqual(outgoing(487), .cancelled)
        XCTAssertEqual(outgoing(603), .declined)
        XCTAssertEqual(outgoing(403), .declined)
        XCTAssertEqual(outgoing(500), .failed)
        XCTAssertEqual(outgoing(404), .failed)
        XCTAssertEqual(outgoing(0), .failed)

        let connected = CallSnapshot.fixture(accountID: accountID, direction: .outgoing, state: .disconnected,
                                             connectedAt: Date(), statusCode: 486)
        XCTAssertEqual(h.state.outcome(for: connected), .completed, "a connected call is completed whatever the final code")

        let incoming = CallSnapshot.fixture(id: 9, accountID: accountID, direction: .incoming, state: .disconnected, statusCode: 487)
        XCTAssertEqual(h.state.outcome(for: incoming), .missed)
        XCTAssertEqual(h.state.outcome(for: CallSnapshot.fixture(id: 9, accountID: accountID, connectedAt: Date())), .completed)
    }

    // MARK: History

    func testUnansweredIncomingCallIsRecordedAsMissed() async throws {
        let h = makeHarness()
        let account = try h.state.addAccount(draft("1001", profileID: h.state.profiles[0].id), password: "pw")
        h.state.addContact(Contact(name: "Alice", numbers: [ContactNumber(number: "020 7946 0958")]))
        let ringing = CallSnapshot.fixture(id: 7, accountID: account.id, remoteNumber: "02079460958")

        h.state.sipEngine(h.state.engine, didReceiveIncomingCall: ringing)
        await expectEventually { h.state.calls.count == 1 }

        XCTAssertEqual(h.state.calls[0].remoteName, "Alice", "the caller is resolved against contacts")
        XCTAssertEqual(h.state.selectedCallID, 7)
        XCTAssertEqual(h.state.activeCall?.id, 7)
        XCTAssertTrue(h.state.hasActiveCalls)
        XCTAssertEqual(h.state.history.count, 1, "a record is opened as soon as the call rings")
        XCTAssertEqual(h.state.history[0].direction, .incoming)
        XCTAssertNil(h.state.history[0].endedAt)
        XCTAssertEqual(h.state.unseenMissedCalls, 0)

        h.state.sipEngine(h.state.engine, callDidEnd: ringing.ended(statusCode: 487, statusText: "Request Terminated"))
        await expectEventually { h.state.calls.isEmpty }

        XCTAssertEqual(h.state.history.count, 1, "the open record is completed, not duplicated")
        let record = h.state.history[0]
        XCTAssertEqual(record.accountID, account.id)
        XCTAssertEqual(record.outcome, .missed)
        XCTAssertTrue(record.wasMissed)
        XCTAssertEqual(record.remoteNumber, "02079460958")
        XCTAssertEqual(record.remoteName, "Alice")
        XCTAssertEqual(record.statusCode, 487)
        XCTAssertEqual(record.statusText, "Request Terminated")
        XCTAssertNotNil(record.endedAt)
        XCTAssertNil(record.connectedAt)
        XCTAssertEqual(h.state.unseenMissedCalls, 1)
        XCTAssertNil(h.state.selectedCallID)
        XCTAssertEqual(h.state.lastEndedCall?.id, 7)
        XCTAssertFalse(h.state.hasActiveCalls)

        h.state.markMissedCallsSeen()
        XCTAssertEqual(h.state.unseenMissedCalls, 0)
    }

    func testDeclinedIncomingCallIsRecordedAsDeclinedNotMissed() async throws {
        let h = makeHarness()
        let account = try h.state.addAccount(draft("1001", profileID: h.state.profiles[0].id), password: "pw")
        let ringing = CallSnapshot.fixture(id: 11, accountID: account.id, remoteNumber: "2001")

        h.state.sipEngine(h.state.engine, didReceiveIncomingCall: ringing)
        await expectEventually { h.state.calls.count == 1 }

        h.state.decline(callID: 11) // engine.hangup is a no-op while the engine is stopped
        XCTAssertEqual(h.state.outcome(for: ringing), .declined)
        XCTAssertTrue(h.state.hasActiveCalls, "the call only leaves the list when the engine reports it ended")

        h.state.sipEngine(h.state.engine, callDidEnd: ringing.ended(statusCode: 486, statusText: "Busy Here"))
        await expectEventually { h.state.calls.isEmpty }

        XCTAssertEqual(h.state.history.count, 1)
        XCTAssertEqual(h.state.history[0].outcome, .declined)
        XCTAssertFalse(h.state.history[0].wasMissed)
        XCTAssertEqual(h.state.unseenMissedCalls, 0, "declining is not a missed call")
        XCTAssertEqual(h.state.outcome(for: ringing), .missed, "the decline marker is cleared once the call has ended")
    }

    func testHangUpActiveCallDeclinesARingingCall() async throws {
        let h = makeHarness()
        let account = try h.state.addAccount(draft("1001", profileID: h.state.profiles[0].id), password: "pw")
        let ringing = CallSnapshot.fixture(id: 12, accountID: account.id)
        h.state.sipEngine(h.state.engine, didReceiveIncomingCall: ringing)
        await expectEventually { h.state.calls.count == 1 }

        h.state.hangupActiveCall()
        XCTAssertEqual(h.state.outcome(for: ringing), .declined)

        h.state.sipEngine(h.state.engine, callDidEnd: ringing.ended())
        await expectEventually { h.state.calls.isEmpty }
        XCTAssertEqual(h.state.history.first?.outcome, .declined)
    }

    func testDoNotDisturbRejectsTheCallAndRecordsItAsDeclined() async throws {
        let h = makeHarness()
        let account = try h.state.addAccount(draft("1001", profileID: h.state.profiles[0].id), password: "pw")
        h.state.toggleDoNotDisturb()
        XCTAssertTrue(h.state.settings.doNotDisturb)
        let ringing = CallSnapshot.fixture(id: 13, accountID: account.id)

        h.state.sipEngine(h.state.engine, didReceiveIncomingCall: ringing)
        await expectEventually { h.state.calls.count == 1 }
        XCTAssertNil(h.state.selectedCallID, "a rejected call is never presented")
        XCTAssertTrue(h.state.history.isEmpty, "no record is opened while the call is being rejected")

        h.state.sipEngine(h.state.engine, callDidEnd: ringing.ended(statusCode: 486))
        await expectEventually { h.state.calls.isEmpty }
        XCTAssertEqual(h.state.history.map(\.outcome), [.declined])
        XCTAssertEqual(h.state.unseenMissedCalls, 0)
    }

    func testConnectedIncomingCallIsCompleted() async throws {
        let h = makeHarness()
        let account = try h.state.addAccount(draft("1001", profileID: h.state.profiles[0].id), password: "pw")
        let ringing = CallSnapshot.fixture(id: 14, accountID: account.id, remoteNumber: "2001")
        h.state.sipEngine(h.state.engine, didReceiveIncomingCall: ringing)
        await expectEventually { h.state.calls.count == 1 }

        var confirmed = ringing
        confirmed.state = .confirmed
        confirmed.connectedAt = Date()
        confirmed.remoteName = "Alice"
        h.state.sipEngine(h.state.engine, callDidChange: confirmed)
        await expectEventually { h.state.calls.first?.state == .confirmed }

        var ended = confirmed.ended(statusCode: 200, statusText: "OK")
        ended.remoteName = ""
        h.state.sipEngine(h.state.engine, callDidEnd: ended)
        await expectEventually { h.state.calls.isEmpty }

        let record = try XCTUnwrap(h.state.history.first)
        XCTAssertEqual(record.outcome, .completed)
        XCTAssertEqual(record.remoteName, "Alice", "the name learnt during the call is kept when the end event lacks it")
        XCTAssertNotNil(record.connectedAt)
        XCTAssertEqual(h.state.unseenMissedCalls, 0)
    }

    func testCallEndWithoutARingEventStillProducesARecord() async throws {
        let h = makeHarness()
        let account = try h.state.addAccount(draft("1001", profileID: h.state.profiles[0].id), password: "pw")
        let snapshot = CallSnapshot.fixture(id: 15, accountID: account.id, direction: .outgoing, state: .disconnected, statusCode: 486)
        h.state.sipEngine(h.state.engine, callDidEnd: snapshot)
        await expectEventually { !h.state.history.isEmpty }
        XCTAssertEqual(h.state.history[0].outcome, .busy)
        XCTAssertEqual(h.state.history[0].direction, .outgoing)
        XCTAssertEqual(h.state.unseenMissedCalls, 0)
    }

    func testHistoryDeletionAndClearing() async throws {
        let h = makeHarness()
        let account = try h.state.addAccount(draft("1001", profileID: h.state.profiles[0].id), password: "pw")
        for id in 1...3 {
            h.state.sipEngine(h.state.engine, callDidEnd: CallSnapshot.fixture(id: id, accountID: account.id, direction: .outgoing, state: .disconnected))
        }
        await expectEventually { h.state.history.count == 3 }

        h.state.deleteHistory(ids: [h.state.history[0].id])
        XCTAssertEqual(h.state.history.count, 2)
        h.state.clearHistory()
        XCTAssertTrue(h.state.history.isEmpty)
    }

    // MARK: Contacts

    func testContactsAreKeptSortedAndLookedUpByNormalisedNumber() {
        let h = makeHarness()
        let bob = h.state.addContact(Contact(name: "Bob", numbers: [ContactNumber(label: "Work", number: "020-7946-0958")]))
        let alice = h.state.addContact(Contact(name: "alice", numbers: [ContactNumber(number: "+44 7700 900123"), ContactNumber(number: "2001")]))
        XCTAssertEqual(h.state.contacts.map(\.name), ["alice", "Bob"], "sorted case-insensitively")

        XCTAssertEqual(h.state.contact(forNumber: "020 7946 0958")?.id, bob.id)
        XCTAssertEqual(h.state.contact(forNumber: "(020) 7946.0958")?.id, bob.id)
        XCTAssertEqual(h.state.contact(forNumber: "+447700900123")?.id, alice.id)
        XCTAssertEqual(h.state.contact(forNumber: "2001")?.id, alice.id, "any of a contact's numbers matches")
        XCTAssertNil(h.state.contact(forNumber: "07700900123"), "a leading + is significant")
        XCTAssertNil(h.state.contact(forNumber: ""))
        XCTAssertNil(h.state.contact(forNumber: " - () "))
        XCTAssertEqual(h.state.contact(for: bob.id)?.name, "Bob")
    }

    func testContactUpdateFavouriteAndDelete() {
        let h = makeHarness()
        let bob = h.state.addContact(Contact(name: "Bob"))
        let alice = h.state.addContact(Contact(name: "Alice"))

        var renamed = bob
        renamed.name = "Aaron"
        h.state.updateContact(renamed)
        XCTAssertEqual(h.state.contacts.map(\.name), ["Aaron", "Alice"], "renaming re-sorts")

        h.state.toggleFavorite(alice.id)
        XCTAssertEqual(h.state.contact(for: alice.id)?.isFavorite, true)
        h.state.toggleFavorite(alice.id)
        XCTAssertEqual(h.state.contact(for: alice.id)?.isFavorite, false)

        var stranger = Contact(name: "Nobody")
        stranger.notes = "never added"
        h.state.updateContact(stranger)
        XCTAssertEqual(h.state.contacts.count, 2, "updating an unknown contact does not insert it")

        h.state.deleteContact(bob.id)
        XCTAssertNil(h.state.contact(for: bob.id))
        XCTAssertEqual(h.state.contacts.map(\.id), [alice.id])
    }

    // MARK: Calls without an engine

    func testCallingWithoutARunningEngineShowsAnAlertInsteadOfDialling() throws {
        let h = makeHarness()
        _ = try h.state.addAccount(draft("1001", profileID: h.state.profiles[0].id), password: "pw")
        h.state.call("2001")
        XCTAssertEqual(h.state.alert?.title, "Cannot place call")
        XCTAssertTrue(h.state.calls.isEmpty)
        XCTAssertTrue(h.state.history.isEmpty)

        h.state.alert = nil
        h.state.call("   ")
        XCTAssertNil(h.state.alert, "blank input is ignored silently")
    }
}
