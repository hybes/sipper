import SwiftUI
import SipperManaged

/// First-run choice shown in place of the dialler while there are no accounts:
/// sign in to receive phone lines from an organisation, or enter SIP details by hand.
struct WelcomeView: View {
    @EnvironmentObject private var state: AppState
    @ObservedObject var managed: ManagedAccountsController
    @Binding var sheet: MainSheet?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: 12) {
                    Image(nsImage: NSApp.applicationIconImage)
                        .resizable()
                        .frame(width: 64, height: 64)
                        .accessibilityHidden(true)
                    Text("Welcome to Sipper")
                        .font(.largeTitle.weight(.semibold))
                }
                if let email = managed.signedInEmail, managed.client?.isSigningIn != true {
                    signedIn(email: email)
                } else {
                    signInOption
                    Divider()
                    manualOption
                }
            }
            .frame(maxWidth: 440, alignment: .leading)
            .padding(40)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle("Sipper")
    }

    private var signInOption: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                Task { await managed.signIn() }
            } label: {
                Text("Sign in").frame(minWidth: 160)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .keyboardShortcut(.defaultAction)
            .disabled(managed.client == nil || managed.isWorking)
            Text("Use the email your organisation or provider set up for you. Your phone lines are added automatically.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            progress
            if let message = managed.message {
                Text(message)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Sign in using your browser") { Task { await managed.signIn(useSystemBrowser: true) } }
                    .buttonStyle(.link)
                    .disabled(managed.client == nil || managed.isWorking)
            }
        }
    }

    @ViewBuilder
    private var progress: some View {
        if managed.isWorking {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small).accessibilityLabel("Signing in")
                Text(managed.client?.signInStatus ?? "Complete sign-in in your browser.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                if managed.client?.isSigningIn == true {
                    Button("Cancel") { managed.client?.cancelSignIn() }
                }
            }
            if let url = managed.client?.signInURL {
                Link("Open the sign-in page if your browser did not appear", destination: url).font(.callout)
            }
        }
    }

    private var manualOption: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                sheet = .addAccount(profileID: nil)
            } label: {
                Text("Set up manually").frame(minWidth: 160)
            }
            .controlSize(.large)
            Text("Enter SIP details yourself. No sign-in needed.")
                .foregroundStyle(.secondary)
        }
    }

    private func signedIn(email: String) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Signed in as \(email). Your administrator hasn't assigned any phone lines yet.")
                .fixedSize(horizontal: false, vertical: true)
            if let error = managed.message ?? managed.organisationErrors.values.first {
                Text(error)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 10) {
                Button("Refresh") { Task { await managed.refreshAndConnect() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(managed.isWorking)
                Button("Set up manually") { sheet = .addAccount(profileID: nil) }
                if managed.isWorking { ProgressView().controlSize(.small).accessibilityLabel("Checking for phone lines") }
            }
            SettingsLink { Text("Account settings…") }
                .buttonStyle(.link)
        }
    }
}
