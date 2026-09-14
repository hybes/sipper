import Foundation

enum SIPTransport: String, Codable, CaseIterable, Identifiable, Hashable {
    case udp
    case tcp
    case tls

    var id: String { rawValue }

    var displayName: String { rawValue.uppercased() }

    var defaultPort: Int { self == .tls ? 5061 : 5060 }

    /// Parses user or extension supplied values such as "TLS", " tcp ".
    init?(loosely value: String?) {
        guard let value else { return nil }
        let normalised = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if normalised.isEmpty { return nil }
        self.init(rawValue: normalised)
    }
}

enum SRTPMode: String, Codable, CaseIterable, Identifiable, Hashable {
    case disabled
    case optional
    case mandatory

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .disabled: return "Off"
        case .optional: return "Optional"
        case .mandatory: return "Required"
        }
    }
}
