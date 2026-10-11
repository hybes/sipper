import SwiftUI

/// Shared native chat UI. Each snapshot expires independently; nothing is archived.
public struct ManagedMessagesView: View {
    @ObservedObject private var client: ManagedClient
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedDevice: UUID?
    @State private var selectedConversation: UUID?
    @State private var conversations: [ManagedConversation] = []
    @State private var listScope: ManagedMessageScope?
    @State private var listCursor: String?
    @State private var history: ManagedMessagePage?
    @State private var historyCursors: [String?] = [nil]
    @State private var historyPage = 0
    @State private var loading = false
    @State private var historyLoading = false
    @State private var sending = false
    @State private var newOpen = false
    @State private var editingGroup: ManagedConversation?
    @State private var error: String?
    @State private var historyError: String?
    @State private var sendError: String?
    @State private var draft = ""
    @State private var pending: (id: UUID, text: String)?
    @State private var generation = UUID()
    @State private var historyAttempt = UUID()
    @State private var appliedNotification: ManagedMessageNotification?
    private struct MeetingSelection: Identifiable {
        let id = UUID()
        let enrollment: ManagedEnrollment
        let conversationID: UUID
    }
    @State private var meeting: MeetingSelection?
    private let notification: ManagedMessageNotification?
    private let onNavigationLock: (Bool) -> Void
    private let phoneBusy: Bool
    private let claimMeetingAudio: () -> Bool
    private let releaseMeetingAudio: () -> Void

    public init(client: ManagedClient, notification: ManagedMessageNotification? = nil, onNavigationLock: @escaping (Bool) -> Void = { _ in },
                phoneBusy: Bool, claimMeetingAudio: @escaping () -> Bool, releaseMeetingAudio: @escaping () -> Void) {
        self.client = client; self.notification = notification; self.onNavigationLock = onNavigationLock
        self.phoneBusy = phoneBusy; self.claimMeetingAudio = claimMeetingAudio; self.releaseMeetingAudio = releaseMeetingAudio
        _selectedDevice = State(initialValue: notification?.deviceId)
    }
    private var connected: [ManagedEnrollment] {
        guard client.isSignedIn else { return [] }
        return client.enrollments.filter { entry in
            client.organisations.contains { $0.id == entry.organisationID && $0.status == "active" && $0.licensed }
        }
    }
    private var enrollment: ManagedEnrollment? { connected.first { $0.deviceID == selectedDevice } }
    private var connectionHint: String {
        #if os(macOS)
        "Open Settings → Managed to sign in and connect a licensed customer."
        #else
        "Open Accounts to sign in and connect a licensed customer."
        #endif
    }
    private var ready: Bool {
        scenePhase == .active && enrollment != nil && historyError == nil
            && history.map { $0.scope.expiresAt > Date() } == true && listScope.map { $0.expiresAt > Date() } == true
    }
    private var navigationLocked: Bool { sending || pending != nil || !draft.isEmpty || newOpen || editingGroup != nil || meeting != nil }
    private var canOpenNotification: Bool { scenePhase == .active && !navigationLocked }
    public var body: some View {
        VStack(spacing: 0) {
            if enrollment == nil {
                Text(connectionHint)
                    .foregroundStyle(.secondary).multilineTextAlignment(.center).padding()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                HStack {
                    Picker("Customer", selection: $selectedDevice) {
                        ForEach(connected) { Text($0.organisationName).tag(Optional($0.deviceID)) }
                    }.pickerStyle(.menu).disabled(navigationLocked)
                    Spacer(minLength: 8)
                    Button("New conversation") { onNavigationLock(true); newOpen = true }.disabled(loading || listScope == nil || navigationLocked)
                    Button { Task { await refresh() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                        .labelStyle(.iconOnly).disabled(loading || historyLoading || sending)
                }.padding()
                if let error { Text(error).font(.callout).foregroundStyle(.red).padding(.horizontal).padding(.bottom, 8) }
                if let notification, notification != appliedNotification, !canOpenNotification,
                   connected.contains(where: { $0.deviceID == notification.deviceId }) {
                    Text("New message ready. Send or clear your draft, or close the open dialogue, to view it.")
                        .font(.callout).foregroundStyle(.secondary).padding(.horizontal).padding(.bottom, 8)
                }
                Divider()
                #if os(macOS)
                HSplitView {
                    conversationList.frame(minWidth: 220, idealWidth: 260, maxWidth: 320)
                    conversationView.frame(minWidth: 300, maxWidth: .infinity)
                }
                #else
                if selectedConversation == nil { conversationList } else { conversationView }
                #endif
            }
        }
        .onAppear { synchroniseCustomer(); applyNotification(); onNavigationLock(navigationLocked) }
        .onChange(of: navigationLocked) { onNavigationLock($0) }
        .onChange(of: connected) { _ in synchroniseCustomer(); applyNotification() }
        .onChange(of: client.identity?.id) { _ in resetCustomer(); synchroniseCustomer() }
        .onChange(of: selectedDevice) { _ in resetCustomer(); applyNotification() }
        .onChange(of: notification) { _ in applyNotification() }
        .onChange(of: canOpenNotification) { _ in applyNotification() }
        .onChange(of: selectedConversation) { _ in
            historyAttempt = UUID(); history = nil; historyError = nil; historyLoading = false
            historyCursors = [nil]; historyPage = 0; discard()
            if selectedConversation != nil { Task { await loadHistory() } }
        }
        .onChange(of: scenePhase) { phase in if phase != .active { clearSnapshots(closeEditor: phase == .background) } }
        .onDisappear { generation = UUID(); clearSnapshots(); discard(); onNavigationLock(false) }
        #if !os(macOS)
        .navigationBarBackButtonHidden(navigationLocked)
        #endif
        .task(id: "\(selectedDevice?.uuidString ?? "")/\(scenePhase)") {
            guard scenePhase == .active, enrollment != nil else { return }
            while !Task.isCancelled {
                if !loading && !historyLoading && !sending { await refresh() }
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
            }
        }
        .task(id: history?.scope.expiresAt) {
            guard let expiry = history?.scope.expiresAt else { return }
            do { try await Task.sleep(for: .seconds(max(0, expiry.timeIntervalSinceNow))) } catch { return }
            history = nil
        }
        .task(id: listScope?.expiresAt) {
            guard let expiry = listScope?.expiresAt else { return }
            do { try await Task.sleep(for: .seconds(max(0, expiry.timeIntervalSinceNow))) } catch { return }
            conversations = []; listScope = nil; listCursor = nil
        }
        .sheet(isPresented: $newOpen) {
            if let enrollment {
                ManagedNewConversationView(client: client, enrollment: enrollment) { id in
                    guard self.enrollment == enrollment else { return }
                    newOpen = false; selectedConversation = id
                    Task { await loadConversations() }
                }
            }
        }
        .sheet(item: $editingGroup, onDismiss: { Task { await refresh() } }) { group in
            if let enrollment {
                ManagedNewConversationView(client: client, enrollment: enrollment, group: group, onLeft: {
                    editingGroup = nil; selectedConversation = nil; discard(); clearSnapshots()
                    Task { await loadConversations() }
                }) { _ in
                    editingGroup = nil; Task { await refresh() }
                }
            }
        }
        .sheet(item: $meeting) { selected in
            ManagedMeetingView(client: client, enrollment: selected.enrollment, conversationID: selected.conversationID,
                phoneBusy: phoneBusy, claimAudio: claimMeetingAudio, releaseAudio: releaseMeetingAudio)
        }
    }
    private var conversationList: some View {
        VStack(spacing: 0) {
            List(selection: $selectedConversation) {
                if conversations.isEmpty { Text(loading ? "Loading conversations…" : "No conversations yet.").foregroundStyle(.secondary) }
                ForEach(conversations) { conversation in
                    Button { selectedConversation = conversation.id } label: {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(conversation.title).foregroundStyle(.primary)
                                Text(conversation.updatedAt, style: .date).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if conversation.unread > 0 { Text("\(conversation.unread)").font(.caption.bold()).foregroundStyle(Color.accentColor).accessibilityLabel(conversation.unread == 1 ? "1 unread message" : "\(conversation.unread) unread messages") }
                        }.padding(.vertical, 4)
                    }.buttonStyle(.plain).tag(conversation.id)
                }
            }.listStyle(.plain).accessibilityLabel("Conversations").disabled(navigationLocked)
            if listCursor != nil { Button("More conversations") { Task { await loadConversations(more: true) } }.disabled(loading).padding() }
        }
    }
    @ViewBuilder private var conversationView: some View {
        if let selectedConversation {
            VStack(spacing: 0) {
                HStack {
                    #if !os(macOS)
                    Button { self.selectedConversation = nil } label: { Label("Conversations", systemImage: "chevron.left") }.disabled(navigationLocked)
                    #endif
                    Text(history?.conversation.title ?? conversations.first { $0.id == selectedConversation }?.title ?? "Conversation").font(.headline)
                    Spacer(minLength: 8)
                    Button("Meeting") {
                        if let enrollment { meeting = MeetingSelection(enrollment: enrollment, conversationID: selectedConversation) }
                    }.disabled(!ready || sending || pending != nil || newOpen || editingGroup != nil)
                }.padding()
                if let conversation = history?.conversation, conversation.kind == .group {
                    HStack {
                        Text(conversation.participants.map(\.name).joined(separator: ", ")).font(.caption).foregroundStyle(.secondary)
                        Spacer(minLength: 8)
                        if conversation.revision != nil {
                            Button("Group settings") { onNavigationLock(true); editingGroup = conversation }.disabled(sending || pending != nil || !ready)
                        }
                    }.padding(.horizontal).padding(.bottom, 8)
                }
                HStack {
                    Button("Older messages") { historyCursors = Array(historyCursors.prefix(historyPage + 1)) + [history?.nextCursor]; historyPage += 1; Task { await loadHistory() } }
                        .disabled(history?.nextCursor == nil || historyLoading || sending)
                    if historyPage > 0 {
                        Button("Newer messages") { historyPage -= 1; Task { await loadHistory() } }.disabled(historyLoading || sending)
                        Button("Latest") { latest() }.disabled(historyLoading || sending)
                    }
                }.font(.caption).padding(.horizontal).padding(.bottom, 8)
                if let historyError {
                    HStack { Text(historyError).foregroundStyle(.red); Button("Reload latest") { latest() } }.font(.callout).padding()
                }
                Divider()
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 20) {
                            if let history, scenePhase == .active {
                                if history.messages.isEmpty { Text("No messages in this conversation yet.").foregroundStyle(.secondary) }
                                ForEach(history.messages) { message in
                                    VStack(alignment: .leading, spacing: 5) {
                                        HStack(alignment: .firstTextBaseline) {
                                            Text(message.senderId == history.scope.userId ? "You" : message.senderName).font(.subheadline.bold())
                                            Text(message.createdAt, style: .time).font(.caption).foregroundStyle(.secondary)
                                        }
                                        Text(verbatim: message.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                                    }.id(message.id)
                                }
                            } else { Text(historyLoading ? "Loading conversation…" : "Refresh to reconnect to this conversation.").foregroundStyle(.secondary) }
                        }.padding().frame(maxWidth: .infinity, alignment: .leading)
                    }.accessibilityLabel("Message history")
                        .onChange(of: history?.messages.last?.id) { id in if historyPage == 0, let id { proxy.scrollTo(id, anchor: .bottom) } }
                }
                Divider()
                VStack(alignment: .leading, spacing: 8) {
                    if let sendError { Text(sendError).font(.callout).foregroundStyle(.red) }
                    Text("Message").font(.caption).foregroundStyle(.secondary)
                    TextEditor(text: Binding(get: { draft }, set: { draft = $0; onNavigationLock(navigationLocked) }))
                        .frame(minHeight: 60, maxHeight: 100).accessibilityLabel("Message text")
                        .disabled(!ready || sending || pending != nil)
                    HStack {
                        Text("\(draft.utf16.count)/4096").font(.caption).foregroundStyle(.secondary)
                        if let history { Text("Kept for \(history.scope.retentionDays) days").font(.caption).foregroundStyle(.secondary) }
                        Spacer(minLength: 8)
                        if !sending && (!draft.isEmpty || pending != nil) {
                            Button(pending == nil ? "Clear draft" : "Discard") { discard() }
                                .accessibilityLabel(pending == nil ? "Clear draft" : "Discard pending message")
                        }
                        if sending { ProgressView().controlSize(.small) }
                        Button(pending == nil ? "Send" : "Retry send") { Task { await send() } }.buttonStyle(.borderedProminent)
                            .disabled(!ready || sending || !validMessageBody(draft))
                    }
                }.padding()
            }
        } else { Text("Choose a conversation or start one with a colleague.").foregroundStyle(.secondary).padding().frame(maxWidth: .infinity, maxHeight: .infinity) }
    }
    private func synchroniseCustomer() {
        if !connected.contains(where: { $0.deviceID == selectedDevice }) { selectedDevice = connected.first?.deviceID }
        if connected.isEmpty { resetCustomer() }
    }
    private func applyNotification() {
        guard canOpenNotification, let notification, notification != appliedNotification,
              connected.contains(where: { $0.deviceID == notification.deviceId }) else { return }
        if selectedDevice != notification.deviceId { selectedDevice = notification.deviceId; return }
        appliedNotification = notification; selectedConversation = notification.conversationId
    }
    private func clearSnapshots(closeEditor: Bool = true) {
        historyAttempt = UUID(); history = nil; historyLoading = false
        conversations = []; listScope = nil; listCursor = nil
        if closeEditor { editingGroup = nil }
    }
    private func resetCustomer() {
        generation = UUID(); clearSnapshots(); selectedConversation = nil
        loading = false; sending = false; newOpen = false; error = nil; historyError = nil; discard()
    }
    private func discard() { draft = ""; pending = nil; sendError = nil }
    private func matches(_ enrollment: ManagedEnrollment, generation: UUID) -> Bool {
        self.generation == generation && self.enrollment == enrollment && scenePhase == .active && !Task.isCancelled
    }
    private func accessDenied(_ failure: Error) -> Bool {
        if case ManagedError.accessUnavailable = failure { return true }
        return (failure as? ManagedError) == .signInRequired
    }
    private func refresh() async { await loadConversations(); if selectedConversation != nil { await loadHistory() } }
    private func loadConversations(more: Bool = false) async {
        guard let enrollment, !loading, scenePhase == .active else { return }
        let generation = generation, hadEntries = !conversations.isEmpty
        loading = true
        defer { if self.generation == generation { loading = false } }
        do {
            let value = try await client.conversations(for: enrollment, after: more ? listCursor : nil)
            guard matches(enrollment, generation: generation) else { return }
            let retained = conversations.contains { old in !value.conversations.contains { $0.id == old.id } }
            let expiry = retained ? min(listScope?.expiresAt ?? value.scope.expiresAt, value.scope.expiresAt) : value.scope.expiresAt
            var merged = Dictionary(uniqueKeysWithValues: conversations.map { ($0.id, $0) })
            for conversation in value.conversations { merged[conversation.id] = conversation }
            conversations = merged.values.sorted { a, b in a.lastSequence == b.lastSequence ? a.id.uuidString > b.id.uuidString : messagingSequence(a.lastSequence)! > messagingSequence(b.lastSequence)! }
            listScope = value.scope; listScope?.expiresAt = expiry
            if more || !hadEntries { listCursor = value.nextCursor }; error = nil
        } catch {
            if matches(enrollment, generation: generation) { self.error = error.localizedDescription; if accessDenied(error) { clearSnapshots(); discard() } }
        }
    }
    private func loadHistory() async {
        guard let enrollment, let id = selectedConversation, scenePhase == .active else { return }
        let generation = generation, attempt = UUID(), cursor = historyCursors[historyPage]
        historyAttempt = attempt; historyLoading = true
        defer { if historyAttempt == attempt { historyLoading = false } }
        do {
            let value = try await client.conversationMessages(id, for: enrollment, before: cursor)
            guard matches(enrollment, generation: generation), selectedConversation == id, historyAttempt == attempt else { return }
            history = value; historyError = nil
            if let index = conversations.firstIndex(where: { $0.id == id }) { conversations[index] = value.conversation }
            if let sequence = value.messages.last?.sequence { try? await client.markConversationRead(id, sequence: sequence, for: enrollment) }
        } catch {
            if matches(enrollment, generation: generation), selectedConversation == id, historyAttempt == attempt {
                historyError = error.localizedDescription; if accessDenied(error) { clearSnapshots(); discard() }
            }
        }
    }
    private func latest() { historyCursors = [nil]; historyPage = 0; Task { await loadHistory() } }
    private func send() async {
        guard ready, !sending, let enrollment, let id = selectedConversation, validMessageBody(draft) else { return }
        pending = pending ?? (UUID(), draft)
        let value = pending!, generation = generation
        sending = true; sendError = nil
        defer { if self.generation == generation { sending = false } }
        do {
            _ = try await client.sendMessage(id: value.id, text: value.text, conversationID: id, for: enrollment)
            guard self.generation == generation, self.enrollment == enrollment, selectedConversation == id else { return }
            discard(); historyCursors = [nil]; historyPage = 0; await refresh()
        } catch {
            if self.generation == generation, self.enrollment == enrollment, selectedConversation == id {
                sendError = "Message not confirmed. \(error.localizedDescription)"
                if [.invalidMessageInput, .messagesChanged, .messageRateLimit].contains(error as? ManagedError ?? .requestFailed) { pending = nil }
                if accessDenied(error) { clearSnapshots(); discard() }
            }
        }
    }
}

private struct ManagedNewConversationView: View {
    @ObservedObject var client: ManagedClient
    let enrollment: ManagedEnrollment
    var group: ManagedConversation? = nil
    var onLeft: (() -> Void)? = nil
    let onCreated: (UUID) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var people: ManagedMessagePeople?
    @State private var selected: [ManagedMessagePerson] = []
    @State private var search = ""
    @State private var searched = ""
    @State private var title = ""
    @State private var loading = false
    @State private var creating = false
    @State private var error: String?
    @State private var createID = UUID()
    @State private var pending: (userIDs: [String], title: String, ownerID: String, leave: Bool)?
    @State private var ownerID = ""
    @State private var confirmLeave = false
    private var canEdit: Bool { group == nil || group?.ownerId == enrollment.userID }
    private var choices: [ManagedMessagePerson] {
        if !canEdit { return selected }
        var unique = Dictionary(uniqueKeysWithValues: (people?.people ?? []).map { ($0.id, $0) })
        if group != nil { for person in selected { unique[person.id] = person } }
        return unique.values.sorted { $0.name == $1.name ? $0.id < $1.id : $0.name < $1.name }
    }
    @State private var attempt = UUID()
    private var authorised: Bool {
        client.isSignedIn && client.enrollments.contains(enrollment)
            && client.organisations.contains { $0.id == enrollment.organisationID && $0.status == "active" && $0.licensed }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Text(group == nil ? "New conversation" : "Group settings").font(.headline); Spacer(); Button("Cancel") { dismiss() }.disabled(creating) }
            if let error { Text(error).foregroundStyle(.red) }
            if canEdit { HStack {
                TextField("Find a colleague", text: $search).textFieldStyle(.roundedBorder).accessibilityLabel("Find a colleague").disabled(creating || pending != nil)
                Button("Search") { searched = search; Task { await load() } }.disabled(loading || creating || pending != nil)
            } }
            Text("People · \(selected.count)/19 selected").font(.subheadline)
            List {
                ForEach(choices) { person in
                    Toggle(person.name, isOn: Binding(get: { selected.contains { $0.id == person.id } }, set: { chosen in
                        if chosen { selected.append(person) } else { selected.removeAll { $0.id == person.id }; if ownerID == person.id { ownerID = enrollment.userID } }
                    })).disabled(!canEdit || creating || pending != nil || (selected.count >= 19 && !selected.contains { $0.id == person.id }))
                }
                if people?.people.isEmpty != false { Text(loading ? "Loading people…" : "No active licensed colleagues match this search.").foregroundStyle(.secondary) }
                if canEdit && people?.nextCursor != nil { Button("More people") { Task { await load(more: true) } }.disabled(loading || creating || pending != nil) }
            }.listStyle(.plain)
            if !selected.isEmpty { Text("Selected: \(selected.map(\.name).joined(separator: ", "))").font(.caption).foregroundStyle(.secondary) }
            if canEdit && (group != nil || selected.count > 1) { TextField("Group name", text: $title).textFieldStyle(.roundedBorder).disabled(creating || pending != nil) }
            if group != nil {
                if canEdit { Picker("Group owner", selection: $ownerID) {
                    Text("You").tag(enrollment.userID)
                    ForEach(selected) { Text($0.name).tag($0.id) }
                }.disabled(creating || pending != nil) }
                else { Text("Only the group owner can change its name or people.").font(.caption).foregroundStyle(.secondary) }
                Text("New members see messages sent after they join.").font(.caption).foregroundStyle(.secondary)
                Button("Leave group") { confirmLeave = true }.disabled(creating || pending != nil)
                if error != nil && pending == nil { Button("Reload group") { dismiss() } }
            }
            Text("Messages stay within this customer organisation.").font(.caption).foregroundStyle(.secondary)
            HStack {
                if pending != nil && !creating { Button("Discard pending request") { pending = nil; createID = UUID(); error = nil } }
                Spacer()
                if creating { ProgressView().controlSize(.small) }
                if canEdit || pending?.leave == true { Button(pending == nil ? (group == nil ? "Start conversation" : "Save group") : "Retry request") { Task { await create() } }.buttonStyle(.borderedProminent)
                    .disabled(!authorised || creating || (group == nil && selected.isEmpty) || ((group != nil || selected.count > 1) && title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)) }
            }
        }.padding()
        #if os(macOS)
        .frame(minWidth: 400, idealWidth: 460, minHeight: 450)
        #endif
        .task {
            if let group {
                selected = group.participants.filter { $0.id != enrollment.userID }.map { ManagedMessagePerson(id: $0.id, name: $0.name) }
                title = group.title; ownerID = group.ownerId ?? enrollment.userID
            }
            await load()
        }
        .confirmationDialog("Leave group?", isPresented: $confirmLeave, titleVisibility: .visible) {
            Button("Leave group", role: .destructive) { Task { await create(leave: true) } }
        } message: { Text("You will lose access to this group's messages. If you own it, ownership passes to a remaining member.") }
        .task(id: people?.scope.expiresAt) {
            guard let expiry = people?.scope.expiresAt else { return }
            do { try await Task.sleep(for: .seconds(max(0, expiry.timeIntervalSinceNow))) } catch { return }
            people = nil
        }
        .onChange(of: scenePhase) { if $0 == .active { Task { await load() } } else { people = nil } }
        .onChange(of: authorised) { if !$0 { attempt = UUID(); people = nil; selected = []; dismiss() } }
        .onDisappear { attempt = UUID(); people = nil; selected = [] }
        .interactiveDismissDisabled(creating)
    }
    private func load(more: Bool = false) async {
        guard authorised, scenePhase == .active, !loading else { return }
        let attempt = attempt
        loading = true
        defer { if self.attempt == attempt { loading = false } }
        do {
            let value = try await client.messagePeople(for: enrollment, search: searched, after: more ? people?.nextCursor : nil)
            guard self.attempt == attempt, authorised, scenePhase == .active, !Task.isCancelled else { return }
            people = value; error = nil
        } catch { if self.attempt == attempt && !Task.isCancelled { self.error = error.localizedDescription } }
    }
    private func create(leave: Bool = false) async {
        guard authorised, !creating, leave || pending?.leave == true || canEdit else { return }
        pending = pending ?? (selected.map(\.id), title, ownerID, leave)
        let value = pending!, attempt = attempt
        creating = true; error = nil
        defer { if self.attempt == attempt { creating = false } }
        do {
            if value.leave, let group {
                try await client.leaveMessageGroup(group.id, for: enrollment)
                guard self.attempt == attempt, authorised else { return }
                onLeft?()
            } else {
                let conversation: ManagedConversation
                if let group { conversation = try await client.updateMessageGroup(group.id, revision: group.revision!, title: value.title, userIDs: [enrollment.userID] + value.userIDs, ownerID: value.ownerID, for: enrollment) }
                else { conversation = try await client.createConversation(id: createID, userIDs: value.userIDs, title: value.title, for: enrollment) }
                guard self.attempt == attempt, authorised else { return }
                onCreated(conversation.id)
            }
        } catch {
            if self.attempt == attempt {
                if (error as? ManagedError) == .signInRequired { selected = []; people = nil; if group != nil { onLeft?() } else { dismiss() }; return }
                if case ManagedError.accessUnavailable = error { selected = []; people = nil; if group != nil { onLeft?() } else { dismiss() }; return }
                self.error = "Request not confirmed. \(error.localizedDescription)"
                if [.invalidMessageInput, .messagesChanged, .messageRateLimit].contains(error as? ManagedError ?? .requestFailed) { pending = nil }
            }
        }
    }
}
