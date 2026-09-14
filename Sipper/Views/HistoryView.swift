import SwiftUI

struct HistoryView: View {
    @EnvironmentObject private var state: AppState
    @Binding var sheet: MainSheet?

    enum Filter: String, CaseIterable, Identifiable {
        case all = "All"
        case missed = "Missed"
        case incoming = "Incoming"
        case outgoing = "Outgoing"
        var id: String { rawValue }
    }

    @State private var filter: Filter = .all
    @State private var accountFilter: UUID?
    @State private var search = ""
    @State private var selection: Set<UUID> = []
    @State private var confirmClear = false

    private struct DayGroup: Identifiable {
        let day: Date
        let records: [CallRecord]
        var id: Date { day }
    }

    private var filtered: [CallRecord] {
        let needle = search.trimmingCharacters(in: .whitespaces).lowercased()
        return state.history.filter { record in
            switch filter {
            case .all: break
            case .missed: if !record.wasMissed { return false }
            case .incoming: if record.direction != .incoming { return false }
            case .outgoing: if record.direction != .outgoing { return false }
            }
            if let accountFilter, record.accountID != accountFilter { return false }
            if !needle.isEmpty {
                let haystack = "\(record.remoteName) \(record.remoteNumber) \(record.remoteURI)".lowercased()
                if !haystack.contains(needle) { return false }
            }
            return true
        }
    }

    private var groups: [DayGroup] {
        let calendar = Calendar.current
        let grouped = Dictionary(grouping: filtered) { calendar.startOfDay(for: $0.startedAt) }
        return grouped.keys.sorted(by: >).map { DayGroup(day: $0, records: grouped[$0] ?? []) }
    }

    var body: some View {
        Group {
            if state.history.isEmpty {
                ContentUnavailableView("No calls yet", systemImage: "clock",
                                       description: Text("Calls you make and receive appear here."))
            } else if filtered.isEmpty {
                ContentUnavailableView.search(text: search)
            } else {
                List(selection: $selection) {
                    ForEach(groups) { group in
                        Section(DayGrouping.title(for: group.day)) {
                            ForEach(group.records) { record in
                                HistoryRow(record: record, sheet: $sheet)
                                    .tag(record.id)
                            }
                        }
                    }
                }
                .onDeleteCommand {
                    guard !selection.isEmpty else { return }
                    state.deleteHistory(ids: selection)
                    selection = []
                }
            }
        }
        .navigationTitle("History")
        .searchable(text: $search, placement: .toolbar, prompt: "Name or number")
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Picker("Filter", selection: $filter) {
                    ForEach(Filter.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .help("Filter by direction")

                Menu {
                    Picker("Account", selection: $accountFilter) {
                        Text("All accounts").tag(UUID?.none)
                        ForEach(state.accounts) { account in
                            Text(account.displayLabel).tag(Optional(account.id))
                        }
                    }
                } label: {
                    Label("Account", systemImage: accountFilter == nil ? "person.crop.circle" : "person.crop.circle.fill")
                }
                .help("Filter by account")

                Button {
                    confirmClear = true
                } label: {
                    Label("Clear", systemImage: "trash")
                }
                .disabled(state.history.isEmpty)
                .help("Clear call history")
            }
        }
        .confirmationDialog("Clear all call history?", isPresented: $confirmClear) {
            Button("Clear History", role: .destructive) { state.clearHistory() }
            Button("Cancel", role: .cancel) {}
        }
        .onAppear { state.markMissedCallsSeen() }
    }
}

struct HistoryRow: View {
    @EnvironmentObject private var state: AppState
    let record: CallRecord
    @Binding var sheet: MainSheet?

    private var accountLabel: String {
        state.account(for: record.accountID)?.displayLabel ?? "Removed account"
    }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: record.symbolName)
                .foregroundStyle(record.symbolColor)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(record.displayName)
                    .foregroundStyle(record.wasMissed ? Color.red : Color.primary)
                    .lineLimit(1)
                Text("\(record.summaryLine) · \(accountLabel)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if record.recordingURL != nil {
                Button {
                    state.openRecording(record)
                } label: {
                    Image(systemName: "waveform")
                }
                .buttonStyle(.borderless)
                .help("Play recording")
            }
            Text(DayGrouping.timeFormatter.string(from: record.startedAt))
                .font(.caption)
                .foregroundStyle(.secondary)
                .monospacedDigit()
            Button {
                state.callBack(record)
            } label: {
                Image(systemName: "phone.fill")
            }
            .buttonStyle(.borderless)
            .help("Call back")
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { state.callBack(record) }
        .contextMenu {
            Button("Call Back") { state.callBack(record) }
            if state.contact(forNumber: record.remoteNumber) == nil {
                Button("Add to Contacts…") {
                    sheet = .addContact(number: record.remoteNumber, name: record.remoteName)
                }
            }
            Button("Copy Number") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(record.remoteNumber, forType: .string)
            }
            if record.recordingURL != nil {
                Divider()
                Button("Play Recording") { state.openRecording(record) }
                Button("Show Recording in Finder") { state.revealRecording(record) }
                Button("Delete Recording", role: .destructive) { state.deleteRecording(for: record.id) }
            }
            Divider()
            Button("Delete", role: .destructive) { state.deleteHistory(ids: [record.id]) }
        }
    }
}
