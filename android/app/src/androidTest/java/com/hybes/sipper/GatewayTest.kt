package com.hybes.sipper

import android.app.Notification
import android.app.NotificationManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import net.openid.appauth.AuthorizationResponse
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

/** Run only with the disposable gateway harness; no real SIP account or microphone. */
@RunWith(AndroidJUnit4::class)
class GatewayTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    @Test fun nativeConferenceForwardsEncryptedRemoteAudioAndClearsItOnSplit() = runBlocking<Unit> {
        assumeTrue(InstrumentationRegistry.getArguments().getString("sipperGateway") == "native-conference")
        // This is the SIP/mixer boundary only. Core-Telecom, permissions and system audio are tested separately.
        val fixture = JSONObject(File(context.filesDir, "gateway-test.json").readText())
        val raw = fixture.getJSONObject("configuration")
        val origin = fixture.getString("origin")
        require(origin.matches(Regex("http://127\\.0\\.0\\.1:[0-9]+")))
        val account = parseConfiguration(raw, origin, raw.getJSONObject("organisation").getString("id"), raw.getString("deviceId")).accounts.single()
        val ca = File(context.cacheDir, "gateway-test-ca.pem").apply { writeText(fixture.getString("certificate")) }
        val ready = File(context.filesDir, "gateway-incoming-ready")
        val completed = File(context.filesDir, "gateway-phase-completed")
        val engine = SipEngine(context, silentAudio = true)
        try {
            engine.trustTestCertificate(ca); engine.start(); engine.enableAudio(true); engine.sync(listOf(account))
            withTimeout(15000) { engine.registrations.first { it[account.id]?.state == "registered" } }
            suspend fun connected(number: String): String {
                val id = engine.dial(account.id, number)
                withTimeout(15000) { engine.calls.first { values -> values.any { it.id == id && it.connected } } }
                mediaFlow(engine, id)
                return id
            }
            suspend fun level(id: String, audible: Boolean, phase: String) {
                var last: Long? = null
                val confirmed = withTimeoutOrNull(10000) {
                    var matching = 0
                    while (matching < 5) {
                        val value = engine.receivedLevelForTest(id)
                        last = value
                        matching = if (value != null && (value >= 2) == audible) matching + 1 else 0
                        delay(100)
                    }
                    true
                }
                assertEquals("$phase: expected ${if (audible) "remote tone" else "silence"}; level=$last%; " +
                    "${engine.mediaStats(id)}; ${engine.testMediaTransport(id)}; ${engine.error.value}", true, confirmed)
            }
            val tone = connected("2001"); val echo = connected("2000")
            level(tone, true, "Tone before merge"); level(echo, false, "Echo before merge")
            val reference = engine.beginConference(tone, echo)
            engine.dtmf(echo, "2", reference)
            engine.mute(tone, true)
            assertTrue(engine.calls.value.all { it.muted })
            // Only the received remote tone can reach the echo phone: the local source is silent and muted.
            level(echo, true, "Echo after merge")
            engine.conferenceHold(tone, reference, true)
            assertTrue(engine.calls.value.all { it.held })
            engine.conferenceHold(echo, reference, false)
            mediaFlow(engine, tone); mediaFlow(engine, echo); level(echo, true, "Echo after resume")
            engine.conferenceHold(tone, reference, true); engine.splitConference(tone, reference)
            assertTrue(engine.calls.value.all { it.held && it.conferenceId == null })
            engine.hold(tone, false); engine.hold(echo, false)
            mediaFlow(engine, tone); mediaFlow(engine, echo)
            level(tone, true, "Tone after split"); level(echo, false, "Echo after split")
            val regrouped = engine.beginConference(tone, echo)
            assertNotEquals(reference, regrouped)
            level(echo, true, "Echo after regroup")
            engine.hangup(tone, regrouped)
            withTimeout(10000) { engine.calls.first { values -> values.none { it.id == tone } } }
            assertTrue(engine.calls.value.single().let { it.id == echo && it.connected && it.conferenceId == null })
            level(echo, false, "Echo after participant leaves")
            engine.hangup(echo)
            withTimeout(10000) { engine.calls.first { it.isEmpty() } }
            ready.writeText("conference-media")
            withTimeout(15000) { while (!completed.exists() || completed.readText() != "conference-media") delay(50) }
        } finally { engine.close(); ca.delete(); ready.delete(); completed.delete() }
    }
    private suspend fun mediaFlow(engine: SipEngine, call: String): SipEngine.MediaStats {
        var media: SipEngine.MediaStats? = null
        var previous: SipEngine.MediaStats? = null
        var transport = ""
        val flowing = withTimeoutOrNull(12000) {
            while (true) {
                media = engine.mediaStats(call)
                transport = engine.testMediaTransport(call)
                if (media?.let { it.sent >= 5 && it.received >= 5 } == true &&
                    transport.contains("SRTP status: Active") && transport.contains("state: Negotiation Success") &&
                    previous?.let { media!!.sent > it.sent && media!!.received > it.received } == true) break
                previous = media
                delay(100)
            }
            true
        }
        assertEquals("Bidirectional media did not start: $media; $transport; ${engine.error.value}", true, flowing)
        assertEquals("opus", media!!.codec.lowercase())
        assertTrue(transport, transport.contains("SRTP status: Active"))
        assertTrue(transport, transport.contains("state: Negotiation Success"))
        return media!!
    }
    private suspend fun checkTransfers(engine: SipEngine, bridge: CallBridge, account: SipAccount,
        ready: File, completed: File, notification: suspend (Boolean) -> Unit) {
        suspend fun transferCall(number: String): String {
            val before = engine.calls.value.map { it.id }.toSet()
            bridge.dial(account.id, number)
            val connected = withTimeout(15000) { engine.calls.first { values -> values.any { it.id !in before && it.connected } } }
                .single { it.id !in before && it.connected }
            assertTrue(bridge.awaitPresentation(connected.id))
            notification(true)
            mediaFlow(engine, connected.id)
            return connected.id
        }
        suspend fun heldForTransfer(id: String) {
            engine.networkEventsForTest(clear = true)
            bridge.hold(id, true)
            withTimeout(10000) {
                while (engine.calls.value.none { it.id == id && it.held } ||
                    !engine.networkEventsForTest().contains("negotiated")) delay(50)
            }
        }
        suspend fun transferred(phase: String) {
            withTimeout(10000) {
                engine.calls.first { it.isEmpty() }
                bridge.routes.first { it.isEmpty() }
            }
            notification(false)
            ready.writeText(phase)
            // The companion verifies continuing remote media and clears its call.
            withTimeout(15000) { while (!completed.exists() || completed.readText() != phase) delay(50) }
        }
        val blind = transferCall("2000")
        for (invalid in listOf("sip:2001@external.invalid", "2001@localhost", "ABCD", "1".repeat(129))) {
            assertTrue(runCatching { engine.transfer(blind, invalid) }.isFailure)
        }
        engine.transfer(blind, "2004") // The disposable PBX rejects this number.
        withTimeout(10000) { engine.calls.first { values -> values.any { it.id == blind && it.connected &&
            !it.transferring && it.transferStatus?.startsWith("Transfer failed") == true } } }
        mediaFlow(engine, blind)
        heldForTransfer(blind)
        engine.transfer(blind, "2001")
        transferred("transfer-blind-media")
        val held = transferCall("2000")
        heldForTransfer(held)
        val consultation = transferCall("2001")
        engine.attendedTransfer(held, consultation)
        assertTrue(runCatching { engine.transfer(consultation, "2000") }.isFailure)
        transferred("transfer-attended-media")
        assertTrue(runCatching { engine.attendedTransfer(held, consultation) }.isFailure)
    }

    @Test fun managedGatewayAuthenticatesAndReconcilesIncomingCalls() = runBlocking<Unit> {
        assumeTrue(InstrumentationRegistry.getArguments().getString("sipperGateway") == "isolated")
        withContext(Dispatchers.Main) {
            val source = File(context.filesDir, "gateway-test.json")
            val fixture = JSONObject(source.readText())
            val raw = fixture.getJSONObject("configuration")
            val origin = fixture.getString("origin")
            require(origin.matches(Regex("http://127\\.0\\.0\\.1:[0-9]+")))
            val config = parseConfiguration(raw, origin, raw.getJSONObject("organisation").getString("id"), raw.getString("deviceId"))
            val account = config.accounts.single()
            assertEquals("gateway", account.managedMode)
            val ca = File(context.cacheDir, "gateway-test-ca.pem").apply { writeText(fixture.getString("certificate")) }
            val ready = File(context.filesDir, "gateway-incoming-ready")
            val completed = File(context.filesDir, "gateway-phase-completed")
            val pushFile = File(context.filesDir, "gateway-push.json")
            try {
                // An unknown CA must fail even though SIP credentials are valid.
                val untrusted = SipEngine(context, silentAudio = true)
                try {
                    untrusted.start(); untrusted.sync(listOf(account))
                    withTimeout(10000) { untrusted.registrations.first { it[account.id]?.state == "failed" } }
                    assertNotEquals("registered", untrusted.registration(account.id).state)
                } finally { untrusted.close() }
                val engine = SipEngine(context, silentAudio = true)
                val vault = SecureVault(context, "test-gateway-${UUID.randomUUID()}")
                var applied = emptyList<SipAccount>()
                val client = ManagedClient(context, origin, vault) { applied = it; engine.sync(it) }
                val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
                val controls = ManagedCallControl(engine, client, scope)
                try {
                    engine.trustTestCertificate(ca)
                    engine.start()
                    // The provider is a protocol fixture; provisioning and call APIs
                    // run the real service code for this isolated device and customer.
                    val request = client.prepareSignIn()
                    val response = AuthorizationResponse.Builder(request).setAuthorizationCode(fixture.getString("code")).setState(request.state).build()
                    client.finishSignIn(response.toIntent()); client.connect(config.organisationId)
                    withTimeout(15000) { engine.registrations.first { it[account.id]?.state == "registered" } }
                    assertEquals(200, engine.registration(account.id).code)
                    assertTrue(engine.hasApplied(applied))
                    val call = engine.dial(account.id, "2000")
                    withTimeout(15000) { engine.calls.first { values -> values.any { it.id == call && it.connected } } }
                    assertEquals("2000", engine.calls.value.single { it.id == call }.destination)
                    engine.enableAudio(true)
                    // Null audio produces silence; this verifies packet flow, not microphones.
                    mediaFlow(engine, call)
                    suspend fun recoverCall(registered: Boolean) {
                        engine.networkChanged(false)
                        assertNotEquals("registered", engine.registration(account.id).state)
                        engine.networkEventsForTest(clear = true)
                        engine.networkChanged(true)
                        if (registered) withTimeout(15000) { engine.registrations.first { it[account.id]?.state == "registered" } }
                        withTimeout(15000) {
                            while (true) {
                                val events = engine.networkEventsForTest()
                                val offer = events.indexOf("offer")
                                if (offer >= 0 && events.drop(offer + 1).contains("negotiated")) break
                                delay(100)
                            }
                        }
                        mediaFlow(engine, call)
                        assertEquals(registered, engine.registration(account.id).state == "registered")
                        assertEquals(registered, engine.networkEventsForTest().contains("register"))
                        assertTrue(engine.calls.value.any { it.id == call && it.connected && it.state != "Ended" })
                    }
                    repeat(3) { recoverCall(true) }
                    engine.sync(listOf(account.copy(expiresAt = System.currentTimeMillis() + 1500)))
                    delay(2200)
                    assertEquals("unregistered", engine.registration(account.id).state)
                    assertTrue(engine.calls.value.any { it.id == call && it.connected && it.state != "Ended" })
                    assertTrue(runCatching { engine.dial(account.id, "2000") }.isFailure)
                    assertTrue(runCatching { engine.transfer(call, "2001") }.isFailure)
                    recoverCall(false)
                    engine.hangup(call)
                    withTimeout(5000) { engine.calls.first { values -> values.none { it.id == call } } }
                    engine.sync(applied)
                    withTimeout(15000) { engine.registrations.first { it[account.id]?.state == "registered" } }

                    // Inject only the opaque provider payload. The real API must authorise
                    // this device, restore its account and fetch the actual SIP offer.
                    engine.sync(emptyList())
                    assertFalse(engine.hasApplied(applied))
                    ready.writeText("push-wake")
                    withTimeout(10000) { while (!pushFile.exists()) delay(50) }
                    val payload = JSONObject(pushFile.readText())
                    val push = incomingCallPush(payload.keys().asSequence().associateWith { payload.getString(it) })!!
                    val woken = withTimeout(15000) { controls.wake(push) }!!
                    assertEquals(push.callId, woken.gatewayCallId)
                    assertEquals(account.id, woken.accountId)
                    assertEquals("registered", engine.registration(account.id).state)
                    assertEquals("Fixture caller", controls.prepare(woken).remote)
                    controls.answer(woken.id) { engine.answer(woken.id); engine.enableAudio(true) }
                    ready.writeText("push-answer")
                    withTimeout(10000) { engine.calls.first { values -> values.any { it.id == woken.id && it.connected } } }
                    mediaFlow(engine, woken.id)
                    engine.hangup(woken.id)
                    withTimeout(5000) { engine.calls.first { values -> values.none { it.id == woken.id } } }
                    withTimeout(5000) { while (client.call(config.deviceId, push.callId).state != "ended") delay(100) }
                    assertNull(controls.wake(push)) // A duplicate hint cannot restart the completed call.

                    suspend fun incoming(phase: String): PhoneCall {
                        ready.writeText(phase)
                        val ringing = withTimeout(15000) { engine.calls.first { values -> values.any { it.incoming && it.state != "Ended" } } }
                            .first { it.incoming && it.state != "Ended" }
                        assertEquals("Incoming managed call", ringing.remote)
                        assertNull(ringing.destination)
                        assertNotNull(canonicalCallId(ringing.gatewayCallId ?: ""))
                        val verified = controls.prepare(ringing)
                        assertEquals("Fixture caller", verified.remote)
                        val callerNumber = client.call(config.deviceId, ringing.gatewayCallId!!).callerNumber
                        assertEquals(callerNumber, verified.destination)
                        assertEquals(account.managedDeviceId, verified.managedDeviceId)
                        assertEquals(config.deviceId to config.remoteIds.single(), client.gatewayBinding(ringing.accountId))
                        return verified
                    }
                    val answered = incoming("answer")
                    val monitor = scope.launch { controls.monitor(answered.id) }
                    controls.answer(answered.id) { engine.answer(answered.id); engine.enableAudio(true) }
                    withTimeout(10000) { engine.calls.first { values -> values.any { it.id == answered.id && it.connected } } }
                    mediaFlow(engine, answered.id)
                    assertEquals(answered.destination, engine.calls.value.single { it.id == answered.id }.destination)
                    val claimed = client.call(config.deviceId, answered.gatewayCallId!!)
                    assertTrue(claimed.claimedByThisDevice); assertEquals("answered", claimed.state)
                    engine.hangup(answered.id)
                    withTimeout(5000) { engine.calls.first { values -> values.none { it.id == answered.id } } }
                    monitor.cancelAndJoin()

                    val cancelled = incoming("cancel")
                    val cancelledMonitor = scope.launch { controls.monitor(cancelled.id) }
                    ready.writeText("cancel-ringing")
                    withTimeout(10000) { engine.calls.first { values -> values.none { it.id == cancelled.id } } }
                    withTimeout(5000) { while (client.call(config.deviceId, cancelled.gatewayCallId!!).state != "ended") delay(100) }
                    var accepted = false
                    assertTrue(runCatching { controls.answer(cancelled.id) { accepted = true } }.isFailure)
                    assertFalse(accepted)
                    cancelledMonitor.cancelAndJoin()

                    val declined = incoming("decline")
                    controls.declined(declined)
                    val declinedMonitor = scope.launch { controls.monitor(declined.id) }
                    // The device API decline itself must dismiss this SIP offer.
                    withTimeout(10000) { engine.calls.first { values -> values.none { it.id == declined.id } } }
                    // Other eligible devices may still wake. Declining this device
                    // must remove its offer and prevent it from taking a later claim.
                    assertFalse(client.call(config.deviceId, declined.gatewayCallId!!).claimedByThisDevice)
                    assertEquals("call_unavailable", (runCatching { client.call(config.deviceId, declined.gatewayCallId, "answer") }.exceptionOrNull() as? ManagedFailure)?.kind)
                    ready.writeText("decline-finished")
                    withTimeout(5000) { while (client.call(config.deviceId, declined.gatewayCallId).state != "ended") delay(100) }
                    declinedMonitor.cancelAndJoin()

                    val lost = incoming("other-device")
                    val lostMonitor = scope.launch { controls.monitor(lost.id) }
                    ready.writeText("other-device-ringing")
                    withTimeout(10000) { engine.calls.first { values -> values.none { it.id == lost.id } } }
                    val otherWinner = client.call(config.deviceId, lost.gatewayCallId!!)
                    assertTrue(otherWinner.unavailable()); assertFalse(otherWinner.claimedByThisDevice)
                    lostMonitor.cancelAndJoin()

                    val failed = incoming("answer-failed")
                    val failure = runCatching { controls.answer(failed.id) { error("Fixture audio setup failure") } }.exceptionOrNull()
                    assertEquals("Fixture audio setup failure", failure?.message)
                    withTimeout(5000) { engine.calls.first { values -> values.none { it.id == failed.id } } }
                    assertFalse(client.call(config.deviceId, failed.gatewayCallId!!).claimedByThisDevice)
                    assertEquals("call_unavailable", (runCatching { client.call(config.deviceId, failed.gatewayCallId, "answer") }.exceptionOrNull() as? ManagedFailure)?.kind)
                    ready.writeText("answer-failed-finished")
                    withTimeout(5000) { while (client.call(config.deviceId, failed.gatewayCallId!!).state != "ended") delay(100) }

                    // Exercise the real Core-Telecom session and notification publisher.
                    // The harness grants permissions only on the isolated QA emulator;
                    // SipEngine still uses null audio and cannot open a microphone.
                    val errors = mutableListOf<String>()
                    val bridge = CallBridge(context, engine, scope, controls) { errors += it }
                    val notifications = context.getSystemService(NotificationManager::class.java)
                    suspend fun notification(present: Boolean, channel: String? = null): Notification? {
                        var shown: Notification? = null
                        val matched = withTimeoutOrNull(8000) {
                            while (true) {
                                shown = notifications.activeNotifications.firstOrNull { it.notification.category == Notification.CATEGORY_CALL }?.notification
                                if ((shown != null) == present && (channel == null || shown?.channelId == channel)) return@withTimeoutOrNull true
                                check(errors.isEmpty()) { errors.joinToString() }
                                delay(50)
                            }
                        }
                        assertEquals("Expected call notification present=$present channel=$channel; errors=$errors", true, matched)
                        return shown
                    }
                    suspend fun ended(id: String) {
                        withTimeout(5000) { engine.calls.first { values -> values.none { it.id == id } } }
                        notification(false)
                        assertTrue(errors.joinToString(), errors.isEmpty())
                    }
                    bridge.dial(account.id, "2000")
                    val outgoing = withTimeout(15000) { engine.calls.first { values -> values.any { !it.incoming && it.connected } } }.first()
                    assertTrue(bridge.awaitPresentation(outgoing.id))
                    val outgoingNotice = notification(true, "ongoing-calls")!!
                    assertNull(outgoingNotice.fullScreenIntent)
                    assertEquals(0, outgoingNotice.flags and Notification.FLAG_INSISTENT)
                    assertNull(notifications.getNotificationChannel("ongoing-calls").sound)
                    mediaFlow(engine, outgoing.id)
                    bridge.hangup(outgoing.id); ended(outgoing.id)

                    checkTransfers(engine, bridge, account, ready, completed) { present ->
                        notification(present, if (present) "ongoing-calls" else null)
                        assertTrue(errors.joinToString(), errors.isEmpty())
                    }

                    val telecom = incoming("telecom-answer")
                    assertTrue("Telecom did not present the incoming call: $errors", bridge.awaitPresentation(telecom.id))
                    val ringingNotice = notification(true, "incoming-calls")!!
                    assertNotNull(ringingNotice.fullScreenIntent)
                    assertEquals(context.packageName, ringingNotice.fullScreenIntent.creatorPackage)
                    assertNotEquals(0, ringingNotice.flags and Notification.FLAG_INSISTENT)
                    assertEquals(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE,
                        notifications.getNotificationChannel("incoming-calls").audioAttributes.usage)
                    assertEquals("Fixture caller", ringingNotice.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
                    assertEquals(Notification.VISIBILITY_PRIVATE, ringingNotice.visibility)
                    assertEquals("Sipper call", ringingNotice.publicVersion.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
                    assertTrue("Incoming call must expose answer and decline", ringingNotice.actions.size >= 2)
                    bridge.answer(telecom.id)
                    withTimeout(10000) { engine.calls.first { values -> values.any { it.id == telecom.id && it.connected } } }
                    val answeredNotice = notification(true, "ongoing-calls")!!
                    assertNull(answeredNotice.fullScreenIntent)
                    assertEquals(0, answeredNotice.flags and Notification.FLAG_INSISTENT)
                    mediaFlow(engine, telecom.id)
                    repeat(3) {
                        bridge.hold(telecom.id, true); bridge.hold(telecom.id, false)
                        mediaFlow(engine, telecom.id)
                    }
                    bridge.hangup(telecom.id); ended(telecom.id)

                    val telecomCancelled = incoming("telecom-cancel")
                    assertTrue(bridge.awaitPresentation(telecomCancelled.id))
                    notification(true)
                    ready.writeText("telecom-cancel-ringing")
                    ended(telecomCancelled.id)
                    assertTrue(runCatching { bridge.answer(telecomCancelled.id) }.isFailure)
                } finally { scope.coroutineContext.job.cancelAndJoin(); client.close(); vault.clear(); engine.close() }
            } finally { ca.delete(); source.delete(); ready.delete(); completed.delete(); pushFile.delete() }
        }
    }
}
