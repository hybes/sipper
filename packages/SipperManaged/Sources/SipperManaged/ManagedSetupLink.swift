import Foundation

/// A customer-selection hint. Possession never replaces authentication or a licence.
public struct ManagedSetupLink: Equatable, Sendable {
    public let reference: String

    public init(url: URL, serverURL: URL) throws {
        guard url.absoluteString.utf8.count <= 4096, url.user == nil, url.password == nil,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw ManagedError.invalidSetupLink }
        let value: String
        if ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
            guard Self.sameOrigin(url, serverURL), url.path == "/portal/setup", url.query == nil,
                  let fragment = parts.fragment, fragment.hasPrefix("ref=") else { throw ManagedError.invalidSetupLink }
            value = String(fragment.dropFirst(4))
        } else {
            guard url.scheme == "sipper" || (url.scheme == "sipper-development" && serverURL.scheme == "http"),
                  url.host == "setup", url.path.isEmpty, url.port == nil, url.fragment == nil,
                  let items = parts.queryItems, items.count == 2,
                  Set(items.map(\.name)) == Set(["server", "reference"]),
                  let server = items.first(where: { $0.name == "server" })?.value.flatMap(URL.init(string:)),
                  server.user == nil, server.password == nil, server.query == nil, server.fragment == nil,
                  server.path.isEmpty || server.path == "/", Self.sameOrigin(server, serverURL),
                  let reference = items.first(where: { $0.name == "reference" })?.value else { throw ManagedError.invalidSetupLink }
            value = reference
        }
        guard value.utf8.count == 43, value.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }) else { throw ManagedError.invalidSetupLink }
        reference = value
    }

    private static func sameOrigin(_ left: URL, _ right: URL) -> Bool {
        let port: (URL) -> Int? = { $0.port ?? ($0.scheme == "https" ? 443 : $0.scheme == "http" ? 80 : nil) }
        return left.scheme?.lowercased() == right.scheme?.lowercased() && left.host?.lowercased() == right.host?.lowercased() && port(left) == port(right)
    }
}
