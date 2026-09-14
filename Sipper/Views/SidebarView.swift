import SwiftUI

struct SidebarView: View {
    @EnvironmentObject private var state: AppState
    @Binding var sheet: MainSheet?
    @State private var collapsed: Set<UUID> = []
    @State private var accountToDelete: SIPAccount?
    @State private var profileToDelete: Profile?

    var body: some View {
        List(selection: $state.selection) {
            Section("Phone") {
                Label("Dialer", systemImage: "circle.grid.3x3.fill")
                    .tag(SidebarItem.dialer)
                HStack {
                    Label("History", systemImage: "clock")
                    Spacer()
                    if state.unseenMissedCalls > 0 {
                        Text("\(state.unseenMissedCalls)")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.red, in: Capsule())
                            .foregroundStyle(.white)
                            .accessibilityLabel("\(state.unseenMissedCalls) missed calls")
                    }
                }
                .tag(SidebarItem.history)
                Label("Contacts", systemImage: "person.crop.circle")
                    .tag(SidebarItem.contacts)
            }

            ForEach(state.profiles) { profile in
                Section(isExpanded: expandedBinding(for: profile.id)) {
                    let members = state.accounts(in: profile.id)
                    if members.isEmpty {
                        Button {
                            sheet = .addAccount(profileID: profile.id)
                        } label: {
                            Label("Add account", systemImage: "plus.circle")
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                    ForEach(members) { account in
                        AccountRow(account: account, profileEnabled: profile.isEnabled)
                            .tag(SidebarItem.account(account.id))
                            .contextMenu { accountMenu(account) }
                    }
                    .onMove { offsets, target in
                        state.moveAccounts(in: profile.id, fromOffsets: offsets, toOffset: target)
                    }
                } header: {
                    ProfileHeader(profile: profile, sheet: $sheet, profileToDelete: $profileToDelete)
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) { bottomBar }
        .confirmationDialog("Delete \(accountToDelete?.displayLabel ?? "account")?",
                            isPresented: Binding(get: { accountToDelete != nil }, set: { if !$0 { accountToDelete = nil } }),
                            presenting: accountToDelete) { account in
            Button("Delete Account", role: .destructive) { state.deleteAccount(account.id) }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("The account is unregistered and its password removed from the Keychain. Call history is kept.")
        }
        .confirmationDialog("Delete profile \(profileToDelete?.name ?? "")?",
                            isPresented: Binding(get: { profileToDelete != nil }, set: { if !$0 { profileToDelete = nil } }),
                            presenting: profileToDelete) { profile in
            let others = state.profiles.filter { $0.id != profile.id }
            ForEach(others) { other in
                Button("Move accounts to \(other.name)") { state.deleteProfile(profile.id, moveAccountsTo: other.id) }
            }
            Button("Delete profile and its accounts", role: .destructive) { state.deleteProfile(profile.id, moveAccountsTo: nil) }
            Button("Cancel", role: .cancel) {}
        } message: { profile in
            Text("\(state.accounts(in: profile.id).count) account(s) belong to this profile.")
        }
    }

    private func expandedBinding(for id: UUID) -> Binding<Bool> {
        Binding(get: { !collapsed.contains(id) },
                set: { expanded in if expanded { collapsed.remove(id) } else { collapsed.insert(id) } })
    }

    @ViewBuilder
    private func accountMenu(_ account: SIPAccount) -> some View {
        Button("Call from this account") {
            state.dialerAccountID = account.id
            state.selection = .dialer
            NotificationCenter.default.post(name: .sipperFocusDialer, object: nil)
        }
        Button("Call voicemail") { state.callVoicemail(for: account.id) }
        Divider()
        Button("Re-register") { state.reRegister(account.id) }
            .disabled(!account.isEnabled)
        Button(account.isEnabled ? "Disable" : "Enable") { state.setAccountEnabled(account.id, enabled: !account.isEnabled) }
        Button("Edit…") { sheet = .editAccount(account.id) }
        if state.profiles.count > 1 {
            Menu("Move to") {
                ForEach(state.profiles.filter { $0.id != account.profileID }) { profile in
                    Button(profile.name) { state.moveAccount(account.id, to: profile.id) }
                }
            }
        }
        Divider()
        Button("Delete…", role: .destructive) { accountToDelete = account }
    }

    private var bottomBar: some View {
        HStack {
            Menu {
                Button("Add Account…") { sheet = .addAccount(profileID: nil) }
                Button("Add Profile…") { sheet = .addProfile }
            } label: {
                Image(systemName: "plus")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Add an account or profile")
            Spacer()
            engineStatus
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    @ViewBuilder
    private var engineStatus: some View {
        if let error = state.engineError {
            Label("Engine stopped", systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.red)
                .help(error)
        } else if state.settings.doNotDisturb {
            Label("Do Not Disturb", systemImage: "moon.fill")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else {
            let registered = state.registeredAccounts.count
            Text(registered == 0 ? "No accounts registered" : "\(registered) registered")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

struct AccountRow: View {
    @EnvironmentObject private var state: AppState
    let account: SIPAccount
    let profileEnabled: Bool

    var body: some View {
        let registration = state.registration(for: account.id)
        HStack(spacing: 8) {
            StatusDot(state: account.isEnabled && profileEnabled ? registration : .unregistered)
            VStack(alignment: .leading, spacing: 1) {
                Text(account.displayLabel)
                    .lineLimit(1)
                    .foregroundStyle(account.isEnabled && profileEnabled ? .primary : .secondary)
                Text(account.isEnabled && profileEnabled ? registration.shortLabel : "Disabled")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            if let vm = state.voicemail[account.id], vm.newCount > 0 {
                Label("\(vm.newCount)", systemImage: "envelope.badge.fill")
                    .labelStyle(.titleAndIcon)
                    .font(.caption)
                    .foregroundStyle(Color.accentColor)
                    .help("\(vm.newCount) new voicemail message(s)")
            }
            if state.calls.contains(where: { $0.accountID == account.id }) {
                Image(systemName: "phone.fill")
                    .font(.caption)
                    .foregroundStyle(.green)
                    .help("In a call")
            }
        }
        .padding(.vertical, 1)
    }
}

struct ProfileHeader: View {
    @EnvironmentObject private var state: AppState
    let profile: Profile
    @Binding var sheet: MainSheet?
    @Binding var profileToDelete: Profile?

    var body: some View {
        HStack(spacing: 6) {
            Button {
                state.selection = .profile(profile.id)
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: profile.iconName)
                        .foregroundStyle(profile.isEnabled ? profile.colorName.color : Color.secondary)
                        .frame(width: 14)
                    Text(profile.name)
                        .foregroundStyle(profile.isEnabled ? .primary : .secondary)
                }
            }
            .buttonStyle(.plain)
            .help("Show profile")
            Spacer()
            Menu {
                Button("Add Account…") { sheet = .addAccount(profileID: profile.id) }
                Button("Edit Profile…") { sheet = .editProfile(profile.id) }
                Button(profile.isEnabled ? "Disable Profile" : "Enable Profile") {
                    state.setProfileEnabled(profile.id, enabled: !profile.isEnabled)
                }
                if state.profiles.count > 1 {
                    Divider()
                    Button("Delete Profile…", role: .destructive) { profileToDelete = profile }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
        }
    }
}
