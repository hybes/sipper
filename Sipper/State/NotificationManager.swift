import Foundation
import UserNotifications

protocol NotificationManagerDelegate: AnyObject {
    func notificationManager(_ manager: NotificationManager, didChooseAnswerFor callID: Int)
    func notificationManager(_ manager: NotificationManager, didChooseDeclineFor callID: Int)
    func notificationManagerDidRequestShowApp(_ manager: NotificationManager)
}

/// Incoming and missed call notifications through UNUserNotificationCenter.
final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    weak var delegate: NotificationManagerDelegate?

    static let incomingCategory = "com.hybes.sipper.incoming-call"
    static let missedCategory = "com.hybes.sipper.missed-call"
    static let answerAction = "answer"
    static let declineAction = "decline"

    /// UNUserNotificationCenter only works inside an app bundle.
    let isAvailable: Bool = {
        Bundle.main.bundleURL.pathExtension == "app" && Bundle.main.bundleIdentifier != nil
            && NSClassFromString("XCTestCase") == nil
    }()

    private var center: UNUserNotificationCenter? {
        isAvailable ? UNUserNotificationCenter.current() : nil
    }

    override init() {
        super.init()
        guard let center else { return }
        center.delegate = self
        let answer = UNNotificationAction(identifier: Self.answerAction, title: "Answer", options: [.foreground])
        let decline = UNNotificationAction(identifier: Self.declineAction, title: "Decline", options: [.destructive])
        let incoming = UNNotificationCategory(identifier: Self.incomingCategory, actions: [answer, decline], intentIdentifiers: [])
        let missed = UNNotificationCategory(identifier: Self.missedCategory, actions: [], intentIdentifiers: [])
        center.setNotificationCategories([incoming, missed])
    }

    func requestAuthorization(completion: ((Bool) -> Void)? = nil) {
        guard let center else { completion?(false); return }
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            DispatchQueue.main.async { completion?(granted) }
        }
    }

    /// Current authorisation, delivered on the main thread (`nil` when notifications
    /// cannot be used by this process at all).
    func fetchAuthorizationStatus(_ completion: @escaping (UNAuthorizationStatus?) -> Void) {
        guard let center else { completion(nil); return }
        center.getNotificationSettings { settings in
            DispatchQueue.main.async { completion(settings.authorizationStatus) }
        }
    }

    /// Posts a sample notification so the user can check delivery and banner style.
    func postTest() {
        guard let center else { return }
        let content = UNMutableNotificationContent()
        content.title = "Sipper notifications work"
        content.body = "Incoming calls will show here with Answer and Decline buttons."
        content.categoryIdentifier = Self.missedCategory
        center.add(UNNotificationRequest(identifier: "test-\(UUID().uuidString)", content: content, trigger: nil))
    }

    func postIncomingCall(_ call: CallSnapshot, accountLabel: String) {
        guard let center else { return }
        let content = UNMutableNotificationContent()
        content.title = "Incoming call"
        content.subtitle = call.displayName
        content.body = accountLabel.isEmpty ? call.remoteNumber : "\(call.remoteNumber) · \(accountLabel)"
        content.categoryIdentifier = Self.incomingCategory
        content.userInfo = ["callID": call.id]
        content.interruptionLevel = .active
        content.sound = nil
        let request = UNNotificationRequest(identifier: "call-\(call.id)", content: content, trigger: nil)
        center.add(request)
    }

    func removeIncomingCall(_ callID: Int) {
        center?.removeDeliveredNotifications(withIdentifiers: ["call-\(callID)"])
        center?.removePendingNotificationRequests(withIdentifiers: ["call-\(callID)"])
    }

    func postMissedCall(_ record: CallRecord) {
        guard let center else { return }
        let content = UNMutableNotificationContent()
        content.title = "Missed call"
        content.body = record.displayName
        content.categoryIdentifier = Self.missedCategory
        content.userInfo = ["recordID": record.id.uuidString]
        let request = UNNotificationRequest(identifier: "missed-\(record.id.uuidString)", content: content, trigger: nil)
        center.add(request)
    }

    // MARK: UNUserNotificationCenterDelegate

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        defer { completionHandler() }
        let info = response.notification.request.content.userInfo
        if let callID = info["callID"] as? Int {
            switch response.actionIdentifier {
            case Self.answerAction, UNNotificationDefaultActionIdentifier:
                delegate?.notificationManager(self, didChooseAnswerFor: callID)
            case Self.declineAction:
                delegate?.notificationManager(self, didChooseDeclineFor: callID)
            default:
                break
            }
        } else {
            delegate?.notificationManagerDidRequestShowApp(self)
        }
    }
}
