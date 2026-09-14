import SwiftUI

/// Confirms accounts handed over by the browser extension (or any sipper:// link).
struct ImportSheet: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss

    private enum ProfileChoice: Hashable {
        case existing(UUID)
        case new
    }

    @State private var selected: Set<UUID> = []
    @State private var profileChoice: ProfileChoice = .new
    @State private var newProfileName = ""
    @State private var loaded = false

    var body: some View {
        VStack(spacing: 0) {
            if let request = state.pendingImport {
                content(request)
            } else {
                ContentUnavailableView("Nothing to import", systemImage: "tray", description: Text(""))
                    .frame(height: 200)
            }
        }
        .frame(width: 600)
        .onAppear(perform: load)
    }

    private func content(_ request: ImportRequest) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                Text(title(request)).font(.title2.weight(.semibold))
                if let url = request.sourceURL {
                    Text(url).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        .textSelection(.enabled)
                }
            }
            .padding(20)

            Divider()

            List {
                ForEach(request.candidates) { candidate in
                    row(candidate)
                }
            }
            .frame(minHeight: 180, maxHeight: 320)

            Divider()

            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Profile")
                    Picker("Profile", selection: $profileChoice) {
                        ForEach(state.profiles) { profile in
                            Text(profile.name).tag(ProfileChoice.existing(profile.id))
                        }
                        Text("New profile").tag(ProfileChoice.new)
                    }
                    .labelsHidden()
                    .frame(maxWidth: 220)
                    if profileChoice == .new {
                        TextField("Profile name", text: $newProfileName)
                            .textFieldStyle(.roundedBorder)
                    }
                }
                if request.candidates.contains(where: \.isUpdate) {
                    Text("Accounts marked “update existing” already exist and are not selected. Tick one to replace its password and connection settings; its profile and history are kept.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(20)

            Divider()

            HStack {
                Text(summary(request)).font(.callout).foregroundStyle(.secondary)
                Spacer()
                Button("Cancel") {
                    state.cancelImport()
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)
                Button(importTitle) {
                    let choice: AppState.ImportProfileChoice
                    switch profileChoice {
                    case .existing(let id): choice = .existing(id)
                    case .new: choice = .new(newProfileName.trimmingCharacters(in: .whitespaces).isEmpty ? (request.profileName ?? "Imported") : newProfileName)
                    }
                    state.commitImport(request, selected: selected, profile: choice)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(selectedValidCount(request) == 0 || (profileChoice == .new && newProfileName.trimmingCharacters(in: .whitespaces).isEmpty && request.profileName == nil))
            }
            .padding(14)
        }
    }

    private func row(_ candidate: ImportCandidate) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Toggle("", isOn: Binding(get: { selected.contains(candidate.id) },
                                     set: { on in if on { selected.insert(candidate.id) } else { selected.remove(candidate.id) } }))
                .labelsHidden()
                .disabled(!candidate.isValid)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(candidate.account.displayLabel).font(.body.weight(.medium))
                    if candidate.isUpdate {
                        Text("update existing")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Color.orange.opacity(0.2), in: Capsule())
                    } else if candidate.isValid {
                        Text("new")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Color.green.opacity(0.2), in: Capsule())
                    }
                }
                Text("\(candidate.account.username)@\(candidate.account.domain) · \(candidate.account.transport.displayName) · \(candidate.account.effectiveServer):\(String(candidate.account.effectivePort))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if !candidate.validationErrors.isEmpty {
                    Text(candidate.validationErrors.joined(separator: " "))
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            Spacer()
        }
        .padding(.vertical, 3)
    }

    private func title(_ request: ImportRequest) -> String {
        let source = request.provider == "manual" ? "" : " from \(request.provider == "fusionpbx" ? "FusionPBX" : request.provider)"
        let count = request.candidates.count
        return count == 1 ? "Add 1 account\(source)" : "Add \(count) accounts\(source)"
    }

    private var importTitle: String {
        let count = selected.count
        return count == 1 ? "Import 1 Account" : "Import \(count) Accounts"
    }

    private func selectedValidCount(_ request: ImportRequest) -> Int {
        request.candidates.filter { selected.contains($0.id) && $0.isValid }.count
    }

    private func summary(_ request: ImportRequest) -> String {
        let invalid = request.candidates.filter { !$0.isValid }.count
        return invalid == 0 ? "\(selected.count) of \(request.candidates.count) selected" : "\(selected.count) selected · \(invalid) cannot be imported"
    }

    private func load() {
        guard !loaded, let request = state.pendingImport else { return }
        loaded = true
        selected = Set(request.candidates.filter { $0.isValid && !$0.isUpdate }.map(\.id))
        if let name = request.profileName,
           let existing = state.profiles.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) {
            profileChoice = .existing(existing.id)
        } else if let name = request.profileName {
            profileChoice = .new
            newProfileName = name
        } else if let first = state.profiles.first {
            profileChoice = .existing(first.id)
        }
    }
}
