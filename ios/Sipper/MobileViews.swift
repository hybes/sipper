import AVFoundation
import AVKit
import SipperManaged
import SwiftUI

struct MobileRootView: View {
    @EnvironmentObject private var state: MobileState
    @State private var messageNotificationOpen = false
    var body: some View {
        TabView(selection: Binding(get: { state.selectedTab }, set: state.selectTab)) {
            if !state.calls.isEmpty {
                NavigationStack { ScrollView { MobileCalls() }.navigationTitle("Calls") }
                    .tabItem { Label("Calls", systemImage: "phone.fill") }.tag(4)
            }
            NavigationStack { MobileDialler() }.tabItem { Label("Keypad", systemImage: "circle.grid.3x3.fill") }.tag(0)
            NavigationStack { MobileHistory() }.tabItem { Label("Recents", systemImage: "clock") }.tag(1)
            NavigationStack {
                if let client = state.managed {
                    ManagedDirectoryView(client: client, accounts: state.accounts.filter { state.canUse($0.id) }.compactMap { ManagedAccountMapper.directoryAccount($0) }) { enrollment, contact, number, account in
                        try await state.callDirectory(number, contactID: contact, enrollment: enrollment, accountID: account)
                        }.navigationTitle("Directory")
                        .navigationDestination(isPresented: $messageNotificationOpen) {
                            let hint = state.messageNotification
                            ManagedMessagesView(client: client, notification: hint, onNavigationLock: state.setMessageNavigationLocked,
                                phoneBusy: state.meetingPhoneBusy, claimMeetingAudio: state.claimMeetingAudio,
                                releaseMeetingAudio: state.releaseMeetingAudio).navigationTitle("Messages")
                                .onDisappear { if let hint { state.consumeMessageNotification(hint) } }
                        }
                        .toolbar {
                            Button { messageNotificationOpen = true } label: {
                                Label("Messages", systemImage: "bubble.left.and.bubble.right")
                            }
                        }
                } else { Text("Managed access is unavailable. Open Accounts to sign in.").foregroundStyle(.secondary).padding().navigationTitle("Directory") }
            }.tabItem { Label("Directory", systemImage: "person.2") }.tag(3)
            NavigationStack { MobileAccounts() }.tabItem { Label("Accounts", systemImage: "person.crop.circle") }.tag(2)
        }
        .onChange(of: state.messageNotification) { hint in messageNotificationOpen = hint != nil }
        .onAppear { messageNotificationOpen = state.messageNotification != nil }
        .safeAreaInset(edge: .top, spacing: 0) {
            if !state.calls.isEmpty && state.selectedTab != 4 {
                Button { state.selectedTab = 4 } label: {
                    Label(state.calls.count == 1 ? "Return to call" : "Return to calls", systemImage: "phone.fill")
                        .font(.headline).frame(maxWidth: .infinity, minHeight: 44)
                }.background(.regularMaterial)
            }
        }
        .alert("Sipper", isPresented: Binding(get: { state.error != nil }, set: { if !$0 { state.error = nil } })) {
            Button("OK") { state.error = nil }
        } message: { Text(state.error ?? "") }
    }
}

struct MobileDialler: View {
    @EnvironmentObject private var state: MobileState
    @State private var calling = false
    private let keys = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["*", "0", "#"]]
    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                if state.accounts.isEmpty {
                    Label("Add a calling account to get started", systemImage: "phone.badge.plus").font(.headline)
                    Text("Use your own SIP details or sign in with your organisation under Accounts.")
                        .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                } else {
                    Picker("Calling account", selection: $state.selectedAccountID) {
                        ForEach(state.accounts.filter(\.isEnabled)) { account in Text(account.displayLabel).tag(Optional(account.id)) }
                    }.pickerStyle(.menu)
                    if let id = state.selectedAccountID {
                        Text((state.registrations[id] ?? .unregistered).shortLabel).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                HStack {
                    TextField(state.accounts.first { $0.id == state.selectedAccountID }?.managed?.mode == .gateway ? "Phone number or extension" : "Number or SIP address", text: $state.dialTarget)
                        .font(.title2).multilineTextAlignment(.center).textInputAutocapitalization(.never)
                        .autocorrectionDisabled().keyboardType(.asciiCapable).accessibilityIdentifier("dial-target")
                    Button { if !state.dialTarget.isEmpty { state.dialTarget.removeLast() } } label: { Image(systemName: "delete.left") }
                        .accessibilityLabel("Delete last digit")
                }
                VStack(spacing: 16) {
                    ForEach(keys, id: \.self) { row in
                        HStack(spacing: 28) {
                            ForEach(row, id: \.self) { key in
                                Button { state.dialTarget += key } label: {
                                    Text(key).font(.largeTitle).frame(width: 72, height: 72).background(Color.secondary.opacity(0.10), in: Circle())
                                }.buttonStyle(.plain).accessibilityLabel(key)
                            }
                        }
                    }
                }
                Button {
                    guard let account = state.accounts.first(where: { $0.id == state.selectedAccountID }) else { return }
                    let target = state.dialTarget
                    calling = true
                    Task {
                        defer { calling = false }
                        do { try await state.callKit.start(account: account, target: target) }
                        catch { state.error = error.localizedDescription }
                    }
                } label: { Label("Call", systemImage: "phone.fill").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 10) }
                    .buttonStyle(.borderedProminent).disabled(calling || state.dialTarget.isEmpty || state.selectedAccountID == nil || state.calls.count >= 2)
                if !state.calls.isEmpty {
                    Text("Your current call will be held when you place another call.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Text("Direct SIP accounts receive calls while Sipper is active. Reliable background calling will use the managed push service.")
                    .font(.footnote).foregroundStyle(.secondary)
            }.padding(24).frame(maxWidth: 440).frame(maxWidth: .infinity)
        }.navigationTitle("Sipper")
    }
}

struct MobileCalls: View {
    @EnvironmentObject private var state: MobileState
    @State private var keypad: Int?
    @State private var transferring: CallSnapshot?
    private var visibleCalls: [CallSnapshot] {
        var groups = Set<UUID>()
        return state.calls.filter { call in call.conferenceID.map { groups.insert($0).inserted } ?? true }
    }
    var body: some View {
        VStack(spacing: 12) {
            MobileCallAudioControls(bridge: state.callKit)
            if state.callKit.changingCalls { ProgressView("Updating calls…").font(.subheadline) }
            ForEach(visibleCalls) { call in
                let members = call.conferenceID.map { group in state.calls.filter { $0.conferenceID == group } } ?? []
                VStack(spacing: 10) {
                    HStack {
                        VStack(alignment: .leading) {
                            Text(members.isEmpty ? call.displayName : "Conference").font(.headline).lineLimit(1)
                            Text(call.isOnHold ? "On hold" : call.state.displayName).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if let date = call.connectedAt { Text(date, style: .timer).font(.subheadline.monospacedDigit()) }
                    }
                    ForEach(members) { member in
                        HStack {
                            Text(member.displayName).lineLimit(1)
                            Spacer(minLength: 8)
                            Button("Keypad") { keypad = keypad == member.id ? nil : member.id }
                                .disabled(state.callKit.changingCalls)
                                .accessibilityLabel("Keypad for \(member.displayName)")
                            Button("Remove", role: .destructive) { state.callKit.end(member) }
                                .accessibilityLabel("Remove \(member.displayName) from conference")
                        }.font(.subheadline).frame(minHeight: 44)
                    }
                    HStack(spacing: 20) {
                        if call.isRinging {
                            Button { state.callKit.answer(call) } label: { Label("Answer", systemImage: "phone.fill") }
                                .disabled(state.callKit.changingCalls)
                        } else {
                            Button { state.callKit.mute(call) } label: { Label(call.isMuted ? "Unmute" : "Mute", systemImage: call.isMuted ? "mic.slash.fill" : "mic.fill") }
                                .disabled(state.callKit.changingCalls)
                            Button { state.callKit.hold(call) } label: { Label(call.isOnHold ? "Resume" : "Hold", systemImage: call.isOnHold ? "play.fill" : "pause.fill") }
                                .disabled(state.callKit.changingCalls)
                            if members.isEmpty {
                                Button { keypad = keypad == call.id ? nil : call.id } label: { Label("Keypad", systemImage: "circle.grid.3x3.fill") }
                                    .disabled(state.callKit.changingCalls)
                            }
                        }
                        Spacer(minLength: 0)
                        Button(role: .destructive) {
                            if members.isEmpty { state.callKit.end(call) } else { state.callKit.endConference(call) }
                        } label: { Label(call.isRinging ? "Decline" : members.isEmpty ? "End" : "End conference", systemImage: "phone.down.fill") }
                    }.labelStyle(.iconOnly).font(.title2).buttonStyle(.bordered)
                    if state.canTransfer(call) {
                        HStack {
                            if state.calls.count == 1 {
                                Button { state.prepareNewCall(call) } label: { Label("Add call", systemImage: "plus") }
                            }
                            Button { transferring = call } label: { Label("Transfer", systemImage: "phone.arrow.right") }
                            let peers = state.calls.filter { $0.id != call.id && $0.accountID == call.accountID && state.canTransfer($0) }
                            if !peers.isEmpty {
                                Menu("Merge calls") {
                                    ForEach(peers) { peer in Button(peer.displayName) { state.callKit.merge(call, with: peer) } }
                                }
                            }
                        }.buttonStyle(.bordered).frame(minHeight: 44)
                    }
                    if !members.isEmpty {
                        Menu("Separate calls") {
                            ForEach(members) { member in Button("Talk to \(member.displayName)") { state.callKit.separate(member) } }
                        }.buttonStyle(.bordered).frame(minHeight: 44).disabled(state.callKit.changingCalls)
                    }
                    if let status = call.transferStatus { Text(status).font(.subheadline).foregroundStyle(.secondary) }
                    if let keyedCall = state.calls.first(where: { $0.id == keypad }), keyedCall.id == call.id || members.contains(where: { $0.id == keyedCall.id }) {
                        if !members.isEmpty { Text("Keypad for \(keyedCall.displayName)").font(.subheadline).foregroundStyle(.secondary) }
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 3), spacing: 8) {
                            ForEach(Array("123456789*0#"), id: \.self) { digit in
                                Button { state.callKit.dtmf(keyedCall, digits: String(digit)) } label: {
                                    Text(String(digit)).font(.title2).frame(maxWidth: .infinity, minHeight: 44)
                                }.buttonStyle(.bordered).accessibilityLabel("Send \(String(digit))").disabled(state.callKit.changingCalls)
                            }
                        }
                    }
                }
                if call.id != visibleCalls.last?.id { Divider().padding(.vertical, 8) }
            }
        }.padding().frame(maxWidth: 600).frame(maxWidth: .infinity)
            .sheet(item: $transferring) { MobileTransfer(call: $0) }
    }
}

struct MobileTransfer: View {
    @EnvironmentObject private var state: MobileState
    @Environment(\.dismiss) private var dismiss
    let call: CallSnapshot
    @State private var target = ""
    @State private var error: String?
    private var available: Bool {
        state.calls.contains { $0.id == call.id && $0.startedAt == call.startedAt && state.canTransfer($0) }
    }
    var body: some View {
        NavigationStack {
            Form {
                if !available { Text("This call is no longer available to transfer.") }
                if let error { Text(error).foregroundStyle(.red) }
                Section("Transfer to a destination") {
                    TextField(state.accounts.first { $0.id == call.accountID }?.managed?.mode == .gateway ? "Phone number or extension" : "Phone number or SIP address", text: $target)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Transfer now") { submit { try state.engine.transfer(call, to: target) } }
                        .disabled(!available || target.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                let peers = state.calls.filter { $0.id != call.id && $0.accountID == call.accountID && state.canTransfer($0) }
                Section("Transfer to another call") {
                    if peers.isEmpty { Text("Use Add call to call the person on the same account, then return here to complete the transfer.").foregroundStyle(.secondary) }
                    ForEach(peers) { peer in
                        Button(peer.displayName) { submit { try state.engine.attendedTransfer(call, to: peer) } }.disabled(!available)
                    }
                }
            }.navigationTitle("Transfer call").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
    private func submit(_ action: () throws -> Void) {
        do { try action(); dismiss() }
        catch SIPEngineError.invalidTransferTarget { error = "Enter a valid phone number or SIP address." }
        catch { self.error = "Transfer could not start. Check that the call and account are still available." }
    }
}

/// Audio routing belongs to the shared CallKit session, not to an individual SIP leg.
struct MobileCallAudioControls: View {
    @ObservedObject var bridge: CallKitBridge
    @State private var route = ""
    var body: some View {
        HStack(spacing: 8) {
            MobileAudioRoutePicker(active: bridge.audioActive && !route.isEmpty)
                .frame(width: 44, height: 44)
                .accessibilityLabel("Choose call audio output")
                .accessibilityValue(route)
                .accessibilityHidden(!bridge.audioActive || route.isEmpty)
            VStack(alignment: .leading, spacing: 2) {
                Text("Call audio").font(.subheadline)
                Text(bridge.audioActive ? (route.isEmpty ? "Audio unavailable" : route) : "Waiting for call audio")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .onAppear(perform: refreshRoute)
        .onReceive(bridge.$audioActive) { _ in refreshRoute() }
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.routeChangeNotification).receive(on: RunLoop.main)) { _ in refreshRoute() }
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.mediaServicesWereResetNotification).receive(on: RunLoop.main)) { _ in refreshRoute() }
    }
    private func refreshRoute() {
        // A requested route is not proof that the system selected it.
        route = AVAudioSession.sharedInstance().currentRoute.outputs.map(\.portName).joined(separator: ", ")
    }
}

struct MobileAudioRoutePicker: UIViewRepresentable {
    let active: Bool
    func makeUIView(context: Context) -> AVRoutePickerView {
        let picker = AVRoutePickerView()
        picker.prioritizesVideoDevices = false
        picker.tintColor = UIColor(named: "AccentColor") ?? .systemTeal
        picker.activeTintColor = picker.tintColor
        return picker
    }
    func updateUIView(_ picker: AVRoutePickerView, context: Context) {
        picker.isUserInteractionEnabled = active
        picker.alpha = active ? 1 : 0.4
    }
}

struct MobileHistory: View {
    @EnvironmentObject private var state: MobileState
    var body: some View {
        List {
            if state.history.isEmpty { Text("Your calls will appear here.").foregroundStyle(.secondary) }
            ForEach(state.history) { record in
                Button {
                    guard let account = state.accounts.first(where: { $0.id == record.accountID && ($0.managed != nil) == record.isManaged }) else {
                        state.error = "This call’s original account is no longer available."; return
                    }
                    Task {
                        do { try await state.callKit.start(account: account, target: record.remoteURI.isEmpty ? record.remoteNumber : record.remoteURI) }
                        catch { state.error = error.localizedDescription }
                    }
                } label: {
                    HStack {
                        Image(systemName: record.direction == .incoming ? "phone.arrow.down.left" : "phone.arrow.up.right")
                        VStack(alignment: .leading, spacing: 4) {
                            Text(record.displayName).foregroundStyle(record.wasMissed ? .red : .primary)
                            Text(record.outcome.displayName).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(record.startedAt, style: .date).font(.caption).foregroundStyle(.secondary)
                    }
                }.buttonStyle(.plain)
            }
        }.navigationTitle("Recents")
    }
}

struct MobileAccounts: View {
    @EnvironmentObject private var state: MobileState
    @State private var editor: SIPAccount?
    @State private var deleting: SIPAccount?
    @State private var disconnecting: ManagedEnrollment?
    @State private var confirmSignOut = false
    var body: some View {
        List {
            if state.importing { MobileImportView().id(state.importReview?.id) }
            Section("Calling accounts") {
                ForEach(state.accounts) { account in
                    HStack {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(account.displayLabel).font(.headline)
                            Text(account.managed != nil ? "Managed by your organisation" : account.defaultLabel).font(.caption).foregroundStyle(.secondary)
                            Text((state.registrations[account.id] ?? .unregistered).shortLabel).font(.caption)
                                .foregroundStyle(state.registrations[account.id]?.isRegistered == true ? .green : .secondary)
                        }
                        Spacer()
                        if account.managed == nil {
                            Button { editor = account } label: { Image(systemName: "pencil") }.accessibilityLabel("Edit \(account.displayLabel)")
                        } else { Image(systemName: "lock.fill").foregroundStyle(.secondary).accessibilityLabel("Managed account") }
                    }.swipeActions {
                        if account.managed == nil { Button("Delete", role: .destructive) { deleting = account } }
                    }
                }
                Button { editor = SIPAccount(profileID: UUID(), username: "", domain: "", transport: .tls, srtp: .mandatory) } label: { Label("Add SIP account", systemImage: "plus") }
                Button("Import accounts") { state.importing = true }.disabled(state.importing)
            }
            if let client = state.managed {
                Section("Managed Sipper") {
                    if client.isSignedIn {
                        Text(client.identity?.email ?? "Signed in").font(.subheadline)
                        if client.organisations.isEmpty {
                            Text("No organisations yet. Accept your invitation in the Sipper portal, then refresh.").font(.subheadline).foregroundStyle(.secondary)
                        }
                        ForEach(client.organisations) { organisation in
                            VStack(alignment: .leading, spacing: 12) {
                              HStack {
                                VStack(alignment: .leading) {
                                    Text(organisation.name)
                                    if organisation.status != "active" || !organisation.licensed { Text("Ask your administrator to enable access").font(.caption).foregroundStyle(.secondary) }
                                }
                                Spacer()
                                if let enrollment = client.enrollments.first(where: { $0.organisationID == organisation.id }) {
                                    Button("Disconnect", role: .destructive) { disconnecting = enrollment }
                                        .disabled(state.managedBusy)
                                } else {
                                    Button("Connect") { Task { await state.connect(organisation) } }.disabled(state.managedBusy || !organisation.licensed || organisation.status != "active")
                                }
                              }
                              Picker("Availability", selection: Binding(get: { organisation.availability }, set: { value in
                                  if let value { Task { await state.setAvailability(value, organisationID: organisation.id) } }
                              })) {
                                  if organisation.availability == nil { Text("Unavailable").tag(Optional<ManagedAvailability>.none) }
                                  ForEach(ManagedAvailability.allCases, id: \.self) { value in Text(value.label).tag(Optional(value)) }
                              }
                              .disabled(state.managedBusy || client.isSigningIn || organisation.status != "active" || organisation.availability == nil)
                              .accessibilityLabel("Availability for \(organisation.name)")
                              HStack {
                                VStack(alignment: .leading) {
                                    Text("Do Not Disturb").font(.subheadline)
                                    Text(organisation.doNotDisturb.map { $0 ? "On" : "Off" } ?? "Unavailable").font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button(organisation.doNotDisturb == true ? "Turn off" : "Turn on") {
                                    Task { await state.setDoNotDisturb(organisation.doNotDisturb != true, organisationID: organisation.id) }
                                }
                                .disabled(state.managedBusy || client.isSigningIn || organisation.status != "active" || organisation.doNotDisturb == nil)
                                .accessibilityLabel("\(organisation.doNotDisturb == true ? "Turn off" : "Turn on") Do Not Disturb for \(organisation.name)")
                              }
                            }.buttonStyle(.borderless)
                        }
                        Text("Availability is your stated status for this customer and stays until changed or cleared; it does not change calling. Do Not Disturb applies across your devices. Gateway calls stop immediately; direct PBX calls stop after the app refreshes its settings. Calls already ringing or connected continue. Refresh to check an unavailable preference.").font(.caption).foregroundStyle(.secondary)
                        Button("Refresh managed accounts") { Task { await state.refreshManaged() } }.disabled(state.managedBusy)
                        Toggle("Message notifications", isOn: Binding(get: { state.messageNotificationsEnabled }, set: { value in
                            Task { await state.setMessageNotifications(value) }
                        }))
                        Text(state.messageNotificationStatus).font(.caption).foregroundStyle(.secondary)
                        Button("Sign out", role: .destructive) { confirmSignOut = true }.disabled(state.managedBusy)
                    } else {
                        Text("Sign in with the email invited by your organisation.").font(.subheadline).foregroundStyle(.secondary)
                        Button("Sign in to Sipper") { Task { await state.signIn() } }.disabled(state.managedBusy)
                    }
                    if client.isSigningIn {
                        Text(client.signInStatus ?? "Complete sign-in in your browser.").font(.subheadline).foregroundStyle(.secondary)
                        Button("Cancel sign-in") { client.cancelSignIn() }
                    }
                    Link("Open management portal", destination: client.serverURL.appendingPathComponent("portal"))
                    TextField("Setup link from your administrator", text: $state.setupLink)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .disabled(state.managedBusy)
                    Button("Connect with setup link") { Task { await state.connectSetupLink() } }
                        .disabled(state.managedBusy || !client.isSignedIn || state.setupLink.isEmpty)
                    Text("Sign in first, then paste your setup link. It works once and only for its intended person.").font(.caption).foregroundStyle(.secondary)
                    if let message = state.managedMessage { Text(message).font(.footnote).foregroundStyle(.secondary) }
                    if state.managedBusy { ProgressView().accessibilityLabel("Updating managed accounts") }
                }
            }
            Section {
                Link("Support", destination: URL(string: "https://sipper.dev/support")!)
                Link("Privacy", destination: URL(string: "https://sipper.dev/privacy")!)
                NavigationLink("Open-source licences") { MobileLicences() }
            }
        }
        .navigationTitle("Accounts")
        .sheet(item: $editor) { account in NavigationStack { MobileAccountEditor(account: account, password: state.saved(account.id)?.password ?? "") } }
        .confirmationDialog("Delete this account?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("Delete account", role: .destructive) {
                if let account = deleting { do { try state.remove(account) } catch { state.error = error.localizedDescription } }
                deleting = nil
            }
        } message: { Text("Its saved SIP password will be removed from this device.") }
        .confirmationDialog("Sign out of managed Sipper?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await state.signOut() } }
            Button("Cancel", role: .cancel) { }
        } message: { Text("Managed accounts and their saved credentials will be removed from this device. Calls already connected can finish. Your personal accounts are kept.") }
        .confirmationDialog("Disconnect \(disconnecting?.organisationName ?? "this customer")?", isPresented: Binding(get: { disconnecting != nil }, set: { if !$0 { disconnecting = nil } }), titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) {
                if let enrollment = disconnecting { Task { await state.disconnect(enrollment) } }
                disconnecting = nil
            }
            Button("Cancel", role: .cancel) { disconnecting = nil }
        } message: { Text("This customer’s managed accounts and shared contacts will be removed from this device. Calls already connected can finish. Personal accounts and other customers are kept.") }
    }
}

struct MobileImportView: View {
    @EnvironmentObject private var state: MobileState
    @State private var link = ""
    @State private var selected = Set<UUID>()
    @State private var message: String?
    var body: some View {
        Section("Import accounts") {
            if let review = state.importReview {
                Text("Review the accounts before saving. Saving connects enabled accounts to the servers shown below.").font(.subheadline)
                ForEach(review.candidates) { candidate in
                    Toggle(isOn: Binding(get: { selected.contains(candidate.id) }, set: { value in
                        if value { selected.insert(candidate.id) } else { selected.remove(candidate.id) }
                    })) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(String(candidate.account.displayLabel.prefix(160)))
                            Text(candidate.isUpdate ? "Update existing" : "New account").font(.caption).foregroundStyle(.secondary)
                            if candidate.isValid {
                                Text("\(candidate.account.username)@\(candidate.account.domain)").font(.caption)
                                Text("\(candidate.account.effectiveServer):\(String(candidate.account.effectivePort)) · \(candidate.account.transport.displayName)").font(.caption)
                                Text("Media encryption: \(candidate.account.srtp.displayName)").font(.caption).foregroundStyle(.secondary)
                            } else { Text(candidate.validationErrors.joined(separator: " ")).font(.caption).foregroundStyle(.red) }
                        }
                    }.disabled(!candidate.isValid)
                }
                Text("Existing accounts are not selected. Selecting one replaces its password and connection settings, keeping its identity, history, enabled state and security preferences. Managed accounts are separate.").font(.footnote).foregroundStyle(.secondary)
                Button("Import selected accounts") {
                    do { try state.importAccounts(selected: selected) } catch { message = error.localizedDescription }
                }.disabled(selected.isEmpty)
            } else {
                SecureField("Sipper import link", text: $link).textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive()
                Text("Paste a sipper://add-accounts link. The link contains passwords; Sipper does not upload it.").font(.footnote).foregroundStyle(.secondary)
                Button("Review accounts") {
                    do { try state.reviewImport(link); link = "" } catch { message = error.localizedDescription }
                }.disabled(link.isEmpty)
            }
            if let message { Text(message).font(.footnote).foregroundStyle(.red) }
            Button("Cancel", role: .cancel) { link = ""; state.cancelImport() }
        }.onAppear { selected = Set(state.importReview?.candidates.filter { $0.isValid && !$0.isUpdate }.map(\.id) ?? []) }
    }
}

struct MobileAccountEditor: View {
    @EnvironmentObject private var state: MobileState
    @Environment(\.dismiss) private var dismiss
    @State var account: SIPAccount
    @State var password: String
    @State private var port = ""
    @State private var message: String?
    var body: some View {
        Form {
            Section("Account") {
                TextField("Label", text: $account.label)
                TextField("Username", text: $account.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField("Password (if required)", text: $password).textContentType(.password)
                TextField("Domain", text: $account.domain).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                TextField("Server (optional)", text: $account.server).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
            }
            Section("Connection") {
                Picker("Transport", selection: $account.transport) { ForEach(SIPTransport.allCases) { Text($0.displayName).tag($0) } }
                TextField("Port (automatic)", text: $port).keyboardType(.numberPad)
                Picker("Media encryption", selection: $account.srtp) { ForEach(SRTPMode.allCases) { Text($0.displayName).tag($0) } }
                Toggle("Account enabled", isOn: $account.isEnabled)
            }
            Section("More settings") {
                TextField("Authentication username (optional)", text: $account.authUsername).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("Display name", text: $account.displayName)
                Toggle("Use ICE", isOn: $account.useICE)
            }
            if let message { Section { Text(message).foregroundStyle(.red) } }
        }.navigationTitle("SIP account").navigationBarTitleDisplayMode(.inline)
            .onAppear { port = account.port.map(String.init) ?? "" }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        guard port.isEmpty || Int(port) != nil else { message = "Enter a valid port number."; return }
                        account.port = port.isEmpty ? nil : Int(port)
                        do { try state.save(account, password: password); password = ""; dismiss() }
                        catch { message = error.localizedDescription }
                    }
                }
            }
    }
}

struct MobileLicences: View {
    private let directory = Bundle.main.resourceURL?.appendingPathComponent("Licenses")
    var body: some View {
        List {
            ForEach((try? FileManager.default.contentsOfDirectory(at: directory!, includingPropertiesForKeys: nil).sorted { $0.lastPathComponent < $1.lastPathComponent }) ?? [], id: \.self) { url in
                NavigationLink(url.deletingPathExtension().lastPathComponent) {
                    ScrollView { Text((try? String(contentsOf: url, encoding: .utf8)) ?? "Licence unavailable").font(.footnote).textSelection(.enabled).padding() }
                        .navigationTitle(url.deletingPathExtension().lastPathComponent).navigationBarTitleDisplayMode(.inline)
                }
            }
        }.navigationTitle("Licences")
    }
}
