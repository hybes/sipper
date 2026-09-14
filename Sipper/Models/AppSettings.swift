import Foundation

enum RingtoneChoice: String, Codable, CaseIterable, Identifiable {
    case classicUK
    case classicUS
    case digital
    case marimba
    case silent

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .classicUK: return "Classic (UK)"
        case .classicUS: return "Classic (US)"
        case .digital: return "Digital"
        case .marimba: return "Marimba"
        case .silent: return "Silent"
        }
    }
}

enum EchoCancellationMode: String, Codable, CaseIterable, Identifiable {
    /// CoreAudio VoiceProcessingIO: Apple's echo cancellation and noise suppression.
    /// The audio unit always uses the system default input and output devices.
    case appleVoiceProcessing
    /// WebRTC software echo cancellation on the devices chosen in Settings.
    case software
    case off

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .appleVoiceProcessing: return "Apple voice processing"
        case .software: return "Software (WebRTC)"
        case .off: return "Off"
        }
    }

    var allowsDeviceSelection: Bool { self != .appleVoiceProcessing }
}

struct CodecPreference: Codable, Hashable, Identifiable {
    /// PJSIP codec id such as "opus/48000/2" or "PCMU/8000/1".
    var codecID: String
    var isEnabled: Bool

    var id: String { codecID }
}

struct AppSettings: Codable, Hashable {
    // Audio
    var inputDeviceName: String?
    var outputDeviceName: String?
    var ringtone: RingtoneChoice
    var ringVolume: Double
    var echoMode: EchoCancellationMode
    var echoTailMilliseconds: Int
    var codecs: [CodecPreference]

    // Behaviour
    var showNotifications: Bool
    var showIncomingCallAlert: Bool
    var doNotDisturb: Bool
    var launchAtLogin: Bool
    var startHidden: Bool
    var showMenuBarItem: Bool
    var muteMicrophoneOnAnswer: Bool
    var confirmBeforeHangUp: Bool
    var lastUsedAccountID: UUID?

    // iCloud
    var iCloudSync: Bool
    var iCloudSyncHistory: Bool

    // Recording and answering
    var recordCalls: Bool
    var recordingsFolderPath: String
    var convertRecordingsToM4A: Bool
    var autoAnswerSeconds: Int

    // Network
    var stunServer: String
    var verifyTLSCertificates: Bool
    var localUDPPort: Int
    var localTCPPort: Int
    var localTLSPort: Int
    var userAgent: String
    var defaultTransport: SIPTransport
    var sipLogLevel: Int

    init() {
        inputDeviceName = nil
        outputDeviceName = nil
        ringtone = .classicUK
        ringVolume = 0.8
        echoMode = .appleVoiceProcessing
        echoTailMilliseconds = 200
        codecs = []
        showNotifications = true
        showIncomingCallAlert = true
        doNotDisturb = false
        launchAtLogin = false
        startHidden = false
        showMenuBarItem = true
        muteMicrophoneOnAnswer = false
        confirmBeforeHangUp = false
        lastUsedAccountID = nil
        iCloudSync = false
        iCloudSyncHistory = false
        recordCalls = false
        recordingsFolderPath = ""
        convertRecordingsToM4A = true
        autoAnswerSeconds = 0
        stunServer = ""
        verifyTLSCertificates = true
        localUDPPort = 0
        localTCPPort = 0
        localTLSPort = 0
        userAgent = AppSettings.defaultUserAgent
        defaultTransport = .udp
        sipLogLevel = 4
    }

    private enum CodingKeys: String, CodingKey {
        case inputDeviceName, outputDeviceName, ringtone, ringVolume, echoMode
        case echoTailMilliseconds, codecs, showNotifications, showIncomingCallAlert, doNotDisturb, launchAtLogin
        case startHidden, showMenuBarItem, muteMicrophoneOnAnswer, confirmBeforeHangUp, iCloudSync, iCloudSyncHistory
        case recordCalls, recordingsFolderPath, convertRecordingsToM4A, autoAnswerSeconds
        case lastUsedAccountID, stunServer, verifyTLSCertificates, localUDPPort, localTCPPort, localTLSPort
        case userAgent, defaultTransport, sipLogLevel
    }

    init(from decoder: Decoder) throws {
        let d = AppSettings()
        let c = try decoder.container(keyedBy: CodingKeys.self)
        inputDeviceName = c.decodeOptional(.inputDeviceName)
        outputDeviceName = c.decodeOptional(.outputDeviceName)
        ringtone = c.decode(.ringtone, default: d.ringtone)
        ringVolume = c.decode(.ringVolume, default: d.ringVolume)
        echoMode = c.decode(.echoMode, default: d.echoMode)
        echoTailMilliseconds = c.decode(.echoTailMilliseconds, default: d.echoTailMilliseconds)
        codecs = c.decode(.codecs, default: d.codecs)
        showNotifications = c.decode(.showNotifications, default: d.showNotifications)
        showIncomingCallAlert = c.decode(.showIncomingCallAlert, default: d.showIncomingCallAlert)
        doNotDisturb = c.decode(.doNotDisturb, default: d.doNotDisturb)
        launchAtLogin = c.decode(.launchAtLogin, default: d.launchAtLogin)
        startHidden = c.decode(.startHidden, default: d.startHidden)
        showMenuBarItem = c.decode(.showMenuBarItem, default: d.showMenuBarItem)
        muteMicrophoneOnAnswer = c.decode(.muteMicrophoneOnAnswer, default: d.muteMicrophoneOnAnswer)
        confirmBeforeHangUp = c.decode(.confirmBeforeHangUp, default: d.confirmBeforeHangUp)
        lastUsedAccountID = c.decodeOptional(.lastUsedAccountID)
        iCloudSync = c.decode(.iCloudSync, default: d.iCloudSync)
        iCloudSyncHistory = c.decode(.iCloudSyncHistory, default: d.iCloudSyncHistory)
        recordCalls = c.decode(.recordCalls, default: d.recordCalls)
        recordingsFolderPath = c.decode(.recordingsFolderPath, default: d.recordingsFolderPath)
        convertRecordingsToM4A = c.decode(.convertRecordingsToM4A, default: d.convertRecordingsToM4A)
        autoAnswerSeconds = c.decode(.autoAnswerSeconds, default: d.autoAnswerSeconds)
        stunServer = c.decode(.stunServer, default: d.stunServer)
        verifyTLSCertificates = c.decode(.verifyTLSCertificates, default: d.verifyTLSCertificates)
        localUDPPort = c.decode(.localUDPPort, default: d.localUDPPort)
        localTCPPort = c.decode(.localTCPPort, default: d.localTCPPort)
        localTLSPort = c.decode(.localTLSPort, default: d.localTLSPort)
        userAgent = c.decode(.userAgent, default: d.userAgent)
        defaultTransport = c.decode(.defaultTransport, default: d.defaultTransport)
        sipLogLevel = c.decode(.sipLogLevel, default: d.sipLogLevel)
    }

    static var defaultUserAgent: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
        return "Sipper/\(version) (macOS)"
    }
}

/// Default codec ordering for FreeSWITCH/FusionPBX-style PBXs: wideband first,
/// G.711 as the universal fallback, everything else available but off.
enum CodecDefaults {
    static let preferredOrder = [
        "opus/48000/2", "G722/16000/1", "PCMU/8000/1", "PCMA/8000/1",
        "speex/16000/1", "speex/8000/1", "iLBC/8000/1", "GSM/8000/1",
        "speex/32000/1", "G7221/16000/1", "G7221/32000/1",
    ]
    static let enabledByDefault: Set<String> = ["opus/48000/2", "G722/16000/1", "PCMU/8000/1", "PCMA/8000/1"]

    static func seed(from codecs: [CodecInfo]) -> [CodecPreference] {
        let rank: [String: Int] = Dictionary(uniqueKeysWithValues: preferredOrder.enumerated().map { ($1, $0) })
        let ordered = codecs.sorted { a, b in
            let ra = rank[a.id] ?? Int.max
            let rb = rank[b.id] ?? Int.max
            return ra == rb ? a.id < b.id : ra < rb
        }
        return ordered.map { CodecPreference(codecID: $0.id, isEnabled: enabledByDefault.contains($0.id)) }
    }
}
