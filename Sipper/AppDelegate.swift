import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let state = AppState(startEngine: false)
    private var menuBar: MenuBarController?

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
        state.startEngineIfNeeded()
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
