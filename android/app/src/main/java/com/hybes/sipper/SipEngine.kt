package com.hybes.sipper

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.util.Base64
import kotlinx.coroutines.android.asCoroutineDispatcher
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.CancellationException
import org.pjsip.pjsua2.*
import java.io.File
import java.security.KeyStore
import java.util.UUID

/** All PJSUA2 objects and callbacks live on this one registered native thread. */
class SipEngine(private val context: Context, private val silentAudio: Boolean = false) {
    private val thread = HandlerThread("Sipper SIP").apply { start() }
    private val handler = Handler(thread.looper)
    private val dispatcher = handler.asCoroutineDispatcher("Sipper SIP")
    private lateinit var endpoint: Endpoint
    private var running = false
    private var desired = emptyMap<String, SipAccount>()
    private val installed = mutableMapOf<String, NativeAccount>()
    private val nativeCalls = mutableMapOf<String, NativeCall>()
    private val transports = mutableMapOf<String, Int>()
    private val _registrations = MutableStateFlow<Map<String, Registration>>(emptyMap())
    val registrations = _registrations.asStateFlow()
    private val _calls = MutableStateFlow<List<PhoneCall>>(emptyList())
    val calls = _calls.asStateFlow()
    private val _error = MutableStateFlow<String?>(null)
    val error = _error.asStateFlow()
    private var testCertificate: File? = null
    private var audioEnabled = false
    private var conferenceChange: String? = null
    private var lastExpiryCheck = 0L
    private var stunServers = emptyList<String>()
    private var networkAvailable = true
    private val awaitingRegistration = mutableSetOf<String>()
    private var testLogWriter: LogWriter? = null
    private val testNetworkEvents = ArrayDeque<String>()
    var onEnded: ((PhoneCall) -> Unit)? = null

    // Instrumentation supplies a one-use CA, never a skip-verification flag.
    internal suspend fun trustTestCertificate(file: File) = withContext(dispatcher) {
        check(BuildConfig.DEBUG && !running && silentAudio)
        testCertificate = file
    }
    internal data class MediaStats(val codec: String, val sent: Long, val received: Long)
    internal fun networkEventsForTest(clear: Boolean = false): List<String> {
        check(BuildConfig.DEBUG && silentAudio)
        return synchronized(testNetworkEvents) { testNetworkEvents.toList().also { if (clear) testNetworkEvents.clear() } }
    }
    internal suspend fun testMediaTransport(token: String): String = work {
        check(BuildConfig.DEBUG && silentAudio)
        // Keep addresses, SIP messages and key material out of test diagnostics.
        nativeCalls[token]?.dump(true, "")?.lineSequence()?.map { it.trim() }?.filter {
            it.startsWith("SRTP status:") || it.startsWith("ICE role:")
        }?.joinToString("; ") ?: "Call ended"
    }
    internal suspend fun mediaStats(token: String): MediaStats? = work {
        check(BuildConfig.DEBUG && silentAudio)
        val call = nativeCalls[token] ?: error("Call ended")
        val info = call.info
        try {
            // SIP confirmation can precede media establishment (for example ICE).
            val media = (0 until info.media.size).map { info.media[it] }.firstOrNull {
                it.type == pjmedia_type.PJMEDIA_TYPE_AUDIO && it.status == pjsua_call_media_status.PJSUA_CALL_MEDIA_ACTIVE
            } ?: return@work null
            val stats = call.getStreamStat(media.index)
            val stream = call.getStreamInfo(media.index)
            try { MediaStats(stream.codecName, stats.rtcp.txStat.pkt, stats.rtcp.rxStat.pkt) }
            finally { stream.delete(); stats.delete() }
        } finally { info.delete() }
    }
    internal suspend fun receivedLevelForTest(token: String): Long? = work {
        check(BuildConfig.DEBUG && silentAudio)
        val call = nativeCalls[token] ?: return@work null
        // PJSUA2 Tx is from this media port into the bridge: decoded remote audio, not local egress.
        audioMedia(call)?.let { audio -> try { audio.txLevel } finally { audio.delete() } }
    }
    suspend fun start() = withContext(dispatcher) {
        if (running) return@withContext
        System.loadLibrary("pjsua2")
        endpoint = Endpoint()
        try {
            endpoint.libCreate()
            val config = EpConfig()
            try {
                config.uaConfig.threadCnt = 0
                config.uaConfig.mainThreadOnly = true
                config.uaConfig.userAgent = "Sipper/${BuildConfig.VERSION_NAME} (Android)"
                // STUN/ICE work without a separate NAT-classification probe or diagnostic SDP field.
                config.uaConfig.natTypeInSdp = 0
                config.logConfig.level = 0
                config.logConfig.consoleLevel = 0
                if (BuildConfig.DEBUG && silentAudio) {
                    // Retain only fixed test milestones, never SIP messages, addresses or keys.
                    testLogWriter = object : LogWriter() {
                        override fun write(entry: LogEntry) {
                            val text = entry.msg
                            val event = when {
                                text.contains("send re-INVITE") && text.contains("triggered by IP change") -> "offer"
                                text.contains("SDP negotiation done: Success") -> "negotiated"
                                text.contains("TX ") && text.contains("Request msg REGISTER") ->
                                    if (text.lineSequence().any { it.trim() == "Expires: 0" }) "unregister" else "register"
                                else -> return
                            }
                            synchronized(testNetworkEvents) {
                                testNetworkEvents.addLast(event)
                                if (testNetworkEvents.size > 64) testNetworkEvents.removeFirst()
                            }
                        }
                    }.also { it.swigReleaseOwnership() } // Endpoint owns and deletes the writer.
                    config.logConfig.writer = testLogWriter
                    config.logConfig.level = 4
                    config.logConfig.consoleLevel = 4 // Routed exclusively to the sanitising writer.
                }
                config.medConfig.hasIoqueue = true
                if (silentAudio) config.medConfig.noVad = true
                endpoint.libInit(config)
            } finally { config.delete() }
            // Never open the microphone simply because an account is registered.
            endpoint.audDevManager().setNullDev()
            endpoint.libStart()
            endpoint.codecEnum2().also { codecs ->
                for (i in 0 until codecs.size) {
                    val codec = codecs[i]
                    endpoint.codecSetPriority(codec.codecId, when {
                        codec.codecId.startsWith("opus/") -> 255
                        codec.codecId.startsWith("G722/") -> 240
                        codec.codecId.startsWith("PCMU/") -> 220
                        codec.codecId.startsWith("PCMA/") -> 210
                        else -> 0
                    }.toShort())
                }
                codecs.delete()
            }
            running = true
            handler.post(poll)
        } catch (error: Throwable) {
            runCatching { endpoint.libDestroy() }; endpoint.delete()
            throw error
        }
    }
    private val poll = object : Runnable {
        override fun run() {
            if (!running) return
            try {
                endpoint.libHandleEvents(10)
                if (System.currentTimeMillis() - lastExpiryCheck >= 250) {
                    lastExpiryCheck = System.currentTimeMillis()
                    reconcile()
                }
            } catch (_: Exception) { _error.value = "The calling engine encountered an error. Check your account connection." }
            handler.postDelayed(this, 15)
        }
    }
    private suspend fun <T> work(block: () -> T): T = withContext(dispatcher) {
        check(running) { "The calling engine is unavailable." }
        block()
    }
    suspend fun sync(accounts: List<SipAccount>) = work {
        require(accounts.size <= 32 && accounts.map { it.id }.toSet().size == accounts.size)
        require(accounts.filter { it.usable() }.map { it.stunServer }.filter { it.isNotEmpty() }.distinct().size <= 8) { "Sipper supports up to eight different STUN servers." }
        accounts.forEach { it.validate() }
        desired = accounts.associateBy { it.id }
        reconcile()
    }
    suspend fun hasApplied(accounts: List<SipAccount>): Boolean = work {
        accounts.all { expected -> installed[expected.id]?.let { admitted(it) && it.settings == expected } == true }
    }
    suspend fun registration(id: String): Registration = work { installed[id]?.let(::registrationOf) ?: Registration() }
    internal suspend fun codecs(): List<String> = work {
        val values = endpoint.codecEnum2()
        try { List(values.size) { values[it].codecId } } finally { values.delete() }
    }
    private fun admitted(account: NativeAccount) = !account.withdrawing && account.settings.usable() && desired[account.settings.id] == account.settings
    private fun reconcile() {
        for ((id, account) in installed.toMap()) {
            val next = desired[id]?.takeIf { it.usable() }
            if (next != null && account.settings.copy(label = next.label, expiresAt = next.expiresAt, voicemailNumber = next.voicemailNumber, managedDoNotDisturb = next.managedDoNotDisturb) == next) {
                // Lease, label and incoming-policy changes keep the existing registration and calls.
                if (account.withdrawing) {
                    val config = configuration(next)
                    try { account.modify(config); account.withdrawing = false } finally { config.delete() }
                }
                account.settings = next
                continue
            }
            if (!account.withdrawing) {
                // Removing the registrar also prevents automatic IP-change handling from reviving it.
                // Keep this account object for its established dialogs until they finish.
                val config = configuration(account.settings).apply {
                    regConfig.registrarUri = ""; regConfig.registerOnAdd = false
                }
                try { account.modify(config) } finally { config.delete() }
                account.withdrawing = true
                // Revocation/expiry preserves established calls, never ringing calls or new calls.
                nativeCalls.values.filter { it.account === account && !it.connected }.forEach { call ->
                    val parameter = CallOpParam().apply { statusCode = 480 }
                    try { call.hangup(parameter) } finally { parameter.delete() }
                }
            }
            if (nativeCalls.values.any { it.account === account }) continue
            account.shutdown(); account.delete(); installed.remove(id)
            awaitingRegistration.remove(id)
            _registrations.value = _registrations.value - id
        }
        val servers = (desired.values.filter { it.usable() } + nativeCalls.values.filter { it.connected && !it.ending }.map { it.account.settings })
            .map { it.stunServer }.filter { it.isNotEmpty() }.distinct().sorted()
        check(servers.size <= 8) { "Finish existing calls before changing more STUN servers." }
        if (servers != stunServers) {
            val values = StringVector()
            try { servers.forEach(values::add); endpoint.natUpdateStunServers(values, false); stunServers = servers }
            finally { values.delete() }
        }
        for ((id, settings) in desired) {
            if (!settings.usable() || installed.containsKey(id)) continue
            val account = NativeAccount(settings)
            val config = configuration(settings)
            try { account.create(config); installed[id] = account }
            catch (error: Exception) { account.delete(); _registrations.value = _registrations.value + (id to Registration("failed")); throw error }
            finally { config.delete() }
        }
    }
    private fun configuration(a: SipAccount): AccountConfig = AccountConfig().apply {
        idUri = a.identityUri
        val server = a.uriHost(a.host) + ":" + (a.port ?: if (a.transport == "tls") 5061 else 5060)
        regConfig.registrarUri = "sip:$server;transport=${a.transport}"
        regConfig.timeoutSec = 300
        sipConfig.proxies.add("sip:$server;transport=${a.transport};lr")
        sipConfig.transportId = transport(a.transport, a.host.contains(':'))
        val credential = AuthCredInfo("digest", "*", a.authUsername.ifBlank { a.username }, 0, a.password)
        sipConfig.authCreds.add(credential); credential.delete()
        mediaConfig.srtpUse = when (a.srtp) { "required" -> 2; "optional" -> 1; else -> 0 }
        mediaConfig.srtpSecureSignaling = if (a.srtp == "required" && a.transport == "tls") 1 else 0
        natConfig.iceEnabled = a.ice
        natConfig.sipStunUse = if (a.stunServer.isEmpty()) pjsua_stun_use.PJSUA_STUN_USE_DISABLED else pjsua_stun_use.PJSUA_STUN_USE_DEFAULT
        natConfig.mediaStunUse = natConfig.sipStunUse
        ipChangeConfig.hangupCalls = false
        videoConfig.autoShowIncoming = false
        videoConfig.autoTransmitOutgoing = false
    }
    suspend fun networkChanged(available: Boolean = true) = work {
        networkAvailable = available
        awaitingRegistration.clear()
        awaitingRegistration.addAll(installed.filterValues(::admitted).keys)
        _registrations.value = installed.mapValues { registrationOf(it.value) }
        reconcile() // Withdraw expired/revoked accounts before PJSIP considers re-registration.
        _registrations.value = installed.mapValues { registrationOf(it.value) }
        if (!available) return@work
        if (installed.isNotEmpty()) {
            val parameter = IpChangeParam()
            try { endpoint.handleIpChange(parameter) } finally { parameter.delete() }
        }
    }
    internal suspend fun refreshRegistration(accountId: String) = work {
        val account = installed[accountId] ?: error("This calling account is unavailable.")
        check(admitted(account)) { "This calling account is no longer available." }
        check(networkAvailable) { "No network connection" }
        // Fresh provisioning may already have sent REGISTER. Share that transaction.
        if (!account.registrationPending) account.setRegistration(true)
    }
    private fun transport(protocol: String, ipv6: Boolean): Int = transports.getOrPut("$protocol:$ipv6") {
        val config = TransportConfig()
        try {
            config.port = 0
            if (protocol == "tls") {
                config.tlsConfig.caListFile = (if (BuildConfig.DEBUG) testCertificate ?: systemRoots() else systemRoots()).absolutePath
                config.tlsConfig.verifyServer = true
                config.tlsConfig.proto = (pj_ssl_sock_proto.PJ_SSL_SOCK_PROTO_TLS1_2 or pj_ssl_sock_proto.PJ_SSL_SOCK_PROTO_TLS1_3).toLong()
            }
            val type = when (protocol) {
                "tls" -> if (ipv6) pjsip_transport_type_e.PJSIP_TRANSPORT_TLS6 else pjsip_transport_type_e.PJSIP_TRANSPORT_TLS
                "tcp" -> if (ipv6) pjsip_transport_type_e.PJSIP_TRANSPORT_TCP6 else pjsip_transport_type_e.PJSIP_TRANSPORT_TCP
                else -> if (ipv6) pjsip_transport_type_e.PJSIP_TRANSPORT_UDP6 else pjsip_transport_type_e.PJSIP_TRANSPORT_UDP
            }
            endpoint.transportCreate(type, config)
        } finally { config.delete() }
    }
    private fun systemRoots(): File {
        val store = KeyStore.getInstance("AndroidCAStore").apply { load(null) }
        val pem = buildString {
            for (alias in store.aliases().toList().filter { it.startsWith("system:") }) {
                val certificate = store.getCertificate(alias) ?: continue
                append("-----BEGIN CERTIFICATE-----\n")
                append(Base64.encodeToString(certificate.encoded, Base64.NO_WRAP).chunked(64).joinToString("\n"))
                append("\n-----END CERTIFICATE-----\n")
            }
        }
        check(pem.isNotEmpty()) { "The system certificate store is unavailable." }
        return File(context.noBackupFilesDir, "sip-system-roots.pem").apply { writeText(pem) }
    }
    private fun callingAccount(accountId: String): NativeAccount {
        val account = installed[accountId] ?: error("Choose an available calling account.")
        check(admitted(account)) { "This calling account is no longer available." }
        return account
    }
    internal suspend fun validateDial(accountId: String, raw: String) = work { dialDestination(raw, callingAccount(accountId).settings); Unit }
    suspend fun dial(accountId: String, raw: String): String = work {
        check(conferenceChange == null && nativeCalls.values.none { it.pendingHold != null }) { "The call is still updating. Try again." }
        val account = callingAccount(accountId)
        val destination = dialDestination(raw, account.settings)
        val call = NativeCall(account, -1, false)
        call.destination = raw.trim()
        nativeCalls[call.token] = call
        val parameter = CallOpParam(true).apply { opt.audioCount = 1; opt.videoCount = 0 }
        try { call.makeCall(destination, parameter); update(call); call.token }
        catch (error: Exception) { nativeCalls.remove(call.token); call.delete(); throw error }
        finally { parameter.delete() }
    }
    suspend fun answer(token: String) = work {
        check(conferenceChange == null && nativeCalls.values.none { it.pendingHold != null }) { "The call is still updating. Try again." }
        val call = nativeCalls[token] ?: error("This call has ended.")
        check(admitted(call.account)) { "This calling account is no longer available." }
        val parameter = CallOpParam(true).apply { statusCode = 200; opt.audioCount = 1; opt.videoCount = 0 }
        try { call.answer(parameter) } finally { parameter.delete() }
    }
    internal suspend fun verifiedCaller(token: String, label: String, number: String?): String? = work {
        require(label.length in 1..160 && label.none(Char::isISOControl))
        val call = nativeCalls[token] ?: return@work null
        check(call.gatewayId != null)
        call.remoteLabel = label
        call.destination = number?.takeIf { runCatching { dialDestination(it, call.account.settings) }.isSuccess }
        update(call)
        call.destination
    }
    suspend fun hangup(token: String, reference: String? = null) = work {
        nativeCalls[token]?.let { call ->
            check(reference == null || call.conferenceId == reference) { "This conference is no longer available." }
            val parameter = CallOpParam().apply { statusCode = if (call.incoming && !call.connected) 603 else 0 }
            try { call.hangup(parameter) } finally { parameter.delete() }
        }
    }
    suspend fun hold(token: String, held: Boolean, presentation: String? = null) {
        val reference = work {
            val call = nativeCalls[token] ?: error("This call has ended.")
            requirePresentation(call, presentation)
            call.conferenceId
        }
        if (reference != null) conferenceHold(token, reference, held) else holdLeg(token, held, presentation = presentation)
    }
    private fun requirePresentation(call: NativeCall, presentation: String?) {
        check(presentation == null || presentation == (call.conferenceId?.let { "conference:$it" } ?: call.token)) {
            "This call has changed. Check the current call controls."
        }
    }
    private suspend fun holdLeg(token: String, held: Boolean, operation: String? = null, presentation: String? = null) = withTimeoutOrNull(4000) {
        var result: CompletableDeferred<Unit>? = null
        while (result == null) {
            result = work {
                val call = nativeCalls[token]?.takeUnless { it.ending } ?: error("This call has ended.")
                requirePresentation(call, presentation)
                check(call.connected && !call.transferring && nativeCalls.values.none { it.transferPeer === call }) { "The call is not available to hold." }
                check((conferenceChange == null || conferenceChange == operation) &&
                    (call.conferenceId == null || call.conferenceId == operation)) { "The conference is still updating. Try again." }
                check(call.pendingHold == null && (held || nativeCalls.values.none { it.pendingHold != null })) { "The call is still updating. Try again." }
                if (if (held) call.held else !call.held && call.negotiatedUnheld) return@work CompletableDeferred<Unit>().apply { complete(Unit) }
                val pending = PendingHold(held)
                call.pendingHold = pending
                val parameter = CallOpParam(true)
                try {
                    connectAudio(call)
                    if (held) call.setHold(parameter)
                    else { parameter.opt.flag = pjsua_call_flag.PJSUA_CALL_UNHOLD.toLong(); call.reinvite(parameter) }
                    pending.result
                } catch (failure: Exception) {
                    if (call.pendingHold === pending) call.pendingHold = null
                    runCatching { connectAudio(call) }
                    // Yield while an earlier ICE offer finishes, within Telecom's callback limit.
                    if (failure.message?.contains("(PJ_EINVALIDOP)") != true) throw failure
                    null
                } finally { parameter.delete() }
            }
            if (result == null) delay(50)
        }
        result.await()
        // A timed-out request stays fenced until its late transaction/media result or hang-up.
    } ?: error("The phone system did not confirm the hold change. Check the call and try again.")
    private fun finishHold(call: NativeCall, failure: Exception? = null) {
        val pending = call.pendingHold ?: return
        if (failure == null && (!pending.accepted || !(if (pending.held) call.held || call.mediaInactive else call.negotiatedUnheld))) return
        call.pendingHold = null
        runCatching { connectAudio(call) }.onFailure { _error.value = "Call audio could not be restored. Check the participants before continuing." }
        if (failure == null) {
            call.confirmedHold = pending.held
            update(call)
            pending.result.complete(Unit)
        } else pending.result.completeExceptionally(failure)
    }
    suspend fun mute(token: String, muted: Boolean, presentation: String? = null) = work {
        nativeCalls[token]?.let { call ->
            requirePresentation(call, presentation)
            for (member in listOfNotNull(call, conferencePeer(call))) {
                member.muted = muted; connectAudio(member); update(member)
            }
        }
    }
    suspend fun dtmf(token: String, digits: String, reference: String? = null) = work {
        require(digits.matches(Regex("[0-9*#]{1,32}")))
        val call = nativeCalls[token]?.takeUnless { it.ending } ?: error("This call has ended.")
        check(call.connected && !call.held && !call.transferring && call.pendingHold == null && conferenceChange == null && call.conferenceId == reference) {
            "Resume this participant before using the keypad."
        }
        call.dialDtmf(digits)
    }
    private fun conferencePeer(call: NativeCall): NativeCall? = call.conferencePeer?.takeIf {
        call.conferenceId != null && it.conferenceId == call.conferenceId && it.conferencePeer === call &&
            nativeCalls[it.token] === it && it.account === call.account
    }
    private fun requireConference(token: String, reference: String): List<NativeCall> {
        val call = nativeCalls[token]?.takeUnless { it.ending } ?: error("This call has ended.")
        val peer = conferencePeer(call)?.takeUnless { it.ending } ?: error("This conference is no longer available.")
        check(call.conferenceId == reference) { "This conference is no longer available." }
        return listOf(call, peer)
    }
    suspend fun beginConference(token: String, otherToken: String): String = work {
        check(conferenceChange == null) { "The conference is still updating. Try again." }
        val call = transferCall(token); val peer = transferCall(otherToken)
        check(call !== peer && call.account === peer.account) { "Choose two connected calls on the same account." }
        check(!call.held && !peer.held) { "Resume both calls before merging." }
        check(nativeCalls.values.none { it !== call && it !== peer && !it.ending && (it.pendingHold != null || (it.connected && !it.held)) }) {
            "Hold your other calls before merging."
        }
        val audio = audioMedia(call) ?: error("Call audio is not ready yet.")
        val other = audioMedia(peer) ?: run { audio.delete(); error("Call audio is not ready yet.") }
        val originalMute = call.muted to peer.muted
        try {
            audio.startTransmit(other)
            try { other.startTransmit(audio) }
            catch (failure: Exception) { runCatching { audio.stopTransmit(other) }; throw failure }
            val reference = UUID.randomUUID().toString()
            call.conferenceId = reference; peer.conferenceId = reference
            call.conferencePeer = peer; peer.conferencePeer = call
            val muted = call.muted || peer.muted
            call.muted = muted; peer.muted = muted
            connectAudio(call); connectAudio(peer)
            update(call); update(peer)
            reference
        } catch (failure: Exception) {
            breakConference(call)
            call.muted = originalMute.first; peer.muted = originalMute.second
            for (member in listOf(call, peer)) runCatching { connectAudio(member); update(member) }
            throw failure
        } finally { other.delete(); audio.delete() }
    }
    suspend fun conferenceHold(token: String, reference: String, held: Boolean) {
        val members = work {
            check(conferenceChange == null) { "The conference is still updating. Try again." }
            val members = requireConference(token, reference)
            check(members.all { it.pendingHold == null }) { "The call is still updating. Try again." }
            conferenceChange = reference
            members.map { it to it.held }
        }
        val changed = mutableListOf<Pair<NativeCall, Boolean>>()
        try {
            check(withTimeoutOrNull(4000) {
                for ((call, before) in members) if (before != held) {
                    work { requireConference(token, reference) }
                    holdLeg(call.token, held, reference)
                    changed += call to before
                }
                work { requireConference(token, reference) }
                true
            } == true) { "The phone system did not confirm the conference hold change. Check each participant." }
        } catch (failure: Exception) {
            val restored = withContext(NonCancellable) {
                // ponytail: 450 ms rollback budget keeps the whole operation within Telecom's five-second callback; delayed restoration stays fenced and visible.
                runCatching { withTimeoutOrNull(450) {
                    for ((call, before) in changed.asReversed()) {
                        val current = work { nativeCalls[call.token]?.takeIf { it === call && !it.ending && (it.conferenceId == null || it.conferenceId == reference) } }
                        if (current != null) holdLeg(current.token, before, reference)
                    }
                    true
                } }.getOrNull() == true
            }
            if (failure is CancellationException) throw failure
            throw IllegalStateException(if (restored) failure.message else "${failure.message} Some calls could not be restored. Check each participant’s hold status.", failure)
        } finally {
            withContext(NonCancellable) { work { if (conferenceChange == reference) conferenceChange = null } }
        }
    }
    suspend fun splitConference(token: String, reference: String) = work {
        check(conferenceChange == null) { "The conference is still updating. Try again." }
        val members = requireConference(token, reference)
        check(members.all { it.held && it.pendingHold == null }) { "Hold both participants before separating the conference." }
        breakConference(members.first())
        members.forEach { connectAudio(it); update(it) }
    }
    suspend fun hangupConference(token: String, reference: String) = work {
        val members = requireConference(token, reference)
        val parameter = CallOpParam()
        try {
            for (call in members) if (nativeCalls[call.token] === call && !call.ending) call.hangup(parameter)
        } finally { parameter.delete() }
    }
    private fun breakConference(call: NativeCall) {
        val peer = conferencePeer(call)
        val audio = runCatching { audioMedia(call) }.getOrNull()
        val other = peer?.let { runCatching { audioMedia(it) }.getOrNull() }
        try {
            if (audio != null && other != null) {
                runCatching { audio.stopTransmit(other) }; runCatching { other.stopTransmit(audio) }
            }
        } finally { other?.delete(); audio?.delete() }
        call.conferenceId = null; call.conferencePeer = null
        if (peer != null) {
            peer.conferenceId = null; peer.conferencePeer = null
            runCatching { connectAudio(peer); update(peer) }
        }
    }
    private fun transferCall(token: String): NativeCall {
        val call = nativeCalls[token] ?: error("This call has ended.")
        check(!call.ending && call.connected && admitted(call.account)) { "This call is no longer available to transfer." }
        check(!call.transferring && nativeCalls.values.none { it.transferPeer === call }) { "A transfer is already in progress." }
        check(call.conferenceId == null && call.pendingHold == null && conferenceChange == null) { "Separate the conference before transferring a participant." }
        return call
    }
    suspend fun transfer(token: String, target: String) = work {
        val call = transferCall(token)
        val destination = dialDestination(target, call.account.settings)
        call.transferring = true; call.transferStatus = "Transferring…"
        val parameter = CallOpParam()
        try { call.xfer(destination, parameter) }
        catch (failure: Exception) {
            call.transferring = false; call.transferStatus = "Transfer failed. Your call is still connected."
            update(call); throw failure
        } finally { parameter.delete() }
        update(call)
    }
    suspend fun attendedTransfer(token: String, otherToken: String) = work {
        val call = transferCall(token); val peer = transferCall(otherToken)
        check(call !== peer && call.account === peer.account) { "Choose another connected call on the same account." }
        call.transferring = true; call.transferPeer = peer; call.transferStatus = "Transferring…"
        val parameter = CallOpParam()
        try { call.xferReplaces(peer, parameter) }
        catch (failure: Exception) {
            call.transferring = false; call.transferPeer = null
            call.transferStatus = "Transfer failed. Your calls are still connected."
            update(call); throw failure
        } finally { parameter.delete() }
        update(call)
    }
    suspend fun enableAudio(enabled: Boolean) = work {
        audioEnabled = enabled
        if (enabled && !silentAudio) {
            endpoint.audDevManager().setCaptureDev(-1)
            endpoint.audDevManager().setPlaybackDev(-2)
        } else endpoint.audDevManager().setNullDev()
        nativeCalls.values.forEach(::connectAudio)
    }
    suspend fun close() = withContext(dispatcher) {
        if (running) {
            running = false; handler.removeCallbacks(poll)
            nativeCalls.values.toList().forEach {
                val parameter = CallOpParam()
                try { runCatching { it.hangup(parameter) } } finally { parameter.delete() }
            }
            nativeCalls.values.forEach { finishHold(it, IllegalStateException("The calling engine stopped.")); it.delete() }; nativeCalls.clear()
            installed.values.forEach { it.shutdown(); it.delete() }; installed.clear()
            endpoint.libDestroy(); endpoint.delete()
            testLogWriter = null
        }
        thread.quitSafely()
    }
    private fun registrationOf(account: NativeAccount): Registration {
        if (!admitted(account)) return Registration("unregistered")
        if (!networkAvailable) return Registration()
        val info = account.info
        return try {
            val code = info.regStatus.takeIf { it in 100..699 }
            // PJSIP skips permanent failures during recovery, so no new callback
            // may arrive. Keep that failure visible instead of waiting forever.
            when {
                info.regLastErr != 0 || (code ?: 0) >= 300 -> Registration("failed", code)
                account.settings.id in awaitingRegistration -> Registration()
                info.regIsActive && code == 200 -> Registration("registered", code)
                else -> Registration("unregistered", code)
            }
        } finally { info.delete() }
    }
    private fun update(call: NativeCall) {
        val info = call.info
        try {
            call.connected = call.connected || info.state == pjsip_inv_state.PJSIP_INV_STATE_CONFIRMED
            val media = (0 until info.media.size).map { info.media[it] }.filter { it.type == pjmedia_type.PJMEDIA_TYPE_AUDIO }
            call.mediaInactive = media.any { it.status == pjsua_call_media_status.PJSUA_CALL_MEDIA_NONE }
            call.held = media.any { it.status == pjsua_call_media_status.PJSUA_CALL_MEDIA_LOCAL_HOLD } || (call.confirmedHold && call.mediaInactive)
            call.negotiatedUnheld = media.any { it.status == pjsua_call_media_status.PJSUA_CALL_MEDIA_ACTIVE || it.status == pjsua_call_media_status.PJSUA_CALL_MEDIA_REMOTE_HOLD || it.status == pjsua_call_media_status.PJSUA_CALL_MEDIA_NONE }
            val state = when (info.state) {
                pjsip_inv_state.PJSIP_INV_STATE_CONFIRMED -> if (call.held) "On hold" else "Connected"
                pjsip_inv_state.PJSIP_INV_STATE_DISCONNECTED -> "Ended"
                pjsip_inv_state.PJSIP_INV_STATE_INCOMING -> "Incoming call"
                pjsip_inv_state.PJSIP_INV_STATE_EARLY -> "Ringing"
                else -> "Connecting"
            }
            val remote = call.remoteLabel ?: if (call.gatewayId != null) "Incoming managed call" else info.remoteUri.take(256)
            if (call.incoming && call.gatewayId == null && call.destination == null)
                call.destination = incomingDestination(info.remoteUri, call.account.settings)
            val snapshot = PhoneCall(call.token, call.account.settings.id, remote, call.incoming, state, call.connected, call.held, call.muted,
                call.gatewayId, call.destination, call.managedDeviceId, call.accountTitle, call.transferring, call.transferStatus,
                call.conferenceId.takeUnless { state == "Ended" })
            if (!call.rejected) _calls.value = _calls.value.filter { it.id != call.token } + snapshot
            if (state == "Ended" && !call.ending) {
                call.ending = true
                breakConference(call)
                finishHold(call, IllegalStateException("This call has ended."))
                if (!call.rejected) onEnded?.invoke(snapshot)
                handler.post {
                    if (!running) return@post
                    nativeCalls.remove(call.token); call.delete()
                    _calls.value = _calls.value.filter { it.id != call.token }
                    reconcile()
                }
            }
            finishHold(call)
        } finally { info.delete() }
    }
    private fun audioMedia(call: NativeCall): AudioMedia? {
        if (call.ending) return null
        val info = call.info
        try {
            for (index in 0 until info.media.size) {
                val media = info.media[index]
                if (media.type == pjmedia_type.PJMEDIA_TYPE_AUDIO && media.status in listOf(
                    pjsua_call_media_status.PJSUA_CALL_MEDIA_ACTIVE, pjsua_call_media_status.PJSUA_CALL_MEDIA_REMOTE_HOLD)) return call.getAudioMedia(index)
            }
            return null
        } finally { info.delete() }
    }
    private fun connectAudio(call: NativeCall) {
        val audio = audioMedia(call) ?: return
        val peer = conferencePeer(call)
        val other = peer?.let(::audioMedia)
        try {
            val devices = endpoint.audDevManager()
            if (!audioEnabled || call.muted || call.held) runCatching { devices.captureDevMedia.stopTransmit(audio) }
            else devices.captureDevMedia.startTransmit(audio)
            if (audioEnabled && !call.held) audio.startTransmit(devices.playbackDevMedia)
            else runCatching { audio.stopTransmit(devices.playbackDevMedia) }
            if (other != null) {
                if (audioEnabled && !call.held && !peer.held && call.pendingHold == null && peer.pendingHold == null) {
                    audio.startTransmit(other); other.startTransmit(audio)
                } else {
                    runCatching { audio.stopTransmit(other) }; runCatching { other.stopTransmit(audio) }
                }
            }
        } finally { other?.delete(); audio.delete() }
    }
    private inner class NativeAccount(var settings: SipAccount) : Account() {
        var withdrawing = false
        var registrationPending = false
        override fun onRegStarted(parameter: OnRegStartedParam) { registrationPending = true }
        override fun onRegState(parameter: OnRegStateParam) {
            registrationPending = false
            if (!running) return
            awaitingRegistration.remove(settings.id)
            runCatching { _registrations.value = _registrations.value + (settings.id to registrationOf(this)) }
        }
        override fun onIncomingCall(parameter: OnIncomingCallParam) {
            val gateway = settings.managedMode == "gateway"
            val reference = if (gateway) parameter.rdata.let { data -> try { gatewayCallId(data.wholeMsg) } finally { data.delete() } } else null
            val duplicate = gateway && reference != null && nativeCalls.values.any {
                !it.ending && it.account.settings.id == settings.id && it.gatewayId == reference
            }
            val call = NativeCall(this, parameter.callId, true, reference)
            val rejectDnd = settings.managedDeviceId != null && !gateway && settings.managedDoNotDisturb
            call.rejected = !admitted(this) || rejectDnd || (gateway && (reference == null || duplicate))
            nativeCalls[call.token] = call
            if (call.rejected) {
                val response = CallOpParam().apply { statusCode = if (rejectDnd && admitted(this@NativeAccount)) 486 else 480 }
                try { call.hangup(response) } finally { response.delete() }
            } else update(call)
        }
    }
    private class PendingHold(val held: Boolean) {
        val result = CompletableDeferred<Unit>()
        var sequence: Long? = null
        var accepted = false
    }
    private inner class NativeCall(val account: NativeAccount, id: Int, val incoming: Boolean, val gatewayId: String? = null) : Call(account, id) {
        val token = UUID.randomUUID().toString()
        var connected = false
        var ending = false
        var held = false
        // Both parties holding produces NONE; retain only a successfully negotiated local hold.
        var confirmedHold = false
        var mediaInactive = false
        var negotiatedUnheld = false
        var pendingHold: PendingHold? = null
        var muted = false
        var rejected = false
        var remoteLabel: String? = null
        var destination: String? = null
        var transferring = false
        var transferStatus: String? = null
        var transferPeer: NativeCall? = null
        var conferenceId: String? = null
        var conferencePeer: NativeCall? = null
        val managedDeviceId = account.settings.managedDeviceId
        val accountTitle = account.settings.title
        override fun onCallState(parameter: OnCallStateParam) { if (running) runCatching { update(this) } }
        override fun onCallMediaState(parameter: OnCallMediaStateParam) {
            runCatching { update(this); connectAudio(this) }.onFailure { _error.value = "Call audio could not start. Check microphone access." }
        }
        override fun onCallTsxState(parameter: OnCallTsxStateParam) {
            val pending = pendingHold ?: return
            val transaction = parameter.e.body.tsxState.tsx
            if (transaction.role != pjsip_role_e.PJSIP_ROLE_UAC || transaction.method != "INVITE") return
            // PJSUA2 exposes CSeq only through the transaction's local message. Retain just the number.
            val sequence = transaction.lastTx.wholeMsg.lineSequence().firstOrNull { it.startsWith("CSeq:", ignoreCase = true) }
                ?.substringAfter(':')?.trim()?.substringBefore(' ')?.toLongOrNull() ?: return
            if (transaction.state == pjsip_tsx_state_e.PJSIP_TSX_STATE_CALLING) pending.sequence = sequence
            val code = transaction.statusCode
            if (pending.sequence != sequence || transaction.state < pjsip_tsx_state_e.PJSIP_TSX_STATE_COMPLETED || code < 200 || code in listOf(401, 407, 422)) return
            if (code < 300) { pending.accepted = true; finishHold(this) }
            else finishHold(this, IllegalStateException("The phone system rejected the hold change (SIP $code)."))
        }
        override fun onCallTransferRequest(parameter: OnCallTransferRequestParam) { parameter.statusCode = 603 }
        override fun onCallTransferStatus(parameter: OnCallTransferStatusParam) {
            if (!running || ending || nativeCalls[token] !== this || !transferring) { parameter.cont = false; return }
            val finished = parameter.statusCode >= 200 || parameter.finalNotify
            val succeeded = parameter.statusCode in 200..299
            val peer = transferPeer
            transferring = !finished
            transferStatus = if (!finished) "Transferring…" else if (succeeded) "Transfer completed" else "Transfer failed. Your call is still connected."
            if (finished) { transferPeer = null; parameter.cont = false }
            update(this)
            if (succeeded) {
                // Retain UUID/object identity across deferred cleanup and numeric PJSIP ID reuse.
                handler.post {
                    if (!running) return@post
                    for (call in listOfNotNull(this, peer)) {
                        if (nativeCalls[call.token] !== call || call.ending) continue
                        val operation = CallOpParam()
                        try { call.hangup(operation) }
                        catch (_: Exception) { _error.value = "The transfer completed, but the local call could not end. Use End call." }
                        finally { operation.delete() }
                    }
                }
            }
        }
    }
}
