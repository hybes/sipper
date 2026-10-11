import AVFoundation
import CallKit
import Combine
import Foundation
import SipperManaged

/// The system provider in the app; a recording provider exercises lifecycle races in XCTest.
@MainActor
protocol MobileCallReporting: AnyObject {
    func setDelegate(_ delegate: CXProviderDelegate?, queue: DispatchQueue?)
    func reportNewIncomingCall(with UUID: UUID, update: CXCallUpdate, completion: @escaping @Sendable (Error?) -> Void)
    func reportCall(with UUID: UUID, updated update: CXCallUpdate)
    func reportCall(with UUID: UUID, endedAt dateEnded: Date?, reason endedReason: CXCallEndedReason)
    func reportOutgoingCall(with UUID: UUID, startedConnectingAt dateStartedConnecting: Date?)
    func reportOutgoingCall(with UUID: UUID, connectedAt dateConnected: Date?)
}
extension CXProvider: MobileCallReporting {}

/// CallKit UUIDs are independent of PJSIP's reusable numeric call IDs.
struct MobileCallIDs {
    private var values: [UUID: CallSnapshot] = [:]
    mutating func bind(_ uuid: UUID, to call: CallSnapshot) {
        values = values.filter { $0.value.id != call.id }
        values[uuid] = call
    }
    func sipID(_ uuid: UUID) -> Int? { values[uuid]?.id }
    func call(_ uuid: UUID) -> CallSnapshot? { values[uuid] }
    func uuid(_ sipID: Int) -> UUID? { values.first(where: { $0.value.id == sipID })?.key }
    mutating func remove(_ uuid: UUID) { values[uuid] = nil }
    mutating func clear() { values.removeAll() }
}

@MainActor
final class CallKitBridge: NSObject, ObservableObject, @preconcurrency CXProviderDelegate {
    @Published private(set) var audioActive = false
    @Published private(set) var changingCalls = false
    private let provider: MobileCallReporting
    private let requestTransaction: (CXTransaction) async throws -> Void
    private let engine: SIPEngine
    private var ids = MobileCallIDs()
    private var pending: [UUID: (UUID, String)] = [:]
    private var connected = Set<UUID>()
    private var gatewayIDs: [UUID: UUID] = [:]
    private var pushes: [UUID: IncomingManagedCall] = [:]
    private var endedGateways: [UUID: Date] = [:]
    private var waking: [UUID: Task<Void, Never>] = [:]
    private var wakeTimeouts: [UUID: Task<Void, Never>] = [:]
    private var performing: [UUID: (action: CXCallAction, task: Task<Void, Never>)] = [:]
    private var holding: [UUID: (actionID: UUID, onHold: Bool, task: Task<Void, Error>)] = [:]
    private var activatingAction: UUID?
    var canUseAccount: (UUID) -> Bool = { _ in false }
    var canUsePhoneAudio: () -> Bool = { true }
    var hasPhoneAudioWork: Bool {
        audioActive || changingCalls || !pending.isEmpty || !pushes.isEmpty || !waking.isEmpty || activatingAction != nil
    }
    var onStarted: (CallSnapshot) -> Void = { _ in }
    var onError: (String) -> Void = { _ in }
    var claimAnswer: (CallSnapshot) async throws -> UUID? = { call in
        guard call.gatewayCallID == nil else { throw ManagedError.callUnavailable }
        return nil
    }
    var onDeclined: (CallSnapshot) -> Void = { _ in }
    var wake: (IncomingManagedCall) async throws -> CallSnapshot? = { _ in nil }
    var onPushDeclined: (IncomingManagedCall) -> Void = { _ in }
    var requestMicrophone: () async -> Bool = { await CallKitBridge.microphonePermission() }

    init(engine: SIPEngine, reporter: MobileCallReporting? = nil,
         requestTransaction: ((CXTransaction) async throws -> Void)? = nil) {
        self.engine = engine
        let controller = CXCallController()
        self.requestTransaction = requestTransaction ?? { try await controller.request($0) }
        let configuration = CXProviderConfiguration()
        configuration.maximumCallGroups = 2
        configuration.maximumCallsPerCallGroup = 2
        configuration.supportsVideo = false
        configuration.supportedHandleTypes = [.generic, .phoneNumber]
        configuration.includesCallsInRecents = false // Recents stay inside Sipper.
        provider = reporter ?? CXProvider(configuration: configuration)
        super.init()
        provider.setDelegate(self, queue: .main)
    }
    static func microphonePermission() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { continuation.resume(returning: $0) }
        }
    }
    private func configureAudio() throws {
        try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
        // CallKit, not the dialler, activates the audio session.
    }
    static func destination(_ target: String, account: SIPAccount) throws -> String {
        let trimmed = target.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, target.utf8.count <= 512,
              target.rangeOfCharacter(from: .controlCharacters) == nil else { throw MobileError.invalidNumber }
        if account.managed?.mode == .gateway {
            let number = trimmed.filter { !" -.()".contains($0) }
            guard SIPEngine.isGatewayNumber(number) else { throw MobileError.invalidNumber }
            return account.callURI(for: number)
        }
        if trimmed.lowercased().hasPrefix("sip:") || trimmed.lowercased().hasPrefix("sips:") || trimmed.contains("@") {
            guard !trimmed.contains(where: \.isWhitespace) else { throw MobileError.invalidNumber }
        } else {
            // Do not silently turn an alphanumeric extension into a different number.
            let allowed = Set("0123456789+*#ABCDabcd -.()")
            guard trimmed.allSatisfy(allowed.contains),
                  !SIPAccount.normaliseDialString(trimmed).isEmpty else { throw MobileError.invalidNumber }
        }
        return account.callURI(for: trimmed)
    }
    func start(account: SIPAccount, target: String) async throws {
        guard canUsePhoneAudio() else { throw ManagedError.accessUnavailable("Leave your meeting before making a phone call.") }
        guard canUseAccount(account.id) else { throw MobileError.accountUnavailable }
        let uri = try Self.destination(target, account: account)
        guard await requestMicrophone() else { throw MobileError.microphoneDenied }
        guard canUsePhoneAudio() else { throw ManagedError.accessUnavailable("Leave your meeting before making a phone call.") }
        guard canUseAccount(account.id) else { throw MobileError.accountUnavailable }
        let calls = engine.activeCalls()
        guard pending.isEmpty, performing.isEmpty, activatingAction == nil, calls.count < 2,
              calls.allSatisfy({ $0.state == .confirmed && !$0.isTransferring }) else { throw MobileError.callUnavailable }
        let uuid = UUID()
        let action = CXStartCallAction(call: uuid, handle: CXHandle(type: .generic, value: target))
        let transaction = try activating(action)
        pending[uuid] = (account.id, uri)
        do { try await requestTransaction(transaction) }
        catch { pending[uuid] = nil; throw error }
    }
    private func activating(_ action: CXCallAction) throws -> CXTransaction {
        let transaction = CXTransaction()
        let group = currentCall(action.callUUID)?.conferenceID
        var heldGroups = Set<UUID>()
        for call in engine.activeCalls() where call.state == .confirmed && !call.isOnHold {
            guard let uuid = ids.uuid(call.id) else { throw MobileError.callUnavailable }
            if uuid == action.callUUID || (group != nil && call.conferenceID == group) { continue }
            if let otherGroup = call.conferenceID, !heldGroups.insert(otherGroup).inserted { continue }
            transaction.addAction(CXSetHeldCallAction(call: uuid, onHold: true))
        }
        transaction.addAction(action)
        return transaction
    }
    private func updateForCall(_ call: CallSnapshot?) -> CXCallUpdate {
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: call?.remoteNumber ?? "Incoming managed call")
        update.localizedCallerName = call.flatMap { $0.remoteName.isEmpty ? nil : $0.remoteName }
        update.supportsHolding = true
        update.supportsDTMF = true
        update.supportsGrouping = call.map { member in
            member.conferenceID == nil && member.state == .confirmed && !member.isTransferring && canUseAccount(member.accountID) &&
            engine.activeCalls().contains { $0.id != member.id && $0.accountID == member.accountID && $0.state == .confirmed && !$0.isTransferring && $0.conferenceID == nil }
        } ?? false
        update.supportsUngrouping = call?.conferenceID != nil
        return update
    }
    private func currentCall(_ uuid: UUID) -> CallSnapshot? {
        guard let bound = ids.call(uuid) else { return nil }
        return engine.activeCalls().first { $0.id == bound.id && $0.accountID == bound.accountID && $0.startedAt == bound.startedAt }
    }
    private func uuid(for call: CallSnapshot) -> UUID? {
        guard let uuid = ids.uuid(call.id), let current = currentCall(uuid),
              current.accountID == call.accountID, current.startedAt == call.startedAt else { return nil }
        return uuid
    }
    private func refreshCapabilities() {
        for call in engine.activeCalls() {
            if let uuid = uuid(for: call) { provider.reportCall(with: uuid, updated: updateForCall(call)) }
        }
    }
    /// Called synchronously from PushKit. Report before starting any network task.
    func incomingPush(_ hint: IncomingManagedCall?, mustReport: Bool = true, completion: @escaping () -> Void) {
        endedGateways = endedGateways.filter { $0.value > Date() }
        guard let hint, hint.expiresAt > Date(), endedGateways[hint.callId] == nil else {
            guard mustReport else { completion(); return }
            let uuid = UUID()
            provider.reportNewIncomingCall(with: uuid, update: updateForCall(nil)) { [weak self] error in
                Task { @MainActor in
                    if error == nil { self?.provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded) }
                    completion()
                }
            }
            return
        }
        let existing = gatewayIDs[hint.callId]
        if !mustReport && existing != nil { completion(); return }
        let uuid = existing ?? UUID()
        if existing == nil { gatewayIDs[hint.callId] = uuid; pushes[uuid] = hint }
        let current = currentCall(uuid)
        provider.reportNewIncomingCall(with: uuid, update: updateForCall(current)) { [weak self] error in
            Task { @MainActor in
                defer { completion() }
                guard let self else { return }
                // A repeated push still reports to CallKit, but cannot tear down the original call.
                guard existing == nil else { return }
                guard self.gatewayIDs[hint.callId] == uuid else {
                    if error == nil { self.provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded) }
                    return
                }
                if error != nil { self.dismiss(uuid, reason: .failed, report: false) }
            }
        }
        guard existing == nil, pushes[uuid] != nil else { return }
        wakeTimeouts[uuid] = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(max(0, min(25, hint.expiresAt.timeIntervalSinceNow)))) }
            catch { return }
            self?.dismiss(uuid, reason: .unanswered)
        }
        waking[uuid] = Task { [weak self] in
            guard let self else { return }
            do {
                let call = try await self.wake(hint)
                try Task.checkCancellation()
                guard self.gatewayIDs[hint.callId] == uuid else { return }
                guard let call else { self.dismiss(uuid, reason: .remoteEnded); return }
                self.incoming(call)
            } catch {
                if !Task.isCancelled { self.dismiss(uuid, reason: .failed) }
            }
            self.waking[uuid] = nil
        }
    }
    func incoming(_ call: CallSnapshot) {
        guard canUseAccount(call.accountID) else { engine.hangup(call, code: 480, onlyIfRinging: true); return }
        if let reference = call.gatewayCallID {
            if endedGateways[reference].map({ $0 > Date() }) == true { engine.hangup(call, code: 480, onlyIfRinging: true); onDeclined(call); return }
            if let uuid = gatewayIDs[reference] {
                guard pushes[uuid].map({ $0.deviceId == call.managedAccount?.deviceID }) ?? true else { engine.hangup(call, code: 480, onlyIfRinging: true); return }
                ids.bind(uuid, to: call)
                wakeTimeouts.removeValue(forKey: uuid)?.cancel()
                provider.reportCall(with: uuid, updated: updateForCall(call))
                return
            }
        }
        let uuid = ids.uuid(call.id) ?? UUID()
        if ids.uuid(call.id) != nil { provider.reportCall(with: uuid, updated: updateForCall(call)); return }
        ids.bind(uuid, to: call)
        if let reference = call.gatewayCallID { gatewayIDs[reference] = uuid }
        let update = updateForCall(call)
        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            Task { @MainActor in
                guard let self else { return }
                guard self.ids.sipID(uuid) == call.id else {
                    if error == nil { self.provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded) }
                    return
                }
                if error != nil { self.dismiss(uuid, reason: .failed, report: false) }
            }
        }
    }
    func changed(_ call: CallSnapshot) {
        guard let uuid = uuid(for: call) else { return }
        ids.bind(uuid, to: call)
        if call.direction == .outgoing, call.state == .confirmed, connected.insert(uuid).inserted {
            provider.reportOutgoingCall(with: uuid, connectedAt: call.connectedAt ?? Date())
        }
        refreshCapabilities()
    }
    func ended(_ call: CallSnapshot) {
        guard let uuid = ids.uuid(call.id), let bound = ids.call(uuid),
              bound.accountID == call.accountID, bound.startedAt == call.startedAt else { return }
        let reason: CXCallEndedReason = call.connectedAt != nil ? .remoteEnded : call.direction == .incoming ? .unanswered : .failed
        provider.reportCall(with: uuid, endedAt: call.endedAt ?? Date(), reason: reason)
        forget(uuid)
        refreshCapabilities()
    }
    private func forget(_ uuid: UUID) {
        waking.removeValue(forKey: uuid)?.cancel()
        wakeTimeouts.removeValue(forKey: uuid)?.cancel()
        cancelAction(uuid)
        if let reference = gatewayIDs.first(where: { $0.value == uuid })?.key {
            gatewayIDs[reference] = nil
            endedGateways = endedGateways.filter { $0.value > Date() }
            if endedGateways.count >= 512, let oldest = endedGateways.min(by: { $0.value < $1.value })?.key { endedGateways[oldest] = nil }
            endedGateways[reference] = Date().addingTimeInterval(120)
        }
        pushes[uuid] = nil
        ids.remove(uuid); connected.remove(uuid)
    }
    private func dismiss(_ uuid: UUID, reason: CXCallEndedReason, report: Bool = true) {
        guard ids.sipID(uuid) != nil || pushes[uuid] != nil || gatewayIDs.values.contains(uuid) else { return }
        if let call = currentCall(uuid) {
            guard call.connectedAt == nil else { return }
            engine.hangup(call, code: 480, onlyIfRinging: true); onDeclined(call)
        } else if let hint = pushes[uuid] { onPushDeclined(hint) }
        forget(uuid)
        if report { provider.reportCall(with: uuid, endedAt: Date(), reason: reason) }
    }
    func withdrawPushCalls(deviceID: UUID) {
        for (uuid, hint) in pushes where hint.deviceId == deviceID { dismiss(uuid, reason: .failed) }
    }
    func answer(_ call: CallSnapshot) { transact(call) { CXAnswerCallAction(call: $0) } }
    func end(_ call: CallSnapshot) { transact(call) { CXEndCallAction(call: $0) } }
    func mute(_ call: CallSnapshot) { transact(call) { CXSetMutedCallAction(call: $0, muted: !call.isMuted) } }
    func hold(_ call: CallSnapshot) { transact(call) { CXSetHeldCallAction(call: $0, onHold: !call.isOnHold) } }
    func dtmf(_ call: CallSnapshot, digits: String) { transact(call) { CXPlayDTMFCallAction(call: $0, digits: digits, type: .singleTone) } }
    func merge(_ call: CallSnapshot, with other: CallSnapshot) {
        guard !changingCalls, call.id != other.id, call.accountID == other.accountID,
              call.conferenceID == nil, other.conferenceID == nil,
              let uuid = uuid(for: call), let peer = self.uuid(for: other) else { return }
        request(CXTransaction(action: CXSetGroupCallAction(call: uuid, callUUIDToGroupWith: peer)))
    }
    func separate(_ call: CallSnapshot) {
        guard !changingCalls, let uuid = uuid(for: call), let current = currentCall(uuid),
              call.conferenceID != nil, current.conferenceID == call.conferenceID else { return }
        request(CXTransaction(action: CXSetGroupCallAction(call: uuid, callUUIDToGroupWith: nil)))
    }
    func endConference(_ call: CallSnapshot) {
        guard let uuid = uuid(for: call), let current = currentCall(uuid), let group = call.conferenceID,
              current.conferenceID == group else { return }
        let members = engine.activeCalls().filter { $0.conferenceID == group }
        guard members.count == 2 else { return }
        let transaction = CXTransaction()
        for member in members {
            guard let memberUUID = self.uuid(for: member) else { return }
            transaction.addAction(CXEndCallAction(call: memberUUID))
        }
        request(transaction)
    }
    private func request(_ transaction: CXTransaction) {
        Task { @MainActor in
            do { try await self.requestTransaction(transaction) }
            catch { self.onError("The call control could not be completed.") }
        }
    }
    private func transact(_ call: CallSnapshot, action: (UUID) -> CXCallAction) {
        guard let uuid = uuid(for: call) else { return }
        let action = action(uuid)
        Task { @MainActor in
            do {
                let needsAudio = action is CXAnswerCallAction || (action as? CXSetHeldCallAction)?.isOnHold == false
                try await self.requestTransaction(needsAudio ? self.activating(action) : CXTransaction(action: action))
            } catch { self.onError("The call control could not be completed.") }
        }
    }
    func providerDidReset(_ provider: CXProvider) {
        audioActive = false
        for uuid in Array(pushes.keys) { dismiss(uuid, reason: .failed, report: false) }
        engine.activeCalls().forEach(onDeclined)
        engine.hangupAll()
        try? engine.setCallAudioActive(false)
        ids.clear(); pending.removeAll(); connected.removeAll()
        for uuid in Array(gatewayIDs.values) { forget(uuid) }
        for uuid in Array(performing.keys) { cancelAction(uuid) }
    }
    private func cancelAction(_ uuid: UUID) {
        if let entry = performing[uuid] {
            for key in Array(performing.keys) where performing[key]?.action.uuid == entry.action.uuid { performing[key] = nil }
            entry.task.cancel(); entry.action.fail()
            if activatingAction == entry.action.uuid { activatingAction = nil }
        }
        holding.removeValue(forKey: uuid)?.task.cancel()
        changingCalls = !performing.isEmpty
    }
    private func perform(_ action: CXCallAction, with peer: UUID? = nil, needsAudio: Bool = false,
                         operation: @escaping @MainActor () async throws -> Void,
                         completed: @escaping @MainActor () -> Void = {},
                         failed: @escaping @MainActor (Error) -> Void) {
        guard performing[action.callUUID] == nil, peer.map({ performing[$0] == nil }) ?? true,
              !needsAudio || activatingAction == nil else { action.fail(); return }
        if needsAudio { activatingAction = action.uuid }
        let task = Task { @MainActor in
            defer { if self.activatingAction == action.uuid { self.activatingAction = nil } }
            do {
                try await operation()
                try Task.checkCancellation()
                guard self.performing[action.callUUID]?.action.uuid == action.uuid else { return }
                for key in Array(self.performing.keys) where self.performing[key]?.action.uuid == action.uuid { self.performing[key] = nil }
                self.changingCalls = !self.performing.isEmpty
                action.fulfill()
                completed()
            } catch {
                guard self.performing[action.callUUID]?.action.uuid == action.uuid else { return }
                for key in Array(self.performing.keys) where self.performing[key]?.action.uuid == action.uuid { self.performing[key] = nil }
                self.changingCalls = !self.performing.isEmpty
                action.fail()
                if !Task.isCancelled { failed(error) }
            }
        }
        performing[action.callUUID] = (action, task)
        if let peer { performing[peer] = (action, task) }
        changingCalls = true
    }
    private func waitForOtherHolds(except uuid: UUID, members: [UUID] = []) async throws {
        try Task.checkCancellation()
        let group = currentCall(uuid)?.conferenceID
        let excluded = Set(members + [uuid])
        for (other, entry) in holding where !excluded.contains(other) && (group == nil || currentCall(other)?.conferenceID != group) { try await entry.task.value }
        try Task.checkCancellation()
        guard engine.activeCalls().allSatisfy({ ids.uuid($0.id) == uuid || (group != nil && $0.conferenceID == group) || $0.state == .incoming || ($0.state == .confirmed && $0.isOnHold) }) else {
            throw MobileError.callUnavailable
        }
    }
    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        guard let (accountID, uri) = pending.removeValue(forKey: action.callUUID), canUseAccount(accountID), canUsePhoneAudio() else { action.fail(); return }
        perform(action, needsAudio: true, operation: {
            try await self.waitForOtherHolds(except: action.callUUID)
            guard self.canUseAccount(accountID) else { throw MobileError.accountUnavailable }
            try self.configureAudio()
            let call = try self.engine.makeCall(accountID: accountID, uri: uri)
            self.ids.bind(action.callUUID, to: call)
            self.onStarted(call)
            self.provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
        }, failed: { _ in self.onError("The call could not be started. Check your account and connection.") })
    }
    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard canUsePhoneAudio() else { action.fail(); onError("Leave your meeting before answering this phone call."); return }
        perform(action, needsAudio: true, operation: {
            guard await self.requestMicrophone() else { throw MobileError.microphoneDenied }
            let deadline = min(action.timeoutDate, Date().addingTimeInterval(20))
            while self.ids.sipID(action.callUUID) == nil, let hint = self.pushes[action.callUUID], Date() < min(hint.expiresAt, deadline) {
                try await Task.sleep(for: .milliseconds(50))
            }
            try Task.checkCancellation()
            guard let call = self.currentCall(action.callUUID), self.canUseAccount(call.accountID), self.canUsePhoneAudio() else { throw ManagedError.callUnavailable }
            try self.configureAudio()
            let claim = try await self.claimAnswer(call)
            try await self.waitForOtherHolds(except: action.callUUID)
            guard self.uuid(for: call) == action.callUUID, self.canUseAccount(call.accountID) else { throw ManagedError.callUnavailable }
            try self.engine.answer(call, claimedGatewayCallID: claim)
        }, failed: { _ in
            self.dismiss(action.callUUID, reason: .failed)
            self.onError("The call could not be answered or is no longer available.")
        })
    }
    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        if let call = currentCall(action.callUUID) {
            onDeclined(call); engine.hangup(call)
            forget(action.callUUID)
        } else if pushes[action.callUUID] != nil { dismiss(action.callUUID, reason: .declinedElsewhere, report: false) }
        else { action.fail(); return }
        action.fulfill()
    }
    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        guard let call = currentCall(action.callUUID) else { action.fail(); return }
        engine.setMuted(call, muted: action.isMuted); action.fulfill()
    }
    func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
        guard action.isOnHold || canUsePhoneAudio() else { action.fail(); return }
        guard let call = currentCall(action.callUUID), performing[action.callUUID] == nil else { action.fail(); return }
        let members = call.conferenceID.map { group in engine.activeCalls().filter { $0.conferenceID == group }.compactMap { uuid(for: $0) } } ?? [action.callUUID]
        // CallKit may deliver one hold action per participant. Share the actual two-leg negotiation.
        if let existing = members.compactMap({ holding[$0] }).first {
            guard existing.onHold == action.isOnHold else { action.fail(); return }
            perform(action, operation: { try await existing.task.value }, failed: { _ in })
            return
        }
        guard action.isOnHold || activatingAction == nil else { action.fail(); return }
        let negotiation = Task { @MainActor in
            defer { for uuid in members where self.holding[uuid]?.actionID == action.uuid { self.holding[uuid] = nil } }
            if !action.isOnHold { try await self.waitForOtherHolds(except: action.callUUID, members: members) }
            if call.conferenceID != nil { try await self.engine.setConferenceHold(call, onHold: action.isOnHold) }
            else { try await self.engine.setHold(call, onHold: action.isOnHold) }
        }
        for uuid in members { holding[uuid] = (action.uuid, action.isOnHold, negotiation) }
        perform(action, needsAudio: !action.isOnHold, operation: { try await negotiation.value },
                failed: { _ in self.onError("The call could not be put on hold or resumed. Try again.") })
    }
    func provider(_ provider: CXProvider, perform action: CXSetGroupCallAction) {
        guard let call = currentCall(action.callUUID), call.state == .confirmed, !call.isTransferring else { action.fail(); return }
        if let peerUUID = action.callUUIDToGroupWith {
            guard peerUUID != action.callUUID, let peer = currentCall(peerUUID), peer.state == .confirmed,
                  peer.accountID == call.accountID, !peer.isTransferring, call.conferenceID == nil, peer.conferenceID == nil,
                  canUseAccount(call.accountID) else { action.fail(); return }
            perform(action, with: peerUUID, needsAudio: true, operation: {
                guard self.engine.activeCalls().allSatisfy({ $0.id == call.id || $0.id == peer.id || $0.state == .incoming || $0.isOnHold }) else { throw MobileError.callUnavailable }
                try await self.engine.mergeConference(call, with: peer)
            }, failed: { _ in self.onError("The calls could not be merged. Check that both calls are connected on the same account.") })
        } else {
            guard let group = call.conferenceID,
                  let peer = engine.activeCalls().first(where: { $0.id != call.id && $0.conferenceID == group }),
                  let peerUUID = uuid(for: peer) else { action.fail(); return }
            perform(action, with: peerUUID, needsAudio: true, operation: {
                // Silence both legs before separating, so a private conversation never leaks to its peer.
                try await self.engine.setConferenceHold(call, onHold: true)
                try self.engine.splitConference(call)
            }, completed: {
                // Grouping has finished before requesting CallKit's separate held/active states.
                Task { @MainActor in
                    guard self.uuid(for: call) == action.callUUID, self.uuid(for: peer) == peerUUID,
                          self.currentCall(action.callUUID)?.conferenceID == nil,
                          self.currentCall(peerUUID)?.conferenceID == nil else { return }
                    let transaction = CXTransaction(actions: [CXSetHeldCallAction(call: peerUUID, onHold: true), CXSetHeldCallAction(call: action.callUUID, onHold: false)])
                    do { try await self.requestTransaction(transaction) }
                    catch { self.onError("The calls are separated and on hold. Resume the call you want to continue.") }
                }
            }, failed: { _ in self.onError("The conference could not be separated. Try again.") })
        }
    }
    func provider(_ provider: CXProvider, perform action: CXPlayDTMFCallAction) {
        guard let call = currentCall(action.callUUID), !action.digits.isEmpty,
              action.digits.allSatisfy({ "0123456789*#ABCD".contains($0) }) else { action.fail(); return }
        engine.sendDTMF(call, digits: action.digits); action.fulfill()
    }
    func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
        guard let action = action as? CXCallAction else { return }
        pending[action.callUUID] = nil
        if performing[action.callUUID]?.action.uuid == action.uuid { cancelAction(action.callUUID) }
        else if !action.isComplete { action.fail() }
        dismiss(action.callUUID, reason: .failed)
    }
    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        audioActive = false
        guard canUsePhoneAudio() else { try? engine.setCallAudioActive(false); return }
        do { try engine.setCallAudioActive(true); audioActive = true }
        catch { onError("Call audio could not start."); engine.activeCalls().forEach(onDeclined); engine.hangupAll() }
    }
    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        audioActive = false
        try? engine.setCallAudioActive(false)
    }
}
