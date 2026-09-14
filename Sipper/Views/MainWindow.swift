import SwiftUI

enum MainSheet: Identifiable, Hashable {
    case addAccount(profileID: UUID?)
    case editAccount(UUID)
    case addProfile
    case editProfile(UUID)
    case addContact(number: String?, name: String?)
    case editContact(UUID)
    case importAccounts

    var id: String {
        switch self {
        case .addAccount(let p): return "addAccount-\(p?.uuidString ?? "")"
        case .editAccount(let id): return "editAccount-\(id)"
        case .addProfile: return "addProfile"
        case .editProfile(let id): return "editProfile-\(id)"
        case .addContact: return "addContact"
        case .editContact(let id): return "editContact-\(id)"
        case .importAccounts: return "import"
        }
    }
}

struct MainWindow: View {
    @EnvironmentObject private var state: AppState
    @State private var sheet: MainSheet?
    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            SidebarView(sheet: $sheet)
                .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 360)
        } detail: {
            VStack(spacing: 0) {
                if state.hasActiveCalls, state.selection != .dialer, state.selection != nil {
                    CallBanner()
                    Divider()
                }
                detail
            }
        }
        .sheet(item: $sheet) { sheet in
            sheetView(sheet)
                .environmentObject(state)
        }
        .alert(state.alert?.title ?? "",
               isPresented: Binding(get: { state.alert != nil }, set: { if !$0 { state.alert = nil } }),
               presenting: state.alert) { _ in
            Button("OK", role: .cancel) {}
        } message: { alert in
            Text(alert.message)
        }
        .onChange(of: state.pendingImport != nil) { _, hasImport in
            if hasImport { sheet = .importAccounts } else if sheet == .importAccounts { sheet = nil }
        }
        .onReceive(NotificationCenter.default.publisher(for: .sipperAddAccount)) { _ in
            sheet = .addAccount(profileID: currentProfileID)
        }
        .onReceive(NotificationCenter.default.publisher(for: .sipperAddProfile)) { _ in
            sheet = .addProfile
        }
        .onAppear {
            if state.pendingImport != nil { sheet = .importAccounts }
        }
    }

    private var currentProfileID: UUID? {
        switch state.selection {
        case .profile(let id): return id
        case .account(let id): return state.account(for: id)?.profileID
        default: return nil
        }
    }

    @ViewBuilder
    private var detail: some View {
        switch state.selection ?? .dialer {
        case .dialer:
            DialerView(sheet: $sheet)
        case .history:
            HistoryView(sheet: $sheet)
        case .contacts:
            ContactsView(sheet: $sheet)
        case .account(let id):
            if state.account(for: id) != nil {
                AccountDetailView(accountID: id, sheet: $sheet)
            } else {
                DialerView(sheet: $sheet)
            }
        case .profile(let id):
            if state.profile(for: id) != nil {
                ProfileDetailView(profileID: id, sheet: $sheet)
            } else {
                DialerView(sheet: $sheet)
            }
        }
    }

    @ViewBuilder
    private func sheetView(_ sheet: MainSheet) -> some View {
        switch sheet {
        case .addAccount(let profileID):
            AccountFormView(mode: .add(profileID: profileID))
        case .editAccount(let id):
            AccountFormView(mode: .edit(id))
        case .addProfile:
            ProfileFormView(mode: .add)
        case .editProfile(let id):
            ProfileFormView(mode: .edit(id))
        case .addContact(let number, let name):
            ContactFormView(mode: .add(number: number, name: name))
        case .editContact(let id):
            ContactFormView(mode: .edit(id))
        case .importAccounts:
            ImportSheet()
        }
    }
}

/// Compact strip shown above non-dialer sections while a call is active.
struct CallBanner: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        if let call = state.activeCall {
            HStack(spacing: 12) {
                Image(systemName: call.state == .incoming ? "phone.arrow.down.left.fill" : "phone.fill")
                    .foregroundStyle(call.state == .incoming ? Color.green : Color.accentColor)
                VStack(alignment: .leading, spacing: 1) {
                    Text(call.displayName).font(.headline).lineLimit(1)
                    HStack(spacing: 6) {
                        CallStatusText(call: call)
                        if call.isRecording {
                            Label("Recording", systemImage: "record.circle.fill").foregroundStyle(.red)
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                Spacer()
                if state.calls.count > 1 {
                    Text("\(state.calls.count) calls").font(.caption).foregroundStyle(.secondary)
                }
                if call.state == .incoming {
                    Button("Answer") { state.answer(callID: call.id) }
                        .buttonStyle(.borderedProminent).tint(.green)
                    Button("Decline") { state.decline(callID: call.id) }
                        .buttonStyle(.bordered).tint(.red)
                } else {
                    BannerIconButton(systemImage: call.isMuted ? "mic.slash.fill" : "mic.fill",
                                     help: call.isMuted ? "Unmute" : "Mute",
                                     isActive: call.isMuted,
                                     isEnabled: call.state == .confirmed) {
                        state.toggleMute(callID: call.id)
                    }
                    BannerIconButton(systemImage: call.isOnHold ? "play.fill" : "pause.fill",
                                     help: call.isOnHold ? "Resume" : "Hold",
                                     isActive: call.isOnHold,
                                     isEnabled: call.state == .confirmed) {
                        state.toggleHold(callID: call.id)
                    }
                    BannerIconButton(systemImage: "phone.down.fill", help: "Hang up", tint: .red) {
                        state.hangup(callID: call.id)
                    }
                }
                Button("Show") { state.selection = .dialer }
                    .controlSize(.regular)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(.bar)
        }
    }
}

/// Fixed-size icon button so banner and panel controls line up regardless of glyph width.
struct BannerIconButton: View {
    let systemImage: String
    let help: String
    var isActive = false
    var isEnabled = true
    var tint: Color? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 13, weight: .semibold))
                .frame(width: 22, height: 16)
        }
        .buttonStyle(.borderedProminent)
        .tint(tint ?? (isActive ? Color.accentColor : Color.secondary.opacity(0.35)))
        .foregroundStyle(tint != nil || isActive ? Color.white : Color.primary)
        .controlSize(.regular)
        .disabled(!isEnabled)
        .help(help)
        .accessibilityLabel(help)
    }
}

/// "Calling…", "Ringing…", running timer, hold state.
struct CallStatusText: View {
    let call: CallSnapshot

    var body: some View {
        switch call.state {
        case .calling: Text("Calling…")
        case .incoming: Text("Incoming call")
        case .early: Text("Ringing…")
        case .connecting: Text("Connecting…")
        case .confirmed:
            if call.isOnHold {
                Text("On hold")
            } else if call.isRemoteHold {
                Text("Held by the other party")
            } else {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(DurationText.format(context.date.timeIntervalSince(call.connectedAt ?? context.date)))
                        .monospacedDigit()
                }
            }
        case .disconnected: Text("Ended")
        }
    }
}
