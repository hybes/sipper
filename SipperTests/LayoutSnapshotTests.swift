import XCTest
import SwiftUI
import SipperManaged
@testable import Sipper

/// Renders the main window and Settings in the managed-only layout to PNG files for visual review.
/// Runs only when TEST_RUNNER_SIPPER_UI_SNAPSHOT_DIR is passed to xcodebuild; normal test runs skip it.
@MainActor
final class LayoutSnapshotTests: XCTestCase {
    /// Offscreen render. cacheDisplay leaves out some materials and list backgrounds, so these
    /// show layout and copy rather than exact appearance.
    private func render<V: View>(_ view: V, size: NSSize, to url: URL) throws {
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: .aqua)
        let host = NSHostingView(rootView: view.background(Color(nsColor: .windowBackgroundColor)))
        host.appearance = NSAppearance(named: .aqua)
        host.frame = NSRect(origin: .zero, size: size)
        window.contentView = host
        window.orderFrontRegardless()
        RunLoop.main.run(until: Date().addingTimeInterval(1.0))
        host.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
        window.orderOut(nil)
    }

    func testRenderManagedOnlyLayout() throws {
        guard let path = ProcessInfo.processInfo.environment["SIPPER_UI_SNAPSHOT_DIR"] else { throw XCTSkip("Set TEST_RUNNER_SIPPER_UI_SNAPSHOT_DIR to render layout snapshots") }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let state = AppState(store: PersistenceStore(directory: TestSupport.makeTemporaryDirectory(for: self)), passwords: InMemoryPasswordStore(), startEngine: false)
        let updater = AppUpdater()
        let settings: [String: Any] = ["username": "201", "authUsername": "", "domain": "pbx.example.invalid", "server": "sip.example.invalid", "port": 5061,
            "transport": "tls", "srtp": "required", "displayName": "Harbour Lane Studio", "voicemailNumber": "*97", "useICE": true, "stunServer": ""]
        let lines = ["Reception", "Sales", "Support"].map { label -> [String: Any] in
            ["id": UUID().uuidString, "label": label, "mode": "direct", "revision": 1, "password": "fictional", "settings": settings]
        }
        let object: [String: Any] = ["schemaVersion": 1, "organisation": ["id": UUID().uuidString, "name": "Harbour Lane Studio"],
            "deviceId": UUID().uuidString, "revision": String(repeating: "a", count: 64),
            "expiresAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)), "accounts": lines]
        let configuration = try ManagedClient.configurationDecoder().decode(ManagedConfiguration.self, from: JSONSerialization.data(withJSONObject: object))

        try render(WelcomeView(managed: state.managedAccounts, sheet: .constant(nil)).environmentObject(state).environmentObject(updater),
                   size: NSSize(width: 700, height: 560), to: directory.appendingPathComponent("mac-welcome.png"))
        try render(GeneralSettingsView().environmentObject(state), size: NSSize(width: 620, height: 900),
                   to: directory.appendingPathComponent("mac-general-settings.png"))
        try state.applyManagedConfiguration(configuration, profileID: UUID())
        XCTAssertTrue(state.isManagedOnly)
        try render(MainWindow().environmentObject(state).environmentObject(updater), size: NSSize(width: 1000, height: 660),
                   to: directory.appendingPathComponent("mac-managed-main.png"))
        try render(SidebarView(sheet: .constant(nil)).environmentObject(state), size: NSSize(width: 280, height: 560),
                   to: directory.appendingPathComponent("mac-managed-sidebar.png"))
        try render(SettingsView().environmentObject(state).environmentObject(updater), size: NSSize(width: 620, height: 560),
                   to: directory.appendingPathComponent("mac-managed-settings.png"))
        try render(GeneralSettingsView().environmentObject(state), size: NSSize(width: 620, height: 1000),
                   to: directory.appendingPathComponent("mac-managed-general-settings.png"))
        try render(AboutSettingsView().environmentObject(updater), size: NSSize(width: 620, height: 400),
                   to: directory.appendingPathComponent("mac-about-settings.png"))
        state.settings.showAdvancedSettings = true
        try render(SettingsView().environmentObject(state).environmentObject(updater), size: NSSize(width: 620, height: 560),
                   to: directory.appendingPathComponent("mac-managed-settings-advanced.png"))
        state.settings.showAdvancedSettings = false
    }
}
