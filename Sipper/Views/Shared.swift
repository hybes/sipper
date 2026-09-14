import SwiftUI

extension ProfileColor {
    var color: Color {
        switch self {
        case .blue: return .blue
        case .green: return .green
        case .orange: return .orange
        case .red: return .red
        case .purple: return .purple
        case .teal: return .teal
        case .pink: return .pink
        case .indigo: return .indigo
        case .gray: return .gray
        }
    }
}

extension RegistrationState {
    var color: Color {
        switch self {
        case .registered: return .green
        case .registering: return .orange
        case .failed: return .red
        case .unregistered: return .secondary
        }
    }
}

/// Registration detail with a live countdown to the next re-REGISTER.
struct RegistrationDetailText: View {
    let state: RegistrationState

    var body: some View {
        if let nextRefresh = state.nextRefresh {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let remaining = nextRefresh.timeIntervalSince(context.date)
                if remaining > 0 {
                    Text("Registered · re-registers in \(DurationText.format(remaining))")
                        .monospacedDigit()
                } else {
                    Text("Registered · re-registering…")
                }
            }
        } else {
            Text(state.detail)
        }
    }
}

struct StatusDot: View {
    let state: RegistrationState
    var size: CGFloat = 8

    var body: some View {
        Circle()
            .fill(state.color)
            .frame(width: size, height: size)
            .overlay {
                if case .registering = state {
                    Circle().strokeBorder(Color.orange.opacity(0.5), lineWidth: 2).scaleEffect(1.8)
                }
            }
            .help(state.detail)
    }
}

enum DurationText {
    static func format(_ seconds: TimeInterval) -> String {
        let total = Int(max(0, seconds.rounded(.down)))
        let h = total / 3600
        let m = (total % 3600) / 60
        let s = total % 60
        if h > 0 { return String(format: "%d:%02d:%02d", h, m, s) }
        return String(format: "%d:%02d", m, s)
    }

    static func spoken(_ seconds: TimeInterval) -> String {
        let total = Int(max(0, seconds.rounded()))
        if total < 60 { return "\(total)s" }
        let m = total / 60
        let s = total % 60
        if m < 60 { return s == 0 ? "\(m) min" : "\(m) min \(s)s" }
        return "\(m / 60) h \(m % 60) min"
    }
}

extension CallRecord {
    var symbolName: String {
        switch (direction, outcome) {
        case (.incoming, .missed): return "phone.arrow.down.left"
        case (.incoming, .declined): return "phone.down"
        case (.incoming, _): return "phone.arrow.down.left.fill"
        case (.outgoing, .completed): return "phone.arrow.up.right.fill"
        case (.outgoing, _): return "phone.arrow.up.right"
        }
    }

    var symbolColor: Color {
        switch outcome {
        case .completed: return .primary
        case .missed: return .red
        case .declined, .busy, .noAnswer, .cancelled: return .secondary
        case .failed: return .orange
        }
    }

    var summaryLine: String {
        if isInProgress { return "In progress" }
        switch outcome {
        case .completed: return duration > 0 ? DurationText.spoken(duration) : "Completed"
        case .failed: return statusCode > 0 ? "Failed · \(statusCode) \(statusText)" : "Failed"
        default: return outcome.displayName
        }
    }
}

enum DayGrouping {
    static func title(for date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        let formatter = DateFormatter()
        formatter.dateStyle = .full
        formatter.timeStyle = .none
        return formatter.string(from: date)
    }

    static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .none
        f.timeStyle = .short
        return f
    }()
}

/// Circular icon button used for in-call controls.
struct CallControlButton: View {
    let title: String
    let systemImage: String
    var isActive = false
    var tint: Color = .primary
    var isEnabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.system(size: 20, weight: .medium))
                    .frame(width: 54, height: 54)
                    .background(isActive ? Color.accentColor : Color.primary.opacity(0.08), in: Circle())
                    .foregroundStyle(isActive ? Color.white : tint)
                Text(title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.4)
        .help(title)
    }
}

struct KeypadKey: Identifiable {
    let digit: String
    let letters: String
    var id: String { digit }

    static let all: [KeypadKey] = [
        .init(digit: "1", letters: ""), .init(digit: "2", letters: "ABC"), .init(digit: "3", letters: "DEF"),
        .init(digit: "4", letters: "GHI"), .init(digit: "5", letters: "JKL"), .init(digit: "6", letters: "MNO"),
        .init(digit: "7", letters: "PQRS"), .init(digit: "8", letters: "TUV"), .init(digit: "9", letters: "WXYZ"),
        .init(digit: "*", letters: ""), .init(digit: "0", letters: "+"), .init(digit: "#", letters: ""),
    ]
}

struct KeypadView: View {
    var compact = false
    let onKey: (String) -> Void
    var onLongPressZero: (() -> Void)? = nil

    private let columns = Array(repeating: GridItem(.fixed(72), spacing: 10), count: 3)

    var body: some View {
        LazyVGrid(columns: columns, spacing: 10) {
            ForEach(KeypadKey.all) { key in
                Button {
                    onKey(key.digit)
                } label: {
                    VStack(spacing: 1) {
                        Text(key.digit)
                            .font(.system(size: compact ? 20 : 24, weight: .regular, design: .rounded))
                        Text(key.letters.isEmpty ? " " : key.letters)
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                    .frame(width: 72, height: compact ? 44 : 52)
                    .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
                .simultaneousGesture(
                    LongPressGesture(minimumDuration: 0.5).onEnded { _ in
                        if key.digit == "0" { onLongPressZero?() }
                    }
                )
                .accessibilityLabel(key.digit == "0" ? "0, long press for plus" : key.digit)
            }
        }
    }
}

/// Filled button that keeps its colour in non-key windows such as the incoming call
/// alert (borderedProminent goes grey there).
struct SolidButtonStyle: ButtonStyle {
    var color: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.vertical, 8)
            .padding(.horizontal, 14)
            .background(color.opacity(configuration.isPressed ? 0.7 : 1), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }
}

struct AccountMenuLabel: View {
    let account: SIPAccount
    let registration: RegistrationState

    var body: some View {
        HStack(spacing: 8) {
            StatusDot(state: registration)
            Text(account.displayLabel)
        }
    }
}
