import SwiftUI

struct AccountDetailView: View {
    @EnvironmentObject private var state: AppState
    let accountID: UUID
    @Binding var sheet: MainSheet?
    @State private var quickDial = ""
    @State private var confirmDelete = false

    private var account: SIPAccount? { state.account(for: accountID) }

    var body: some View {
        if let account {
            content(account)
                .navigationTitle(account.displayLabel)
                .toolbar {
                    ToolbarItemGroup(placement: .primaryAction) {
                        Button("Re-register") { state.reRegister(account.id) }
                            .disabled(!account.isEnabled)
                        Button("Edit…") { sheet = .editAccount(account.id) }
                    }
                }
                .confirmationDialog("Delete \(account.displayLabel)?", isPresented: $confirmDelete) {
                    Button("Delete Account", role: .destructive) { state.deleteAccount(account.id) }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("The account is unregistered and its password removed from the Keychain.")
                }
        } else {
            ContentUnavailableView("Account removed", systemImage: "person.crop.circle.badge.xmark", description: Text(""))
        }
    }

    private func content(_ account: SIPAccount) -> some View {
        let registration = state.registration(for: account.id)
        let profile = state.profile(for: account.profileID)
        let profileEnabled = profile?.isEnabled ?? true
        let voicemail = state.voicemail[account.id] ?? .none

        return ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack(alignment: .top, spacing: 14) {
                    StatusDot(state: account.isEnabled && profileEnabled ? registration : .unregistered, size: 14)
                        .padding(.top, 8)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(account.displayLabel).font(.title2.weight(.semibold))
                        Group {
                            if account.isEnabled && profileEnabled {
                                RegistrationDetailText(state: registration)
                            } else {
                                Text(account.isEnabled ? "Profile disabled" : "Account disabled")
                            }
                        }
                        .foregroundStyle(registration.isFailed && account.isEnabled ? Color.red : Color.secondary)
                        if let profile {
                            HStack(spacing: 4) {
                                Image(systemName: profile.iconName).foregroundStyle(profile.colorName.color)
                                Text(profile.name)
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Toggle("Enabled", isOn: Binding(get: { account.isEnabled },
                                                    set: { state.setAccountEnabled(account.id, enabled: $0) }))
                        .toggleStyle(.switch)
                }

                if !state.engineIsRunning, let error = state.engineError {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .font(.callout)
                }

                GroupBox("Quick call") {
                    HStack {
                        TextField("Number or SIP address", text: $quickDial)
                            .textFieldStyle(.roundedBorder)
                            .onSubmit { placeQuickCall(account) }
                        Button {
                            placeQuickCall(account)
                        } label: {
                            Label("Call", systemImage: "phone.fill")
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.green)
                        .disabled(quickDial.trimmingCharacters(in: .whitespaces).isEmpty)
                        Button {
                            state.callVoicemail(for: account.id)
                        } label: {
                            Label(voicemail.newCount > 0 ? "Voicemail (\(voicemail.newCount))" : "Voicemail",
                                  systemImage: voicemail.newCount > 0 ? "envelope.badge.fill" : "recordingtape")
                        }
                        .help("Dial \(account.voicemailNumber)")
                    }
                    .padding(.vertical, 4)
                }

                GroupBox("Connection") {
                    Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 8) {
                        detailRow("Username", account.username)
                        if !account.authUsername.isEmpty { detailRow("Auth username", account.authUsername) }
                        detailRow("Domain", account.domain)
                        detailRow("Server", account.usesSeparateServer ? account.effectiveServer : "Same as domain")
                        detailRow("Transport", "\(account.transport.displayName) · port \(account.effectivePort)")
                        detailRow("Registration", "Every \(account.registrationExpiry) s")
                        detailRow("SRTP", account.srtp.displayName)
                        if !account.stunServer.isEmpty { detailRow("STUN", account.stunServer) }
                        if account.useICE { detailRow("ICE", "Enabled") }
                        if !account.displayName.isEmpty { detailRow("Display name", account.displayName) }
                        if !account.callerIDName.isEmpty || !account.callerIDNumber.isEmpty {
                            detailRow("Caller ID", "\(account.callerIDName) \(account.callerIDNumber)".trimmingCharacters(in: .whitespaces))
                        }
                        detailRow("Voicemail", account.voicemailNumber)
                        detailRow("Address of record", account.addressOfRecord)
                        if account.source != "manual" { detailRow("Source", account.source) }
                    }
                    .padding(.vertical, 4)
                    .textSelection(.enabled)
                }

                if !account.notes.isEmpty {
                    GroupBox("Notes") {
                        Text(account.notes).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
                    }
                }

                let recent = state.history.filter { $0.accountID == account.id }.prefix(10)
                if !recent.isEmpty {
                    GroupBox("Recent calls") {
                        VStack(spacing: 0) {
                            ForEach(Array(recent)) { record in
                                HistoryRow(record: record, sheet: $sheet)
                                    .padding(.vertical, 4)
                                if record.id != recent.last?.id { Divider() }
                            }
                        }
                    }
                }

                HStack {
                    Spacer()
                    Button("Delete Account…", role: .destructive) { confirmDelete = true }
                }
            }
            .padding(24)
            .frame(maxWidth: 640, alignment: .leading)
        }
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary).gridColumnAlignment(.trailing)
            Text(value).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func placeQuickCall(_ account: SIPAccount) {
        state.call(quickDial, from: account.id)
        quickDial = ""
    }
}

struct ProfileDetailView: View {
    @EnvironmentObject private var state: AppState
    let profileID: UUID
    @Binding var sheet: MainSheet?

    var body: some View {
        if let profile = state.profile(for: profileID) {
            let members = state.accounts(in: profile.id)
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack(spacing: 12) {
                        Image(systemName: profile.iconName)
                            .font(.title)
                            .foregroundStyle(profile.colorName.color)
                            .frame(width: 44, height: 44)
                            .background(profile.colorName.color.opacity(0.15), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(profile.name).font(.title2.weight(.semibold))
                            Text(summary(members, enabled: profile.isEnabled))
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Toggle("Enabled", isOn: Binding(get: { profile.isEnabled },
                                                        set: { state.setProfileEnabled(profile.id, enabled: $0) }))
                            .toggleStyle(.switch)
                    }

                    if members.isEmpty {
                        ContentUnavailableView {
                            Label("No accounts in this profile", systemImage: "person.crop.circle.badge.plus")
                        } description: {
                            Text("Add an account or move one here from another profile.")
                        } actions: {
                            Button("Add Account…") { sheet = .addAccount(profileID: profile.id) }
                        }
                        .frame(height: 220)
                    } else {
                        VStack(spacing: 0) {
                            ForEach(members) { account in
                                let registration = state.registration(for: account.id)
                                HStack(spacing: 10) {
                                    StatusDot(state: account.isEnabled && profile.isEnabled ? registration : .unregistered)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(account.displayLabel)
                                        Text("\(account.username)@\(account.domain) · \(account.transport.displayName)")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text(account.isEnabled && profile.isEnabled ? registration.shortLabel : "Disabled")
                                        .font(.caption)
                                        .foregroundStyle(registration.isFailed && account.isEnabled ? Color.red : Color.secondary)
                                    Button("Show") { state.selection = .account(account.id) }
                                }
                                .padding(.vertical, 8)
                                .contentShape(Rectangle())
                                .onTapGesture(count: 2) { state.selection = .account(account.id) }
                                if account.id != members.last?.id { Divider() }
                            }
                        }
                        .padding(.horizontal, 12)
                        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                }
                .padding(24)
                .frame(maxWidth: 640, alignment: .leading)
            }
            .navigationTitle(profile.name)
            .toolbar {
                ToolbarItemGroup(placement: .primaryAction) {
                    Button {
                        sheet = .addAccount(profileID: profile.id)
                    } label: {
                        Label("Add Account", systemImage: "person.badge.plus")
                    }
                    Button("Edit…") { sheet = .editProfile(profile.id) }
                }
            }
        } else {
            ContentUnavailableView("Profile removed", systemImage: "folder.badge.minus", description: Text(""))
        }
    }

    private func summary(_ members: [SIPAccount], enabled: Bool) -> String {
        guard enabled else { return "Disabled · \(members.count) account(s)" }
        let registered = members.filter { state.registration(for: $0.id).isRegistered }.count
        return "\(registered) of \(members.count) registered"
    }
}
