import SwiftUI
import SipperManaged

struct ManagedSettingsView: View {
    @ObservedObject var managed: ManagedAccountsController
    @State private var confirmSignOut = false
    @State private var disconnecting: ManagedEnrollment?

    var body: some View {
        Form {
            Section {
                Text("Sign in with the email your administrator invited. Each licence covers you across your devices.")
                    .foregroundStyle(.secondary)
                if let client = managed.client, client.isSignedIn {
                    LabeledContent("Signed in as", value: client.identity?.email ?? "Sipper user")
                    HStack {
                        Button("Refresh settings") { Task { await managed.refresh() } }
                        Button("Sign out…", role: .destructive) { confirmSignOut = true }
                    }
                } else {
                    Button("Sign in to Sipper") { Task { await managed.signIn() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(managed.client == nil || managed.isWorking)
                    if managed.message != nil {
                        Button("Sign in using your browser") { Task { await managed.signIn(useSystemBrowser: true) } }
                            .disabled(managed.client == nil || managed.isWorking)
                    }
                }
                if managed.isWorking {
                    HStack {
                        ProgressView().controlSize(.small).accessibilityLabel("Updating managed accounts")
                        if let status = managed.client?.signInStatus { Text(status).font(.caption) }
                        Spacer()
                        if managed.client?.isSigningIn == true {
                            Button("Cancel") { managed.client?.cancelSignIn() }
                        }
                    }
                    if let url = managed.client?.signInURL {
                        Link("Open the sign-in page if your browser did not appear", destination: url).font(.caption)
                    }
                }
                if let message = managed.message { Text(message).foregroundStyle(.red).textSelection(.enabled) }
            } header: { Text("Managed accounts") } footer: {
                Text("Personal SIP accounts continue to work independently. Your administrator supplies and controls your managed calling settings.")
            }
            Section {
                Toggle("Notify me about managed messages", isOn: Binding(get: { managed.messageNotificationsEnabled }, set: { enabled in
                    Task { await managed.setMessageNotifications(enabled) }
                }))
                .disabled(managed.client?.isSignedIn != true || managed.requestingMessagePermission)
                if let error = managed.messageNotificationError { Text(error).foregroundStyle(.red).font(.caption) }
            } header: { Text("Message notifications") } footer: {
                Text("Shows a generic New message alert while Sipper is running. Message text and people's names are kept out of notifications. macOS notification settings also apply.")
            }
            Section("Setup link") {
                TextField("Paste the setup link from your administrator", text: $managed.setupLink)
                    .textFieldStyle(.roundedBorder)
                Button("Connect with setup link") { Task { await managed.connectSetupLink() } }
                    .disabled(managed.client?.isSignedIn != true || managed.isWorking || managed.setupLink.isEmpty)
                Text("Sign in above, then use your link. It works once and only for the person it was created for.")
                    .font(.caption).foregroundStyle(.secondary)
            }.disabled(managed.isWorking)
            if let client = managed.client, client.isSignedIn {
                Section {
                    if client.organisations.isEmpty { Text("No organisations yet. Accept your invitation in the Sipper portal, then refresh.").foregroundStyle(.secondary) }
                    ForEach(client.organisations) { organisation in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(organisation.name).font(.headline)
                                    Text(organisation.status != "active" ? "Access suspended" : organisation.licensed ? "Licence assigned" : "Waiting for a licence")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if let enrollment = client.enrollments.first(where: { $0.id == organisation.id }) {
                                    Button("Disconnect…") { disconnecting = enrollment }
                                } else {
                                    Button("Connect this Mac") { Task { await managed.connect(organisation) } }
                                        .disabled(!organisation.licensed || organisation.status != "active")
                                }
                            }
                            if let error = managed.organisationErrors[organisation.id] { Text(error).font(.caption).foregroundStyle(.red) }
                            Picker("Availability", selection: Binding(get: { organisation.availability }, set: { value in
                                if let value { Task { await managed.setAvailability(value, organisationID: organisation.id) } }
                            })) {
                                if organisation.availability == nil { Text("Unavailable").tag(Optional<ManagedAvailability>.none) }
                                ForEach(ManagedAvailability.allCases, id: \.self) { value in Text(value.label).tag(Optional(value)) }
                            }
                            .disabled(organisation.status != "active" || organisation.availability == nil)
                            .accessibilityLabel("Availability for \(organisation.name)")
                            HStack {
                                Text("Do Not Disturb")
                                Spacer()
                                Text(organisation.doNotDisturb.map { $0 ? "On" : "Off" } ?? "Unavailable").foregroundStyle(.secondary)
                                Button(organisation.doNotDisturb == true ? "Turn off" : "Turn on") {
                                    Task { await managed.setDoNotDisturb(organisation.doNotDisturb != true, organisationID: organisation.id) }
                                }
                                .disabled(organisation.status != "active" || organisation.doNotDisturb == nil)
                                .accessibilityLabel("\(organisation.doNotDisturb == true ? "Turn off" : "Turn on") Do Not Disturb for \(organisation.name)")
                            }
                        }
                    }
                    if let date = managed.refreshedAt { LabeledContent("Last checked", value: date.formatted(date: .omitted, time: .standard)).foregroundStyle(.secondary) }
                    Link("Open management portal", destination: client.serverURL.appendingPathComponent("portal"))
                } header: { Text("Your organisations") } footer: {
                    Text("Availability is your stated status for this customer and stays until changed or cleared; it does not change calling. Do Not Disturb applies across your devices. Gateway calls stop immediately; direct PBX calls stop after the app refreshes its settings. Calls already ringing or connected continue. Refresh to check an unavailable preference.")
                }.disabled(managed.isWorking)
            }
        }
        .formStyle(.grouped)
        .confirmationDialog("Sign out of managed Sipper?", isPresented: $confirmSignOut) {
            Button("Sign out", role: .destructive) { Task { await managed.signOut() } }
        } message: { Text("Managed accounts and their saved credentials will be removed from this Mac. Calls already connected can finish. Your personal accounts are kept.") }
        .confirmationDialog("Disconnect \(disconnecting?.organisationName ?? "this customer")?", isPresented: Binding(get: { disconnecting != nil }, set: { if !$0 { disconnecting = nil } })) {
            Button("Disconnect", role: .destructive) {
                if let enrollment = disconnecting { Task { await managed.disconnect(enrollment) } }
                disconnecting = nil
            }
            Button("Cancel", role: .cancel) { disconnecting = nil }
        } message: { Text("This customer’s managed accounts and shared contacts will be removed from this Mac. Calls already connected can finish. Personal accounts and other customers are kept.") }
    }
}
