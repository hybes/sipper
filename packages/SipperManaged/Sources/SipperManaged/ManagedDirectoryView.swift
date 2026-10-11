import SwiftUI

public struct ManagedDirectoryCallingAccount: Identifiable, Equatable {
    public let id: UUID
    public let label: String
    public let organisationID: UUID
    public let deviceID: UUID
    public let expiresAt: Date

    public init(id: UUID, label: String, organisationID: UUID, deviceID: UUID, expiresAt: Date) {
        self.id = id; self.label = label; self.organisationID = organisationID; self.deviceID = deviceID; self.expiresAt = expiresAt
    }
    public func belongs(to enrollment: ManagedEnrollment, now: Date = Date()) -> Bool {
        organisationID == enrollment.organisationID && deviceID == enrollment.deviceID && expiresAt > now
    }
}

/// The same read-only company directory on Mac and iOS. Hosts recheck the calling account before dialling.
public struct ManagedDirectoryView: View {
    @ObservedObject private var client: ManagedClient
    private let accounts: [ManagedDirectoryCallingAccount]
    private let onCall: (ManagedEnrollment, UUID, String, UUID) async throws -> Void
    @State private var selectedDevice: UUID?
    @State private var selectedAccount: UUID?
    @State private var search = ""
    @State private var loadingDevice: UUID?
    @State private var errors: [UUID: String] = [:]
    @State private var calling = false
    @State private var expandedContact: UUID?

    public init(client: ManagedClient, accounts: [ManagedDirectoryCallingAccount], onCall: @escaping (ManagedEnrollment, UUID, String, UUID) async throws -> Void) {
        self.client = client; self.accounts = accounts; self.onCall = onCall
    }
    private var enrollment: ManagedEnrollment? { client.enrollments.first { $0.deviceID == selectedDevice } }
    private var eligible: [ManagedDirectoryCallingAccount] {
        guard client.isSignedIn, let enrollment else { return [] }
        return accounts.filter { $0.belongs(to: enrollment) }
    }
    private var accountID: UUID? { eligible.first(where: { $0.id == selectedAccount })?.id ?? eligible.first?.id }

    public var body: some View {
        VStack(spacing: 0) {
            if !client.isSignedIn || client.enrollments.isEmpty {
                VStack(spacing: 12) {
                    Text("Company directory").font(.headline)
                    Text("Sign in and connect a managed customer to see their shared contacts.").foregroundStyle(.secondary).multilineTextAlignment(.center)
                }.padding().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                controls
                Divider()
                if let enrollment {
                    List {
                        if let error = errors[enrollment.deviceID] { Text(error).foregroundStyle(.red) }
                        if let value = client.directories[enrollment.deviceID], value.expiresAt > Date() {
                            let contacts = value.contacts.filter { $0.matches(search) }
                            if contacts.isEmpty {
                                Text(search.isEmpty ? "No shared contacts yet." : "No contacts match your search.").foregroundStyle(.secondary)
                            }
                            ForEach(contacts) { contact in
                                DisclosureGroup(isExpanded: Binding(get: { expandedContact == contact.id }, set: { expandedContact = $0 ? contact.id : nil })) {
                                    if expandedContact == contact.id {
                                        ManagedContactStatusView(client: client, enrollment: enrollment, contactID: contact.id, revision: value.revision)
                                            .id("\(enrollment.deviceID):\(value.revision):\(contact.id)")
                                    }
                                    ForEach(contact.numbers, id: \.number) { number in
                                        HStack {
                                            VStack(alignment: .leading, spacing: 3) {
                                                Text(number.label).font(.caption).foregroundStyle(.secondary)
                                                Text(number.number).monospacedDigit().textSelection(.enabled)
                                            }
                                            Spacer()
                                            Button { call(contact, number: number.number, enrollment: enrollment) } label: {
                                                Label("Call", systemImage: "phone")
                                            }.buttonStyle(.bordered).disabled(accountID == nil || calling)
                                                .accessibilityLabel("Call \(contact.name), \(number.label), \(number.number)")
                                        }.padding(.vertical, 6).accessibilityElement(children: .contain)
                                    }
                                } label: {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(contact.name)
                                        if !contact.company.isEmpty { Text(contact.company).font(.caption).foregroundStyle(.secondary) }
                                    }.padding(.vertical, 4)
                                }
                            }
                        } else if loadingDevice == enrollment.deviceID {
                            ProgressView("Loading directory…")
                        } else {
                            Text("Refresh to load this customer’s shared contacts.").foregroundStyle(.secondary)
                        }
                    }.listStyle(.plain)
                }
            }
        }
        .onAppear { if selectedDevice == nil { selectedDevice = client.enrollments.first?.deviceID } }
        .onReceive(client.$enrollments) { values in
            if !values.contains(where: { $0.deviceID == selectedDevice }) { selectedDevice = values.first?.deviceID }
        }
        .task(id: selectedDevice) {
            guard let enrollment else { return }
            while !Task.isCancelled {
                await refresh(enrollment)
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
            }
        }
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Picker("Customer", selection: $selectedDevice) {
                    ForEach(client.enrollments) { Text($0.organisationName).tag(Optional($0.deviceID)) }
                }.pickerStyle(.menu)
                Spacer(minLength: 8)
                Button {
                    if let enrollment { Task { await refresh(enrollment) } }
                } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .disabled(enrollment == nil || loadingDevice == selectedDevice)
            }
            TextField("Search name, company or number", text: $search).textFieldStyle(.roundedBorder)
                .accessibilityLabel("Search company directory")
            if eligible.isEmpty {
                Text("No active calling account for this customer. Refresh managed accounts to make calls.").font(.caption).foregroundStyle(.secondary)
            } else {
                Picker("Call from", selection: Binding(get: { accountID }, set: { selectedAccount = $0 })) {
                    ForEach(eligible) { Text($0.label).tag(Optional($0.id)) }
                }.pickerStyle(.menu)
            }
            Text("Shared contacts are managed by your administrator. Personal contacts are kept separately.").font(.caption).foregroundStyle(.secondary)
        }.padding()
    }

    private func refresh(_ enrollment: ManagedEnrollment) async {
        guard loadingDevice != enrollment.deviceID else { return }
        loadingDevice = enrollment.deviceID
        defer { if loadingDevice == enrollment.deviceID { loadingDevice = nil } }
        do { try await client.directory(for: enrollment); errors[enrollment.deviceID] = nil }
        catch { if !Task.isCancelled { errors[enrollment.deviceID] = error.localizedDescription } }
    }
    private func call(_ contact: ManagedDirectoryContact, number: String, enrollment: ManagedEnrollment) {
        guard let accountID, !calling else { return }
        calling = true
        Task { @MainActor in
            defer { calling = false }
            do {
                let verified = try client.directoryNumber(number, contactID: contact.id, for: enrollment)
                guard eligible.contains(where: { $0.id == accountID && $0.belongs(to: enrollment) }) else { throw ManagedError.accessUnavailable("This customer’s calling account is unavailable.") }
                try await onCall(enrollment, contact.id, verified, accountID)
                errors[enrollment.deviceID] = nil
            } catch { errors[enrollment.deviceID] = error.localizedDescription }
        }
    }
}

private struct ManagedContactStatusView: View {
    @ObservedObject var client: ManagedClient
    let enrollment: ManagedEnrollment
    let contactID: UUID
    let revision: UUID
    @Environment(\.scenePhase) private var scenePhase
    @State private var observation: ManagedDirectoryStatus?

    var body: some View {
        Text(scenePhase == .active && client.isSignedIn && client.directories[enrollment.deviceID]?.revision == revision
             ? observation?.label(for: contactID) ?? "Status unavailable" : "Status unavailable")
            .font(.caption).foregroundStyle(.secondary)
            .help("Shared by this person. This does not confirm they can answer.")
            .task(id: scenePhase) {
                observation = nil
                guard scenePhase == .active else { return }
                while !Task.isCancelled {
                    do {
                        let value = try await client.directoryStatus(contactIDs: [contactID], for: enrollment)
                        try Task.checkCancellation()
                        observation = value
                    } catch { observation = nil }
                    do { try await Task.sleep(for: .seconds(20)) } catch { return }
                }
            }
            .task(id: observation?.expiresAt) {
                guard let expiry = observation?.expiresAt else { return }
                do { try await Task.sleep(for: .seconds(max(0, min(30, expiry.timeIntervalSinceNow)))) } catch { return }
                observation = nil
            }
    }
}
