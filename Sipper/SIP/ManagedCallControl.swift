import Foundation
import SipperManaged

@MainActor
final class ManagedCallControl {
    private let engine: SIPEngine
    private let client: ManagedClient
    init(engine: SIPEngine, client: ManagedClient) { self.engine = engine; self.client = client }

    func wake(_ hint: IncomingManagedCall, refresh: (ManagedEnrollment) async throws -> Void) async throws -> CallSnapshot? {
        guard hint.expiresAt > Date(), client.isSignedIn,
              let enrollment = client.enrollments.first(where: { $0.deviceID == hint.deviceId }) else { return nil }
        let initial = try await client.call(hint.callId, for: enrollment, action: .wake)
        guard !initial.isUnavailable(), initial.state != .answered else { return nil }
        try Task.checkCancellation()
        try await refresh(enrollment)
        let deadline = min(hint.expiresAt, initial.expiresAt, Date().addingTimeInterval(25))
        var registrationRequested = false
        while Date() < deadline {
            try Task.checkCancellation()
            let current = try await client.call(hint.callId, for: enrollment)
            guard !current.isUnavailable(), current.state != .answered, current.configurationId == initial.configurationId else { return nil }
            if let call = engine.activeCalls().first(where: {
                $0.gatewayCallID == hint.callId && $0.managedAccount?.deviceID == enrollment.deviceID
                    && $0.managedAccount?.organisationID == enrollment.organisationID && $0.managedAccount?.accountID == initial.configurationId
            }) { return try await prepare(call) }
            if !registrationRequested {
                registrationRequested = try engine.refreshManagedRegistration(deviceID: enrollment.deviceID, accountID: initial.configurationId)
            }
            try await Task.sleep(for: .milliseconds(500))
        }
        return nil
    }
    func decline(_ hint: IncomingManagedCall) async {
        guard let enrollment = client.enrollments.first(where: { $0.deviceID == hint.deviceId }) else { return }
        _ = try? await client.call(hint.callId, for: enrollment, action: .decline)
    }

    private func status(_ call: CallSnapshot, action: ManagedCallAction = .status) async throws -> ManagedCall {
        guard let reference = call.gatewayCallID, let binding = call.managedAccount, binding.mode == .gateway,
              let enrollment = client.enrollments.first(where: { $0.deviceID == binding.deviceID && $0.organisationID == binding.organisationID }) else { throw ManagedError.callUnavailable }
        let value = try await client.call(reference, for: enrollment, action: action)
        guard value.configurationId == binding.accountID else { throw ManagedError.callUnavailable }
        try Task.checkCancellation()
        return value
    }
    func prepare(_ call: CallSnapshot) async throws -> CallSnapshot {
        guard call.gatewayCallID != nil else { return call }
        let value = try await status(call)
        guard !value.isUnavailable(), let caller = value.caller else { throw ManagedError.callUnavailable }
        return try engine.setManagedCaller(call, name: caller.name, number: caller.number.isEmpty ? "Unknown caller" : caller.number)
    }
    func claim(_ call: CallSnapshot) async throws -> UUID? {
        guard call.gatewayCallID != nil else { return nil }
        func stillRinging() -> Bool {
            engine.activeCalls().contains {
                $0.id == call.id && $0.accountID == call.accountID && $0.startedAt == call.startedAt &&
                $0.gatewayCallID == call.gatewayCallID && $0.direction == .incoming && $0.isRinging && $0.connectedAt == nil
            }
        }
        guard stillRinging() else { throw ManagedError.callUnavailable }
        let value = try await status(call, action: .answer)
        guard !value.isUnavailable(), value.claimedByThisDevice, value.state == .answering || value.state == .answered else { throw ManagedError.callUnavailable }
        guard stillRinging() else {
            await decline(call)
            throw ManagedError.callUnavailable
        }
        return value.id
    }
    func decline(_ call: CallSnapshot) async {
        guard call.direction == .incoming, call.connectedAt == nil, call.gatewayCallID != nil else { return }
        _ = try? await status(call, action: .decline)
    }
    func monitor(_ call: CallSnapshot) async {
        guard call.gatewayCallID != nil else { return }
        var deadline = call.startedAt.addingTimeInterval(90)
        while !Task.isCancelled {
            guard let current = engine.activeCalls().first(where: { $0.id == call.id && $0.startedAt == call.startedAt }), current.connectedAt == nil else { return }
            if Date() >= deadline { engine.hangup(call, code: 480, onlyIfRinging: true); return }
            do {
                let value = try await status(call)
                if value.isUnavailable() { engine.hangup(call, code: 480, onlyIfRinging: true); return }
                deadline = min(deadline, value.expiresAt)
            } catch {
                if Task.isCancelled { return }
                switch error {
                case ManagedError.serverUnavailable, ManagedError.requestFailed, is URLError: break
                default: engine.hangup(call, code: 480, onlyIfRinging: true); return
                }
            }
            do { try await Task.sleep(for: .seconds(1)) } catch { return }
        }
    }
}
