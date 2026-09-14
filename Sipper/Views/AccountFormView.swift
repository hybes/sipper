import SwiftUI

struct AccountFormView: View {
    enum Mode: Hashable {
        case add(profileID: UUID?)
        case edit(UUID)
    }

    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    let mode: Mode

    @State private var draft = SIPAccount(profileID: UUID(), username: "", domain: "")
    @State private var password = ""
    @State private var originalPassword = ""
    @State private var showPassword = false
    @State private var portText = ""
    @State private var showAdvanced = false
    @State private var loaded = false
    @State private var saveError: String?

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section {
                    TextField("Label", text: $draft.label, prompt: Text(draft.defaultLabel.isEmpty || draft.username.isEmpty ? "Optional" : draft.defaultLabel))
                    Picker("Profile", selection: $draft.profileID) {
                        ForEach(state.profiles) { profile in
                            Text(profile.name).tag(profile.id)
                        }
                    }
                    Toggle("Enabled", isOn: $draft.isEnabled)
                }

                Section("Credentials") {
                    TextField("Username", text: $draft.username, prompt: Text("Extension, e.g. 1001"))
                        .autocorrectionDisabled()
                    HStack {
                        Group {
                            if showPassword {
                                TextField("Password", text: $password)
                            } else {
                                SecureField("Password", text: $password)
                            }
                        }
                        Button {
                            showPassword.toggle()
                        } label: {
                            Image(systemName: showPassword ? "eye.slash" : "eye")
                        }
                        .buttonStyle(.borderless)
                        .help(showPassword ? "Hide password" : "Show password")
                    }
                    TextField("Auth username", text: $draft.authUsername, prompt: Text("Same as username"))
                        .autocorrectionDisabled()
                }

                Section("Server") {
                    TextField("Domain", text: $draft.domain, prompt: Text("pbx.example.com"))
                        .autocorrectionDisabled()
                    TextField("Outbound proxy", text: $draft.server, prompt: Text("Same as domain"))
                        .autocorrectionDisabled()
                    Picker("Transport", selection: $draft.transport) {
                        ForEach(SIPTransport.allCases) { Text($0.displayName).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    TextField("Port", text: $portText, prompt: Text(String(draft.transport.defaultPort)))
                }

                Section {
                    DisclosureGroup("Advanced", isExpanded: $showAdvanced) {
                        TextField("Display name", text: $draft.displayName, prompt: Text("Shown to people you call"))
                        Stepper("Registration expiry: \(String(draft.registrationExpiry)) s", value: $draft.registrationExpiry, in: 60...86400, step: 60)
                        Picker("Media encryption (SRTP)", selection: $draft.srtp) {
                            ForEach(SRTPMode.allCases) { Text($0.displayName).tag($0) }
                        }
                        TextField("STUN server", text: $draft.stunServer, prompt: Text("Uses the global setting when empty"))
                            .autocorrectionDisabled()
                        Toggle("Use ICE", isOn: $draft.useICE)
                        TextField("Voicemail number", text: $draft.voicemailNumber)
                        TextField("Caller ID name", text: $draft.callerIDName)
                        TextField("Caller ID number", text: $draft.callerIDNumber)
                        TextField("Notes", text: $draft.notes, axis: .vertical)
                            .lineLimit(2...4)
                    }
                }
            }
            .formStyle(.grouped)

            Divider()
            HStack(alignment: .center) {
                if let message = validationMessage {
                    Label(message, systemImage: "exclamationmark.circle")
                        .font(.callout)
                        .foregroundStyle(.red)
                        .lineLimit(2)
                }
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(isEditing ? "Save" : "Add Account") { save() }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(validationMessage != nil)
            }
            .padding(14)
        }
        .frame(width: 540, height: 560)
        .onAppear(perform: load)
        .onChange(of: draft.transport) { _, _ in
            // A port equal to the previous transport default follows the new default.
            if let port = Int(portText), SIPTransport.allCases.contains(where: { $0.defaultPort == port }) {
                portText = ""
            }
        }
    }

    private var isEditing: Bool {
        if case .edit = mode { return true }
        return false
    }

    private var editedID: UUID? {
        if case .edit(let id) = mode { return id }
        return nil
    }

    private var validationMessage: String? {
        if let saveError { return saveError }
        var candidate = draft
        candidate.port = parsedPort
        if !portIsValid {
            return "Port must be a number between 1 and 65535."
        }
        if let error = candidate.validationErrors.first { return error }
        if password.isEmpty { return "Password is required." }
        if let duplicate = state.duplicateAccount(username: candidate.username.trimmingCharacters(in: .whitespaces),
                                                  domain: candidate.domain.trimmingCharacters(in: .whitespaces),
                                                  excluding: editedID) {
            let profileName = state.profile(for: duplicate.profileID)?.name ?? "another profile"
            return "\(duplicate.displayLabel) already exists in \(profileName)."
        }
        return nil
    }

    private var portIsValid: Bool {
        let trimmed = portText.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return true }
        guard let value = Int(trimmed) else { return false }
        return (1...65535).contains(value)
    }

    private var parsedPort: Int? {
        let trimmed = portText.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return nil }
        guard let value = Int(trimmed), (1...65535).contains(value) else { return nil }
        return value == draft.transport.defaultPort ? nil : value
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        switch mode {
        case .add(let profileID):
            let target = profileID.flatMap { state.profile(for: $0)?.id } ?? state.profiles.first?.id ?? UUID()
            draft = SIPAccount(profileID: target, username: "", domain: "", transport: state.settings.defaultTransport)
        case .edit(let id):
            if let existing = state.account(for: id) {
                draft = existing
                password = state.password(for: id)
                originalPassword = password
                portText = existing.port.map(String.init) ?? ""
                showAdvanced = !existing.stunServer.isEmpty || existing.useICE || existing.srtp != .disabled
                    || !existing.displayName.isEmpty || !existing.notes.isEmpty
            }
        }
    }

    private func save() {
        var account = draft
        account.label = account.label.trimmingCharacters(in: .whitespaces)
        account.username = account.username.trimmingCharacters(in: .whitespaces)
        account.authUsername = account.authUsername.trimmingCharacters(in: .whitespaces)
        if account.authUsername == account.username { account.authUsername = "" }
        account.domain = account.domain.trimmingCharacters(in: .whitespaces)
        account.server = account.server.trimmingCharacters(in: .whitespaces)
        if account.server.caseInsensitiveCompare(account.domain) == .orderedSame { account.server = "" }
        account.stunServer = account.stunServer.trimmingCharacters(in: .whitespaces)
        account.voicemailNumber = account.voicemailNumber.trimmingCharacters(in: .whitespaces)
        if account.voicemailNumber.isEmpty { account.voicemailNumber = "*97" }
        account.port = parsedPort
        do {
            if isEditing {
                try state.updateAccount(account, password: password == originalPassword ? nil : password)
            } else {
                let added = try state.addAccount(account, password: password)
                state.selection = .account(added.id)
            }
            dismiss()
        } catch {
            saveError = error.localizedDescription
        }
    }
}

struct ProfileFormView: View {
    enum Mode: Hashable {
        case add
        case edit(UUID)
    }

    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    let mode: Mode

    @State private var draft = Profile(name: "")
    @State private var loaded = false

    private let iconColumns = Array(repeating: GridItem(.fixed(36), spacing: 6), count: 8)

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section {
                    TextField("Name", text: $draft.name, prompt: Text("e.g. Office PBX"))
                    Toggle("Enabled", isOn: $draft.isEnabled)
                }
                Section("Colour") {
                    HStack(spacing: 10) {
                        ForEach(ProfileColor.allCases) { color in
                            Button {
                                draft.colorName = color
                            } label: {
                                Circle()
                                    .fill(color.color)
                                    .frame(width: 22, height: 22)
                                    .overlay {
                                        if draft.colorName == color {
                                            Image(systemName: "checkmark").font(.caption.bold()).foregroundStyle(.white)
                                        }
                                    }
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(color.displayName)
                        }
                    }
                }
                Section("Icon") {
                    LazyVGrid(columns: iconColumns, spacing: 6) {
                        ForEach(ProfileIcon.choices, id: \.self) { icon in
                            Button {
                                draft.iconName = icon
                            } label: {
                                Image(systemName: icon)
                                    .frame(width: 34, height: 30)
                                    .background(draft.iconName == icon ? draft.colorName.color.opacity(0.25) : Color.clear,
                                                in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(icon)
                        }
                    }
                }
            }
            .formStyle(.grouped)
            Divider()
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(isEditing ? "Save" : "Add Profile") { save() }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(draft.name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(14)
        }
        .frame(width: 440, height: 400)
        .onAppear(perform: load)
    }

    private var isEditing: Bool {
        if case .edit = mode { return true }
        return false
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        if case .edit(let id) = mode, let existing = state.profile(for: id) {
            draft = existing
        }
    }

    private func save() {
        if isEditing {
            var profile = draft
            profile.name = profile.name.trimmingCharacters(in: .whitespaces)
            state.updateProfile(profile)
        } else {
            var profile = state.addProfile(name: draft.name, color: draft.colorName, icon: draft.iconName)
            if !draft.isEnabled {
                profile.isEnabled = false
                state.updateProfile(profile)
            }
            state.selection = .profile(profile.id)
        }
        dismiss()
    }
}
