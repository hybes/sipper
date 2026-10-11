import Foundation
import Combine
import AppAuth
#if os(macOS)
import AppKit
#else
import UIKit
#endif

public struct ManagedEnrollment: Codable, Equatable, Identifiable, Sendable {
    public var id: UUID { organisationID }
    public let organisationID: UUID
    public let organisationName: String
    public let deviceID: UUID
    public let installationID: UUID
    public let userID: String
    /// The app's local container; unrelated manual profiles must never be adopted by matching SIP addresses.
    public let localProfileID: UUID
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor
public final class ManagedClient: ObservableObject {
    @Published public private(set) var isSignedIn = false
    @Published public private(set) var isSigningIn = false
    @Published public private(set) var signInStatus: String?
    @Published public private(set) var signInURL: URL?
    @Published public private(set) var identity: ManagedIdentity?
    @Published public private(set) var organisations: [ManagedOrganisation] = []
    @Published public private(set) var enrollments: [ManagedEnrollment] = []
    @Published public private(set) var directories: [UUID: ManagedDirectory] = [:]
    @Published public private(set) var lastError: ManagedError?
    public let serverURL: URL
    public let clientID: String
    public let redirectURL: URL
    private let storage: ManagedSecretStore
    private let http: URLSession
    private let allowLocalMeetings: Bool
    private let encoder = JSONEncoder()
    private let decoder: JSONDecoder
    private var authState: OIDAuthState?
    private var flow: OIDExternalUserAgentSession?
    private var generation = 0
    private var organisationRequest = 0
    private var changingCallingPreference = false
    private var directoryAttempts: [UUID: Int] = [:]
    private var reportTask: Task<Void, Error>?
    private var lastReports: [UUID: ManagedDeviceReport] = [:]
    private var reportAttempts: [UUID: TimeInterval] = [:]
    private struct DirectoryArchive: Codable { let userID: String; let value: ManagedDirectory }
    private var authenticationIsPending = false
    private var isSigningOut = false
    private struct SessionArchive: Codable { let identity: ManagedIdentity; let state: Data }
    private var resource: String { serverURL.appendingPathComponent("api/client").absoluteString }
    private var namespace: String { "\(clientID).\(serverURL.absoluteString)" }
    private func key(_ suffix: String) -> String { "\(namespace).\(suffix)" }

    public init(serverURL: URL = URL(string: "https://sipper.dev")!, clientID: String, storage: ManagedSecretStore = ManagedKeychainStore(), allowLocalDevelopment: Bool = false, sessionConfiguration: URLSessionConfiguration = .ephemeral, redirectURL: URL = URL(string: "com.hybes.sipper:/oauth/callback")!) throws {
        guard serverURL.user == nil, serverURL.password == nil, serverURL.query == nil, serverURL.fragment == nil,
              serverURL.path.isEmpty || serverURL.path == "/", serverURL.host != nil else { throw ManagedError.invalidServer }
        let local = allowLocalDevelopment && serverURL.scheme == "http" && ["localhost", "127.0.0.1", "[::1]"].contains(serverURL.host!)
        guard serverURL.scheme == "https" || local else { throw ManagedError.invalidServer }
        guard ["sipper-macos", "sipper-ios"].contains(clientID) else { throw ManagedError.invalidServer }
        guard redirectURL.absoluteString == "com.hybes.sipper:/oauth/callback"
                || (local && redirectURL.absoluteString == "com.hybes.sipper.development:/oauth/callback") else { throw ManagedError.invalidServer }
        self.redirectURL = redirectURL
        self.allowLocalMeetings = local
        var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false)!
        components.path = ""
        self.serverURL = components.url!
        self.clientID = clientID; self.storage = storage
        let configuration = sessionConfiguration
        configuration.urlCache = nil; configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 20; configuration.timeoutIntervalForResource = 30
        self.http = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
        self.decoder = Self.configurationDecoder()
        if let data = try storage.read(key("enrollments")) { enrollments = try decoder.decode([ManagedEnrollment].self, from: data) }
        if let data = try storage.read(key("authentication")) {
            let archive = try decoder.decode(SessionArchive.self, from: data)
            identity = archive.identity
            authState = try NSKeyedUnarchiver.unarchivedObject(ofClass: OIDAuthState.self, from: archive.state)
            isSignedIn = authState?.isAuthorized ?? false
        }
        for enrollment in enrollments {
            do { directories[enrollment.deviceID] = try cachedDirectory(for: enrollment) }
            catch { lastError = error as? ManagedError ?? .invalidDirectory }
        }
    }

    public nonisolated static func configurationDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let value = try decoder.singleValueContainer().decode(String.self)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: value) { return date }
            formatter.formatOptions = [.withInternetDateTime]
            guard let date = formatter.date(from: value) else { throw ManagedError.invalidConfiguration }
            return date
        }
        return decoder
    }

    #if os(macOS)
    public func signIn(presenting window: NSWindow, useSystemBrowser: Bool = false) async throws {
        if useSystemBrowser { try await signIn(userAgent: SystemBrowserAgent()) }
        else { try await signIn(userAgent: OIDExternalUserAgentMac(presenting: window)) }
    }
    #else
    public func signIn(presenting controller: UIViewController) async throws {
        guard let agent = OIDExternalUserAgentIOS(presenting: controller) else { throw ManagedError.requestFailed }
        try await signIn(userAgent: agent)
    }
    #endif

    func signIn(userAgent: OIDExternalUserAgent) async throws {
        guard !isSigningOut else { throw ManagedError.cancelled }
        guard !isSigningIn else { return }
        isSigningIn = true
        signInStatus = "Connecting to Sipper…"
        defer { flow = nil; isSigningIn = false; signInStatus = nil; signInURL = nil }
        let attempt = generation
        let configuration: OIDServiceConfiguration = try await withCheckedThrowingContinuation { continuation in
            OIDAuthorizationService.discoverConfiguration(forIssuer: serverURL) { configuration, _ in
                if let configuration { continuation.resume(returning: configuration) }
                else { continuation.resume(throwing: ManagedError.serverUnavailable) }
            }
        }
        guard configuration.authorizationEndpoint == serverURL.appendingPathComponent("api/auth/oauth2/authorize"),
              configuration.tokenEndpoint == serverURL.appendingPathComponent("api/auth/oauth2/token") else { throw ManagedError.invalidServer }
        guard generation == attempt else { throw ManagedError.cancelled }
        let request = OIDAuthorizationRequest(configuration: configuration, clientId: clientID,
            scopes: [OIDScopeOpenID, OIDScopeEmail, OIDScopeProfile, "offline_access", "sipper:client"],
            redirectURL: redirectURL, responseType: OIDResponseTypeCode,
            additionalParameters: ["resource": resource])
        signInStatus = "Complete sign-in in your browser."
        signInURL = request.authorizationRequestURL()
        let state: OIDAuthState = try await withCheckedThrowingContinuation { continuation in
            flow = OIDAuthState.authState(byPresenting: request, externalUserAgent: userAgent) { state, error in
                if let state { continuation.resume(returning: state) }
                else {
                    let value = error as NSError?
                    let cancelled = value?.domain == OIDGeneralErrorDomain && value?.code == OIDErrorCode.userCanceledAuthorizationFlow.rawValue
                    continuation.resume(throwing: cancelled ? ManagedError.cancelled : .requestFailed)
                }
            }
        }
        flow = nil
        guard generation == attempt else { throw ManagedError.cancelled }
        signInStatus = "Checking your account…"
        try await acceptAuthentication(state)
    }

    /// Bind tokens to the server's verified identity before committing anything to Keychain.
    func acceptAuthentication(_ state: OIDAuthState) async throws {
        guard !isSigningOut else { throw ManagedError.cancelled }
        let attempt = generation
        authenticationIsPending = true
        defer { authenticationIsPending = false }
        let oldState = authState, oldIdentity = identity, oldOrganisations = organisations
        authState = state; isSignedIn = state.isAuthorized
        do {
            try await refreshOrganisations()
            try persist(state)
            lastError = nil
        } catch {
            if generation == attempt { authState = oldState; identity = oldIdentity; organisations = oldOrganisations; isSignedIn = oldState?.isAuthorized ?? false }
            throw error
        }
    }

    @discardableResult public func resumeSignIn(url: URL) -> Bool {
        guard let flow else { return false }
        do { try flow.resumeExternalUserAgentFlow(url); return true }
        catch { return false }
    }
    public func cancelSignIn() { generation += 1; flow?.cancel(); flow = nil }

    private func persist(_ state: OIDAuthState) throws {
        guard let identity else { throw ManagedError.signInRequired }
        let archive = SessionArchive(identity: identity, state: try NSKeyedArchiver.archivedData(withRootObject: state, requiringSecureCoding: true))
        try storage.write(encoder.encode(archive), key: key("authentication"))
    }
    private func accessToken() async throws -> String {
        guard isSignedIn, let state = authState else { throw ManagedError.signInRequired }
        let attempt = generation
        let token: String = try await withCheckedThrowingContinuation { continuation in
            state.performAction(freshTokens: { token, _, _ in
                if let token { continuation.resume(returning: token) }
                else { continuation.resume(throwing: ManagedError.signInRequired) }
            }, additionalRefreshParameters: ["resource": resource])
        }
        guard generation == attempt else { throw ManagedError.cancelled }
        if !authenticationIsPending { try persist(state) }
        return token
    }
    private func requireEnrollment(_ enrollment: ManagedEnrollment) throws {
        guard !isSigningOut, isSignedIn, identity?.id == enrollment.userID else { throw ManagedError.signInRequired }
        guard enrollments.contains(enrollment) else { throw ManagedError.accessUnavailable("This managed device is unavailable.") }
    }
    private func send<Response: Decodable>(_ path: String, method: String = "GET", body: Data? = nil,
                                            query: [URLQueryItem] = [],
                                            enrollment: ManagedEnrollment? = nil,
                                            unavailable: ManagedError = .accessUnavailable("Managed access is unavailable. Contact your administrator."),
                                            conflict: ManagedError = .accessUnavailable("Your settings have changed. Refresh your managed accounts."),
                                            rateLimited: ManagedError = .requestFailed,
                                            response: Response.Type) async throws -> Response {
        let attempt = generation
        if let enrollment { try requireEnrollment(enrollment) }
        var url = URLComponents(url: serverURL, resolvingAgainstBaseURL: false)!
        // Internal route segments are fixed/UUIDs; opaque person IDs are encoded
        // once by their caller. appendingPathComponent would encode '%' again.
        url.percentEncodedPath = "/api/client/\(path)"
        if !query.isEmpty { url.queryItems = query }
        var request = URLRequest(url: url.url!, cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = method; request.httpBody = body
        request.setValue("Bearer \(try await accessToken())", forHTTPHeaderField: "Authorization")
        if let enrollment { try requireEnrollment(enrollment) }
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, result) = try await http.data(for: request)
        guard generation == attempt else { throw ManagedError.cancelled }
        if let enrollment { try requireEnrollment(enrollment) }
        guard data.count <= 2_000_000, let result = result as? HTTPURLResponse else { throw ManagedError.requestFailed }
        switch result.statusCode {
        case 200..<300: return try decoder.decode(Response.self, from: data)
        case 401:
            isSignedIn = false
            for enrollment in enrollments { try? forgetDirectory(for: enrollment) }
            throw ManagedError.signInRequired
        case 403, 404: throw unavailable
        case 409: throw conflict
        case 429: throw rateLimited
        case 500...599: throw ManagedError.serverUnavailable
        default: throw ManagedError.requestFailed
        }
    }
    public func refreshOrganisations() async throws {
        guard !isSigningOut, !changingCallingPreference else { throw ManagedError.cancelled }
        organisationRequest += 1
        let request = organisationRequest, attempt = generation
        do {
            let value = try await send("organisations", response: OrganisationList.self)
            guard request == organisationRequest else { throw ManagedError.cancelled }
            if let previous = identity, previous.id != value.user.id { throw ManagedError.accessUnavailable("Sign out before connecting a different Sipper identity.") }
            identity = value.user; organisations = value.organisations
        } catch {
            if request == organisationRequest, generation == attempt {
                for index in organisations.indices { organisations[index].doNotDisturb = nil; organisations[index].availability = nil }
            }
            throw error
        }
        for enrollment in enrollments where !organisations.contains(where: { $0.id == enrollment.organisationID && $0.status == "active" && $0.licensed }) {
            try forgetDirectory(for: enrollment)
        }
    }
    public func setDoNotDisturb(_ enabled: Bool, organisationID: UUID) async throws {
        try await setCallingPreference(doNotDisturb: enabled, organisationID: organisationID)
    }
    public func setAvailability(_ availability: ManagedAvailability, organisationID: UUID) async throws {
        try await setCallingPreference(availability: availability, organisationID: organisationID)
    }
    private func setCallingPreference(doNotDisturb enabled: Bool? = nil, availability: ManagedAvailability? = nil, organisationID: UUID) async throws {
        guard !isSigningOut, isSignedIn, let user = identity else { throw ManagedError.signInRequired }
        guard !isSigningIn, !authenticationIsPending, !changingCallingPreference else { throw ManagedError.cancelled }
        guard organisations.contains(where: { $0.id == organisationID && $0.status == "active" && (enabled == nil || $0.doNotDisturb != nil) && (availability == nil || $0.availability != nil) }) else {
            throw ManagedError.accessUnavailable("Refresh your organisations to check calling preferences.")
        }
        // Invalidate an older membership response before writing, and keep a new
        // refresh from racing this write. Sign-out still cancels through generation.
        changingCallingPreference = true; organisationRequest += 1
        defer { changingCallingPreference = false }
        let attempt = generation
        struct Input: Encodable { let doNotDisturb: Bool?; let availability: ManagedAvailability? }
        struct Result: Decodable { let doNotDisturb: Bool?; let availability: ManagedAvailability? }
        do {
            let result = try await send("organisations/\(organisationID.uuidString)/calling-preference", method: "PATCH",
                body: encoder.encode(Input(doNotDisturb: enabled, availability: availability)), response: Result.self)
            guard identity == user, isSignedIn else { throw ManagedError.cancelled }
            guard (enabled == nil || result.doNotDisturb == enabled), (availability == nil || result.availability == availability) else { throw ManagedError.invalidConfiguration }
            if let index = organisations.firstIndex(where: { $0.id == organisationID }) {
                if enabled != nil { organisations[index].doNotDisturb = result.doNotDisturb }
                if availability != nil { organisations[index].availability = result.availability }
            }
        } catch {
            // A lost response may follow a successful server write. Do not show
            // the previous value as confirmed; the next refresh resolves it.
            if generation == attempt, identity == user, let index = organisations.firstIndex(where: { $0.id == organisationID }) {
                if enabled != nil { organisations[index].doNotDisturb = nil }
                if availability != nil { organisations[index].availability = nil }
            }
            throw error
        }
    }
    public func redeemSetupLink(_ value: String) async throws -> ManagedOrganisation {
        guard !isSigningOut, isSignedIn, let identity else { throw ManagedError.signInRequired }
        guard let url = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)) else { throw ManagedError.invalidSetupLink }
        let link = try ManagedSetupLink(url: url, serverURL: serverURL)
        struct Input: Encodable { let reference: String }
        struct Result: Decodable { let userId: String; let organisation: ManagedOrganisation }
        let result = try await send("setup-links/redeem", method: "POST", body: encoder.encode(Input(reference: link.reference)),
            unavailable: .accessUnavailable("This setup link is unavailable for your signed-in account. Check your email and ask your administrator for a new link."), response: Result.self)
        guard !isSigningOut, self.identity == identity, isSignedIn, result.userId == identity.id,
              result.organisation.status == "active", result.organisation.licensed,
              !result.organisation.name.isEmpty, result.organisation.name.count <= 160 else { throw ManagedError.invalidConfiguration }
        return result.organisation
    }
    @discardableResult public func enrol(organisation: ManagedOrganisation, name: String, appVersion: String, osVersion: String) async throws -> ManagedEnrollment {
        guard !isSigningOut, isSignedIn, let identity else { throw ManagedError.signInRequired }
        guard organisation.status == "active", organisation.licensed else { throw ManagedError.accessUnavailable("Ask your administrator to assign a licence and enable your access.") }
        if let existing = enrollments.first(where: { $0.organisationID == organisation.id }) { try requireEnrollment(existing); return existing }
        let installationID = UUID()
        let registration = DeviceRegistration(installationId: installationID, name: name, platform: clientID == "sipper-macos" ? "macos" : "ios", appVersion: appVersion, osVersion: osVersion)
        let device = try await send("organisations/\(organisation.id.uuidString)/devices", method: "POST", body: encoder.encode(registration), response: EnrolledDevice.self)
        let enrollment = ManagedEnrollment(organisationID: organisation.id, organisationName: organisation.name, deviceID: device.id, installationID: installationID, userID: identity.id, localProfileID: UUID())
        let next = enrollments + [enrollment]
        try storage.write(encoder.encode(next), key: key("enrollments")); enrollments = next
        return enrollment
    }
    public func configuration(for enrollment: ManagedEnrollment) async throws -> ManagedConfiguration {
        let value = try await send("devices/\(enrollment.deviceID.uuidString)/configuration", enrollment: enrollment, response: ManagedConfiguration.self)
        try value.validate(organisationID: enrollment.organisationID, deviceID: enrollment.deviceID)
        let cacheEncoder = JSONEncoder(); cacheEncoder.dateEncodingStrategy = .iso8601
        try storage.write(cacheEncoder.encode(value), key: key("configuration.\(enrollment.deviceID.uuidString)"))
        return value
    }
    public func cachedConfiguration(for enrollment: ManagedEnrollment) throws -> ManagedConfiguration? {
        guard !isSigningOut, isSignedIn, identity?.id == enrollment.userID, enrollments.contains(enrollment),
              let data = try storage.read(key("configuration.\(enrollment.deviceID.uuidString)")) else { return nil }
        let value = try decoder.decode(ManagedConfiguration.self, from: data)
        try value.validate(organisationID: enrollment.organisationID, deviceID: enrollment.deviceID)
        return value
    }
    public func forgetConfiguration(for enrollment: ManagedEnrollment) throws {
        lastReports[enrollment.deviceID] = nil; reportAttempts[enrollment.deviceID] = nil
        // Withdraw directory authority even if removal of the SIP cache subsequently fails.
        var directoryError: Error?
        do { try forgetDirectory(for: enrollment) } catch { directoryError = error }
        try storage.remove(key("configuration.\(enrollment.deviceID.uuidString)"))
        if let directoryError { throw directoryError }
    }
    private struct Acknowledgement: Decodable { let accepted: Bool?; let signedOut: Bool? }
    public func report(_ report: ManagedDeviceReport, for enrollment: ManagedEnrollment, onlyIfChanged: Bool = false) async throws {
        let previous = reportTask
        let task = Task {
            _ = try? await previous?.value
            try Task.checkCancellation()
            try self.requireEnrollment(enrollment)
            let ids = Set(self.enrollments.map(\.deviceID))
            self.lastReports = self.lastReports.filter { ids.contains($0.key) }; self.reportAttempts = self.reportAttempts.filter { ids.contains($0.key) }
            let now = ProcessInfo.processInfo.systemUptime
            if onlyIfChanged && (self.lastReports[enrollment.deviceID] == report || now - (self.reportAttempts[enrollment.deviceID] ?? -.infinity) < 5) { return }
            self.reportAttempts[enrollment.deviceID] = now
            let result = try await self.send("devices/\(enrollment.deviceID.uuidString)/report", method: "POST", body: self.encoder.encode(report), enrollment: enrollment, conflict: .configurationChanged, response: Acknowledgement.self)
            guard result.accepted == true else { throw ManagedError.requestFailed }
            self.lastReports[enrollment.deviceID] = report
        }
        reportTask = task
        try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }

    public func call(_ id: UUID, for enrollment: ManagedEnrollment, action: ManagedCallAction = .status) async throws -> ManagedCall {
        let path = "devices/\(enrollment.deviceID.uuidString)/calls/\(id.uuidString)" + (action == .status ? "" : "/\(action.rawValue)")
        let value = try await send(path, method: action == .status ? "GET" : "POST",
            body: action == .status ? nil : Data("{}".utf8), enrollment: enrollment, conflict: .callUnavailable, response: ManagedCall.self)
        try value.validate(callID: id)
        return value
    }

    private func conversationRequest<Response: Decodable>(_ path: String, for enrollment: ManagedEnrollment, method: String = "GET",
                                               body: Data? = nil, query: [URLQueryItem] = [], service: String = "messages", response: Response.Type) async throws -> Response {
        let meeting = service == "conferencing"
        func checkMembership() throws {
            try requireEnrollment(enrollment)
            guard organisations.contains(where: { $0.id == enrollment.organisationID && $0.status == "active" && $0.licensed }) else {
                throw meeting ? ManagedError.meetingUnavailable : ManagedError.accessUnavailable("Messaging is unavailable for this customer.")
            }
        }
        try checkMembership()
        do {
            let value = try await send("devices/\(enrollment.deviceID.uuidString)/\(service)/\(path)", method: method, body: body,
                query: query, enrollment: enrollment, unavailable: meeting ? .meetingUnavailable : .accessUnavailable("Messaging is unavailable for this customer or conversation."),
                conflict: meeting ? .meetingChanged : .messagesChanged, rateLimited: meeting ? .meetingRateLimit : .messageRateLimit, response: response)
            try checkMembership(); return value
        } catch is DecodingError { throw meeting ? ManagedError.invalidMeeting : ManagedError.invalidMessages }
        catch ManagedError.invalidConfiguration { throw meeting ? ManagedError.invalidMeeting : ManagedError.invalidMessages }
        catch ManagedError.invalidMessages { throw meeting ? ManagedError.invalidMeeting : ManagedError.invalidMessages }
    }
    public func currentMeeting(conversationID: UUID, for enrollment: ManagedEnrollment) async throws -> ManagedCurrentMeeting {
        var value = try await conversationRequest("conversations/\(conversationID.uuidString)/meeting", for: enrollment, service: "conferencing", response: ManagedCurrentMeeting.self)
        do { try value.validate(for: enrollment, conversationID: conversationID) } catch { throw ManagedError.invalidMeeting }
        return value
    }
    public func startMeeting(id: UUID, conversationID: UUID, for enrollment: ManagedEnrollment) async throws -> ManagedCurrentMeeting {
        struct Input: Encodable { let id: UUID }
        var value = try await conversationRequest("conversations/\(conversationID.uuidString)/meeting", for: enrollment, method: "POST", body: encoder.encode(Input(id: id)), service: "conferencing", response: ManagedCurrentMeeting.self)
        do { try value.validate(for: enrollment, conversationID: conversationID) } catch { throw ManagedError.invalidMeeting }
        guard value.meeting != nil else { throw ManagedError.invalidMeeting }
        // The server may return the conversation's already-open room with a different UUID.
        return value
    }
    public func meetingDetails(_ id: UUID, for enrollment: ManagedEnrollment) async throws -> ManagedMeetingDetails {
        var value = try await conversationRequest("meetings/\(id.uuidString)", for: enrollment, service: "conferencing", response: ManagedMeetingDetails.self)
        do { try value.validate(for: enrollment, meetingID: id) } catch { throw ManagedError.invalidMeeting }
        return value
    }
    public func joinMeeting(_ id: UUID, sessionID: UUID, for enrollment: ManagedEnrollment) async throws -> ManagedMeetingGrant {
        struct Input: Encodable { let id: UUID }
        let value = try await conversationRequest("meetings/\(id.uuidString)/join", for: enrollment, method: "POST", body: encoder.encode(Input(id: sessionID)), service: "conferencing", response: ManagedMeetingGrant.self)
        try value.validate(for: enrollment, meetingID: id, sessionID: sessionID, allowLocalDevelopment: allowLocalMeetings)
        return value
    }
    public func leaveMeeting(_ id: UUID, sessionID: UUID, for enrollment: ManagedEnrollment) async throws {
        var value = try await conversationRequest("meetings/\(id.uuidString)/sessions/\(sessionID.uuidString)/leave", for: enrollment, method: "POST", body: Data("{}".utf8), service: "conferencing", response: ManagedMeetingAcknowledgement.self)
        do { try value.scope.validate(for: enrollment) } catch { throw ManagedError.invalidMeeting }
        guard value.meetingId == id, value.sessionId == sessionID, value.leaveRequested == true else { throw ManagedError.invalidMeeting }
    }
    public func endMeeting(_ id: UUID, for enrollment: ManagedEnrollment) async throws -> ManagedMeeting {
        var value = try await conversationRequest("meetings/\(id.uuidString)/end", for: enrollment, method: "POST", body: Data("{}".utf8), service: "conferencing", response: ManagedMeetingResult.self)
        do { try value.scope.validate(for: enrollment); try value.meeting.validate() } catch { throw ManagedError.invalidMeeting }
        guard value.meeting.id == id, value.meeting.endedAt != nil else { throw ManagedError.invalidMeeting }
        return value.meeting
    }
    public func removeMeetingPerson(_ userID: String, meetingID: UUID, for enrollment: ManagedEnrollment) async throws {
        guard userID != enrollment.userID, messagingText(userID, limit: 128), let component = userID.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")) else { throw ManagedError.invalidMeeting }
        var value = try await conversationRequest("meetings/\(meetingID.uuidString)/people/\(component)", for: enrollment, method: "DELETE", service: "conferencing", response: ManagedMeetingAcknowledgement.self)
        do { try value.scope.validate(for: enrollment) } catch { throw ManagedError.invalidMeeting }
        guard value.meetingId == meetingID, value.targetUserId == userID, value.removalRequested == true else { throw ManagedError.invalidMeeting }
    }
    public func messagePeople(for enrollment: ManagedEnrollment, search: String = "", after: String? = nil) async throws -> ManagedMessagePeople {
        guard search.utf16.count <= 160, after == nil || messagingText(after!, limit: 128) else { throw ManagedError.invalidMessageInput }
        var query = [URLQueryItem(name: "q", value: search)]
        if let after { query.append(URLQueryItem(name: "after", value: after)) }
        var value = try await conversationRequest("people", for: enrollment, query: query, response: ManagedMessagePeople.self)
        try value.validate(for: enrollment); return value
    }
    public func messageAlerts(for enrollment: ManagedEnrollment, after: String = "0") async throws -> ManagedMessageAlerts {
        guard messagingSequence(after) != nil else { throw ManagedError.invalidMessageInput }
        var value = try await conversationRequest("alerts", for: enrollment, query: [URLQueryItem(name: "after", value: after)], response: ManagedMessageAlerts.self)
        try value.validate(for: enrollment, after: after); return value
    }
    public func conversations(for enrollment: ManagedEnrollment, after: String? = nil) async throws -> ManagedConversationPage {
        guard after == nil || validConversationCursor(after!) else { throw ManagedError.invalidMessageInput }
        let query = after.map { [URLQueryItem(name: "after", value: $0)] } ?? []
        var value = try await conversationRequest("conversations", for: enrollment, query: query, response: ManagedConversationPage.self)
        try value.validate(for: enrollment); return value
    }
    public func createConversation(id: UUID, userIDs: [String], title: String = "", for enrollment: ManagedEnrollment) async throws -> ManagedConversation {
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...19).contains(userIDs.count), Set(userIDs).count == userIDs.count, !userIDs.contains(enrollment.userID),
              userIDs.allSatisfy({ messagingText($0, limit: 128) }), name.isEmpty || messagingText(name, limit: 160),
              userIDs.count == 1 || !name.isEmpty else { throw ManagedError.invalidMessageInput }
        struct Input: Encodable { let id: UUID; let userIds: [String]; let title: String }
        var value = try await conversationRequest("conversations", for: enrollment, method: "POST", body: encoder.encode(Input(id: id, userIds: userIDs, title: name)), response: ManagedConversationResult.self)
        try value.scope.validate(for: enrollment); try value.conversation.validate(userID: enrollment.userID)
        guard Set(value.conversation.participants.map(\.id)) == Set(userIDs + [enrollment.userID]),
              value.conversation.kind == (userIDs.count == 1 ? .direct : .group),
              userIDs.count == 1 || (value.conversation.id == id && value.conversation.title == name) else { throw ManagedError.invalidMessages }
        return value.conversation
    }
    public func conversationMessages(_ id: UUID, for enrollment: ManagedEnrollment, before: String? = nil, after: String? = nil) async throws -> ManagedMessagePage {
        guard before == nil || after == nil, [before, after].compactMap({ $0 }).allSatisfy({ messagingSequence($0).map { $0 > 0 } == true }) else { throw ManagedError.invalidMessageInput }
        var query: [URLQueryItem] = []
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        if let after { query.append(URLQueryItem(name: "after", value: after)) }
        var value = try await conversationRequest("conversations/\(id.uuidString)", for: enrollment, query: query, response: ManagedMessagePage.self)
        try value.validate(for: enrollment, conversationID: id, after: after != nil)
        if let before, value.messages.contains(where: { messagingSequence($0.sequence)! >= messagingSequence(before)! }) { throw ManagedError.invalidMessages }
        if let after, value.messages.contains(where: { messagingSequence($0.sequence)! <= messagingSequence(after)! }) { throw ManagedError.invalidMessages }
        return value
    }
    public func sendMessage(id: UUID, text: String, conversationID: UUID, for enrollment: ManagedEnrollment) async throws -> ManagedTextMessage {
        guard validMessageBody(text) else { throw ManagedError.invalidMessageInput }
        struct Input: Encodable { let id: UUID; let text: String }
        var value = try await conversationRequest("conversations/\(conversationID.uuidString)", for: enrollment, method: "POST", body: encoder.encode(Input(id: id, text: text)), response: ManagedMessageResult.self)
        try value.scope.validate(for: enrollment); try value.message.validate()
        guard value.message.id == id, value.message.senderId == enrollment.userID, value.message.text == text else { throw ManagedError.invalidMessages }
        return value.message
    }
    public func updateMessageGroup(_ id: UUID, revision: String, title: String, userIDs: [String], ownerID: String, for enrollment: ManagedEnrollment) async throws -> ManagedConversation {
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard messagingSequence(revision).map({ $0 > 0 }) == true, messagingText(name, limit: 160),
              (1...20).contains(userIDs.count), Set(userIDs).count == userIDs.count,
              userIDs.allSatisfy({ messagingText($0, limit: 128) }), userIDs.contains(ownerID), userIDs.contains(enrollment.userID) else { throw ManagedError.invalidMessageInput }
        struct Input: Encodable { let revision: String; let title: String; let userIds: [String]; let ownerId: String }
        var value = try await conversationRequest("conversations/\(id.uuidString)/group", for: enrollment, method: "PUT",
            body: encoder.encode(Input(revision: revision, title: name, userIds: userIDs, ownerId: ownerID)), response: ManagedConversationResult.self)
        try value.scope.validate(for: enrollment); try value.conversation.validate(userID: enrollment.userID)
        let c = value.conversation
        guard c.id == id, c.kind == .group, c.title == name, c.ownerId == ownerID,
              c.revision.flatMap(messagingSequence).map({ $0 >= messagingSequence(revision)! }) == true,
              Set(c.participants.map(\.id)) == Set(userIDs) else { throw ManagedError.invalidMessages }
        return c
    }
    public func leaveMessageGroup(_ id: UUID, for enrollment: ManagedEnrollment) async throws {
        var value = try await conversationRequest("conversations/\(id.uuidString)/leave", for: enrollment, method: "POST", body: Data("{}".utf8), response: ManagedMessageLeaveResult.self)
        try value.scope.validate(for: enrollment)
        guard value.conversationId == id, value.left else { throw ManagedError.invalidMessages }
    }
    public func markConversationRead(_ id: UUID, sequence: String, for enrollment: ManagedEnrollment) async throws {
        guard messagingSequence(sequence).map({ $0 > 0 }) == true else { throw ManagedError.invalidMessageInput }
        struct Input: Encodable { let sequence: String }
        var value = try await conversationRequest("conversations/\(id.uuidString)/read", for: enrollment, method: "POST", body: encoder.encode(Input(sequence: sequence)), response: ManagedMessageReadResult.self)
        try value.scope.validate(for: enrollment)
        guard let confirmed = messagingSequence(value.sequence), confirmed >= messagingSequence(sequence)! else { throw ManagedError.invalidMessages }
    }
    public func setMessagePushToken(_ token: Data?, for enrollment: ManagedEnrollment) async throws {
        guard clientID == "sipper-ios" else { throw ManagedError.unsupportedConfiguration }
        let path = "devices/\(enrollment.deviceID.uuidString)/messages/push"
        if let token {
            guard (10...256).contains(token.count) else { throw ManagedError.invalidMessageInput }
            struct Input: Encodable { let token: String }
            struct Result: Decodable { let deviceId: UUID; let registered: Bool; let provider: String }
            let value = try await send(path, method: "PUT", body: encoder.encode(Input(token: token.map { String(format: "%02x", $0) }.joined())), enrollment: enrollment, response: Result.self)
            guard value.deviceId == enrollment.deviceID, value.registered, value.provider == "apns" else { throw ManagedError.invalidMessages }
        } else {
            struct Result: Decodable { let deviceId: UUID; let removed: Bool }
            let value = try await send(path, method: "DELETE", enrollment: enrollment, response: Result.self)
            guard value.deviceId == enrollment.deviceID, value.removed else { throw ManagedError.invalidMessages }
        }
    }
    public func setVoIPPushToken(_ token: Data?, for enrollment: ManagedEnrollment) async throws {
        guard clientID == "sipper-ios" else { throw ManagedError.unsupportedConfiguration }
        if let token {
            guard (10...256).contains(token.count) else { throw ManagedError.invalidConfiguration }
            struct Registration: Encodable { let token: String }
            struct Result: Decodable { let registered: Bool; let provider: String }
            let body = Registration(token: token.map { String(format: "%02x", $0) }.joined())
            let result = try await send("devices/\(enrollment.deviceID.uuidString)/push", method: "PUT", body: encoder.encode(body), enrollment: enrollment, response: Result.self)
            guard result.registered, result.provider == "apns" else { throw ManagedError.invalidConfiguration }
        } else {
            struct Result: Decodable { let removed: Bool }
            let result = try await send("devices/\(enrollment.deviceID.uuidString)/push", method: "DELETE", enrollment: enrollment, response: Result.self)
            guard result.removed else { throw ManagedError.invalidConfiguration }
        }
    }
    public func disconnect(_ enrollment: ManagedEnrollment) async throws {
        guard enrollments.contains(enrollment) else { return }
        // Remove authority before the first suspension point. Late responses cannot restore it.
        let next = enrollments.filter { $0.deviceID != enrollment.deviceID }
        try storage.write(encoder.encode(next), key: key("enrollments")); enrollments = next
        var cleanupError: Error?
        do { try forgetDirectory(for: enrollment) } catch { cleanupError = error }
        do { try storage.remove(key("configuration.\(enrollment.deviceID.uuidString)")) } catch { cleanupError = error }
        _ = try? await send("devices/\(enrollment.deviceID.uuidString)", method: "DELETE", response: Acknowledgement.self)
        if let cleanupError { throw cleanupError }
    }
    public func signOut() async throws {
        guard !isSigningOut else { return }
        isSigningOut = true
        defer { isSigningOut = false }
        cancelSignIn()
        let previous = enrollments, token = authState?.lastTokenResponse?.accessToken, refresh = authState?.refreshToken
        authState = nil; isSignedIn = false; identity = nil; organisations = []; enrollments = []; directories = [:]; lastError = nil
        var cleanupError: Error?
        for suffix in ["authentication", "enrollments"] + previous.flatMap({ ["configuration.\($0.deviceID.uuidString)", "directory.\($0.deviceID.uuidString)"] }) {
            do { try storage.remove(key(suffix)) } catch { cleanupError = cleanupError ?? error }
        }
        // Best effort, using the old session only for revocation. Local sign-out is already complete.
        // Expired tokens or an offline server cannot prevent local removal.
        if let token {
            for enrollment in previous {
                var request = URLRequest(url: serverURL.appendingPathComponent("api/client/devices/\(enrollment.deviceID.uuidString)"))
                request.httpMethod = "DELETE"; request.timeoutInterval = 3
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                _ = try? await http.data(for: request)
            }
        }
        if let refresh {
            var request = URLRequest(url: serverURL.appendingPathComponent("api/auth/oauth2/revoke"))
            request.timeoutInterval = 3
            request.httpMethod = "POST"; request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            var form = URLComponents(); form.queryItems = [URLQueryItem(name: "client_id", value: clientID), URLQueryItem(name: "token", value: refresh), URLQueryItem(name: "token_type_hint", value: "refresh_token")]
            request.httpBody = form.percentEncodedQuery?.data(using: .utf8)
            _ = try? await http.data(for: request)
        }
        if let cleanupError { throw cleanupError }
    }

    /// Publish only a complete, verified revision. Directory failures never block incoming-call restoration.
    @discardableResult public func directory(for enrollment: ManagedEnrollment) async throws -> ManagedDirectory {
        try requireEnrollment(enrollment)
        let attempt = (directoryAttempts[enrollment.deviceID] ?? 0) + 1
        directoryAttempts[enrollment.deviceID] = attempt
        func check() throws {
            try Task.checkCancellation()
            try requireEnrollment(enrollment)
            guard directoryAttempts[enrollment.deviceID] == attempt else { throw ManagedError.cancelled }
        }
        do {
            for restart in 0...1 {
                var contacts: [ManagedDirectoryContact] = [], seen = Set<UUID>()
                var first: ManagedDirectoryPage?, cursor: UUID?, expiry = Date.distantFuture, bytes = 0
                do {
                    repeat {
                        try check()
                        let query = cursor.map { [URLQueryItem(name: "after", value: $0.uuidString), URLQueryItem(name: "revision", value: first!.revision.uuidString)] } ?? []
                        let page = try await send("devices/\(enrollment.deviceID.uuidString)/directory", query: query, enrollment: enrollment,
                                                  conflict: .directoryChanged, response: ManagedDirectoryPage.self)
                        try check(); try page.validate(for: enrollment)
                        if let first, page.revision != first.revision || page.organisation != first.organisation { throw ManagedError.directoryChanged }
                        if first == nil { first = page }
                        for contact in page.contacts {
                            guard seen.insert(contact.id).inserted else { throw ManagedError.invalidDirectory }
                            bytes += contact.name.utf8.count + contact.company.utf8.count + contact.numbers.reduce(0) { $0 + $1.label.utf8.count + $1.number.utf8.count }
                        }
                        contacts += page.contacts; expiry = min(expiry, page.expiresAt); cursor = page.nextCursor
                        // ponytail: bounded full snapshots; use encrypted indexed storage for directories beyond 10,000 contacts / 8 MB.
                        guard contacts.count <= 10_000, bytes <= 8_000_000,
                              cursor == nil || contacts.count < 10_000 else { throw ManagedError.directoryTooLarge }
                    } while cursor != nil
                    let value = ManagedDirectory(organisation: first!.organisation, deviceId: enrollment.deviceID,
                                                 revision: first!.revision, expiresAt: expiry, contacts: contacts)
                    try value.validate(organisationID: enrollment.organisationID, deviceID: enrollment.deviceID)
                    try check()
                    let cacheEncoder = JSONEncoder(); cacheEncoder.dateEncodingStrategy = .iso8601
                    try storage.write(cacheEncoder.encode(DirectoryArchive(userID: enrollment.userID, value: value)), key: key("directory.\(enrollment.deviceID.uuidString)"))
                    directories[enrollment.deviceID] = value
                    return value
                } catch ManagedError.directoryChanged where restart == 0 { continue }
            }
            throw ManagedError.directoryChanged
        } catch {
            if case ManagedError.accessUnavailable = error { try? forgetDirectory(for: enrollment) }
            throw error
        }
    }

    public func directoryStatus(contactIDs: [UUID], for enrollment: ManagedEnrollment) async throws -> ManagedDirectoryStatus {
        try requireEnrollment(enrollment)
        guard let directory = directories[enrollment.deviceID], directory.expiresAt > Date(),
              (1...100).contains(contactIDs.count), Set(contactIDs).count == contactIDs.count,
              Set(contactIDs).isSubset(of: Set(directory.contacts.map(\.id))) else { throw ManagedError.invalidDirectory }
        do {
            let body = try JSONSerialization.data(withJSONObject: ["revision": directory.revision.uuidString, "contactIds": contactIDs.map(\.uuidString)])
            var value = try await send("devices/\(enrollment.deviceID.uuidString)/directory/status", method: "POST", body: body,
                                       enrollment: enrollment, conflict: .directoryChanged, response: ManagedDirectoryStatus.self)
            try Task.checkCancellation()
            guard let current = directories[enrollment.deviceID], current.revision == directory.revision, current.expiresAt > Date() else { throw ManagedError.directoryChanged }
            try value.validate(directory: current, contactIDs: contactIDs)
            value.expiresAt = min(value.expiresAt, Date().addingTimeInterval(30))
            return value
        } catch {
            if case ManagedError.accessUnavailable = error { try? forgetDirectory(for: enrollment) }
            throw error
        }
    }

    public func cachedDirectory(for enrollment: ManagedEnrollment) throws -> ManagedDirectory? {
        guard !isSigningOut, isSignedIn, identity?.id == enrollment.userID, enrollments.contains(enrollment) else { return nil }
        guard let data = try storage.read(key("directory.\(enrollment.deviceID.uuidString)")) else { return nil }
        do {
            guard data.count <= 16_000_000 else { throw ManagedError.invalidDirectory }
            let archive = try decoder.decode(DirectoryArchive.self, from: data)
            guard archive.userID == enrollment.userID else { throw ManagedError.invalidDirectory }
            try archive.value.validate(organisationID: enrollment.organisationID, deviceID: enrollment.deviceID)
            return archive.value
        } catch {
            try forgetDirectory(for: enrollment)
            throw error
        }
    }

    public func forgetDirectory(for enrollment: ManagedEnrollment) throws {
        directoryAttempts[enrollment.deviceID, default: 0] += 1
        directories[enrollment.deviceID] = nil
        try storage.remove(key("directory.\(enrollment.deviceID.uuidString)"))
    }

    public func expireDirectories(now: Date = Date()) throws {
        var failure: Error?
        for enrollment in enrollments where directories[enrollment.deviceID].map({ $0.expiresAt <= now || !isSignedIn }) == true {
            do { try forgetDirectory(for: enrollment) } catch { failure = error }
        }
        if let failure { throw failure }
    }

    /// Recheck the selected row at action time; a retained view cannot authorise a removed contact.
    public func directoryNumber(_ number: String, contactID: UUID, for enrollment: ManagedEnrollment) throws -> String {
        try requireEnrollment(enrollment)
        guard let value = directories[enrollment.deviceID], value.expiresAt > Date(),
              let contact = value.contacts.first(where: { $0.id == contactID }), contact.numbers.contains(where: { $0.number == number }) else { throw ManagedError.invalidDirectory }
        return number
    }
}
