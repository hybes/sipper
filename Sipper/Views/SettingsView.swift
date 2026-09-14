import SwiftUI
import AppKit
import UserNotifications

struct SettingsView: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        TabView {
            GeneralSettingsView()
                .tabItem { Label("General", systemImage: "gearshape") }
            AudioSettingsView()
                .tabItem { Label("Audio", systemImage: "speaker.wave.2") }
            NetworkSettingsView()
                .tabItem { Label("Network", systemImage: "network") }
            CodecSettingsView()
                .tabItem { Label("Codecs", systemImage: "waveform") }
            BrowserExtensionSettingsView()
                .tabItem { Label("Browser", systemImage: "puzzlepiece.extension") }
            RecordingSettingsView()
                .tabItem { Label("Recording", systemImage: "record.circle") }
            #if SIPPER_ICLOUD
            SyncSettingsView()
                .tabItem { Label("iCloud", systemImage: "icloud") }
            #endif
            DiagnosticsView()
                .tabItem { Label("Diagnostics", systemImage: "stethoscope") }
        }
        .frame(width: 620, height: 520)
    }
}

struct GeneralSettingsView: View {
    @EnvironmentObject private var state: AppState
    @State private var notificationStatus: UNAuthorizationStatus?
    @State private var notificationStatusLoaded = false

    var body: some View {
        Form {
            Section("Behaviour") {
                Toggle("Launch at login", isOn: $state.settings.launchAtLogin)
                Toggle("Show icon in the menu bar", isOn: $state.settings.showMenuBarItem)
                Toggle("Start with the window hidden", isOn: $state.settings.startHidden)
            }
            Section {
                Stepper(value: $state.settings.autoAnswerSeconds, in: 0...30) {
                    Text(state.settings.autoAnswerSeconds == 0 ? "Auto-answer: off" : "Auto-answer after \(String(state.settings.autoAnswerSeconds)) s")
                }
                Toggle("Show a floating alert for incoming calls", isOn: $state.settings.showIncomingCallAlert)
                Toggle("Send notifications for incoming and missed calls", isOn: $state.settings.showNotifications)
                HStack {
                    notificationStatusLabel
                    Spacer()
                    if notificationStatus == .denied {
                        Button("Open System Settings") {
                            if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") {
                                NSWorkspace.shared.open(url)
                            }
                        }
                    } else if notificationStatus == .notDetermined {
                        Button("Allow…") {
                            state.notifications.requestAuthorization { _ in refreshNotificationStatus() }
                        }
                    }
                    Button("Send Test") { state.notifications.postTest() }
                        .disabled(notificationStatus != .authorized && notificationStatus != .provisional)
                }
            } header: {
                Text("Incoming calls")
            } footer: {
                Text("The floating alert appears on every Space and answers with ⌘↩. Notifications add Answer and Decline buttons in Notification Centre and work when Sipper is hidden.")
            }
            Section("Calls") {
                Toggle("Do Not Disturb (reject incoming calls as busy)", isOn: $state.settings.doNotDisturb)
                Toggle("Mute the microphone when answering", isOn: $state.settings.muteMicrophoneOnAnswer)
                Picker("Transport for new accounts", selection: $state.settings.defaultTransport) {
                    ForEach(SIPTransport.allCases) { Text($0.displayName).tag($0) }
                }
            }
            Section("Ringtone") {
                Picker("Ringtone", selection: $state.settings.ringtone) {
                    ForEach(RingtoneChoice.allCases) { Text($0.displayName).tag($0) }
                }
                HStack {
                    Slider(value: $state.settings.ringVolume, in: 0...1) {
                        Text("Volume")
                    }
                    Button(state.ringer.isPlaying ? "Stop" : "Preview") {
                        if state.ringer.isPlaying {
                            state.ringer.stop()
                        } else {
                            state.ringer.preview(state.settings.ringtone, volume: state.settings.ringVolume)
                        }
                    }
                    .disabled(state.settings.ringtone == .silent)
                }
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: refreshNotificationStatus)
    }

    @ViewBuilder
    private var notificationStatusLabel: some View {
        switch notificationStatus {
        case .authorized, .provisional:
            Label("Notifications allowed", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        case .denied:
            Label("Notifications are turned off for Sipper", systemImage: "bell.slash.fill").foregroundStyle(.orange)
        case .notDetermined:
            Label("Notifications not yet allowed", systemImage: "bell.badge").foregroundStyle(.secondary)
        default:
            Label(notificationStatusLoaded ? "Notifications unavailable in this build" : "Checking…", systemImage: "bell")
                .foregroundStyle(.secondary)
        }
    }

    private func refreshNotificationStatus() {
        state.notifications.fetchAuthorizationStatus { status in
            notificationStatus = status
            notificationStatusLoaded = true
        }
    }
}

struct AudioSettingsView: View {
    @EnvironmentObject private var state: AppState

    private var inputs: [AudioDevice] { state.audioDevices.filter(\.isInput) }
    private var outputs: [AudioDevice] { state.audioDevices.filter(\.isOutput) }

    var body: some View {
        Form {
            Section {
                Picker("Echo cancellation", selection: $state.settings.echoMode) {
                    ForEach(EchoCancellationMode.allCases) { Text($0.displayName).tag($0) }
                }
                if state.settings.echoMode == .software {
                    Stepper("Tail length: \(String(state.settings.echoTailMilliseconds)) ms",
                            value: $state.settings.echoTailMilliseconds, in: 50...800, step: 50)
                }
            } header: {
                Text("Echo cancellation")
            } footer: {
                Text(state.settings.echoMode == .appleVoiceProcessing
                     ? "Apple voice processing gives the best echo and noise suppression, but always uses the system default microphone and speaker. Pick devices in System Settings › Sound."
                     : "Software echo cancellation runs on the devices selected below.")
            }
            Section {
                Picker("Microphone", selection: $state.settings.inputDeviceName) {
                    Text("System default").tag(String?.none)
                    ForEach(inputs) { device in
                        Text(device.name).tag(Optional(device.name))
                    }
                }
                Picker("Speaker", selection: $state.settings.outputDeviceName) {
                    Text("System default").tag(String?.none)
                    ForEach(outputs) { device in
                        Text(device.name).tag(Optional(device.name))
                    }
                }
                HStack {
                    Text(state.engineIsRunning ? "\(state.audioDevices.count) devices" : "Engine not running")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Refresh") { state.refreshAudioDevices() }
                }
            } header: {
                Text("Devices")
            } footer: {
                Text("The ringtone always plays through the system output device.")
            }
            .disabled(!state.settings.echoMode.allowsDeviceSelection)
            Section("Microphone access") {
                if MicrophoneAccess.isDenied {
                    Label("Sipper is not allowed to use the microphone.", systemImage: "mic.slash")
                        .foregroundStyle(.red)
                    Button("Open Privacy Settings") {
                        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                } else {
                    Button("Check microphone permission") {
                        MicrophoneAccess.request { granted in
                            if !granted {
                                state.alert = AppAlert(title: "Microphone", message: "Access was not granted. Enable it in System Settings › Privacy & Security › Microphone.")
                            }
                        }
                    }
                }
            }
        }
        .formStyle(.grouped)
        .onAppear { state.refreshAudioDevices() }
    }
}

struct NetworkSettingsView: View {
    @EnvironmentObject private var state: AppState
    @State private var stun = ""
    @State private var udp = ""
    @State private var tcp = ""
    @State private var tls = ""
    @State private var userAgent = ""
    @State private var verifyTLS = true
    @State private var logLevel = 4
    @State private var loaded = false

    var body: some View {
        Form {
            Section {
                TextField("STUN server", text: $stun, prompt: Text("stun.example.com:3478"))
                    .autocorrectionDisabled()
                Toggle("Verify TLS certificates", isOn: $verifyTLS)
            } header: {
                Text("NAT and security")
            } footer: {
                Text("Turn certificate verification off only for PBXs with self-signed certificates.")
            }
            Section {
                TextField("UDP port", text: $udp, prompt: Text("Automatic"))
                TextField("TCP port", text: $tcp, prompt: Text("Automatic"))
                TextField("TLS port", text: $tls, prompt: Text("Automatic"))
            } header: {
                Text("Local SIP ports")
            } footer: {
                Text("Leave empty to let the system choose. Fixed ports are useful for firewall rules.")
            }
            Section {
                TextField("User agent", text: $userAgent, prompt: Text(AppSettings.defaultUserAgent))
                Picker("SIP log level", selection: $logLevel) {
                    Text("Errors only (1)").tag(1)
                    Text("Warnings (2)").tag(2)
                    Text("Normal (3)").tag(3)
                    Text("Verbose with SIP messages (4)").tag(4)
                    Text("Debug (5)").tag(5)
                }
            } header: {
                Text("Advanced")
            } footer: {
                HStack {
                    Text("Changes here restart the SIP engine and re-register every account.")
                    Spacer()
                    Button("Apply") { apply() }
                        .disabled(!hasChanges)
                }
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: load)
    }

    private var hasChanges: Bool {
        stun != state.settings.stunServer
            || (Int(udp) ?? 0) != state.settings.localUDPPort
            || (Int(tcp) ?? 0) != state.settings.localTCPPort
            || (Int(tls) ?? 0) != state.settings.localTLSPort
            || userAgent != state.settings.userAgent
            || verifyTLS != state.settings.verifyTLSCertificates
            || logLevel != state.settings.sipLogLevel
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        stun = state.settings.stunServer
        udp = state.settings.localUDPPort == 0 ? "" : String(state.settings.localUDPPort)
        tcp = state.settings.localTCPPort == 0 ? "" : String(state.settings.localTCPPort)
        tls = state.settings.localTLSPort == 0 ? "" : String(state.settings.localTLSPort)
        userAgent = state.settings.userAgent
        verifyTLS = state.settings.verifyTLSCertificates
        logLevel = state.settings.sipLogLevel
    }

    private func apply() {
        var settings = state.settings
        settings.stunServer = stun.trimmingCharacters(in: .whitespaces)
        settings.localUDPPort = min(65535, max(0, Int(udp) ?? 0))
        settings.localTCPPort = min(65535, max(0, Int(tcp) ?? 0))
        settings.localTLSPort = min(65535, max(0, Int(tls) ?? 0))
        settings.userAgent = userAgent.trimmingCharacters(in: .whitespaces)
        settings.verifyTLSCertificates = verifyTLS
        settings.sipLogLevel = logLevel
        state.settings = settings
    }
}

struct CodecSettingsView: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if state.settings.codecs.isEmpty {
                ContentUnavailableView("No codecs", systemImage: "waveform",
                                       description: Text(state.engineIsRunning ? "" : "Start the SIP engine to list codecs."))
            } else {
                List {
                    ForEach(Array(state.settings.codecs.enumerated()), id: \.element.id) { index, preference in
                        HStack {
                            Toggle("", isOn: Binding(get: { preference.isEnabled },
                                                     set: { state.settings.codecs[index].isEnabled = $0 }))
                                .labelsHidden()
                            Text(CodecInfo(id: preference.codecID, priority: 0).displayName)
                                .foregroundStyle(preference.isEnabled ? .primary : .secondary)
                            Spacer()
                            Text(preference.codecID).font(.caption).foregroundStyle(.tertiary)
                        }
                    }
                    .onMove { offsets, target in
                        state.settings.codecs.move(fromOffsets: offsets, toOffset: target)
                    }
                }
                Text("Drag to reorder. The first enabled codec is offered first. Opus and G.722 give wideband audio; PCMU/PCMA work everywhere.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 12)
            }
        }
        .onAppear { state.refreshCodecs() }
    }
}

struct BrowserExtensionSettingsView: View {
    @EnvironmentObject private var state: AppState
    @State private var entries: [NativeMessagingInstaller.Entry] = []
    @State private var extensionID = ChromeExtension.pinnedID
    @State private var message: String?

    private var installer: NativeMessagingInstaller {
        NativeMessagingInstaller(extensionID: extensionID.trimmingCharacters(in: .whitespaces))
    }

    var body: some View {
        Form {
            Section {
                Text("The Sipper browser extension reads the extension you are viewing in FusionPBX and adds it here. It works in Chrome, Edge, Brave, Vivaldi, Arc and Helium.")
                    .font(.callout)
                Text("1. Open chrome://extensions, turn on Developer mode and choose “Load unpacked”, then pick the extension folder from the Sipper source tree.\n2. Open an extension in FusionPBX and click the Sipper icon in the toolbar.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } header: {
                Text("Browser extension")
            }
            Section {
                TextField("Extension ID", text: $extensionID)
                    .font(.system(.body, design: .monospaced))
                    .autocorrectionDisabled()
                ForEach(entries) { entry in
                    HStack {
                        Text(entry.browser.name)
                        Spacer()
                        statusLabel(entry.status)
                    }
                    .help(entry.manifestPath)
                }
                HStack {
                    Button("Install Helper") { install() }
                    Button("Remove") {
                        installer.uninstall()
                        refresh()
                        message = "Helper manifests removed."
                    }
                    Spacer()
                    if let message {
                        Text(message).font(.caption).foregroundStyle(.secondary)
                    }
                }
            } header: {
                Text("Native messaging helper")
            } footer: {
                Text("Optional. With the helper installed the extension hands accounts to Sipper directly instead of opening a sipper:// link, and can tell whether Sipper is installed. Re-install after moving Sipper.app.")
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: refresh)
    }

    private func statusLabel(_ status: NativeMessagingInstaller.Status) -> some View {
        Group {
            switch status {
            case .installed:
                Label("Installed", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
            case .installedElsewhere(let path):
                Label("Points to another copy", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .help(path)
            case .notInstalled:
                Text("Not installed").foregroundStyle(.secondary)
            case .browserMissing:
                Text("Browser not found").foregroundStyle(.tertiary)
            }
        }
        .font(.callout)
    }

    private func install() {
        do {
            let written = try installer.install()
            refresh()
            message = written.isEmpty ? "No supported browser was found." : "Installed for \(written.map(\.name).joined(separator: ", "))."
        } catch {
            message = error.localizedDescription
        }
    }

    private func refresh() {
        entries = installer.status()
    }
}

struct RecordingSettingsView: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        Form {
            Section {
                Toggle("Record every call automatically", isOn: $state.settings.recordCalls)
                Toggle("Convert recordings to M4A (smaller files)", isOn: $state.settings.convertRecordingsToM4A)
            } header: {
                Text("Call recording")
            } footer: {
                Text("You can also start or stop recording during a call with the Record button. Recordings mix both sides of the conversation into one file. Check the recording laws where you are; many places require telling the other party.")
            }
            Section {
                LabeledContent("Folder") {
                    Text(state.recordingsDirectory.path)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
                HStack {
                    Button("Choose…") { chooseFolder() }
                    Button("Use Default") { state.settings.recordingsFolderPath = "" }
                        .disabled(state.settings.recordingsFolderPath.isEmpty)
                    Spacer()
                    Button("Show in Finder") { state.revealRecordingsFolder() }
                }
            } header: {
                Text("Storage")
            } footer: {
                Text("Recordings are named by date, the other party and the account. They are not synced with iCloud.")
            }
        }
        .formStyle(.grouped)
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.directoryURL = state.recordingsDirectory
        panel.prompt = "Use Folder"
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            state.settings.recordingsFolderPath = url.path
        }
    }
}

struct SyncSettingsView: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        Form {
            Section {
                Toggle("Sync profiles, accounts and contacts with iCloud", isOn: $state.settings.iCloudSync)
                Toggle("Include call history", isOn: $state.settings.iCloudSyncHistory)
                    .disabled(!state.settings.iCloudSync)
                HStack {
                    statusLabel
                    Spacer()
                    Button("Sync Now") { state.syncNow() }
                        .disabled(!state.settings.iCloudSync)
                }
            } header: {
                Text("iCloud")
            } footer: {
                Text("Passwords travel separately through iCloud Keychain, so turn on Passwords & Keychain in System Settings › Apple Account › iCloud on every Mac. Audio, network and other per-device settings are not synced.")
            }
            if !CloudSyncService.isEntitledAndSignedIn {
                Section {
                    Text("This build cannot reach iCloud. Sign in to iCloud on this Mac and build Sipper with a team that has the iCloud container (make app TEAM=<TeamID> ICLOUD=1, see README).")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
    }

    @ViewBuilder
    private var statusLabel: some View {
        switch state.cloudSyncStatus {
        case .off:
            Label("Off", systemImage: "icloud.slash").foregroundStyle(.secondary)
        case .unavailable(let reason):
            Label(reason, systemImage: "exclamationmark.icloud").foregroundStyle(.orange)
        case .starting, .syncing:
            Label(state.cloudSyncStatus.description, systemImage: "arrow.triangle.2.circlepath.icloud")
        case .idle:
            Label(state.cloudSyncStatus.description, systemImage: "checkmark.icloud").foregroundStyle(.green)
        case .error(let message):
            Label(message, systemImage: "xmark.icloud").foregroundStyle(.red)
        }
    }
}

struct DiagnosticsView: View {
    @EnvironmentObject private var state: AppState
    @State private var lines: [String] = []
    @State private var autoScroll = true

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(state.engineIsRunning ? "SIP engine running" : "SIP engine stopped")
                        .font(.headline)
                    Text("PJSIP \(state.engine.pjsipVersion) · \(state.registeredAccounts.count) registered · \(state.calls.count) active call(s)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let error = state.engineError {
                        Text(error).font(.caption).foregroundStyle(.red)
                    }
                }
                Spacer()
                Button("Restart Engine") { state.restartEngine() }
            }
            .padding([.horizontal, .top], 16)

            LogTextView(text: lines.joined(separator: "\n"), autoScroll: autoScroll)
                .padding(.horizontal, 16)

            HStack {
                Toggle("Follow", isOn: $autoScroll)
                Spacer()
                Button("Clear") { state.engine.log.clear() }
                Button("Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(state.engine.log.export(), forType: .string)
                }
                Button("Save…") { save() }
            }
            .padding([.horizontal, .bottom], 16)
        }
        .onAppear {
            lines = state.engine.log.snapshot()
            state.engine.log.onChange = { lines = state.engine.log.snapshot() }
        }
        .onDisappear {
            state.engine.log.onChange = nil
        }
    }

    private func save() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "sipper-log.txt"
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            try? state.engine.log.export().write(to: url, atomically: true, encoding: .utf8)
        }
    }
}

/// Read-only monospaced text view that can follow the end.
struct LogTextView: NSViewRepresentable {
    let text: String
    let autoScroll: Bool

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSTextView.scrollableTextView()
        let textView = scrollView.documentView as! NSTextView
        textView.isEditable = false
        textView.isRichText = false
        textView.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        textView.textContainerInset = NSSize(width: 6, height: 6)
        scrollView.hasVerticalScroller = true
        scrollView.borderType = .bezelBorder
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        if textView.string != text {
            textView.string = text
            if autoScroll {
                textView.scrollToEndOfDocument(nil)
            }
        }
    }
}
