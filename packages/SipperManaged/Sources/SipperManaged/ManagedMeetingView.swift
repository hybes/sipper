import AVFoundation
import Combine
import LiveKit
import SwiftUI

/// One in-memory join. Phone audio is claimed before any media connection and
/// released only after pending permission/connect work and local tracks finish.
@MainActor
final class ManagedMeetingSession: NSObject, ObservableObject, RoomDelegate {
    @Published private(set) var current: ManagedCurrentMeeting?
    @Published private(set) var details: ManagedMeetingDetails?
    @Published private(set) var room: Room?
    @Published private(set) var loading = false
    @Published private(set) var joining = false
    @Published private(set) var stopping = false
    @Published private(set) var captureBusy = false
    @Published private(set) var controlling = false
    @Published private(set) var error: String?
    let client: ManagedClient
    let enrollment: ManagedEnrollment
    let conversationID: UUID
    private let claimAudio: () -> Bool
    private let releaseAudio: () -> Void
    private var claimedAudio = false
    private var startID = UUID()
    private var joinID: UUID?
    private var joinedMeeting: UUID?
    private var generation = UUID()
    private var joinTask: Task<Void, Never>?
    private var captureTask: Task<Void, Never>?
    private var stopTask: Task<Void, Never>?

    init(client: ManagedClient, enrollment: ManagedEnrollment, conversationID: UUID,
         claimAudio: @escaping () -> Bool, releaseAudio: @escaping () -> Void) {
        self.client = client; self.enrollment = enrollment; self.conversationID = conversationID
        self.claimAudio = claimAudio; self.releaseAudio = releaseAudio
    }
    var authorised: Bool {
        client.isSignedIn && client.identity?.id == enrollment.userID && client.enrollments.contains(enrollment)
            && client.organisations.contains { $0.id == enrollment.organisationID && $0.status == "active" && $0.licensed }
    }
    var metadataReady: Bool { details.map { $0.scope.expiresAt > Date() && $0.canJoin } == true }
    var canJoin: Bool {
        authorised && !loading && !joining && !stopping && !controlling && room == nil && current?.available == true
            && current.map { $0.scope.expiresAt > Date() } == true
            && (current?.meeting == nil || metadataReady)
    }
    var host: Bool { details?.meeting.createdBy == enrollment.userID }
    var canControl: Bool { authorised && metadataReady && !controlling && !stopping }
    private func matches(_ attempt: UUID) -> Bool { generation == attempt && authorised && !Task.isCancelled }
    func clearExpiredMetadata(now: Date = Date()) {
        if current.map({ $0.scope.expiresAt <= now }) == true { current = nil }
        if details.map({ $0.scope.expiresAt <= now }) == true { details = nil }
    }
    func refresh() async {
        guard authorised else { details = nil; current = nil; stop(reason: "Meeting access is no longer available."); return }
        guard !loading, !joining, !stopping else { return }
        let attempt = generation
        loading = true
        defer { if generation == attempt { loading = false } }
        do {
            let value = try await client.currentMeeting(conversationID: conversationID, for: enrollment)
            guard matches(attempt) else { return }
            let id = joinedMeeting ?? value.meeting?.id
            if let id {
                let metadata = try await client.meetingDetails(id, for: enrollment)
                guard matches(attempt) else { return }
                details = metadata
                if joinedMeeting != nil, !metadata.canJoin || metadata.sessions.contains(where: { $0.id == joinID && $0.revokedAt != nil }) {
                    stop(reason: metadata.meeting.endedAt != nil ? "The meeting has ended." : "Your meeting access was withdrawn.")
                }
            } else { details = nil }
            current = value
        } catch {
            guard generation == attempt else { return }
            self.error = error.localizedDescription
            if !authorised || [.signInRequired, .meetingUnavailable].contains(error as? ManagedError ?? .requestFailed) {
                current = nil; details = nil; stop(reason: self.error)
            } else if case ManagedError.accessUnavailable = error {
                current = nil; details = nil; stop(reason: self.error)
            }
        }
    }
    func join() {
        guard canJoin else { return }
        guard claimAudio() else { error = "Finish your phone call before joining a meeting."; return }
        claimedAudio = true; joining = true; error = nil
        let attempt = generation, sessionID = UUID()
        joinID = sessionID
        joinTask = Task { [self] in
            defer { if generation == attempt { joining = false; joinTask = nil } }
            do {
                let value: ManagedCurrentMeeting
                if current?.meeting == nil { value = try await client.startMeeting(id: startID, conversationID: conversationID, for: enrollment) }
                else { value = try await client.currentMeeting(conversationID: conversationID, for: enrollment) }
                guard matches(attempt), let meeting = value.meeting else { throw ManagedError.meetingUnavailable }
                current = value; joinedMeeting = meeting.id
                let metadata = try await client.meetingDetails(meeting.id, for: enrollment)
                guard matches(attempt), metadata.canJoin else { throw ManagedError.meetingUnavailable }
                details = metadata
                let grant = try await client.joinMeeting(meeting.id, sessionID: sessionID, for: enrollment)
                guard matches(attempt), grant.expiresAt > Date() else { throw ManagedError.meetingUnavailable }
                // Receiving does not open microphone input or request its permission.
                try AudioManager.shared.setEngineAvailability(.init(isInputAvailable: false, isOutputAvailable: true))
                let media = Room()
                media.add(delegate: self); room = media
                try await media.connect(url: grant.url.absoluteString, token: grant.token,
                    connectOptions: ConnectOptions(enableMicrophone: false),
                    roomOptions: RoomOptions(adaptiveStream: true, dynacast: true, stopLocalTrackOnUnpublish: true))
                guard matches(attempt) else { await media.disconnect(); throw CancellationError() }
            } catch {
                if generation == attempt {
                    self.error = (error as? ManagedError)?.localizedDescription ?? "Could not connect meeting media. Check your connection, then join again."
                    stop()
                }
                // stop() waits for this task before withdrawing a late HTTP join.
            }
        }
    }
    func stop(reason: String? = nil) {
        if let reason { error = reason }
        guard !stopping else { return }
        generation = UUID(); loading = false; joining = false; stopping = true
        joinTask?.cancel(); captureTask?.cancel()
        // Fence all late SDK input/output immediately, before asynchronous cleanup.
        if claimedAudio { try? AudioManager.shared.setEngineAvailability(.none) }
        let pendingJoin = joinTask, pendingCapture = captureTask, media = room
        stopTask = Task { [self] in
            if let media { await media.disconnect() }
            await pendingJoin?.value; await pendingCapture?.value
            // A pending connect/capture may have published after the first disconnect.
            if let media { await stopTracks(media); await media.disconnect() }
            if let id = joinedMeeting, let session = joinID {
                do { try await client.leaveMeeting(id, sessionID: session, for: enrollment) }
                catch { if authorised { self.error = "Local media stopped. Leaving was not confirmed. \(error.localizedDescription)" } }
                startID = UUID()
            }
            room = nil; joinedMeeting = nil; joinID = nil; joinTask = nil; captureTask = nil
            captureBusy = false; stopping = false; stopTask = nil
            if claimedAudio { claimedAudio = false; releaseAudio() }
        }
    }
    func waitForStop() async { await stopTask?.value }
    private func stopTracks(_ media: Room, source: Track.Source? = nil) async {
        for publication in media.localParticipant.trackPublications.values {
            guard source == nil || publication.source == source else { continue }
            try? await publication.track?.stop()
            if let local = publication as? LocalTrackPublication { try? await media.localParticipant.unpublish(publication: local) }
        }
    }
    func capture(_ source: Track.Source, enabled: Bool) {
        guard !captureBusy, !stopping, let media = room, source == .microphone || source == .camera else { return }
        guard !enabled || (metadataReady && authorised && media.connectionState == .connected) else { return }
        let attempt = generation
        captureBusy = true; error = nil
        captureTask = Task { [self] in
            defer { if generation == attempt { captureBusy = false; captureTask = nil } }
            do {
                if !enabled {
                    // Stop capture, rather than merely muting its outgoing packets.
                    if source == .microphone { try AudioManager.shared.setEngineAvailability(.init(isInputAvailable: false, isOutputAvailable: true)) }
                    await stopTracks(media, source: source)
                    return
                }
                let granted = await LiveKitSDK.ensureDeviceAccess(for: [source == .microphone ? .audio : .video])
                guard matches(attempt), room === media, metadataReady, media.connectionState == .connected else { throw CancellationError() }
                guard granted else { throw NSError(domain: "SipperMeeting", code: 1, userInfo: [NSLocalizedDescriptionKey: "Allow Sipper to use the \(source == .microphone ? "microphone" : "camera") in system privacy settings."]) }
                if source == .microphone {
                    try AudioManager.shared.setEngineAvailability(.default)
                    try await media.localParticipant.setMicrophone(enabled: true)
                } else { try await media.localParticipant.setCamera(enabled: true) }
                guard matches(attempt), room === media, metadataReady, media.connectionState == .connected else { throw CancellationError() }
            } catch {
                await stopTracks(media, source: source)
                if source == .microphone, room === media { try? AudioManager.shared.setEngineAvailability(.init(isInputAvailable: false, isOutputAvailable: !stopping)) }
                if generation == attempt { self.error = error.localizedDescription }
            }
        }
    }
    func end() async {
        guard canControl, host, let details else { return }
        controlling = true
        defer { controlling = false }
        do { _ = try await client.endMeeting(details.meeting.id, for: enrollment); stop(reason: "Meeting end requested. Server confirmation may take a moment.") }
        catch { self.error = error.localizedDescription }
    }
    func remove(_ userID: String) async {
        guard canControl, host, userID != enrollment.userID, let details else { return }
        controlling = true
        defer { controlling = false }
        do { try await client.removeMeetingPerson(userID, meetingID: details.meeting.id, for: enrollment); await refresh() }
        catch { self.error = error.localizedDescription }
    }
    nonisolated func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        Task { @MainActor [weak self] in
            guard let self, self.room === room, !self.stopping else { return }
            self.stop(reason: "The media connection ended. Join again to reconnect.")
        }
    }
}

/// Shared Mac/iOS meeting screen. SDK tracks and grants never enter persistent storage.
public struct ManagedMeetingView: View {
    @StateObject private var session: ManagedMeetingSession
    @ObservedObject private var client: ManagedClient
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var confirmEnd = false
    @State private var removing: String?
    private let phoneBusy: Bool
    public init(client: ManagedClient, enrollment: ManagedEnrollment, conversationID: UUID, phoneBusy: Bool,
                claimAudio: @escaping () -> Bool, releaseAudio: @escaping () -> Void) {
        self.client = client; self.phoneBusy = phoneBusy
        _session = StateObject(wrappedValue: ManagedMeetingSession(client: client, enrollment: enrollment, conversationID: conversationID, claimAudio: claimAudio, releaseAudio: releaseAudio))
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(session.details?.title ?? "Meeting").font(.title2.bold()).lineLimit(2)
                Spacer()
                Button(session.room == nil && !session.joining ? "Close" : "Leave") {
                    session.stop(); Task { await session.waitForStop(); dismiss() }
                }.disabled(session.stopping)
            }
            Text(session.enrollment.organisationName).font(.callout).foregroundStyle(.secondary)
            if let error = session.error { Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
            if phoneBusy { Text("Finish your phone call before joining a meeting.").foregroundStyle(.secondary) }
            if session.joining || session.stopping { ProgressView(session.stopping ? "Stopping local media…" : "Joining meeting…") }
            if let media = session.room { ManagedMeetingMediaView(room: media, session: session, removing: $removing) }
            else {
                Text(session.current?.available == false ? "Meetings are not configured for this service yet." : session.details?.meeting.endedAt != nil ? "The meeting has ended." : "Join with microphone and camera off. You can turn them on after joining.").foregroundStyle(.secondary)
                HStack {
                    Button(session.current?.meeting == nil ? "Start meeting" : "Join meeting") { session.join() }
                        .buttonStyle(.borderedProminent).disabled(!session.canJoin || phoneBusy)
                    Button("Refresh") { Task { await session.refresh() } }.disabled(session.loading || session.joining || session.stopping)
                }
                Spacer()
            }
            if session.host {
                Button("End for everyone…", role: .destructive) { confirmEnd = true }.disabled(!session.canControl)
            }
            #if os(iOS)
            Text("Meeting media stops when Sipper goes into the background.").font(.caption).foregroundStyle(.secondary)
            #endif
        }.padding()
        #if os(macOS)
        .frame(minWidth: 720, idealWidth: 840, minHeight: 540, idealHeight: 650)
        #endif
        .interactiveDismissDisabled(session.joining || session.stopping || session.room != nil)
        .task {
            while !Task.isCancelled {
                await session.refresh(); session.clearExpiredMetadata()
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
            }
        }
        .task(id: session.current?.scope.expiresAt) {
            guard let expiry = session.current?.scope.expiresAt else { return }
            do { try await Task.sleep(for: .seconds(max(0, expiry.timeIntervalSinceNow))) } catch { return }
            session.clearExpiredMetadata()
        }
        .task(id: session.details?.scope.expiresAt) {
            guard let expiry = session.details?.scope.expiresAt else { return }
            do { try await Task.sleep(for: .seconds(max(0, expiry.timeIntervalSinceNow))) } catch { return }
            session.clearExpiredMetadata()
        }
        .onChange(of: session.authorised) { allowed in if !allowed { session.stop(reason: "Meeting access is no longer available.") } }
        .onChange(of: phoneBusy) { busy in if busy { session.stop(reason: "A phone call needs your audio. Join again when it finishes.") } }
        .onChange(of: scenePhase) { phase in
            #if os(iOS)
            // ponytail: foreground meetings only; background/lock-screen support needs a meeting CallKit owner.
            if phase == .background { session.stop(reason: "Meeting media stopped while Sipper was in the background. Join again to reconnect.") }
            #endif
        }
        .onDisappear { session.stop() }
        .confirmationDialog("End this meeting for everyone?", isPresented: $confirmEnd) {
            Button("End meeting", role: .destructive) { Task { await session.end() } }
        } message: { Text("Everyone will be disconnected. A new meeting will have separate access.") }
        .confirmationDialog("Remove this person from the meeting?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
            Button("Remove person", role: .destructive) { if let id = removing { removing = nil; Task { await session.remove(id) } } }
        } message: { Text("All of their devices will leave this meeting. They cannot rejoin it.") }
    }
}

private struct ManagedMeetingMediaView: View {
    @ObservedObject var room: Room
    @ObservedObject var session: ManagedMeetingSession
    @Binding var removing: String?
    private var participants: [Participant] {
        [room.localParticipant] + room.remoteParticipants.values.sorted { ($0.identity?.stringValue ?? "") < ($1.identity?.stringValue ?? "") }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(status).font(.callout).foregroundStyle(.secondary)
            ScrollView(.horizontal) {
                HStack {
                    Button(room.localParticipant.isMicrophoneEnabled() ? "Turn microphone off" : "Turn microphone on") {
                        session.capture(.microphone, enabled: !room.localParticipant.isMicrophoneEnabled())
                    }.disabled(session.captureBusy || session.stopping || (!room.localParticipant.isMicrophoneEnabled() && !canCapture))
                    Button(room.localParticipant.isCameraEnabled() ? "Turn camera off" : "Turn camera on") {
                        session.capture(.camera, enabled: !room.localParticipant.isCameraEnabled())
                    }.disabled(session.captureBusy || session.stopping || (!room.localParticipant.isCameraEnabled() && !canCapture))
                }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ScrollView(.horizontal) {
                        VStack(alignment: .leading, spacing: 0) {
                            HStack { Text("Person").frame(width: 200, alignment: .leading); Text("Microphone").frame(width: 100); Text("Camera").frame(width: 80); Text("Screen").frame(width: 80); Text("Actions").frame(width: 100) }.font(.caption.bold()).padding(.vertical, 8)
                            Divider()
                            ForEach(participants, id: \.identity) { person in
                                ManagedMeetingPersonRow(person: person, local: person === room.localParticipant, session: session, removing: $removing)
                                Divider()
                            }
                        }
                    }.accessibilityLabel("Meeting participants")
                    ForEach(participants, id: \.identity) { person in
                        ManagedMeetingVideoView(person: person, local: person === room.localParticipant, session: session)
                    }
                }
            }
        }
    }
    private var canCapture: Bool { session.metadataReady && session.authorised && room.connectionState == .connected }
    private var status: String {
        switch room.connectionState {
        case .connected: "Connected"
        case .connecting: "Connecting…"
        case .reconnecting: "Reconnecting…"
        case .disconnecting: "Disconnecting…"
        default: "Disconnected"
        }
    }
}

@MainActor private func meetingPersonName(_ person: Participant, local: Bool, session: ManagedMeetingSession) -> String {
    if local { return "You" }
    let id = person.identity?.stringValue.replacingOccurrences(of: "sipper:", with: "")
    if let row = session.details?.sessions.first(where: { $0.id.uuidString.lowercased() == id }) {
        if row.userId == session.enrollment.userID { return "You (another device)" }
        return row.name ?? "Participant"
    }
    return "Participant"
}
private struct ManagedMeetingPersonRow: View {
    @ObservedObject var person: Participant
    let local: Bool
    @ObservedObject var session: ManagedMeetingSession
    @Binding var removing: String?
    var body: some View {
        HStack {
            Text(meetingPersonName(person, local: local, session: session)).frame(width: 200, alignment: .leading)
            Text(person.isMicrophoneEnabled() ? "On" : "Off").frame(width: 100)
            Text(person.isCameraEnabled() ? "On" : "Off").frame(width: 80)
            Text(person.isScreenShareEnabled() ? "Sharing" : "Off").frame(width: 80)
            Group {
                if let target, session.host, !local, target.userId != session.enrollment.userID {
                    Button("Remove…") { removing = target.userId }.disabled(!session.canControl)
                } else { Text("—").foregroundStyle(.secondary) }
            }.frame(width: 100)
        }.font(.callout).padding(.vertical, 10)
    }
    private var target: ManagedMeetingDetails.Session? {
        session.details?.sessions.first { "sipper:\($0.id.uuidString.lowercased())" == person.identity?.stringValue }
    }
}
private struct ManagedMeetingVideoView: View {
    @ObservedObject var person: Participant
    let local: Bool
    @ObservedObject var session: ManagedMeetingSession
    var body: some View {
        ForEach(person.videoTracks.filter { !$0.isMuted && $0.track is VideoTrack }, id: \.sid) { publication in
            if let track = publication.track as? VideoTrack {
                VStack(alignment: .leading, spacing: 6) {
                    Text("\(meetingPersonName(person, local: local, session: session)) · \(publication.source == .screenShareVideo ? "Screen" : "Camera")").font(.caption)
                    SwiftUIVideoView(track, layoutMode: .fit).aspectRatio(16 / 9, contentMode: .fit)
                        .frame(maxWidth: 720).accessibilityLabel(publication.source == .screenShareVideo ? "Shared screen" : "Camera video")
                }
            }
        }
    }
}
