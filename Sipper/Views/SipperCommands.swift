import SwiftUI

struct SipperCommands: Commands {
    @ObservedObject var state: AppState

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Call") {
                state.selection = .dialer
                NotificationCenter.default.post(name: .sipperFocusDialer, object: nil)
            }
            .keyboardShortcut("n", modifiers: [.command])

            Button("Add Account…") {
                NotificationCenter.default.post(name: .sipperAddAccount, object: nil)
            }
            .keyboardShortcut("a", modifiers: [.command, .shift])

            Button("Add Profile…") {
                NotificationCenter.default.post(name: .sipperAddProfile, object: nil)
            }
        }

        CommandMenu("Call") {
            Button(state.activeCall?.state == .incoming ? "Answer" : "Hang Up") {
                if let call = state.activeCall {
                    if call.state == .incoming { state.answer(callID: call.id) } else { state.hangup(callID: call.id) }
                }
            }
            .keyboardShortcut(.return, modifiers: [.command])
            .disabled(state.activeCall == nil)

            Button("Decline") {
                if let call = state.activeCall, call.state == .incoming { state.decline(callID: call.id) }
            }
            .keyboardShortcut(.escape, modifiers: [.command])
            .disabled(state.activeCall?.state != .incoming)

            Divider()

            Button(state.activeCall?.isMuted == true ? "Unmute" : "Mute") {
                if let call = state.activeCall { state.toggleMute(callID: call.id) }
            }
            .keyboardShortcut("m", modifiers: [.command, .shift])
            .disabled(state.activeCall == nil || state.activeCall?.state != .confirmed)

            Button(state.activeCall?.isOnHold == true ? "Resume" : "Hold") {
                if let call = state.activeCall { state.toggleHold(callID: call.id) }
            }
            .keyboardShortcut("h", modifiers: [.command, .shift])
            .disabled(state.activeCall == nil || state.activeCall?.state != .confirmed)

            Divider()

            Button("Call Voicemail") {
                state.callVoicemail()
            }
            .disabled(state.accounts.isEmpty)

            Toggle("Do Not Disturb", isOn: Binding(get: { state.settings.doNotDisturb },
                                                   set: { state.settings.doNotDisturb = $0 }))
                .keyboardShortcut("d", modifiers: [.command, .shift])

            Button("Re-register All Accounts") {
                state.reRegisterAll()
            }
            .disabled(state.accounts.isEmpty)
        }

        CommandGroup(after: .sidebar) {
            Button("Dialer") { state.selection = .dialer }.keyboardShortcut("1", modifiers: [.command])
            Button("History") { state.selection = .history }.keyboardShortcut("2", modifiers: [.command])
            Button("Contacts") { state.selection = .contacts }.keyboardShortcut("3", modifiers: [.command])
            Divider()
        }
    }
}

extension Notification.Name {
    static let sipperFocusDialer = Notification.Name("com.hybes.sipper.focus-dialer")
    static let sipperAddAccount = Notification.Name("com.hybes.sipper.add-account")
    static let sipperAddProfile = Notification.Name("com.hybes.sipper.add-profile")
}
