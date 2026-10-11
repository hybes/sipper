import Foundation

/// Events from the engine. All methods are invoked on the main thread.
protocol SIPEngineDelegate: AnyObject {
    func sipEngine(_ engine: SIPEngine, registrationDidChange accountID: UUID, state: RegistrationState)
    func sipEngine(_ engine: SIPEngine, didReceiveIncomingCall call: CallSnapshot)
    func sipEngine(_ engine: SIPEngine, callDidChange call: CallSnapshot)
    func sipEngine(_ engine: SIPEngine, callDidEnd call: CallSnapshot)
    func sipEngine(_ engine: SIPEngine, voicemailDidChange accountID: UUID, info: VoicemailInfo)
    func sipEngine(_ engine: SIPEngine, transferStatusDidChange callID: Int, code: Int, text: String, isFinal: Bool)
    func sipEngineDidStop(_ engine: SIPEngine, error: Error?)
}

/// Wraps the pjsua C API. Every pjsua call runs on one dedicated thread that also
/// pumps `pjsua_handle_events`, so callbacks arrive on that same thread and the
/// pjlib thread-registration rules are satisfied without extra bookkeeping.
final class SIPEngine {
    /// The engine reachable from C callbacks (which cannot capture context).
    fileprivate static weak var current: SIPEngine?

    /// Set SIPPER_LOG_STDERR=1 to mirror PJSIP logs to stderr (development aid).
    fileprivate static let logsToStandardError = ProcessInfo.processInfo.environment["SIPPER_LOG_STDERR"] == "1"

    weak var delegate: SIPEngineDelegate?
    let log = SIPLogBuffer()

    private let thread = EngineThread()
    private var settings = AppSettings()

    // Engine-thread state
    private var running = false
    private var accountIDs: [UUID: pjsua_acc_id] = [:]
    private var accountsByPJ: [pjsua_acc_id: UUID] = [:]
    private var accountConfigs: [UUID: (SIPAccount, String)] = [:]
    private var blockedManagedAccounts = Set<UUID>()
    private var registrationWithdrawalFailed = Set<UUID>()
    private var pendingManagedAccounts: [UUID: (account: SIPAccount, password: String)] = [:]
    private var lastManagedExpiryCheck = Date.distantPast
    private var calls: [pjsua_call_id: CallContext] = [:]
    private var transports: [SIPTransport: pjsua_transport_id] = [:]
    private var ringback: RingbackTone?
    private var stunServers: [String] = []
    private var lastTransportError: (message: String, at: Date)?
    private var networkAvailable = true
    private var recoveringNetwork = false
    private var awaitingRegistration = Set<UUID>()
    private var changingConferences = Set<UUID>()

    #if DEBUG
    private var testCertificate: String?
    private var testNullAudio = false
    /// XCTest supplies a one-use DER CA. Verification stays enabled; Release has no override.
    func trustTestCertificate(_ path: String) {
        thread.sync { precondition(!self.running); self.testCertificate = path }
    }
    func useNullAudioForTesting() throws {
        try thread.sync {
            self.testNullAudio = true
            if self.running { try pjCheck(pjsua_set_null_snd_dev(), "test null audio") }
        }
    }
    func mediaForTesting(_ call: CallSnapshot) -> (codec: String, sent: UInt32, received: UInt32, transport: String, vad: Bool, microphoneConnected: Bool, speakerConnected: Bool, captureDevice: Int32)? {
        thread.sync { () -> (codec: String, sent: UInt32, received: UInt32, transport: String, vad: Bool, microphoneConnected: Bool, speakerConnected: Bool, captureDevice: Int32)? in
            guard self.running, let current = self.calls[Int32(call.id)], current.startedAt == call.startedAt, current.accountID == call.accountID else { return nil }
            var info = pjsua_stream_info(), stats = pjsua_stream_stat()
            guard pjsua_call_get_stream_info(Int32(call.id), 0, &info).isSuccess,
                  pjsua_call_get_stream_stat(Int32(call.id), 0, &stats).isSuccess else { return nil }
            var buffer = [CChar](repeating: 0, count: 16384)
            guard pjsua_call_dump(Int32(call.id), 1, &buffer, UInt32(buffer.count), "").isSuccess else { return nil }
            // Do not return addresses, SIP messages or key material in diagnostics.
            let transport = String(cString: buffer).components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { $0.hasPrefix("SRTP status:") || $0.hasPrefix("ICE role:") }.joined(separator: "; ")
            var microphone = pjsua_conf_port_info(), speaker = pjsua_conf_port_info()
            let microphoneConnected = pjsua_conf_get_port_info(0, &microphone).isSuccess && withUnsafeBytes(of: microphone.listeners) {
                $0.bindMemory(to: Int32.self).prefix(Int(microphone.listener_cnt)).contains(current.confSlot)
            }
            let speakerConnected = current.confSlot >= 0 && pjsua_conf_get_port_info(current.confSlot, &speaker).isSuccess && withUnsafeBytes(of: speaker.listeners) {
                $0.bindMemory(to: Int32.self).prefix(Int(speaker.listener_cnt)).contains(0)
            }
            var capture: Int32 = -1, playback: Int32 = -1
            pjsua_get_snd_dev(&capture, &playback)
            return (info.info.aud.fmt.encoding_name.string, stats.rtcp.tx.pkt, stats.rtcp.rx.pkt, transport,
                    info.info.aud.param.map { $0.pointee.setting.vad != 0 } ?? false, microphoneConnected, speakerConnected, capture)
        }
    }
    /// The received signal from this remote party, independent of the local speaker mix.
    func incomingAudioLevelForTesting(_ call: CallSnapshot) -> Int? {
        thread.sync {
            guard self.running, self.testNullAudio, let current = self.calls[Int32(call.id)],
                  current.startedAt == call.startedAt, current.accountID == call.accountID, current.confSlot >= 0 else { return nil }
            var sent: UInt32 = 0, received: UInt32 = 0
            guard pjsua_conf_get_signal_level(current.confSlot, &sent, &received).isSuccess else { return nil }
            return Int(received)
        }
    }
    #endif

    private let stateLock = NSLock()
    private var _isRunning = false

    /// True once `start` succeeded. Safe to read from any thread.
    var isRunning: Bool {
        stateLock.lock(); defer { stateLock.unlock() }
        return _isRunning
    }

    var pjsipVersion: String { String(cString: sipper_pjsip_version()) }

    init() {
        SIPEngine.current = self
        thread.name = "com.hybes.sipper.sip-engine"
        thread.qualityOfService = .userInteractive
        thread.onIdle = { [weak self] in
            guard let self, self.running else { return false }
            if Date().timeIntervalSince(self.lastManagedExpiryCheck) >= 1 {
                self.lastManagedExpiryCheck = Date()
                self.expireManagedAccountsOnEngineThread()
            }
            pjsua_handle_events(20)
            for context in self.calls.values {
                guard var pending = context.pendingHold, let continuation = pending.continuation, ContinuousClock.now >= pending.deadline else { continue }
                // A late SIP response may still change media. Fence new audio until it resolves.
                pending.continuation = nil; context.pendingHold = pending
                continuation.resume(throwing: SIPEngineError.holdTimedOut)
            }
            return true
        }
        thread.start()
    }

    deinit {
        thread.cancel()
    }

    // MARK: Lifecycle

    func start(settings: AppSettings) throws {
        try thread.sync { try self.startOnEngineThread(settings: settings) }
    }

    func stop() {
        thread.sync { self.stopOnEngineThread() }
    }

    func restart(settings: AppSettings) throws {
        try thread.sync {
            self.stopOnEngineThread()
            try self.startOnEngineThread(settings: settings)
        }
    }

    private func startOnEngineThread(settings newSettings: AppSettings) throws {
        guard !running else { return }
        settings = newSettings
        let pool = CStringPool()

        try pjCheck(pjsua_create(), "pjsua_create")

        var cfg = pjsua_config()
        pjsua_config_default(&cfg)
        cfg.thread_cnt = 0
        cfg.user_agent = pool.pj(settings.userAgent.isEmpty ? AppSettings.defaultUserAgent : settings.userAgent)
        cfg.stun_ignore_failure = 1
        cfg.stun_try_ipv6 = 0

        stunServers = collectSTUNServers()
        cfg.stun_srv_cnt = UInt32(min(stunServers.count, 8))
        withUnsafeMutablePointer(to: &cfg.stun_srv) { tuple in
            tuple.withMemoryRebound(to: pj_str_t.self, capacity: 8) { servers in
                for (index, server) in stunServers.prefix(8).enumerated() {
                    servers[index] = pool.pj(server)
                }
            }
        }

        cfg.cb.on_incoming_call = { accID, callID, data in
            SIPEngine.current?.handleIncomingCall(accID: accID, callID: callID, data: data)
        }
        cfg.cb.on_call_state = { callID, _ in
            SIPEngine.current?.handleCallState(callID: callID)
        }
        cfg.cb.on_call_media_state = { callID in
            SIPEngine.current?.handleCallMediaState(callID: callID)
        }
        cfg.cb.on_ip_change_progress = { operation, _, _ in
            guard operation == PJSUA_IP_CHANGE_OP_COMPLETED, let engine = SIPEngine.current else { return }
            engine.recoveringNetwork = false
            for id in engine.accountIDs.keys { engine.emitRegistration(id, engine.currentRegistration(accountID: id)) }
        }
        cfg.cb.on_call_tsx_state = { callID, transaction, _ in
            if let transaction { SIPEngine.current?.handleCallTransaction(callID: callID, transaction: transaction.pointee) }
        }
        cfg.cb.on_reg_state2 = { accID, info in
            SIPEngine.current?.handleRegistrationState(accID: accID, info: info)
        }
        cfg.cb.on_mwi_info = { accID, info in
            SIPEngine.current?.handleMWI(accID: accID, info: info)
        }
        cfg.cb.on_call_transfer_status = { callID, code, _, isFinal, shouldContinue in
            if SIPEngine.current?.handleTransferStatus(callID: callID, code: code, isFinal: isFinal != 0) == true {
                shouldContinue?.pointee = 0
            }
        }
        cfg.cb.on_transport_state = { transport, state, info in
            SIPEngine.current?.handleTransportState(transport: transport, state: state, info: info)
        }

        var logCfg = pjsua_logging_config()
        pjsua_logging_config_default(&logCfg)
        logCfg.level = UInt32(max(0, min(6, settings.sipLogLevel)))
        logCfg.console_level = logCfg.level
        logCfg.msg_logging = 1
        logCfg.decor = UInt32(PJ_LOG_HAS_TIME.rawValue | PJ_LOG_HAS_MICRO_SEC.rawValue | PJ_LOG_HAS_SENDER.rawValue | PJ_LOG_HAS_INDENT.rawValue)
        logCfg.cb = { _, data, len in
            guard let data, len > 0 else { return }
            let line = String(decoding: UnsafeRawBufferPointer(start: UnsafeRawPointer(data), count: Int(len)), as: UTF8.self)
                .trimmingCharacters(in: .newlines)
            SIPEngine.current?.log.append(line)
            if SIPEngine.logsToStandardError {
                FileHandle.standardError.write(Data((line + "\n").utf8))
            }
        }

        var mediaCfg = pjsua_media_config()
        pjsua_media_config_default(&mediaCfg)
        mediaCfg.clock_rate = 16000
        mediaCfg.snd_clock_rate = 0
        let echo = echoParameters(mode: settings.echoMode, tailMilliseconds: settings.echoTailMilliseconds)
        mediaCfg.ec_tail_len = echo.tail
        mediaCfg.ec_options = echo.options
        #if os(iOS)
        mediaCfg.snd_auto_close_time = -1 // CallKit owns audio activation/deactivation.
        #else
        mediaCfg.snd_auto_close_time = 1
        #endif
        mediaCfg.no_vad = 0

        // Keep UDP accounts on UDP even for large INVITEs (RFC 3261 §18.1.1 would
        // otherwise switch to TCP, which some PBXs do not listen on).
        pjsip_cfg().pointee.endpt.disable_tcp_switch = 1

        let initStatus = pjsua_init(&cfg, &logCfg, &mediaCfg)
        guard initStatus.isSuccess else {
            pjsua_destroy()
            throw SIPEngineError.pjsip(operation: "pjsua_init", status: initStatus, message: pjErrorMessage(initStatus))
        }

        do {
            try createTransport(.udp, port: settings.localUDPPort)
            try createTransport(.tcp, port: settings.localTCPPort)
            try createTransport(.tls, port: settings.localTLSPort)
            try pjCheck(pjsua_start(), "pjsua_start")
        } catch {
            pjsua_destroy()
            throw error
        }

        running = true
        setRunning(true)
        #if os(iOS)
        #if DEBUG
        // XCTest's virtual clock must survive startup without opening physical audio.
        if testNullAudio { pjsua_set_null_snd_dev() }
        else { pjsua_set_no_snd_dev() }
        #else
        pjsua_set_no_snd_dev()
        #endif
        #else
        applyAudioDevices(input: settings.inputDeviceName, output: settings.outputDeviceName)
        #endif
        applyCodecPreferences(settings.codecs)
        ringback = RingbackTone(clockRate: 16000)
        log.append("Sipper: engine started (pjsip \(pjsipVersion))")
    }

    private func stopOnEngineThread() {
        guard running else { return }
        running = false
        setRunning(false)
        ringback?.stop()
        ringback = nil
        pjsua_call_hangup_all()
        for context in calls.values { destroyRecorder(context) }
        for context in calls.values where context.state != .disconnected {
            finishHold(context, error: SIPEngineError.unknownCall)
            context.state = .disconnected
            context.endedAt = Date()
            context.lastCode = 0
            context.lastText = "Engine stopped"
            emitCallEnded(context)
        }
        calls.removeAll()
        pjsua_destroy()
        accountIDs.removeAll()
        accountsByPJ.removeAll()
        accountConfigs.removeAll()
        blockedManagedAccounts.removeAll()
        registrationWithdrawalFailed.removeAll()
        pendingManagedAccounts.removeAll()
        awaitingRegistration.removeAll()
        networkAvailable = true
        recoveringNetwork = false
        transports.removeAll()
        log.append("Sipper: engine stopped")
    }

    private func setRunning(_ value: Bool) {
        stateLock.lock()
        _isRunning = value
        stateLock.unlock()
    }

    private func collectSTUNServers() -> [String] {
        var servers: [String] = []
        let global = settings.stunServer.trimmingCharacters(in: .whitespaces)
        if !global.isEmpty { servers.append(global) }
        for (account, _) in accountConfigs.values {
            let s = account.stunServer.trimmingCharacters(in: .whitespaces)
            if !s.isEmpty, !servers.contains(s) { servers.append(s) }
        }
        return servers
    }

    private func createTransport(_ transport: SIPTransport, port: Int) throws {
        #if DEBUG
        let pool = CStringPool()
        #endif
        var config = pjsua_transport_config()
        pjsua_transport_config_default(&config)
        config.port = UInt32(max(0, port))
        if transport == .tls {
            config.tls_setting.verify_server = settings.verifyTLSCertificates ? 1 : 0
            #if DEBUG
            if let testCertificate { config.tls_setting.ca_list_file = pool.pj(testCertificate) }
            #endif
        }
        let type: pjsip_transport_type_e
        switch transport {
        case .udp: type = PJSIP_TRANSPORT_UDP
        case .tcp: type = PJSIP_TRANSPORT_TCP
        case .tls: type = PJSIP_TRANSPORT_TLS
        }
        var id: pjsua_transport_id = -1
        var status = pjsua_transport_create(type, &config, &id)
        if !status.isSuccess, port != 0 {
            log.append("Sipper: \(transport.displayName) port \(port) unavailable (\(pjErrorMessage(status))), using a random port")
            config.port = 0
            status = pjsua_transport_create(type, &config, &id)
        }
        try pjCheck(status, "pjsua_transport_create(\(transport.displayName))")
        transports[transport] = id
    }

    // MARK: Accounts

    /// Makes the set of active pjsua accounts match `accounts`. Missing accounts are
    /// removed, changed ones modified and new ones added.
    func syncAccounts(_ accounts: [(account: SIPAccount, password: String)]) {
        thread.async { self.syncAccountsOnEngineThread(accounts) }
    }

    /// A barrier after syncAccounts: acknowledge only settings actually accepted by PJSIP.
    func hasApplied(_ accounts: [(account: SIPAccount, password: String)]) -> Bool {
        thread.sync {
            self.running && accounts.allSatisfy { entry in
                guard self.pendingManagedAccounts[entry.account.id] == nil,
                      !self.blockedManagedAccounts.contains(entry.account.id),
                      let saved = self.accountConfigs[entry.account.id] else { return false }
                return saved.0 == entry.account && saved.1 == entry.password
            }
        }
    }

    func currentRegistration(accountID: UUID) -> RegistrationState {
        thread.sync {
            guard self.running, let id = self.accountIDs[accountID] else { return .unregistered }
            guard !self.blockedManagedAccounts.contains(accountID) else { return .unregistered }
            guard self.networkAvailable else { return .failed(code: 0, reason: "No network connection") }
            var info = pjsua_acc_info()
            guard pjsua_acc_get_info(id, &info).isSuccess else { return .unregistered }
            let code = Int(info.status.rawValue)
            if code >= 300 { return .failed(code: code, reason: "Registration failed") }
            guard !self.recoveringNetwork, !self.awaitingRegistration.contains(accountID) else { return .registering }
            if code == 200 && info.expires > 0 { return .registered(expiresIn: Int(info.expires), since: Date()) }
            return info.expires == 0 ? .unregistered : .registering
        }
    }

    /// Revocation must not wait for a prompt reading an unrelated personal Keychain item.
    func retainManagedAccounts(_ allowed: Set<UUID>) {
        thread.async {
            guard self.running else { return }
            for (id, entry) in Array(self.accountConfigs) where entry.0.managed != nil && !allowed.contains(id) {
                self.pendingManagedAccounts[id] = nil
                self.withdrawManagedAccountOnEngineThread(id)
            }
        }
    }

    private func syncAccountsOnEngineThread(_ accounts: [(account: SIPAccount, password: String)]) {
        guard running else { return }
        let wanted = Dictionary(uniqueKeysWithValues: accounts.filter {
            ($0.account.managed.map { $0.expiresAt > Date() } ?? true) &&
            ($0.account.managed?.mode != .gateway || ($0.account.transport == .tls && $0.account.srtp == .mandatory &&
                settings.verifyTLSCertificates && pjsip_auth_is_algorithm_supported(PJSIP_AUTH_ALGORITHM_SHA256) != 0))
        }.map { ($0.account.id, $0) })

        for id in Array(accountIDs.keys) where wanted[id] == nil {
            pendingManagedAccounts[id] = nil
            if accountConfigs[id]?.0.managed != nil { withdrawManagedAccountOnEngineThread(id) }
            else { removeAccountOnEngineThread(id) }
        }

        var newSTUN: [String] = []
        let global = settings.stunServer.trimmingCharacters(in: .whitespaces)
        if !global.isEmpty { newSTUN.append(global) }
        for entry in wanted.values {
            let s = entry.account.stunServer.trimmingCharacters(in: .whitespaces)
            if !s.isEmpty, !newSTUN.contains(s) { newSTUN.append(s) }
        }
        if newSTUN != stunServers {
            updateSTUNServers(newSTUN)
        }
        for (id, entry) in wanted {
            if let existing = accountConfigs[id] {
                var oldSettings = existing.0, newSettings = entry.account
                oldSettings.managed = nil; newSettings.managed = nil
                if oldSettings != newSettings || existing.1 != entry.password || existing.0.managed?.mode != entry.account.managed?.mode {
                    if entry.account.managed != nil, calls.values.contains(where: { $0.accountID == id && $0.connectedAt != nil && $0.state != .disconnected }) {
                        pendingManagedAccounts[id] = entry
                        withdrawManagedAccountOnEngineThread(id)
                        continue
                    }
                    pendingManagedAccounts[id] = nil
                    modifyAccountOnEngineThread(entry.account, password: entry.password)
                } else {
                    accountConfigs[id] = (entry.account, entry.password)
                    pendingManagedAccounts[id] = nil
                    if blockedManagedAccounts.contains(id) {
                        modifyAccountOnEngineThread(entry.account, password: entry.password)
                    }
                }
            } else {
                addAccountOnEngineThread(entry.account, password: entry.password)
            }
        }
    }

    private func updateSTUNServers(_ servers: [String]) {
        stunServers = servers
        let pool = CStringPool()
        var list = servers.prefix(8).map { pool.pj($0) }
        let count = UInt32(list.count)
        if count == 0 {
            return
        }
        list.withUnsafeMutableBufferPointer { buffer in
            let status = pjsua_update_stun_servers(count, buffer.baseAddress, 0)
            if !status.isSuccess {
                log.append("Sipper: updating STUN servers failed: \(pjErrorMessage(status))")
            }
        }
    }

    private func fillAccountConfig(_ cfg: inout pjsua_acc_config, account: SIPAccount, password: String, pool: CStringPool) {
        cfg.id = pool.pj(account.addressOfRecord)
        cfg.reg_uri = pool.pj(account.registrarURI)
        cfg.reg_timeout = UInt32(max(60, account.registrationExpiry))
        cfg.reg_retry_interval = 30
        cfg.reg_first_retry_interval = 5
        cfg.reg_delay_before_refresh = 5
        cfg.register_on_acc_add = 1
        cfg.mwi_enabled = 1
        cfg.publish_enabled = 0
        cfg.ka_interval = 15
        cfg.allow_via_rewrite = 1
        cfg.allow_contact_rewrite = 1
        cfg.use_rfc5626 = 1
        cfg.ip_change_cfg.hangup_calls = 0

        // Plaintext credentials are bound to the challenge algorithm by PJSIP.
        // Offer SHA-256 first when the native library supports it, retaining MD5
        // for direct providers which have not migrated yet.
        let algorithms = (account.managed?.mode == .gateway ? [PJSIP_AUTH_ALGORITHM_SHA256] : [PJSIP_AUTH_ALGORITHM_SHA256, PJSIP_AUTH_ALGORITHM_MD5]).filter {
            pjsip_auth_is_algorithm_supported($0) != 0
        }
        cfg.cred_count = UInt32(algorithms.count)
        withUnsafeMutablePointer(to: &cfg.cred_info) { tuple in
            tuple.withMemoryRebound(to: pjsip_cred_info.self, capacity: 8) { creds in
                for (index, algorithm) in algorithms.enumerated() {
                    creds[index].realm = pool.pj("*")
                    creds[index].scheme = pool.pj("digest")
                    creds[index].username = pool.pj(account.effectiveAuthUsername)
                    creds[index].data_type = Int32(PJSIP_CRED_DATA_PLAIN_PASSWD.rawValue)
                    creds[index].data = pool.pj(password)
                    creds[index].algorithm_type = algorithm
                }
            }
        }

        cfg.proxy_cnt = 1
        withUnsafeMutablePointer(to: &cfg.proxy) { tuple in
            tuple.withMemoryRebound(to: pj_str_t.self, capacity: 8) { proxies in
                proxies[0] = pool.pj(account.proxyURI)
            }
        }

        switch account.srtp {
        case .disabled: cfg.use_srtp = PJMEDIA_SRTP_DISABLED
        case .optional: cfg.use_srtp = PJMEDIA_SRTP_OPTIONAL
        case .mandatory: cfg.use_srtp = PJMEDIA_SRTP_MANDATORY
        }
        cfg.srtp_secure_signaling = account.managed?.mode == .gateway ? 1 : 0
        if account.managed?.mode == .gateway, let transport = transports[.tls] { cfg.transport_id = transport }

        let hasSTUN = !stunServers.isEmpty && (!account.stunServer.isEmpty || !settings.stunServer.isEmpty)
        cfg.sip_stun_use = hasSTUN ? PJSUA_STUN_USE_DEFAULT : PJSUA_STUN_USE_DISABLED
        cfg.media_stun_use = hasSTUN ? PJSUA_STUN_USE_DEFAULT : PJSUA_STUN_USE_DISABLED

        cfg.ice_cfg_use = PJSUA_ICE_CONFIG_USE_CUSTOM
        cfg.ice_cfg.enable_ice = account.useICE ? 1 : 0

        cfg.vid_in_auto_show = 0
        cfg.vid_out_auto_transmit = 0
    }

    private func addAccountOnEngineThread(_ account: SIPAccount, password: String) {
        let pool = CStringPool()
        var cfg = pjsua_acc_config()
        pjsua_acc_config_default(&cfg)
        fillAccountConfig(&cfg, account: account, password: password, pool: pool)

        var accID: pjsua_acc_id = -1
        let status = pjsua_acc_add(&cfg, 0, &accID)
        guard status.isSuccess else {
            let message = pjErrorMessage(status)
            log.append("Sipper: adding account \(account.displayLabel) failed: \(message)")
            emitRegistration(account.id, .failed(code: 0, reason: message))
            return
        }
        accountIDs[account.id] = accID
        accountsByPJ[accID] = account.id
        accountConfigs[account.id] = (account, password)
        emitRegistration(account.id, .registering)
    }

    private func modifyAccountOnEngineThread(_ account: SIPAccount, password: String) {
        guard let accID = accountIDs[account.id] else {
            addAccountOnEngineThread(account, password: password)
            return
        }
        let pool = CStringPool()
        var cfg = pjsua_acc_config()
        pjsua_acc_config_default(&cfg)
        fillAccountConfig(&cfg, account: account, password: password, pool: pool)
        let status = pjsua_acc_modify(accID, &cfg)
        if status.isSuccess {
            accountConfigs[account.id] = (account, password)
            blockedManagedAccounts.remove(account.id)
            registrationWithdrawalFailed.remove(account.id)
            emitRegistration(account.id, .registering)
        } else {
            let message = pjErrorMessage(status)
            log.append("Sipper: modifying account \(account.displayLabel) failed: \(message)")
            emitRegistration(account.id, .failed(code: 0, reason: message))
        }
    }

    private func removeAccountOnEngineThread(_ id: UUID) {
        guard let accID = accountIDs[id] else { return }
        for (callID, context) in calls where context.accountID == id && context.state != .disconnected {
            pjsua_call_hangup(callID, 0, nil, nil)
        }
        pjsua_acc_del(accID)
        accountIDs[id] = nil
        accountsByPJ[accID] = nil
        accountConfigs[id] = nil
        blockedManagedAccounts.remove(id)
        registrationWithdrawalFailed.remove(id)
        pendingManagedAccounts[id] = nil
        awaitingRegistration.remove(id)
        emitRegistration(id, .unregistered)
    }

    /// Unregister and reject new calls, keeping established dialogs until they end.
    private func withdrawManagedAccountOnEngineThread(_ id: UUID) {
        guard let accID = accountIDs[id] else { return }
        if blockedManagedAccounts.insert(id).inserted || registrationWithdrawalFailed.contains(id) {
            // A retained dialog must not let automatic network recovery register
            // a withdrawn account again. Keep only its existing call configuration.
            if let (account, password) = accountConfigs[id] {
                let pool = CStringPool()
                var cfg = pjsua_acc_config()
                pjsua_acc_config_default(&cfg)
                fillAccountConfig(&cfg, account: account, password: password, pool: pool)
                cfg.reg_uri = pool.pj("")
                cfg.register_on_acc_add = 0
                let status = pjsua_acc_modify(accID, &cfg)
                if !status.isSuccess {
                    registrationWithdrawalFailed.insert(id)
                    pjsua_acc_set_registration(accID, 0)
                    log.append("Sipper: disabling managed registration failed: \(pjErrorMessage(status))")
                } else { registrationWithdrawalFailed.remove(id) }
            }
            awaitingRegistration.remove(id)
            emitRegistration(id, .unregistered)
        }
        for (callID, context) in Array(calls) where context.accountID == id && context.connectedAt == nil && context.state != .disconnected {
            pjsua_call_hangup(callID, 480, nil, nil)
        }
        if !calls.values.contains(where: { $0.accountID == id && $0.state != .disconnected }) {
            removeAccountOnEngineThread(id)
        }
    }

    private func expireManagedAccountsOnEngineThread() {
        for (id, entry) in Array(accountConfigs) where entry.0.managed.map({ $0.expiresAt <= Date() }) == true {
            withdrawManagedAccountOnEngineThread(id)
        }
    }

    private func allowsNewCall(_ id: UUID) -> Bool {
        guard !blockedManagedAccounts.contains(id), let account = accountConfigs[id]?.0 else { return false }
        return account.managed.map { $0.expiresAt > Date() } ?? true
    }

    /// Forces a fresh REGISTER (or un-REGISTER) for one account.
    func setRegistration(accountID: UUID, enabled: Bool) {
        thread.async {
            guard let accID = self.accountIDs[accountID] else { return }
            guard !enabled || self.allowsNewCall(accountID) else { return }
            guard !enabled || self.networkAvailable else {
                self.emitRegistration(accountID, .failed(code: 0, reason: "No network connection"))
                return
            }
            let status = pjsua_acc_set_registration(accID, enabled ? 1 : 0)
            if status.isSuccess {
                self.emitRegistration(accountID, enabled ? .registering : .unregistered)
            } else {
                self.emitRegistration(accountID, .failed(code: 0, reason: pjErrorMessage(status)))
            }
        }
    }

    func reRegisterAll() {
        thread.async {
            guard self.running, self.networkAvailable else { return }
            for (id, accID) in self.accountIDs where self.allowsNewCall(id) {
                pjsua_acc_set_registration(accID, 1)
            }
        }
    }

    /// Recover listeners, registrations and established media through PJSIP's
    /// IP-change path. A lost connection must not leave an old green status.
    func networkChanged(available: Bool) {
        thread.async {
            guard self.running else { return }
            self.networkAvailable = available
            self.expireManagedAccountsOnEngineThread()
            for id in Array(self.registrationWithdrawalFailed) { self.withdrawManagedAccountOnEngineThread(id) }
            self.awaitingRegistration = Set(self.accountIDs.keys.filter { self.allowsNewCall($0) })
            for id in self.awaitingRegistration {
                // PJSIP deliberately skips permanent failures such as bad credentials.
                // Preserve that error instead of waiting for a callback it will not send.
                let state = self.currentRegistration(accountID: id)
                self.emitRegistration(id, state.isFailed ? state : .registering)
            }
            guard available, !self.accountIDs.isEmpty, self.registrationWithdrawalFailed.isEmpty else { return }
            var parameter = pjsua_ip_change_param()
            pjsua_ip_change_param_default(&parameter)
            self.recoveringNetwork = true
            let status = pjsua_handle_ip_change(&parameter)
            if !status.isSuccess {
                self.recoveringNetwork = false
                self.log.append("Sipper: network recovery failed: \(pjErrorMessage(status))")
                for id in self.awaitingRegistration {
                    self.emitRegistration(id, .failed(code: 0, reason: "Network recovery failed"))
                }
            }
        }
    }

    /// Push wake targets one enrolled account; an in-flight REGISTER can finish normally.
    func refreshManagedRegistration(deviceID: UUID, accountID: UUID) throws -> Bool {
        try thread.sync { () throws -> Bool in
            guard self.running else { throw SIPEngineError.notRunning }
            let entry = self.accountConfigs.first { entry in
                guard let binding = entry.value.0.managed else { return false }
                return binding.deviceID == deviceID && binding.accountID == accountID && binding.mode == .gateway
            }
            guard let id = entry?.key, self.allowsNewCall(id), let accID = self.accountIDs[id] else { throw SIPEngineError.unknownAccount }
            let status = pjsua_acc_set_registration(accID, 1)
            // The SIP registration client uses PJSIP_EBUSY, distinct from PJ_EBUSY.
            if sipper_registration_is_busy(status) != 0 { return false }
            try pjCheck(status, "Refresh managed registration")
            return true
        }
    }

    // MARK: Calls

    @discardableResult
    func makeCall(accountID: UUID, uri: String) throws -> CallSnapshot {
        try thread.sync {
            guard self.running else { throw SIPEngineError.notRunning }
            guard !self.recoveringNetwork else { throw SIPEngineError.networkUpdating }
            guard !self.calls.values.contains(where: { $0.pendingHold != nil }) else { throw SIPEngineError.holdUpdating }
            guard let accID = self.accountIDs[accountID] else { throw SIPEngineError.unknownAccount }
            guard self.allowsNewCall(accountID) else { throw SIPEngineError.unknownAccount }
            if let account = self.accountConfigs[accountID]?.0, account.managed?.mode == .gateway {
                let number = SIPAddress.parse(uri).user
                guard Self.isGatewayNumber(number), uri == account.callURI(for: number) else { throw SIPEngineError.invalidURI(uri) }
            }
            let pool = CStringPool()
            var dest = pool.pj(uri)
            guard pjsua_verify_sip_url(dest.ptr).isSuccess || pjsua_verify_url(dest.ptr).isSuccess else {
                throw SIPEngineError.invalidURI(uri)
            }
            var setting = pjsua_call_setting()
            pjsua_call_setting_default(&setting)
            setting.aud_cnt = 1
            setting.vid_cnt = 0
            var callID: pjsua_call_id = -1
            let status = pjsua_call_make_call(accID, &dest, &setting, nil, nil, &callID)
            try pjCheck(status, "pjsua_call_make_call")
            let context = self.calls[callID] ?? CallContext(callID: callID, accountID: accountID, direction: .outgoing)
            let address = SIPAddress.parse(uri)
            context.remoteURI = uri
            context.remoteNumber = address.user.isEmpty ? uri : address.user
            context.remoteName = address.displayName
            context.state = .calling
            self.calls[callID] = context
            return self.snapshot(context)
        }
    }

    func answer(callID: Int, code: Int = 200) {
        thread.async {
            guard let context = self.calls[pjsua_call_id(callID)] else { return }
            guard code != 200 || !self.recoveringNetwork else { return }
            guard code != 200 || !self.calls.values.contains(where: { $0.pendingHold != nil }) else { return }
            guard code != 200 || self.allowsNewCall(context.accountID) else { return }
            guard code != 200 || context.gatewayCallID == nil else { return }
            var setting = pjsua_call_setting()
            pjsua_call_setting_default(&setting)
            setting.aud_cnt = 1
            setting.vid_cnt = 0
            let status = pjsua_call_answer2(pjsua_call_id(callID), &setting, UInt32(code), nil, nil)
            if !status.isSuccess {
                self.log.append("Sipper: answering call \(callID) failed: \(pjErrorMessage(status))")
            }
        }
    }

    static func isGatewayNumber(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 128 && value.allSatisfy { "0123456789+*#".contains($0) }
    }

    /// Recheck identity on the engine thread after an asynchronous managed answer claim.
    func answer(_ expected: CallSnapshot, claimedGatewayCallID: UUID? = nil) throws {
        try thread.sync {
            guard !self.recoveringNetwork else { throw SIPEngineError.networkUpdating }
            guard !self.calls.values.contains(where: { $0.pendingHold != nil }) else { throw SIPEngineError.holdUpdating }
            guard self.running, let context = self.calls[pjsua_call_id(expected.id)],
                  context.startedAt == expected.startedAt, context.accountID == expected.accountID,
                  context.direction == .incoming, context.connectedAt == nil,
                  context.gatewayCallID == expected.gatewayCallID,
                  context.gatewayCallID == claimedGatewayCallID,
                  self.allowsNewCall(context.accountID) else { throw SIPEngineError.unknownCall }
            var setting = pjsua_call_setting(); pjsua_call_setting_default(&setting)
            setting.aud_cnt = 1; setting.vid_cnt = 0
            try pjCheck(pjsua_call_answer2(context.callID, &setting, 200, nil, nil), "Answer call")
        }
    }

    func setManagedCaller(_ expected: CallSnapshot, name: String, number: String) throws -> CallSnapshot {
        try thread.sync {
            guard let context = self.calls[pjsua_call_id(expected.id)], context.startedAt == expected.startedAt,
                  context.accountID == expected.accountID, context.gatewayCallID != nil,
                  context.gatewayCallID == expected.gatewayCallID, self.allowsNewCall(context.accountID) else { throw SIPEngineError.unknownCall }
            context.remoteName = name; context.remoteNumber = number
            return self.snapshot(context)
        }
    }

    /// Ends a call. `code` 0 lets pjsua pick (BYE, CANCEL or 603 as appropriate).
    func hangup(callID: Int, code: Int = 0) {
        thread.async {
            guard let context = self.calls[pjsua_call_id(callID)] else { return }
            context.hangupCode = code
            let status = pjsua_call_hangup(pjsua_call_id(callID), UInt32(code), nil, nil)
            if !status.isSuccess {
                self.log.append("Sipper: hanging up call \(callID) failed: \(pjErrorMessage(status))")
            }
        }
    }

    func hangup(_ expected: CallSnapshot, code: Int = 0, onlyIfRinging: Bool = false) {
        thread.async {
            guard let context = self.calls[pjsua_call_id(expected.id)],
                  context.startedAt == expected.startedAt, context.accountID == expected.accountID,
                  !onlyIfRinging || context.connectedAt == nil else { return }
            context.hangupCode = code
            pjsua_call_hangup(context.callID, UInt32(code), nil, nil)
        }
    }

    func hangupAll() {
        thread.async { pjsua_call_hangup_all() }
    }

    func setHold(_ expected: CallSnapshot, onHold: Bool) async throws {
        try await setHold(expected, onHold: onHold, conferenceID: nil)
    }

    private func setHold(_ expected: CallSnapshot, onHold: Bool, conferenceID: UUID?) async throws {
        try Task.checkCancellation()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            thread.async {
                guard self.running, let context = self.calls[pjsua_call_id(expected.id)],
                      context.startedAt == expected.startedAt, context.accountID == expected.accountID else {
                    continuation.resume(throwing: SIPEngineError.unknownCall); return
                }
                guard context.conferenceID == conferenceID,
                      conferenceID == nil || expected.conferenceID == conferenceID else {
                    continuation.resume(throwing: SIPEngineError.conferenceControlRequired); return
                }
                guard context.pendingHold == nil, onHold || !self.calls.values.contains(where: { $0.pendingHold != nil }) else { continuation.resume(throwing: SIPEngineError.holdUpdating); return }
                if context.state == .confirmed && (onHold ? context.isOnHold : !context.isOnHold && [PJSUA_CALL_MEDIA_NONE, PJSUA_CALL_MEDIA_ACTIVE, PJSUA_CALL_MEDIA_REMOTE_HOLD].contains(context.mediaStatus)) {
                    continuation.resume(); return
                }
                context.pendingHold = PendingHold(onHold: onHold, continuation: continuation)
                let status: pj_status_t
                if onHold {
                    status = pjsua_call_set_hold2(context.callID, 0, nil)
                } else {
                    var setting = pjsua_call_setting()
                    pjsua_call_setting_default(&setting)
                    setting.aud_cnt = 1
                    setting.vid_cnt = 0
                    setting.flag |= UInt32(PJSUA_CALL_UNHOLD.rawValue)
                    status = pjsua_call_reinvite2(context.callID, &setting, nil)
                }
                do { try pjCheck(status, onHold ? "Hold call" : "Resume call") }
                catch { self.finishHold(context, error: error) }
            }
        }
        try Task.checkCancellation()
    }

    private func finishHold(_ context: CallContext, error: Error? = nil) {
        guard let pending = context.pendingHold else { return }
        if error == nil {
            guard pending.accepted, context.state == .confirmed,
                  pending.onHold ? [PJSUA_CALL_MEDIA_LOCAL_HOLD, PJSUA_CALL_MEDIA_NONE].contains(context.mediaStatus) :
                    [PJSUA_CALL_MEDIA_NONE, PJSUA_CALL_MEDIA_ACTIVE, PJSUA_CALL_MEDIA_REMOTE_HOLD].contains(context.mediaStatus) else { return }
            context.confirmedHold = pending.onHold
            emitCallChanged(context)
        }
        context.pendingHold = nil
        if let error { pending.continuation?.resume(throwing: error) }
        else { pending.continuation?.resume() }
    }

    fileprivate func handleCallTransaction(callID: pjsua_call_id, transaction: pjsip_transaction) {
        guard let context = calls[callID], var pending = context.pendingHold,
              transaction.role == PJSIP_ROLE_UAC, transaction.method.id == PJSIP_INVITE_METHOD else { return }
        if transaction.state == PJSIP_TSX_STATE_CALLING {
            pending.sequence = transaction.cseq
            context.pendingHold = pending
        }
        guard pending.sequence == transaction.cseq, transaction.state.rawValue >= PJSIP_TSX_STATE_COMPLETED.rawValue,
              transaction.status_code >= 200, ![401, 407, 422].contains(Int(transaction.status_code)) else { return }
        if transaction.status_code < 300 {
            pending.accepted = true; context.pendingHold = pending
            finishHold(context)
        } else { finishHold(context, error: SIPEngineError.holdRejected(code: Int(transaction.status_code))) }
    }

    func setMuted(callID: Int, muted: Bool) {
        guard let call = activeCalls().first(where: { $0.id == callID }) else { return }
        setMuted(call, muted: muted)
    }
    func setMuted(_ expected: CallSnapshot, muted: Bool) {
        thread.async {
            guard let context = self.calls[pjsua_call_id(expected.id)],
                  context.accountID == expected.accountID, context.startedAt == expected.startedAt else { return }
            context.isMuted = muted
            self.applyMediaWiring(context)
            self.emitCallChanged(context)
            if let peer = self.conferencePeer(context) {
                peer.isMuted = muted
                self.applyMediaWiring(peer)
                self.emitCallChanged(peer)
            }
        }
    }

    func sendDTMF(callID: Int, digits: String) {
        guard let call = activeCalls().first(where: { $0.id == callID }) else { return }
        sendDTMF(call, digits: digits)
    }
    func sendDTMF(_ expected: CallSnapshot, digits: String) {
        thread.async {
            let callID = expected.id
            guard let context = self.calls[pjsua_call_id(callID)],
                  context.accountID == expected.accountID, context.startedAt == expected.startedAt else { return }
            let pool = CStringPool()
            var param = pjsua_call_send_dtmf_param()
            pjsua_call_send_dtmf_param_default(&param)
            param.method = PJSUA_DTMF_METHOD_RFC2833
            param.digits = pool.pj(digits)
            var status = pjsua_call_send_dtmf(pjsua_call_id(callID), &param)
            if !status.isSuccess {
                param.method = PJSUA_DTMF_METHOD_SIP_INFO
                status = pjsua_call_send_dtmf(pjsua_call_id(callID), &param)
            }
            if !status.isSuccess {
                self.log.append("Sipper: DTMF on call \(callID) failed: \(pjErrorMessage(status))")
            }
        }
    }

    private func transferCall(_ expected: CallSnapshot) throws -> CallContext {
        guard running, let context = calls[pjsua_call_id(expected.id)],
              context.startedAt == expected.startedAt, context.accountID == expected.accountID,
              context.state == .confirmed, allowsNewCall(context.accountID),
              context.conferenceID == nil,
              !calls.values.contains(where: { $0.pendingHold != nil }),
              !context.isTransferring, !calls.values.contains(where: { $0.transferPeer?.id == expected.id }) else {
            throw SIPEngineError.transferUnavailable
        }
        return context
    }

    func transfer(_ expected: CallSnapshot, to target: String) throws {
        try thread.sync {
            let context = try self.transferCall(expected)
            guard let account = self.accountConfigs[context.accountID]?.0 else { throw SIPEngineError.unknownAccount }
            let value = target.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty, value.utf8.count <= 512, !target.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
                  value.contains("@") || value.allSatisfy({ "0123456789+*#ABCDabcd() .-".contains($0) }) else {
                throw SIPEngineError.invalidTransferTarget
            }
            let uri = account.callURI(for: value)
            if account.managed?.mode == .gateway {
                let number = SIPAddress.parse(uri).user
                guard !value.contains("@"), !value.contains(":"), Self.isGatewayNumber(number),
                      uri == account.callURI(for: number) else { throw SIPEngineError.invalidTransferTarget }
            }
            let pool = CStringPool()
            var dest = pool.pj(uri)
            guard !SIPAddress.parse(uri).user.isEmpty, pjsua_verify_sip_url(dest.ptr).isSuccess else { throw SIPEngineError.invalidTransferTarget }
            context.isTransferring = true; context.transferStatus = "Transferring…"
            do { try pjCheck(pjsua_call_xfer(context.callID, &dest, nil), "Transfer call") }
            catch { context.isTransferring = false; context.transferStatus = "Transfer failed. Your call is still connected."; self.emitCallChanged(context); throw error }
            self.emitCallChanged(context)
        }
    }

    func attendedTransfer(_ expected: CallSnapshot, to other: CallSnapshot) throws {
        try thread.sync {
            let context = try self.transferCall(expected), peer = try self.transferCall(other)
            guard context.callID != peer.callID, context.accountID == peer.accountID else { throw SIPEngineError.transferUnavailable }
            context.isTransferring = true; context.transferPeer = self.snapshot(peer); context.transferStatus = "Transferring…"
            do { try pjCheck(pjsua_call_xfer_replaces(context.callID, peer.callID, 0, nil), "Transfer call") }
            catch {
                context.isTransferring = false; context.transferPeer = nil
                context.transferStatus = "Transfer failed. Your calls are still connected."
                self.emitCallChanged(context); throw error
            }
            self.emitCallChanged(context)
        }
    }

    func activeCalls() -> [CallSnapshot] {
        thread.sync { self.calls.values.filter { $0.state != .disconnected }.map { self.snapshot($0) } }
    }

    /// Both SIP legs must already have accepted resume. No third-party PBX conference service is needed.
    func beginConference(_ expected: CallSnapshot, with other: CallSnapshot) throws {
        try thread.sync {
            guard !self.recoveringNetwork, !self.calls.values.contains(where: { $0.pendingHold != nil }),
                  let first = try? self.transferCall(expected), let second = try? self.transferCall(other),
                  first.callID != second.callID, first.accountID == second.accountID,
                  first.hasActiveMedia, second.hasActiveMedia, !first.isOnHold, !second.isOnHold,
                  first.confSlot >= 0, second.confSlot >= 0, first.confSlot != second.confSlot else {
                throw SIPEngineError.conferenceUnavailable
            }
            do {
                try pjCheck(pjsua_conf_connect(first.confSlot, second.confSlot), "Merge call audio")
                try pjCheck(pjsua_conf_connect(second.confSlot, first.confSlot), "Merge call audio")
            } catch {
                pjsua_conf_disconnect(first.confSlot, second.confSlot)
                pjsua_conf_disconnect(second.confSlot, first.confSlot)
                throw error
            }
            let id = UUID()
            first.conferenceID = id; second.conferenceID = id
            // Merging must never silently turn a muted microphone back on.
            let muted = first.isMuted || second.isMuted
            first.isMuted = muted; second.isMuted = muted
            for call in [first, second] { self.applyMediaWiring(call); self.emitCallChanged(call) }
        }
    }

    func mergeConference(_ expected: CallSnapshot, with other: CallSnapshot) async throws {
        try Task.checkCancellation()
        let members = try thread.sync {
            guard !self.recoveringNetwork, let first = try? self.transferCall(expected), let second = try? self.transferCall(other),
                  first.callID != second.callID, first.accountID == second.accountID else { throw SIPEngineError.conferenceUnavailable }
            return [self.snapshot(first), self.snapshot(second)]
        }
        var resumed: [CallSnapshot] = []
        do {
            for member in members where member.isOnHold {
                try await setHold(member, onHold: false)
                resumed.append(member)
            }
            try Task.checkCancellation()
            try beginConference(expected, with: other)
        } catch {
            for member in resumed { try? await setHold(member, onHold: true) }
            throw error
        }
    }

    /// Split the local mixer without ending either remote conversation. The caller then holds its chosen leg.
    func splitConference(_ expected: CallSnapshot) throws {
        try thread.sync {
            guard self.running, let call = self.calls[Int32(expected.id)],
                  call.accountID == expected.accountID, call.startedAt == expected.startedAt,
                  let id = call.conferenceID, expected.conferenceID == id,
                  !self.changingConferences.contains(id) else { throw SIPEngineError.conferenceUnavailable }
            self.breakConference(call)
        }
    }

    /// Both parties negotiate hold/resume; a rejected second leg restores the first leg's prior state.
    func setConferenceHold(_ expected: CallSnapshot, onHold: Bool) async throws {
        guard let id = expected.conferenceID else { throw SIPEngineError.conferenceUnavailable }
        let members = try thread.sync {
            let members = try self.conferenceMembers(expected)
            guard self.changingConferences.insert(id).inserted else { throw SIPEngineError.holdUpdating }
            return members
        }
        defer { thread.sync { _ = self.changingConferences.remove(id) } }
        var changed: [CallSnapshot] = []
        do {
            for member in members {
                try await setHold(member, onHold: onHold, conferenceID: expected.conferenceID)
                changed.append(member)
            }
        } catch {
            for member in changed.reversed() where member.isOnHold != onHold {
                // The peer may have ended while this offer was negotiating. Restore only the captured survivor.
                let current = thread.sync {
                    self.calls[Int32(member.id)].flatMap { call -> CallSnapshot? in
                        guard call.startedAt == member.startedAt, call.accountID == member.accountID,
                              call.conferenceID == nil || call.conferenceID == id else { return nil }
                        return self.snapshot(call)
                    }
                }
                if let current { try? await setHold(current, onHold: member.isOnHold, conferenceID: current.conferenceID) }
            }
            throw error
        }
    }

    func hangupConference(_ expected: CallSnapshot) {
        thread.async {
            guard let members = try? self.conferenceMembers(expected) else { return }
            for member in members { pjsua_call_hangup(Int32(member.id), 0, nil, nil) }
        }
    }

    private func conferenceMembers(_ expected: CallSnapshot) throws -> [CallSnapshot] {
        guard running, let call = calls[Int32(expected.id)], call.accountID == expected.accountID,
              call.startedAt == expected.startedAt, let id = call.conferenceID, expected.conferenceID == id,
              let peer = conferencePeer(call) else { throw SIPEngineError.conferenceUnavailable }
        return [snapshot(call), snapshot(peer)]
    }

    private func conferencePeer(_ call: CallContext) -> CallContext? {
        guard let id = call.conferenceID else { return nil }
        return calls.values.first { $0.callID != call.callID && $0.conferenceID == id }
    }

    private func breakConference(_ call: CallContext) {
        guard call.conferenceID != nil else { return }
        if let peer = conferencePeer(call) {
            if call.confSlot >= 0 && peer.confSlot >= 0 {
                pjsua_conf_disconnect(call.confSlot, peer.confSlot)
                pjsua_conf_disconnect(peer.confSlot, call.confSlot)
            }
            if peer.recorderSlot >= 0 && call.confSlot >= 0 { pjsua_conf_disconnect(call.confSlot, peer.recorderSlot) }
            if call.recorderSlot >= 0 && peer.confSlot >= 0 { pjsua_conf_disconnect(peer.confSlot, call.recorderSlot) }
            peer.conferenceID = nil
            applyMediaWiring(peer); emitCallChanged(peer)
        }
        call.conferenceID = nil
        if call.state != .disconnected { applyMediaWiring(call); emitCallChanged(call) }
    }

    // MARK: Audio and codecs

    #if os(iOS)
    /// Called only after CallKit has activated/deactivated this app's audio session.
    func setCallAudioActive(_ active: Bool) throws {
        try thread.sync {
            guard self.running else { throw SIPEngineError.notRunning }
            if active { try pjCheck(pjsua_set_snd_dev(-1, -2), "Activate call audio") }
            else { _ = pjsua_set_no_snd_dev() }
        }
    }
    #endif

    func audioDevices() -> [AudioDevice] {
        thread.sync {
            guard self.running else { return [] }
            pjmedia_aud_dev_refresh()
            var infos = [pjmedia_aud_dev_info](repeating: pjmedia_aud_dev_info(), count: 64)
            var count: UInt32 = 64
            let status = infos.withUnsafeMutableBufferPointer { pjsua_enum_aud_devs($0.baseAddress, &count) }
            guard status.isSuccess else { return [] }
            return (0..<Int(count)).map { index in
                let info = infos[index]
                return AudioDevice(id: index,
                                   name: cString(info.name),
                                   inputChannels: Int(info.input_count),
                                   outputChannels: Int(info.output_count),
                                   driver: cString(info.driver))
            }
        }
    }

    func setAudioDevices(input: String?, output: String?) {
        thread.async { self.applyAudioDevices(input: input, output: output) }
    }

    private func applyAudioDevices(input: String?, output: String?) {
        guard running else { return }
        #if DEBUG
        if testNullAudio { pjsua_set_null_snd_dev(); return }
        #endif
        pjmedia_aud_dev_refresh()
        var infos = [pjmedia_aud_dev_info](repeating: pjmedia_aud_dev_info(), count: 64)
        var count: UInt32 = 64
        guard infos.withUnsafeMutableBufferPointer({ pjsua_enum_aud_devs($0.baseAddress, &count) }).isSuccess else { return }

        var capture: Int32 = -1   // PJMEDIA_AUD_DEFAULT_CAPTURE_DEV
        var playback: Int32 = -2  // PJMEDIA_AUD_DEFAULT_PLAYBACK_DEV
        for index in 0..<Int(count) {
            let name = cString(infos[index].name)
            if let input, name == input, infos[index].input_count > 0 { capture = Int32(index) }
            if let output, name == output, infos[index].output_count > 0 { playback = Int32(index) }
        }
        var param = pjsua_snd_dev_param()
        pjsua_snd_dev_param_default(&param)
        param.capture_dev = capture
        param.playback_dev = playback
        param.mode = UInt32(PJSUA_SND_DEV_NO_IMMEDIATE_OPEN.rawValue)
        let status = pjsua_set_snd_dev2(&param)
        if !status.isSuccess {
            log.append("Sipper: selecting audio devices failed: \(pjErrorMessage(status))")
        }
    }

    func codecs() -> [CodecInfo] {
        thread.sync {
            guard self.running else { return [] }
            var infos = [pjsua_codec_info](repeating: pjsua_codec_info(), count: 32)
            var count: UInt32 = 32
            let status = infos.withUnsafeMutableBufferPointer { pjsua_enum_codecs($0.baseAddress, &count) }
            guard status.isSuccess else { return [] }
            return (0..<Int(count)).map { CodecInfo(id: infos[$0].codec_id.string, priority: Int(infos[$0].priority)) }
        }
    }

    func setCodecPreferences(_ preferences: [CodecPreference]) {
        thread.async { self.applyCodecPreferences(preferences) }
    }

    private func applyCodecPreferences(_ preferences: [CodecPreference]) {
        guard running, !preferences.isEmpty else { return }
        let pool = CStringPool()
        for (index, preference) in preferences.enumerated() {
            var id = pool.pj(preference.codecID)
            let priority: UInt8 = preference.isEnabled ? UInt8(max(1, 250 - index)) : 0
            pjsua_codec_set_priority(&id, priority)
        }
    }

    func setEchoCancellation(mode: EchoCancellationMode, tailMilliseconds: Int) {
        thread.async {
            guard self.running else { return }
            let echo = self.echoParameters(mode: mode, tailMilliseconds: tailMilliseconds)
            let status = pjsua_set_ec(echo.tail, echo.options)
            if !status.isSuccess {
                self.log.append("Sipper: echo cancellation change failed: \(pjErrorMessage(status))")
            }
        }
    }

    /// PJSIP echo canceller parameters. Apple voice processing uses the CoreAudio
    /// VoiceProcessingIO unit (device selection is ignored by that unit); software
    /// mode uses the WebRTC canceller on the selected devices.
    private func echoParameters(mode: EchoCancellationMode, tailMilliseconds: Int) -> (tail: UInt32, options: UInt32) {
        let tail = UInt32(max(0, tailMilliseconds))
        switch mode {
        case .appleVoiceProcessing:
            return (tail == 0 ? 200 : tail, 0)
        case .software:
            return (tail == 0 ? 200 : tail, UInt32(PJMEDIA_ECHO_USE_SW_ECHO.rawValue | PJMEDIA_ECHO_WEBRTC.rawValue))
        case .off:
            return (0, 0)
        }
    }

    // MARK: Callbacks (engine thread)

    fileprivate func handleIncomingCall(accID: pjsua_acc_id, callID: pjsua_call_id, data: UnsafeMutablePointer<pjsip_rx_data>?) {
        guard let accountID = accountsByPJ[accID], allowsNewCall(accountID) else {
            pjsua_call_hangup(callID, 480, nil, nil)
            return
        }
        if let binding = accountConfigs[accountID]?.0.managed, binding.mode == .direct, binding.doNotDisturb {
            pjsua_call_hangup(callID, 486, nil, nil)
            return
        }
        var info = pjsua_call_info()
        guard pjsua_call_get_info(callID, &info).isSuccess else {
            pjsua_call_hangup(callID, 500, nil, nil)
            return
        }
        let context = CallContext(callID: callID, accountID: accountID, direction: .incoming)
        context.managedAccount = accountConfigs[accountID]?.0.managed
        if context.managedAccount?.mode == .gateway {
            var buffer = [CChar](repeating: 0, count: 37)
            guard let transport = data?.pointee.tp_info.transport,
                  transport.pointee.flag & UInt32(PJSIP_TRANSPORT_SECURE.rawValue) != 0,
                  transport.pointee.dir == PJSIP_TP_DIR_OUTGOING,
                  sipper_gateway_call_id(data?.pointee.msg_info.msg, &buffer, buffer.count) != 0,
                  let reference = UUID(uuidString: String(cString: buffer)),
                  !calls.values.contains(where: { $0.accountID == accountID && $0.gatewayCallID == reference }) else {
                pjsua_call_hangup(callID, 400, nil, nil); return
            }
            context.gatewayCallID = reference
        }
        let address = SIPAddress.parse(info.remote_info.string)
        context.remoteURI = context.gatewayCallID == nil ? address.uri : ""
        context.remoteNumber = context.gatewayCallID == nil ? (address.user.isEmpty ? address.host : address.user) : "Incoming managed call"
        context.remoteName = context.gatewayCallID == nil ? address.displayName : ""
        context.state = .incoming
        calls[callID] = context
        pjsua_call_answer(callID, 180, nil, nil)

        let snapshot = snapshot(context)
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.delegate?.sipEngine(self, didReceiveIncomingCall: snapshot)
        }
    }

    fileprivate func handleCallState(callID: pjsua_call_id) {
        var info = pjsua_call_info()
        guard pjsua_call_get_info(callID, &info).isSuccess else { return }
        let context: CallContext
        if let existing = calls[callID] {
            context = existing
        } else {
            // Only track calls that are alive; a DISCONNECTED or NULL report for an
            // unknown id (e.g. a failed make_call) must not create a phantom call.
            switch info.state {
            case PJSIP_INV_STATE_CALLING, PJSIP_INV_STATE_INCOMING, PJSIP_INV_STATE_EARLY,
                 PJSIP_INV_STATE_CONNECTING, PJSIP_INV_STATE_CONFIRMED:
                break
            default:
                return
            }
            guard let accountID = accountsByPJ[info.acc_id] else { return }
            // Gateway offers must first pass the incoming callback's transport/header checks.
            if info.role != PJSIP_ROLE_UAC, accountConfigs[accountID]?.0.managed?.mode == .gateway { return }
            context = CallContext(callID: callID, accountID: accountID, direction: info.role == PJSIP_ROLE_UAC ? .outgoing : .incoming)
            let address = SIPAddress.parse(info.remote_info.string)
            context.remoteURI = address.uri
            context.remoteNumber = address.user
            context.remoteName = address.displayName
            calls[callID] = context
        }

        context.lastCode = Int(info.last_status.rawValue)
        context.lastText = info.last_status_text.string

        switch info.state {
        case PJSIP_INV_STATE_CALLING:
            context.state = .calling
        case PJSIP_INV_STATE_INCOMING:
            context.state = .incoming
        case PJSIP_INV_STATE_EARLY:
            if context.direction == .incoming {
                // We answered with 180 Ringing; from the user's point of view the
                // call is still ringing here.
                context.state = .incoming
            } else {
                context.state = .early
                if !context.hasActiveMedia {
                    startRingback(for: context)
                }
            }
        case PJSIP_INV_STATE_CONNECTING:
            context.state = .connecting
            stopRingback(for: context)
        case PJSIP_INV_STATE_CONFIRMED:
            context.state = .confirmed
            if context.connectedAt == nil { context.connectedAt = Date() }
            stopRingback(for: context)
        case PJSIP_INV_STATE_DISCONNECTED:
            context.state = .disconnected
            context.endedAt = Date()
            stopRingback(for: context)
        default:
            break
        }

        if context.state == .disconnected {
            finishHold(context, error: SIPEngineError.unknownCall)
            breakConference(context)
            destroyRecorder(context)
            calls[callID] = nil
            emitCallEnded(context)
            let id = context.accountID
            if blockedManagedAccounts.contains(id), !calls.values.contains(where: { $0.accountID == id && $0.state != .disconnected }) {
                // Finish after the current PJSIP callback unwinds.
                thread.async {
                    guard self.running, self.blockedManagedAccounts.contains(id) else { return }
                    let pending = self.pendingManagedAccounts[id]
                    self.removeAccountOnEngineThread(id)
                    if let pending, pending.account.managed.map({ $0.expiresAt > Date() }) == true {
                        self.addAccountOnEngineThread(pending.account, password: pending.password)
                    }
                }
            }
        } else {
            emitCallChanged(context)
        }
    }

    fileprivate func handleCallMediaState(callID: pjsua_call_id) {
        guard let context = calls[callID] else { return }
        var info = pjsua_call_info()
        guard pjsua_call_get_info(callID, &info).isSuccess else { return }
        context.mediaStatus = info.media_status
        context.confSlot = info.conf_slot
        context.hasActiveMedia = sipper_call_media_is_active(&info) != 0
        context.isRemoteHold = info.media_status == PJSUA_CALL_MEDIA_REMOTE_HOLD
        if context.hasActiveMedia {
            stopRingback(for: context)
        }
        applyMediaWiring(context)
        emitCallChanged(context)
        finishHold(context)
    }

    private func applyMediaWiring(_ context: CallContext) {
        guard context.confSlot >= 0 else { return }
        let slot = context.confSlot
        if context.hasActiveMedia {
            pjsua_conf_connect(slot, 0)
            if context.isMuted {
                pjsua_conf_disconnect(0, slot)
            } else {
                pjsua_conf_connect(0, slot)
            }
        } else {
            pjsua_conf_disconnect(slot, 0)
            pjsua_conf_disconnect(0, slot)
        }
        if context.recorderSlot >= 0 {
            // Record both directions mixed: the remote party and (unless muted) the microphone.
            if context.hasActiveMedia {
                pjsua_conf_connect(slot, context.recorderSlot)
            } else {
                pjsua_conf_disconnect(slot, context.recorderSlot)
            }
            if context.isMuted || !context.hasActiveMedia {
                pjsua_conf_disconnect(0, context.recorderSlot)
            } else {
                pjsua_conf_connect(0, context.recorderSlot)
            }
        }
        if let peer = conferencePeer(context), peer.confSlot >= 0 {
            if context.hasActiveMedia && peer.hasActiveMedia {
                pjsua_conf_connect(slot, peer.confSlot)
                pjsua_conf_connect(peer.confSlot, slot)
            } else {
                pjsua_conf_disconnect(slot, peer.confSlot)
                pjsua_conf_disconnect(peer.confSlot, slot)
            }
            if context.recorderSlot >= 0 {
                if peer.hasActiveMedia { pjsua_conf_connect(peer.confSlot, context.recorderSlot) }
                else { pjsua_conf_disconnect(peer.confSlot, context.recorderSlot) }
            }
            if peer.recorderSlot >= 0 {
                if context.hasActiveMedia { pjsua_conf_connect(slot, peer.recorderSlot) }
                else { pjsua_conf_disconnect(slot, peer.recorderSlot) }
            }
        }
    }

    // MARK: Recording

    /// Starts writing a 16-bit mono WAV of the call to `url` (which must end in .wav).
    func startRecording(callID: Int, to url: URL) throws {
        try thread.sync {
            guard self.running else { throw SIPEngineError.notRunning }
            guard let context = self.calls[pjsua_call_id(callID)] else { throw SIPEngineError.unknownCall }
            guard context.recorderID < 0 else { return }
            let pool = CStringPool()
            var filename = pool.pj(url.path)
            var recorderID: pjsua_recorder_id = -1
            try pjCheck(pjsua_recorder_create(&filename, 0, nil, 0, 0, &recorderID), "pjsua_recorder_create")
            context.recorderID = recorderID
            context.recorderSlot = pjsua_recorder_get_conf_port(recorderID)
            self.applyMediaWiring(context)
            self.log.append("Sipper: recording call \(callID) to \(url.lastPathComponent)")
            self.emitCallChanged(context)
        }
    }

    func stopRecording(callID: Int) {
        thread.async {
            guard let context = self.calls[pjsua_call_id(callID)], context.recorderID >= 0 else { return }
            self.destroyRecorder(context)
            self.emitCallChanged(context)
        }
    }

    private func destroyRecorder(_ context: CallContext) {
        guard context.recorderID >= 0 else { return }
        if context.recorderSlot >= 0 {
            if context.confSlot >= 0 { pjsua_conf_disconnect(context.confSlot, context.recorderSlot) }
            pjsua_conf_disconnect(0, context.recorderSlot)
            if let peer = conferencePeer(context), peer.confSlot >= 0 { pjsua_conf_disconnect(peer.confSlot, context.recorderSlot) }
        }
        pjsua_recorder_destroy(context.recorderID)
        context.recorderID = -1
        context.recorderSlot = -1
    }

    fileprivate func handleRegistrationState(accID: pjsua_acc_id, info: UnsafeMutablePointer<pjsua_reg_info>?) {
        guard let accountID = accountsByPJ[accID] else { return }
        guard !blockedManagedAccounts.contains(accountID) else { emitRegistration(accountID, .unregistered); return }
        guard networkAvailable else { emitRegistration(accountID, .failed(code: 0, reason: "No network connection")); return }
        awaitingRegistration.remove(accountID)
        var state: RegistrationState = .unregistered
        if let param = info?.pointee.cbparam?.pointee {
            let code = Int(param.code)
            let renew = (info?.pointee.renew ?? 0) != 0
            if param.status != PJ_SUCCESS.rawValue {
                state = .failed(code: code, reason: pjErrorMessage(param.status))
            } else if code >= 300 {
                var reason = param.reason.string
                // 503 is pjsip's local failure code; the transport error says why.
                if code == 503, let transportError = lastTransportError, Date().timeIntervalSince(transportError.at) < 30 {
                    reason += " (\(transportError.message))"
                }
                state = .failed(code: code, reason: reason)
            } else if code >= 200 {
                state = renew ? .registered(expiresIn: Int(param.expiration), since: Date()) : .unregistered
            } else {
                state = .registering
            }
        } else {
            var accInfo = pjsua_acc_info()
            if pjsua_acc_get_info(accID, &accInfo).isSuccess {
                let code = Int(accInfo.status.rawValue)
                if accInfo.has_registration != 0, code == 200, accInfo.expires > 0 {
                    state = .registered(expiresIn: Int(accInfo.expires), since: Date())
                } else if code >= 300 {
                    state = .failed(code: code, reason: accInfo.status_text.string)
                }
            }
        }
        emitRegistration(accountID, recoveringNetwork && state.isRegistered ? .registering : state)
    }

    fileprivate func handleMWI(accID: pjsua_acc_id, info: UnsafeMutablePointer<pjsua_mwi_info>?) {
        guard let accountID = accountsByPJ[accID] else { return }
        var body = ""
        if let rdata = info?.pointee.rdata, let msg = rdata.pointee.msg_info.msg, let msgBody = msg.pointee.body,
           let data = msgBody.pointee.data, msgBody.pointee.len > 0 {
            body = String(decoding: UnsafeRawBufferPointer(start: data, count: Int(msgBody.pointee.len)), as: UTF8.self)
        }
        let voicemail = VoicemailInfo.parse(body: body)
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.delegate?.sipEngine(self, voicemailDidChange: accountID, info: voicemail)
        }
    }

    fileprivate func handleTransferStatus(callID: pjsua_call_id, code: Int32, isFinal: Bool) -> Bool {
        guard let context = calls[callID], context.isTransferring else { return true }
        // Some PBXs send a successful sipfrag before terminating the subscription.
        let finished = code >= 200 || isFinal
        let succeeded = (200..<300).contains(code)
        let peer = context.transferPeer
        context.isTransferring = !finished
        context.transferStatus = finished ? (succeeded ? "Transfer completed" : "Transfer failed. Your call is still connected.") : "Transferring…"
        if finished { context.transferPeer = nil }
        let message = context.transferStatus ?? ""
        emitCallChanged(context)
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.delegate?.sipEngine(self, transferStatusDidChange: Int(callID), code: Int(code), text: message, isFinal: finished)
        }
        if succeeded {
            // Capture identity before any asynchronous hangup; PJSIP reuses numeric IDs.
            hangup(snapshot(context))
            if let peer { hangup(peer) }
        }
        return finished
    }

    fileprivate func handleTransportState(transport: UnsafeMutablePointer<pjsip_transport>?,
                                          state: pjsip_transport_state,
                                          info: UnsafePointer<pjsip_transport_state_info>?) {
        guard let info, let transport else { return }
        let status = sipper_transport_state_status(info)
        if state == PJSIP_TP_STATE_DISCONNECTED, !status.isSuccess {
            let name = transport.pointee.type_name.map { String(cString: $0) } ?? "transport"
            let message = pjErrorMessage(status)
            lastTransportError = ("\(name): \(message)", Date())
            log.append("Sipper: \(name) transport disconnected: \(message)")
        }
    }

    // MARK: Ringback

    private func startRingback(for context: CallContext) {
        guard !context.ringbackActive, let ringback else { return }
        ringback.start()
        context.ringbackActive = true
    }

    private func stopRingback(for context: CallContext) {
        guard context.ringbackActive else { return }
        context.ringbackActive = false
        let stillNeeded = calls.values.contains { $0.ringbackActive }
        if !stillNeeded {
            ringback?.stop()
        }
    }

    // MARK: Emitting

    private func snapshot(_ context: CallContext) -> CallSnapshot {
        CallSnapshot(id: Int(context.callID),
                     accountID: context.accountID,
                     direction: context.direction,
                     state: context.state,
                     remoteURI: context.remoteURI,
                     remoteNumber: context.remoteNumber,
                     remoteName: context.remoteName,
                     isMuted: context.isMuted,
                     isOnHold: context.isOnHold,
                     isRemoteHold: context.isRemoteHold,
                     hasActiveMedia: context.hasActiveMedia,
                     isRecording: context.recorderID >= 0,
                     startedAt: context.startedAt,
                     connectedAt: context.connectedAt,
                     endedAt: context.endedAt,
                     lastStatusCode: context.lastCode,
                     lastStatusText: context.lastText,
                     gatewayCallID: context.gatewayCallID,
                     managedAccount: context.managedAccount,
                     isTransferring: context.isTransferring,
                     transferStatus: context.transferStatus,
                     conferenceID: context.conferenceID)
    }

    private func emitCallChanged(_ context: CallContext) {
        let snapshot = snapshot(context)
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.delegate?.sipEngine(self, callDidChange: snapshot)
        }
    }

    private func emitCallEnded(_ context: CallContext) {
        let snapshot = snapshot(context)
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.delegate?.sipEngine(self, callDidEnd: snapshot)
        }
    }

    private func emitRegistration(_ accountID: UUID, _ state: RegistrationState) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.delegate?.sipEngine(self, registrationDidChange: accountID, state: state)
        }
    }
}

// MARK: - Call bookkeeping (engine thread only)

private struct PendingHold {
    let onHold: Bool
    var continuation: CheckedContinuation<Void, Error>?
    let deadline = ContinuousClock.now.advanced(by: .seconds(4))
    var sequence: Int32?
    var accepted = false
}

private final class CallContext {
    let callID: pjsua_call_id
    let accountID: UUID
    let direction: CallDirection
    var remoteURI = ""
    var remoteNumber = ""
    var remoteName = ""
    var gatewayCallID: UUID?
    var managedAccount: ManagedAccountBinding?
    var state: CallState
    var isMuted = false
    var isRemoteHold = false
    var hasActiveMedia = false
    var mediaStatus: pjsua_call_media_status = PJSUA_CALL_MEDIA_NONE
    var confSlot: pjsua_conf_port_id = -1
    var recorderID: pjsua_recorder_id = -1
    var recorderSlot: pjsua_conf_port_id = -1
    var startedAt = Date()
    var connectedAt: Date?
    var endedAt: Date?
    var lastCode = 0
    var lastText = ""
    var hangupCode = 0
    var ringbackActive = false
    var isTransferring = false
    var transferStatus: String?
    var conferenceID: UUID?
    var transferPeer: CallSnapshot?
    var pendingHold: PendingHold?
    // Both parties holding produces NONE. This flag changes only after SIP acceptance and negotiated inactive media.
    var confirmedHold = false
    var isOnHold: Bool { mediaStatus == PJSUA_CALL_MEDIA_LOCAL_HOLD || (confirmedHold && mediaStatus == PJSUA_CALL_MEDIA_NONE) }

    init(callID: pjsua_call_id, accountID: UUID, direction: CallDirection) {
        self.callID = callID
        self.accountID = accountID
        self.direction = direction
        self.state = direction == .outgoing ? .calling : .incoming
    }
}

// MARK: - Ringback tone (engine thread only)

/// Generates a UK-style ringback (400 + 450 Hz) into the conference bridge while an
/// outgoing call rings without early media.
private final class RingbackTone {
    private var pool: UnsafeMutablePointer<pj_pool_t>?
    private var port: UnsafeMutablePointer<pjmedia_port>?
    private var slot: pjsua_conf_port_id = -1
    private var playing = false

    init?(clockRate: UInt32) {
        guard let pool = pjsua_pool_create("sipper-ringback", 1024, 1024) else { return nil }
        self.pool = pool
        let samplesPerFrame = clockRate * 20 / 1000
        var port: UnsafeMutablePointer<pjmedia_port>?
        guard pjmedia_tonegen_create2(pool, nil, clockRate, 1, samplesPerFrame, 16, 0, &port).isSuccess, let port else {
            pj_pool_release(pool)
            return nil
        }
        self.port = port
        var slot: pjsua_conf_port_id = -1
        guard pjsua_conf_add_port(pool, port, &slot).isSuccess else {
            pjmedia_port_destroy(port)
            pj_pool_release(pool)
            return nil
        }
        self.slot = slot
    }

    func start() {
        guard !playing, let port else { return }
        var tones = [
            pjmedia_tone_desc(freq1: 400, freq2: 450, on_msec: 400, off_msec: 200, volume: 0, flags: 0),
            pjmedia_tone_desc(freq1: 400, freq2: 450, on_msec: 400, off_msec: 2000, volume: 0, flags: 0),
        ]
        let status = tones.withUnsafeMutableBufferPointer {
            pjmedia_tonegen_play(port, UInt32($0.count), $0.baseAddress, UInt32(PJMEDIA_TONEGEN_LOOP))
        }
        guard status.isSuccess else { return }
        pjsua_conf_connect(slot, 0)
        playing = true
    }

    func stop() {
        guard playing, let port else { return }
        pjsua_conf_disconnect(slot, 0)
        pjmedia_tonegen_rewind(port)
        pjmedia_tonegen_stop(port)
        playing = false
    }

    deinit {
        if slot >= 0 { pjsua_conf_remove_port(slot) }
        if let port { pjmedia_port_destroy(port) }
        if let pool { pj_pool_release(pool) }
    }
}

// MARK: - Engine thread

/// A thread with a work queue. `onIdle` runs between work items and returns false
/// when there is nothing to pump, in which case the thread waits for work.
final class EngineThread: Thread {
    private let condition = NSCondition()
    private var queue: [() -> Void] = []
    private var stopped = false

    var onIdle: (() -> Bool)?

    override func main() {
        while !stopped {
            var item: (() -> Void)?
            condition.lock()
            if !queue.isEmpty {
                item = queue.removeFirst()
            }
            condition.unlock()

            if let item {
                item()
                continue
            }

            let pumped = onIdle?() ?? false
            if !pumped {
                condition.lock()
                if queue.isEmpty && !stopped {
                    condition.wait(until: Date().addingTimeInterval(0.1))
                }
                condition.unlock()
            }
        }
    }

    override func cancel() {
        condition.lock()
        stopped = true
        condition.broadcast()
        condition.unlock()
        super.cancel()
    }

    func async(_ block: @escaping () -> Void) {
        condition.lock()
        queue.append(block)
        condition.broadcast()
        condition.unlock()
    }

    func sync<T>(_ block: @escaping () -> T) -> T {
        if Thread.current === self {
            return block()
        }
        var result: T?
        let semaphore = DispatchSemaphore(value: 0)
        async {
            result = block()
            semaphore.signal()
        }
        semaphore.wait()
        return result!
    }

    func sync<T>(_ block: @escaping () throws -> T) throws -> T {
        if Thread.current === self {
            return try block()
        }
        var result: Result<T, Error>?
        let semaphore = DispatchSemaphore(value: 0)
        async {
            result = Result { try block() }
            semaphore.signal()
        }
        semaphore.wait()
        return try result!.get()
    }
}
