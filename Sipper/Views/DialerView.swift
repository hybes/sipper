import SwiftUI

struct DialerView: View {
    @EnvironmentObject private var state: AppState
    @Binding var sheet: MainSheet?
    @FocusState private var numberFocused: Bool

    var body: some View {
        Group {
            if let call = state.activeCall {
                ActiveCallView(call: call)
            } else if state.accounts.isEmpty {
                noAccounts
            } else {
                idle
            }
        }
        .navigationTitle("Dialer")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    sheet = .addAccount(profileID: nil)
                } label: {
                    Label("Add Account", systemImage: "person.badge.plus")
                }
                .help("Add a SIP account")
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .sipperFocusDialer)) { _ in
            numberFocused = true
        }
    }

    private var noAccounts: some View {
        ContentUnavailableView {
            Label("No SIP accounts", systemImage: "phone.badge.plus")
        } description: {
            Text("Add an account manually, or open an extension in FusionPBX and use the Sipper browser extension to import it.")
        } actions: {
            Button("Add Account…") { sheet = .addAccount(profileID: nil) }
                .buttonStyle(.borderedProminent)
        }
    }

    private var idle: some View {
        VStack(spacing: 18) {
            accountPicker
            numberField
            KeypadView { key in
                state.dialString += key
            } onLongPressZero: {
                if state.dialString.hasSuffix("0") { state.dialString.removeLast() }
                state.dialString += "+"
            }
            actionRow
            recentCalls
        }
        .frame(maxWidth: 380)
        .padding(.horizontal, 32)
        .padding(.vertical, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private var accountPicker: some View {
        HStack {
            Text("From").foregroundStyle(.secondary)
            Picker("From", selection: Binding(get: { state.dialerAccount?.id }, set: { state.dialerAccountID = $0 })) {
                ForEach(state.profiles) { profile in
                    let members = state.accounts(in: profile.id)
                    if !members.isEmpty {
                        Section(profile.name) {
                            ForEach(members) { account in
                                AccountMenuLabel(account: account, registration: state.registration(for: account.id))
                                    .tag(Optional(account.id))
                            }
                        }
                    }
                }
            }
            .labelsHidden()
            .frame(maxWidth: 260)
            if let account = state.dialerAccount {
                let registration = state.registration(for: account.id)
                Text(registration.shortLabel)
                    .font(.caption)
                    .foregroundStyle(registration.color)
                    .help(registration.detail)
            }
        }
    }

    private var numberField: some View {
        HStack(spacing: 8) {
            TextField("Number or SIP address", text: $state.dialString)
                .textFieldStyle(.plain)
                .font(.system(size: 26, weight: .regular, design: .rounded))
                .multilineTextAlignment(.center)
                .focused($numberFocused)
                .onSubmit { placeCall() }
                .accessibilityLabel("Number to call")
            if !state.dialString.isEmpty {
                Button {
                    state.dialString.removeLast()
                } label: {
                    Image(systemName: "delete.left.fill")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help("Delete last character")
                .simultaneousGesture(LongPressGesture(minimumDuration: 0.6).onEnded { _ in state.dialString = "" })
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .onAppear { numberFocused = true }
    }

    private var actionRow: some View {
        HStack(spacing: 16) {
            Button {
                state.callVoicemail(for: state.dialerAccount?.id)
            } label: {
                Label("Voicemail", systemImage: "recordingtape")
                    .frame(maxWidth: .infinity)
            }
            .controlSize(.large)
            .help("Call voicemail (\(state.dialerAccount?.voicemailNumber ?? "*97"))")

            Button {
                placeCall()
            } label: {
                Label("Call", systemImage: "phone.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(.green)
            .controlSize(.large)
            .keyboardShortcut(.defaultAction)
            .disabled(state.dialString.trimmingCharacters(in: .whitespaces).isEmpty)
        }
    }

    @ViewBuilder
    private var recentCalls: some View {
        let recent = Array(state.history.prefix(5))
        if !recent.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("Recent").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Show all") { state.selection = .history }
                        .buttonStyle(.plain)
                        .font(.caption)
                        .foregroundStyle(Color.accentColor)
                }
                ForEach(recent) { record in
                    Button {
                        state.callBack(record)
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: record.symbolName)
                                .foregroundStyle(record.symbolColor)
                                .frame(width: 18)
                            Text(record.displayName).lineLimit(1)
                            Spacer()
                            Text(DayGrouping.timeFormatter.string(from: record.startedAt))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Call \(record.remoteNumber) again")
                }
            }
            .padding(.top, 8)
        }
    }

    private func placeCall() {
        state.call(state.dialString, from: state.dialerAccount?.id)
    }
}

/// Full-size view of the selected call with controls, DTMF keypad and transfer.
struct ActiveCallView: View {
    @EnvironmentObject private var state: AppState
    let call: CallSnapshot
    @State private var showKeypad = false
    @State private var dtmfHistory = ""
    @State private var showTransfer = false
    @State private var transferTarget = ""
    @FocusState private var focused: Bool

    private var account: SIPAccount? { state.account(for: call.accountID) }
    private var otherCalls: [CallSnapshot] { state.calls.filter { $0.id != call.id } }

    var body: some View {
        VStack(spacing: 20) {
            header
            if call.state == .incoming {
                incomingButtons
            } else {
                if showKeypad {
                    keypad
                }
                controls
                hangupButton
            }
            if let status = state.transferStatus {
                Text(status).font(.caption).foregroundStyle(.secondary)
            }
            if !otherCalls.isEmpty {
                otherCallsList
            }
        }
        .frame(maxWidth: 420)
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .focusable()
        .focusEffectDisabled()
        .focused($focused)
        .onAppear { focused = true }
        .onKeyPress(characters: CharacterSet(charactersIn: "0123456789*#")) { press in
            guard call.state == .confirmed else { return .ignored }
            let digits = String(press.characters)
            state.sendDTMF(digits, callID: call.id)
            dtmfHistory += digits
            return .handled
        }
        .onChange(of: call.id) { _, _ in
            dtmfHistory = ""
            showKeypad = false
        }
    }

    private var header: some View {
        VStack(spacing: 6) {
            Image(systemName: call.direction == .incoming ? "phone.arrow.down.left.fill" : "phone.arrow.up.right.fill")
                .font(.system(size: 28))
                .foregroundStyle(call.state == .confirmed ? Color.green : Color.accentColor)
                .padding(.bottom, 4)
            Text(call.displayName)
                .font(.system(size: 30, weight: .medium, design: .rounded))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            if !call.remoteName.isEmpty {
                Text(call.remoteNumber).font(.title3).foregroundStyle(.secondary)
            }
            CallStatusText(call: call)
                .font(.title3)
                .foregroundStyle(.secondary)
            if let account {
                Text("via \(account.displayLabel)")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            if call.isRecording {
                Label("Recording", systemImage: "record.circle.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.red)
                    .padding(.top, 2)
            }
            if !dtmfHistory.isEmpty {
                Text(dtmfHistory)
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .padding(.top, 4)
                    .accessibilityLabel("Digits sent: \(dtmfHistory)")
            }
        }
    }

    private var incomingButtons: some View {
        HStack(spacing: 16) {
            Button {
                state.decline(callID: call.id)
            } label: {
                Label("Decline", systemImage: "phone.down.fill").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)
            .controlSize(.large)
            Button {
                state.answer(callID: call.id)
            } label: {
                Label("Answer", systemImage: "phone.fill").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(.green)
            .controlSize(.large)
            .keyboardShortcut(.defaultAction)
        }
    }

    private var keypad: some View {
        KeypadView(compact: true) { key in
            state.sendDTMF(key, callID: call.id)
            dtmfHistory += key
        }
    }

    private var controls: some View {
        HStack(spacing: 22) {
            CallControlButton(title: call.isMuted ? "Unmute" : "Mute",
                              systemImage: call.isMuted ? "mic.slash.fill" : "mic.fill",
                              isActive: call.isMuted,
                              isEnabled: call.state == .confirmed) {
                state.toggleMute(callID: call.id)
            }
            CallControlButton(title: call.isOnHold ? "Resume" : "Hold",
                              systemImage: call.isOnHold ? "play.fill" : "pause.fill",
                              isActive: call.isOnHold,
                              isEnabled: call.state == .confirmed) {
                state.toggleHold(callID: call.id)
            }
            CallControlButton(title: "Keypad",
                              systemImage: "circle.grid.3x3.fill",
                              isActive: showKeypad,
                              isEnabled: call.state == .confirmed) {
                showKeypad.toggle()
            }
            CallControlButton(title: "Transfer",
                              systemImage: "arrow.triangle.branch",
                              isEnabled: call.state == .confirmed) {
                showTransfer = true
            }
            .popover(isPresented: $showTransfer, arrowEdge: .bottom) { transferPopover }
            CallControlButton(title: call.isRecording ? "Stop" : "Record",
                              systemImage: call.isRecording ? "stop.circle.fill" : "record.circle",
                              isActive: call.isRecording,
                              tint: .red,
                              isEnabled: call.state == .confirmed) {
                state.toggleRecording(callID: call.id)
            }
        }
    }

    private var transferPopover: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Transfer call").font(.headline)
            TextField("Number or SIP address", text: $transferTarget)
                .textFieldStyle(.roundedBorder)
                .frame(width: 260)
                .onSubmit { blindTransfer() }
            HStack {
                Spacer()
                Button("Cancel") { showTransfer = false }
                Button("Transfer") { blindTransfer() }
                    .buttonStyle(.borderedProminent)
                    .disabled(transferTarget.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            let held = otherCalls.filter { $0.state == .confirmed }
            if !held.isEmpty {
                Divider()
                Text("Or connect to another call").font(.caption).foregroundStyle(.secondary)
                ForEach(held) { other in
                    Button("Connect with \(other.displayName)") {
                        state.attendedTransfer(callID: call.id, toCallID: other.id)
                        showTransfer = false
                    }
                }
            }
        }
        .padding(16)
    }

    private func blindTransfer() {
        let target = transferTarget.trimmingCharacters(in: .whitespaces)
        guard !target.isEmpty else { return }
        state.transfer(callID: call.id, to: target)
        transferTarget = ""
        showTransfer = false
    }

    private var hangupButton: some View {
        Button {
            state.hangup(callID: call.id)
        } label: {
            Label(call.state == .confirmed ? "Hang Up" : "Cancel", systemImage: "phone.down.fill")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .tint(.red)
        .controlSize(.large)
        .keyboardShortcut(.cancelAction)
    }

    private var otherCallsList: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Other calls").font(.caption).foregroundStyle(.secondary)
            ForEach(otherCalls) { other in
                HStack {
                    Image(systemName: other.state == .incoming ? "phone.arrow.down.left" : "pause.circle")
                        .foregroundStyle(other.state == .incoming ? Color.green : Color.secondary)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(other.displayName).lineLimit(1)
                        CallStatusText(call: other).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if other.state == .incoming {
                        Button("Answer") { state.answer(callID: other.id) }.tint(.green)
                        Button("Decline") { state.decline(callID: other.id) }
                    } else {
                        Button("Swap") { state.swapToCall(other.id) }
                        Button {
                            state.hangup(callID: other.id)
                        } label: {
                            Image(systemName: "phone.down.fill")
                        }
                        .help("Hang up this call")
                    }
                }
                .padding(8)
                .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
        }
    }
}
