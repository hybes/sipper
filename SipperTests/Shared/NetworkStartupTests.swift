import XCTest
#if os(macOS)
@testable import Sipper
#else
@testable import SipperIOS
#endif

@MainActor
final class NetworkStartupTests: XCTestCase {
    func testInitialNetworkSnapshotPreservesAnOutgoingCallAndLaterChangesRecover() async throws {
        guard ProcessInfo.processInfo.environment["SIPPER_TEST_DIRECT_DND"] == "127.0.0.1" else {
            throw XCTSkip("Requires the isolated direct registrar")
        }
        for initiallyAvailable in [true, false] {
            #if os(macOS)
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("Sipper-Network-Test-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: directory) }
            let state = AppState(store: PersistenceStore(directory: directory), passwords: InMemoryPasswordStore(), startEngine: false)
            #else
            let state = MobileState()
            #endif
            let engine = state.engine
            try engine.useNullAudioForTesting()
            var settings = AppSettings(); settings.sipLogLevel = 0
            try engine.start(settings: settings)
            defer { engine.stop() }
            // Only the native engine is seeded, so no personal account or Keychain item is touched.
            let account = SIPAccount(profileID: UUID(), username: "dnd-user", domain: "sipper.test", server: "127.0.0.1", port: 5098)
            engine.syncAccounts([(account, "fictional-dnd")])
            func until(_ check: () -> Bool) async throws {
                for _ in 0..<120 { if check() { return }; try await Task.sleep(for: .milliseconds(25)) }
                throw NSError(domain: "NetworkStartupTests", code: 1)
            }
            try await until { engine.currentRegistration(accountID: account.id).isRegistered }
            if !initiallyAvailable {
                state.networkPathChanged(available: false)
                try await until { engine.currentRegistration(accountID: account.id).isFailed }
                state.networkPathChanged(available: true)
                try await until { engine.currentRegistration(accountID: account.id).isRegistered }
            }
            let call = try engine.makeCall(accountID: account.id, uri: account.callURI(for: "*97"))
            if initiallyAvailable { state.networkPathChanged(available: true) }
            try await Task.sleep(for: .milliseconds(1200))
            XCTAssertEqual(engine.activeCalls().first { $0.id == call.id && $0.startedAt == call.startedAt }?.state, .confirmed,
                           "The initial connected snapshot must not invoke PJSIP recovery and cancel a ringing outgoing call")
            state.networkPathChanged(available: false)
            try await until { engine.currentRegistration(accountID: account.id).isFailed }
            state.networkPathChanged(available: true)
            try await until { engine.currentRegistration(accountID: account.id).isRegistered }
            XCTAssertTrue(engine.activeCalls().contains { $0.id == call.id && $0.startedAt == call.startedAt && $0.state == .confirmed })
            engine.hangup(call)
            try await until { engine.activeCalls().isEmpty }
        }
    }
}
