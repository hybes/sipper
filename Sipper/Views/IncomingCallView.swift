import SwiftUI

/// Content of the floating incoming-call alert. One card per ringing call.
struct IncomingCallView: View {
    @EnvironmentObject private var state: AppState

    private var ringing: [CallSnapshot] { state.calls.filter { $0.state == .incoming } }

    var body: some View {
        VStack(spacing: 10) {
            if ringing.isEmpty {
                IncomingCallCard(call: nil, accountLabel: "")
            } else {
                ForEach(ringing) { call in
                    IncomingCallCard(call: call, accountLabel: state.account(for: call.accountID)?.displayLabel ?? "Unknown account")
                }
            }
        }
        .padding(12)
    }
}

struct IncomingCallCard: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let call: CallSnapshot?
    let accountLabel: String
    @State private var pulse = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 14) {
                ZStack {
                    Circle()
                        .fill(Color.green.opacity(0.25))
                        .scaleEffect(pulse ? 1.35 : 1)
                        .opacity(pulse ? 0 : 1)
                    Circle().fill(Color.green)
                    Image(systemName: "phone.arrow.down.left.fill")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(.white)
                }
                .frame(width: 48, height: 48)
                .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 3) {
                    Text("Incoming call")
                        .font(.caption.weight(.semibold))
                        .textCase(.uppercase)
                        .foregroundStyle(Color.green)
                    Text(call?.displayName ?? "No incoming calls")
                        .font(.title2.weight(.semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    if let call, !call.remoteName.isEmpty {
                        Text(call.remoteNumber)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if !accountLabel.isEmpty {
                        Text("via \(accountLabel)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }

            if let call {
                HStack(spacing: 10) {
                    Button {
                        state.decline(callID: call.id)
                    } label: {
                        Label("Decline", systemImage: "phone.down.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(SolidButtonStyle(color: .red))
                    .keyboardShortcut(.cancelAction)

                    Button {
                        state.answer(callID: call.id)
                    } label: {
                        Label("Answer", systemImage: "phone.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(SolidButtonStyle(color: .green))
                    .keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.green.opacity(0.35), lineWidth: 1)
        )
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeOut(duration: 1.2).repeatForever(autoreverses: false)) {
                pulse = true
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(call.map { "Incoming call from \($0.displayName)" } ?? "No incoming calls")
    }
}
