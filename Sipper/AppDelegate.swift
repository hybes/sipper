import AppKit
import SwiftUI
import CryptoKit
import Network

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let state: AppState = {
        let environment = ProcessInfo.processInfo.environment
        if NSClassFromString("XCTestCase") != nil || environment["XCTestConfigurationFilePath"] != nil {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("Sipper-TestHost-\(UUID().uuidString)")
            return AppState(store: PersistenceStore(directory: directory), passwords: InMemoryPasswordStore(), startEngine: false)
        }
        #if DEBUG
        if let path = DevelopmentEnvironment.profileDirectory {
            let suffix = SHA256.hash(data: Data(path.utf8)).map { String(format: "%02x", $0) }.joined()
            let engine = SIPEngine()
            // Virtual audio for isolated UI checks; microphone authorisation still follows the normal app flow.
            if environment["SIPPER_NULL_AUDIO"] == "1" { try? engine.useNullAudioForTesting() }
            return AppState(store: PersistenceStore(directory: URL(fileURLWithPath: path)),
                passwords: KeychainPasswordStore(service: "com.hybes.sipper.development.\(suffix)"), engine: engine, startEngine: false)
        }
        #endif
        return AppState(startEngine: false)
    }()
    private var menuBar: MenuBarController?
    private let network = NWPathMonitor()
    private var workspaceObservers: [NSObjectProtocol] = []
    private var sleeping = false

    func applicationWillFinishLaunching(_ notification: Notification) {
        // URL scheme events can arrive before didFinishLaunching.
        NSAppleEventManager.shared().setEventHandler(self,
                                                     andSelector: #selector(handleGetURL(_:with:)),
                                                     forEventClass: AEEventClass(kInternetEventClass),
                                                     andEventID: AEEventID(kAEGetURL))
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // The unit-test bundle uses the app as its host; keep the SIP stack off there.
        if NSClassFromString("XCTestCase") != nil { return }
        state.managedAccounts.start(state: state)
        state.startEngineIfNeeded()
        network.pathUpdateHandler = { [weak self] path in
            let available = path.status == .satisfied
            Task { @MainActor in
                guard let self, !self.sleeping else { return }
                self.state.networkPathChanged(available: available)
            }
        }
        network.start(queue: DispatchQueue(label: "com.hybes.sipper.network"))
        let workspace = NSWorkspace.shared.notificationCenter
        workspaceObservers = [
            workspace.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    self?.sleeping = true
                    self?.state.networkChanged(available: false)
                }
            },
            workspace.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.sleeping = false
                    self.state.networkChanged(available: self.network.currentPath.status == .satisfied)
                }
            },
        ]
        if state.settings.showNotifications {
            state.notifications.requestAuthorization { [weak self] granted in
                self?.state.engine.log.append("Sipper: notifications \(granted ? "allowed" : "not allowed")")
            }
        }
        state.notifications.fetchAuthorizationStatus { [weak self] status in
            let name: String
            switch status {
            case .authorized?: name = "authorized"
            case .denied?: name = "denied"
            case .notDetermined?: name = "not determined"
            case .provisional?: name = "provisional"
            default: name = "unavailable"
            }
            self?.state.engine.log.append("Sipper: notification authorization is \(name)")
        }
        menuBar = MenuBarController(state: state)
        if state.settings.startHidden {
            NSApp.windows.first { $0.identifier?.rawValue == "main" }?.orderOut(nil)
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            state.handle(url: url)
        }
    }

    @objc private func handleGetURL(_ event: NSAppleEventDescriptor, with reply: NSAppleEventDescriptor) {
        guard let string = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue,
              let url = URL(string: string) else { return }
        state.handle(url: url)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            showMainWindow()
        }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        network.cancel()
        workspaceObservers.forEach { NSWorkspace.shared.notificationCenter.removeObserver($0) }
        workspaceObservers.removeAll()
        state.shutdown()
        return .terminateNow
    }

    func showMainWindow() {
        NSApp.activate(ignoringOtherApps: true)
        if let window = NSApp.windows.first(where: { $0.identifier?.rawValue == "main" }) {
            window.makeKeyAndOrderFront(nil)
        } else {
            // The SwiftUI Window scene recreates itself when asked to open.
            NSApp.sendAction(Selector(("newWindowForTab:")), to: nil, from: nil)
        }
    }
}
