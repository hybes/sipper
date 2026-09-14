import SwiftUI

struct SipperApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Window("Sipper", id: "main") {
            MainWindow()
                .environmentObject(appDelegate.state)
                .frame(minWidth: 820, minHeight: 520)
        }
        .defaultSize(width: 1000, height: 660)
        .commands {
            SipperCommands(state: appDelegate.state)
        }

        Settings {
            SettingsView()
                .environmentObject(appDelegate.state)
        }
    }
}
