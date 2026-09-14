import Foundation

enum RegistrationState: Equatable {
    case unregistered
    case registering
    /// `since` is when the last REGISTER succeeded; PJSIP refreshes `refreshLeadTime`
    /// seconds before `expiresIn` runs out.
    case registered(expiresIn: Int, since: Date)
    case failed(code: Int, reason: String)

    var isRegistered: Bool {
        if case .registered = self { return true }
        return false
    }

    var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }

    /// Seconds before expiry at which PJSIP sends the refreshing REGISTER
    /// (pjsua_acc_config.reg_delay_before_refresh, set in SIPEngine).
    static let refreshLeadTime: TimeInterval = 5

    /// When the next re-REGISTER is due, for a live countdown.
    var nextRefresh: Date? {
        guard case .registered(let expiresIn, let since) = self else { return nil }
        return since.addingTimeInterval(TimeInterval(expiresIn) - Self.refreshLeadTime)
    }

    var shortLabel: String {
        switch self {
        case .unregistered: return "Off"
        case .registering: return "Registering"
        case .registered: return "Registered"
        case .failed(let code, _): return code > 0 ? "Failed (\(code))" : "Failed"
        }
    }

    var detail: String {
        switch self {
        case .unregistered: return "Not registered"
        case .registering: return "Registering…"
        case .registered: return "Registered"
        case .failed(let code, let reason):
            return code > 0 ? "\(code) \(reason)" : reason
        }
    }
}

enum CallState: String, Equatable {
    case calling
    case incoming
    case early
    case connecting
    case confirmed
    case disconnected

    var displayName: String {
        switch self {
        case .calling: return "Calling"
        case .incoming: return "Incoming"
        case .early: return "Ringing"
        case .connecting: return "Connecting"
        case .confirmed: return "Connected"
        case .disconnected: return "Ended"
        }
    }
}

/// Immutable view of a call, delivered on the main thread.
struct CallSnapshot: Identifiable, Equatable {
    var id: Int
    var accountID: UUID
    var direction: CallDirection
    var state: CallState
    var remoteURI: String
    var remoteNumber: String
    var remoteName: String
    var isMuted: Bool
    var isOnHold: Bool
    var isRemoteHold: Bool
    var hasActiveMedia: Bool
    var isRecording: Bool = false
    var startedAt: Date
    var connectedAt: Date?
    var endedAt: Date?
    var lastStatusCode: Int
    var lastStatusText: String

    var isActive: Bool { state != .disconnected }
    var isRinging: Bool { state == .incoming }
    var displayName: String { remoteName.isEmpty ? remoteNumber : remoteName }
}

struct VoicemailInfo: Equatable {
    var hasMessages: Bool
    var newCount: Int
    var oldCount: Int

    static let none = VoicemailInfo(hasMessages: false, newCount: 0, oldCount: 0)

    /// Parses an RFC 3842 message-summary body.
    static func parse(body: String) -> VoicemailInfo {
        var info = VoicemailInfo.none
        for rawLine in body.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            let lower = line.lowercased()
            if lower.hasPrefix("messages-waiting:") {
                info.hasMessages = lower.contains("yes")
            } else if lower.hasPrefix("voice-message:") {
                let value = line.drop(while: { $0 != ":" }).dropFirst().trimmingCharacters(in: .whitespaces)
                let counts = value.split(separator: " ").first ?? ""
                let parts = counts.split(separator: "/")
                if parts.count >= 1 { info.newCount = Int(parts[0]) ?? 0 }
                if parts.count >= 2 { info.oldCount = Int(parts[1]) ?? 0 }
            }
        }
        if info.newCount > 0 { info.hasMessages = true }
        return info
    }
}

struct AudioDevice: Identifiable, Hashable {
    var id: Int
    var name: String
    var inputChannels: Int
    var outputChannels: Int
    var driver: String

    var isInput: Bool { inputChannels > 0 }
    var isOutput: Bool { outputChannels > 0 }
}

struct CodecInfo: Identifiable, Hashable {
    /// PJSIP codec id, e.g. "opus/48000/2".
    var id: String
    var priority: Int

    var displayName: String {
        let parts = id.split(separator: "/")
        guard parts.count >= 2 else { return id }
        let name = String(parts[0])
        let rate = (Int(parts[1]) ?? 0) / 1000
        let channels = parts.count > 2 ? Int(parts[2]) ?? 1 : 1
        return "\(name) \(rate) kHz\(channels > 1 ? " stereo" : "")"
    }
}

enum SIPEngineError: LocalizedError {
    case notRunning
    case pjsip(operation: String, status: Int32, message: String)
    case invalidURI(String)
    case unknownAccount
    case unknownCall
    case accountNotRegistered

    var errorDescription: String? {
        switch self {
        case .notRunning: return "The SIP engine is not running."
        case .pjsip(let op, let status, let message): return "\(op) failed: \(message) (\(status))"
        case .invalidURI(let uri): return "“\(uri)” is not a valid SIP address."
        case .unknownAccount: return "The account is not active."
        case .unknownCall: return "The call no longer exists."
        case .accountNotRegistered: return "The account is not registered."
        }
    }
}

/// Parses SIP name-addr strings such as `"Ben" <sip:1001@pbx.example.com>;tag=abc`.
struct SIPAddress: Equatable {
    var displayName: String
    var uri: String
    var user: String
    var host: String

    static func parse(_ raw: String) -> SIPAddress {
        var name = ""
        var uri = raw.trimmingCharacters(in: .whitespacesAndNewlines)

        if let open = uri.firstIndex(of: "<") {
            name = String(uri[..<open]).trimmingCharacters(in: .whitespaces)
            if name.hasPrefix("\""), name.hasSuffix("\""), name.count >= 2 {
                name = String(name.dropFirst().dropLast())
            }
            name = name.replacingOccurrences(of: "\\\"", with: "\"")
            let afterOpen = uri[uri.index(after: open)...]
            if let close = afterOpen.firstIndex(of: ">") {
                uri = String(afterOpen[..<close])
            } else {
                uri = String(afterOpen)
            }
        } else if let semicolon = uri.firstIndex(of: ";") {
            uri = String(uri[..<semicolon])
        }

        var rest = uri
        var isTel = false
        for prefix in ["sips:", "sip:", "tel:"] where rest.lowercased().hasPrefix(prefix) {
            rest = String(rest.dropFirst(prefix.count))
            isTel = prefix == "tel:"
            break
        }
        // Strip URI parameters and headers.
        if let cut = rest.firstIndex(where: { $0 == ";" || $0 == "?" }) {
            rest = String(rest[..<cut])
        }
        var user = ""
        var host = rest
        if isTel {
            user = rest
            host = ""
        } else if let at = rest.firstIndex(of: "@") {
            user = String(rest[..<at])
            host = String(rest[rest.index(after: at)...])
        }
        if host.hasPrefix("["), let close = host.firstIndex(of: "]") {
            host = String(host[host.index(after: host.startIndex)..<close])
        } else if let colon = host.lastIndex(of: ":"), host.filter({ $0 == ":" }).count == 1 {
            host = String(host[..<colon])
        }
        if let pct = user.removingPercentEncoding { user = pct }
        return SIPAddress(displayName: name, uri: uri, user: user, host: host)
    }
}
