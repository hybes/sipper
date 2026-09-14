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
    private var calls: [pjsua_call_id: CallContext] = [:]
    private var transports: [SIPTransport: pjsua_transport_id] = [:]
    private var ringback: RingbackTone?
    private var stunServers: [String] = []
    private var lastTransportError: (message: String, at: Date)?

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
        thread.onIdle = { [weak self] in
            guard let self, self.running else { return false }
            pjsua_handle_events(20)
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

        cfg.cb.on_incoming_call = { accID, callID, _ in
            SIPEngine.current?.handleIncomingCall(accID: accID, callID: callID)
        }
        cfg.cb.on_call_state = { callID, _ in
            SIPEngine.current?.handleCallState(callID: callID)
        }
        cfg.cb.on_call_media_state = { callID in
            SIPEngine.current?.handleCallMediaState(callID: callID)
        }
        cfg.cb.on_reg_state2 = { accID, info in
            SIPEngine.current?.handleRegistrationState(accID: accID, info: info)
        }
        cfg.cb.on_mwi_info = { accID, info in
            SIPEngine.current?.handleMWI(accID: accID, info: info)
        }
        cfg.cb.on_call_transfer_status = { callID, code, text, isFinal, _ in
            SIPEngine.current?.handleTransferStatus(callID: callID, code: code, text: text?.pointee.string ?? "", isFinal: isFinal != 0)
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
        mediaCfg.snd_auto_close_time = 1
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
        applyAudioDevices(input: settings.inputDeviceName, output: settings.outputDeviceName)
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
        var config = pjsua_transport_config()
        pjsua_transport_config_default(&config)
        config.port = UInt32(max(0, port))
        if transport == .tls {
            config.tls_setting.verify_server = settings.verifyTLSCertificates ? 1 : 0
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

    private func syncAccountsOnEngineThread(_ accounts: [(account: SIPAccount, password: String)]) {
        guard running else { return }
        let wanted = Dictionary(uniqueKeysWithValues: accounts.map { ($0.account.id, $0) })

        for id in Array(accountIDs.keys) where wanted[id] == nil {
            removeAccountOnEngineThread(id)
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
                if existing.0 != entry.account || existing.1 != entry.password {
                    modifyAccountOnEngineThread(entry.account, password: entry.password)
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

        cfg.cred_count = 1
        withUnsafeMutablePointer(to: &cfg.cred_info) { tuple in
            tuple.withMemoryRebound(to: pjsip_cred_info.self, capacity: 8) { creds in
                creds[0].realm = pool.pj("*")
                creds[0].scheme = pool.pj("digest")
                creds[0].username = pool.pj(account.effectiveAuthUsername)
                creds[0].data_type = Int32(PJSIP_CRED_DATA_PLAIN_PASSWD.rawValue)
                creds[0].data = pool.pj(password)
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
        cfg.srtp_secure_signaling = 0

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
        emitRegistration(id, .unregistered)
    }

    /// Forces a fresh REGISTER (or un-REGISTER) for one account.
    func setRegistration(accountID: UUID, enabled: Bool) {
        thread.async {
            guard let accID = self.accountIDs[accountID] else { return }
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
            for accID in self.accountIDs.values {
                pjsua_acc_set_registration(accID, 1)
            }
        }
    }

    // MARK: Calls

    @discardableResult
    func makeCall(accountID: UUID, uri: String) throws -> CallSnapshot {
        try thread.sync {
            guard self.running else { throw SIPEngineError.notRunning }
            guard let accID = self.accountIDs[accountID] else { throw SIPEngineError.unknownAccount }
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
            guard self.calls[pjsua_call_id(callID)] != nil else { return }
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

    func hangupAll() {
        thread.async { pjsua_call_hangup_all() }
    }

    func setHold(callID: Int, onHold: Bool) {
        thread.async {
            guard let context = self.calls[pjsua_call_id(callID)] else { return }
            context.holdRequested = onHold
            let status: pj_status_t
            if onHold {
                status = pjsua_call_set_hold2(pjsua_call_id(callID), 0, nil)
            } else {
                var setting = pjsua_call_setting()
                pjsua_call_setting_default(&setting)
                setting.aud_cnt = 1
                setting.vid_cnt = 0
                setting.flag |= UInt32(PJSUA_CALL_UNHOLD.rawValue)
                status = pjsua_call_reinvite2(pjsua_call_id(callID), &setting, nil)
            }
            if !status.isSuccess {
                self.log.append("Sipper: hold change for call \(callID) failed: \(pjErrorMessage(status))")
            }
            self.emitCallChanged(context)
        }
    }

    func setMuted(callID: Int, muted: Bool) {
        thread.async {
            guard let context = self.calls[pjsua_call_id(callID)] else { return }
            context.isMuted = muted
            self.applyMediaWiring(context)
            self.emitCallChanged(context)
        }
    }

    func sendDTMF(callID: Int, digits: String) {
        thread.async {
            guard self.calls[pjsua_call_id(callID)] != nil else { return }
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

    func transfer(callID: Int, to uri: String) throws {
        try thread.sync {
            guard self.calls[pjsua_call_id(callID)] != nil else { throw SIPEngineError.unknownCall }
            let pool = CStringPool()
            var dest = pool.pj(uri)
            guard pjsua_verify_sip_url(dest.ptr).isSuccess else { throw SIPEngineError.invalidURI(uri) }
            try pjCheck(pjsua_call_xfer(pjsua_call_id(callID), &dest, nil), "pjsua_call_xfer")
        }
    }

    func attendedTransfer(callID: Int, toCallID otherCallID: Int) throws {
        try thread.sync {
            guard self.calls[pjsua_call_id(callID)] != nil, self.calls[pjsua_call_id(otherCallID)] != nil else {
                throw SIPEngineError.unknownCall
            }
            try pjCheck(pjsua_call_xfer_replaces(pjsua_call_id(callID), pjsua_call_id(otherCallID), 0, nil), "pjsua_call_xfer_replaces")
        }
    }

    func activeCalls() -> [CallSnapshot] {
        thread.sync { self.calls.values.filter { $0.state != .disconnected }.map { self.snapshot($0) } }
    }

    // MARK: Audio and codecs

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

    fileprivate func handleIncomingCall(accID: pjsua_acc_id, callID: pjsua_call_id) {
        guard let accountID = accountsByPJ[accID] else {
            pjsua_call_hangup(callID, 480, nil, nil)
            return
        }
        var info = pjsua_call_info()
        guard pjsua_call_get_info(callID, &info).isSuccess else {
            pjsua_call_hangup(callID, 500, nil, nil)
            return
        }
        let context = CallContext(callID: callID, accountID: accountID, direction: .incoming)
        let address = SIPAddress.parse(info.remote_info.string)
        context.remoteURI = address.uri
        context.remoteNumber = address.user.isEmpty ? address.host : address.user
        context.remoteName = address.displayName
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
            destroyRecorder(context)
            calls[callID] = nil
            emitCallEnded(context)
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
        if info.media_status == PJSUA_CALL_MEDIA_LOCAL_HOLD {
            context.holdRequested = true
        } else if info.media_status == PJSUA_CALL_MEDIA_ACTIVE {
            context.holdRequested = false
        }
        if context.hasActiveMedia {
            stopRingback(for: context)
        }
        applyMediaWiring(context)
        emitCallChanged(context)
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
        }
        pjsua_recorder_destroy(context.recorderID)
        context.recorderID = -1
        context.recorderSlot = -1
    }

    fileprivate func handleRegistrationState(accID: pjsua_acc_id, info: UnsafeMutablePointer<pjsua_reg_info>?) {
        guard let accountID = accountsByPJ[accID] else { return }
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
        emitRegistration(accountID, state)
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

    fileprivate func handleTransferStatus(callID: pjsua_call_id, code: Int32, text: String, isFinal: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.delegate?.sipEngine(self, transferStatusDidChange: Int(callID), code: Int(code), text: text, isFinal: isFinal)
        }
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
                     isOnHold: context.holdRequested || context.mediaStatus == PJSUA_CALL_MEDIA_LOCAL_HOLD,
                     isRemoteHold: context.isRemoteHold,
                     hasActiveMedia: context.hasActiveMedia,
                     isRecording: context.recorderID >= 0,
                     startedAt: context.startedAt,
                     connectedAt: context.connectedAt,
                     endedAt: context.endedAt,
                     lastStatusCode: context.lastCode,
                     lastStatusText: context.lastText)
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

private final class CallContext {
    let callID: pjsua_call_id
    let accountID: UUID
    let direction: CallDirection
    var remoteURI = ""
    var remoteNumber = ""
    var remoteName = ""
    var state: CallState
    var isMuted = false
    var holdRequested = false
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
