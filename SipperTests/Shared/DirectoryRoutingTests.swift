import XCTest
import SipperManaged
#if os(macOS)
@testable import Sipper
#else
@testable import SipperIOS
#endif

final class DirectoryRoutingTests: XCTestCase {
    func testDirectoryAccountsRequireTheSameOrganisationDeviceAndUnexpiredLease() throws {
        let organisation = UUID(), device = UUID(), profile = UUID(), now = Date()
        let data = try JSONSerialization.data(withJSONObject: ["organisationID": organisation.uuidString,
            "organisationName": "Example customer", "deviceID": device.uuidString, "installationID": UUID().uuidString,
            "userID": "fixture-user", "localProfileID": profile.uuidString])
        let enrollment = try JSONDecoder().decode(ManagedEnrollment.self, from: data)
        var account = SIPAccount(profileID: profile, username: "fixture", domain: "example.invalid")
        XCTAssertNil(ManagedAccountMapper.directoryAccount(account), "Personal accounts must never be offered as directory routes")
        account.managed = ManagedAccountBinding(organisationID: organisation, deviceID: device, accountID: UUID(), expiresAt: now.addingTimeInterval(60), mode: .direct)
        let route = try XCTUnwrap(ManagedAccountMapper.directoryAccount(account, now: now))
        XCTAssertEqual(route.id, account.id); XCTAssertTrue(route.belongs(to: enrollment, now: now))
        XCTAssertFalse(route.belongs(to: enrollment, now: now.addingTimeInterval(60)))
        account.isEnabled = false; XCTAssertNil(ManagedAccountMapper.directoryAccount(account, now: now))
        account.isEnabled = true
        for (org, enrolledDevice) in [(UUID(), device), (organisation, UUID())] {
            account.managed = ManagedAccountBinding(organisationID: org, deviceID: enrolledDevice, accountID: UUID(), expiresAt: now.addingTimeInterval(60), mode: .gateway)
            XCTAssertFalse(try XCTUnwrap(ManagedAccountMapper.directoryAccount(account, now: now)).belongs(to: enrollment, now: now))
        }
        XCTAssertNil(ManagedAccountMapper.directoryAccount(account, now: now.addingTimeInterval(60)))
    }
}
