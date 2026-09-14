import SwiftUI

struct ContactsView: View {
    @EnvironmentObject private var state: AppState
    @Binding var sheet: MainSheet?
    @State private var selectedID: UUID?
    @State private var search = ""
    @State private var contactToDelete: Contact?

    private var filtered: [Contact] {
        let needle = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return state.contacts }
        return state.contacts.filter { contact in
            contact.name.lowercased().contains(needle)
                || contact.company.lowercased().contains(needle)
                || contact.numbers.contains { $0.number.lowercased().contains(needle) }
        }
    }

    var body: some View {
        Group {
            if state.contacts.isEmpty {
                ContentUnavailableView {
                    Label("No contacts", systemImage: "person.crop.circle")
                } description: {
                    Text("Contacts are stored on this Mac and used to name incoming calls.")
                } actions: {
                    Button("Add Contact…") { sheet = .addContact(number: nil, name: nil) }
                        .buttonStyle(.borderedProminent)
                }
            } else {
                HSplitView {
                    list
                        .frame(minWidth: 220, idealWidth: 260, maxWidth: 340)
                    detail
                        .frame(minWidth: 320, maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .navigationTitle("Contacts")
        .searchable(text: $search, placement: .toolbar, prompt: "Name, company or number")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    sheet = .addContact(number: nil, name: nil)
                } label: {
                    Label("Add Contact", systemImage: "plus")
                }
                .help("Add a contact")
            }
        }
        .confirmationDialog("Delete \(contactToDelete?.name ?? "contact")?",
                            isPresented: Binding(get: { contactToDelete != nil }, set: { if !$0 { contactToDelete = nil } }),
                            presenting: contactToDelete) { contact in
            Button("Delete Contact", role: .destructive) {
                state.deleteContact(contact.id)
                if selectedID == contact.id { selectedID = nil }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    private var list: some View {
        List(selection: $selectedID) {
            let favourites = filtered.filter(\.isFavorite)
            if !favourites.isEmpty {
                Section("Favourites") {
                    ForEach(favourites) { contact in row(contact) }
                }
            }
            Section(favourites.isEmpty ? "Contacts" : "All") {
                ForEach(filtered) { contact in row(contact) }
            }
        }
        .listStyle(.inset)
    }

    private func row(_ contact: Contact) -> some View {
        HStack(spacing: 10) {
            ContactAvatar(contact: contact, size: 28)
            VStack(alignment: .leading, spacing: 1) {
                Text(contact.name).lineLimit(1)
                Text(contact.primaryNumber ?? contact.company)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .tag(contact.id)
        .contextMenu {
            if let number = contact.primaryNumber {
                Button("Call \(number)") { state.call(number, from: contact.preferredAccountID) }
            }
            Button(contact.isFavorite ? "Remove from Favourites" : "Add to Favourites") { state.toggleFavorite(contact.id) }
            Button("Edit…") { sheet = .editContact(contact.id) }
            Divider()
            Button("Delete…", role: .destructive) { contactToDelete = contact }
        }
    }

    @ViewBuilder
    private var detail: some View {
        if let id = selectedID, let contact = state.contact(for: id) {
            ContactDetailView(contact: contact, sheet: $sheet, onDelete: { contactToDelete = contact })
        } else {
            ContentUnavailableView("Select a contact", systemImage: "person.crop.circle", description: Text(""))
        }
    }
}

struct ContactAvatar: View {
    let contact: Contact
    var size: CGFloat = 40

    var body: some View {
        ZStack {
            Circle().fill(Color.accentColor.opacity(0.18))
            Text(contact.initials.isEmpty ? "?" : contact.initials)
                .font(.system(size: size * 0.4, weight: .semibold, design: .rounded))
                .foregroundStyle(Color.accentColor)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

struct ContactDetailView: View {
    @EnvironmentObject private var state: AppState
    let contact: Contact
    @Binding var sheet: MainSheet?
    let onDelete: () -> Void

    private var recent: [CallRecord] {
        state.history.filter { contact.matches(number: $0.remoteNumber) }.prefix(8).map { $0 }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 14) {
                    ContactAvatar(contact: contact, size: 56)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(contact.name).font(.title2.weight(.semibold))
                        if !contact.company.isEmpty {
                            Text(contact.company).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Button {
                        state.toggleFavorite(contact.id)
                    } label: {
                        Image(systemName: contact.isFavorite ? "star.fill" : "star")
                            .foregroundStyle(contact.isFavorite ? Color.yellow : Color.secondary)
                    }
                    .buttonStyle(.plain)
                    .help(contact.isFavorite ? "Remove from Favourites" : "Add to Favourites")
                    Button("Edit…") { sheet = .editContact(contact.id) }
                    Button("Delete…", role: .destructive, action: onDelete)
                }

                if contact.numbers.isEmpty {
                    Text("No numbers").foregroundStyle(.secondary)
                } else {
                    VStack(spacing: 0) {
                        ForEach(contact.numbers) { number in
                            HStack {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(number.label).font(.caption).foregroundStyle(.secondary)
                                    Text(number.number).font(.body.monospacedDigit())
                                }
                                Spacer()
                                Button {
                                    state.call(number.number, from: contact.preferredAccountID)
                                } label: {
                                    Label("Call", systemImage: "phone.fill")
                                }
                                .buttonStyle(.borderedProminent)
                                .tint(.green)
                            }
                            .padding(.vertical, 8)
                            if number.id != contact.numbers.last?.id { Divider() }
                        }
                    }
                    .padding(.horizontal, 12)
                    .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }

                if let accountID = contact.preferredAccountID, let account = state.account(for: accountID) {
                    Text("Calls from \(account.displayLabel)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if !contact.notes.isEmpty {
                    Text(contact.notes).font(.callout)
                }

                if !recent.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Recent calls").font(.headline)
                        ForEach(recent) { record in
                            HStack {
                                Image(systemName: record.symbolName).foregroundStyle(record.symbolColor).frame(width: 18)
                                Text(record.summaryLine)
                                Spacer()
                                Text(record.startedAt, format: .dateTime.day().month().hour().minute())
                                    .foregroundStyle(.secondary)
                            }
                            .font(.callout)
                        }
                    }
                }
            }
            .padding(24)
            .frame(maxWidth: 560, alignment: .leading)
        }
    }
}

struct ContactFormView: View {
    enum Mode: Hashable {
        case add(number: String?, name: String?)
        case edit(UUID)
    }

    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    let mode: Mode

    @State private var draft = Contact(name: "")
    @State private var loaded = false

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section {
                    TextField("Name", text: $draft.name)
                    TextField("Company", text: $draft.company)
                    Toggle("Favourite", isOn: $draft.isFavorite)
                }
                Section("Numbers") {
                    ForEach($draft.numbers) { $number in
                        HStack {
                            Picker("", selection: $number.label) {
                                ForEach(ContactNumber.labels, id: \.self) { Text($0).tag($0) }
                            }
                            .labelsHidden()
                            .frame(width: 110)
                            TextField("Number or SIP address", text: $number.number)
                            Button {
                                draft.numbers.removeAll { $0.id == number.id }
                            } label: {
                                Image(systemName: "minus.circle")
                            }
                            .buttonStyle(.borderless)
                            .help("Remove number")
                        }
                    }
                    Button {
                        draft.numbers.append(ContactNumber(label: draft.numbers.isEmpty ? "Work" : "Other", number: ""))
                    } label: {
                        Label("Add Number", systemImage: "plus.circle")
                    }
                    .buttonStyle(.borderless)
                }
                Section {
                    Picker("Call from", selection: $draft.preferredAccountID) {
                        Text("Dialer’s selected account").tag(UUID?.none)
                        ForEach(state.accounts) { account in
                            Text(account.displayLabel).tag(Optional(account.id))
                        }
                    }
                    TextField("Notes", text: $draft.notes, axis: .vertical)
                        .lineLimit(2...5)
                }
            }
            .formStyle(.grouped)
            Divider()
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(isEditing ? "Save" : "Add Contact") { save() }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(draft.name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(14)
        }
        .frame(width: 480, height: 460)
        .onAppear(perform: load)
    }

    private var isEditing: Bool {
        if case .edit = mode { return true }
        return false
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        switch mode {
        case .add(let number, let name):
            draft = Contact(name: name ?? "", numbers: number.map { [ContactNumber(label: "Work", number: $0)] } ?? [])
        case .edit(let id):
            if let existing = state.contact(for: id) { draft = existing }
        }
    }

    private func save() {
        var contact = draft
        contact.name = contact.name.trimmingCharacters(in: .whitespaces)
        contact.numbers = contact.numbers
            .map { ContactNumber(id: $0.id, label: $0.label, number: $0.number.trimmingCharacters(in: .whitespaces)) }
            .filter { !$0.number.isEmpty }
        if isEditing { state.updateContact(contact) } else { state.addContact(contact) }
        dismiss()
    }
}
