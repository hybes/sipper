import Foundation
import CryptoKit
import SipperManaged

enum ManagedAccountMapper {
    static func deviceReport(_ configuration: ManagedConfiguration, expected: [(account: SIPAccount, password: String)], engine: SIPEngine, ready: Bool = true) -> ManagedDeviceReport {
        let current = ready && configuration.expiresAt > Date()
        let applied = current && engine.hasApplied(expected)
        let reports = expected.map { item -> ManagedDeviceReport.Registration in
            let status = current && engine.hasApplied([item]) ? engine.currentRegistration(accountID: item.account.id) : .registering
            var state = "unknown", code: Int?
            switch status {
            case .registered: state = "registered"; code = 200
            case .failed(let sipCode, _): state = "failed"; code = (100...699).contains(sipCode) ? sipCode : nil
            case .unregistered: state = "unregistered"
            case .registering: break
            }
            return .init(accountID: item.account.managed!.accountID, state: state, sipCode: code)
        }
        return .init(appliedRevision: applied ? configuration.revision : nil, registrations: reports,
            directCalls: applied ? directCalls(accounts: expected.map(\.account), calls: engine.activeCalls()) : nil)
    }

    /// Only managed direct accounts contribute; caller identities never leave the app.
    static func directCalls(accounts: [SIPAccount], calls: [CallSnapshot]) -> [ManagedDeviceReport.DirectCalls] {
        accounts.compactMap { account in
            guard let binding = account.managed, binding.mode == .direct else { return nil }
            var report = ManagedDeviceReport.DirectCalls(accountID: binding.accountID)
            for call in calls where call.accountID == account.id && call.isActive {
                if call.connectedAt != nil || call.state == .confirmed {
                    if call.isOnHold || call.isRemoteHold { report.held += 1 } else { report.connected += 1 }
                } else if call.direction == .incoming { report.ringing += 1 } else { report.dialling += 1 }
            }
            return report
        }
    }

    static func directoryAccount(_ account: SIPAccount, now: Date = Date()) -> ManagedDirectoryCallingAccount? {
        guard account.isEnabled, let binding = account.managed, binding.expiresAt > now else { return nil }
        return ManagedDirectoryCallingAccount(id: account.id, label: account.displayLabel, organisationID: binding.organisationID,
                                              deviceID: binding.deviceID, expiresAt: binding.expiresAt)
    }

    /// Installation-specific IDs prevent a managed account from claiming a manual account.
    static func localID(profileID: UUID, accountID: UUID) -> UUID {
        let digest = Array(SHA256.hash(data: Data("\(profileID.uuidString):\(accountID.uuidString)".utf8)))
        return UUID(uuid: (digest[0], digest[1], digest[2], digest[3], digest[4], digest[5],
                           (digest[6] & 15) | 80, digest[7], (digest[8] & 63) | 128, digest[9],
                           digest[10], digest[11], digest[12], digest[13], digest[14], digest[15]))
    }

    static func account(_ value: ManagedCallingAccount, configuration: ManagedConfiguration, profileID: UUID) -> SIPAccount {
        let settings = value.settings
        var result = SIPAccount(id: localID(profileID: profileID, accountID: value.id), profileID: profileID,
            label: value.label, displayName: settings.displayName, username: settings.username,
            authUsername: settings.authUsername, domain: settings.domain, server: settings.server, port: settings.port,
            transport: SIPTransport(rawValue: settings.transport)!,
            srtp: settings.srtp == "required" ? .mandatory : SRTPMode(rawValue: settings.srtp)!,
            stunServer: settings.stunServer, useICE: settings.useICE, voicemailNumber: settings.voicemailNumber,
            createdAt: .distantPast, source: "managed")
        result.managed = ManagedAccountBinding(organisationID: configuration.organisation.id,
            deviceID: configuration.deviceId, accountID: value.id, expiresAt: configuration.expiresAt,
            mode: value.mode == "gateway" ? .gateway : .direct, doNotDisturb: value.doNotDisturb == true)
        return result
    }
}
