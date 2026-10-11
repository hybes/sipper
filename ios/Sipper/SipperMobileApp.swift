import SwiftUI
import UserNotifications
import SipperManaged

final class MobileAppDelegate: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
    lazy var state = MobileState()
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        _ = state // PushKit must exist on a background launch before any scene is created.
        UNUserNotificationCenter.current().delegate = self
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) { state.messagePushToken(deviceToken) }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) { state.messagePushToken(nil) }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completion: @escaping (UNNotificationPresentationOptions) -> Void) {
        guard let hint = ManagedMessageNotification.parse(apns: notification.request.content.userInfo), state.ownsMessageNotification(hint) else { completion([]); return }
        completion([.banner, .sound])
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completion: @escaping () -> Void) {
        if let hint = ManagedMessageNotification.parse(apns: response.notification.request.content.userInfo, forRouting: true) { state.openMessageNotification(hint) }
        completion()
    }
}

@main
struct SipperMobileApp: App {
    @UIApplicationDelegateAdaptor(MobileAppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var scene
    var body: some Scene {
        WindowGroup {
            MobileRootView().environmentObject(delegate.state)
                .tint(Color(red: 0.15, green: 0.50, blue: 0.54))
                .onChange(of: scene) { delegate.state.foreground($0 == .active) }
                .onOpenURL { delegate.state.handle(url: $0) }
        }
    }
}
