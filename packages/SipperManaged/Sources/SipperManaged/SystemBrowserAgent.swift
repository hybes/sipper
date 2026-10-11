#if os(macOS)
import AppKit
import AppAuth

/// External-browser fallback. AppAuth still owns PKCE, state and token exchange.
final class SystemBrowserAgent: NSObject, OIDExternalUserAgent {
    func present(_ request: OIDExternalUserAgentRequest, session: OIDExternalUserAgentSession) -> Bool {
        guard let url = request.externalUserAgentRequestURL() else { return false }
        return NSWorkspace.shared.open(url)
    }
    func dismiss(animated: Bool, completion: @escaping () -> Void) { completion() }
}
#endif
