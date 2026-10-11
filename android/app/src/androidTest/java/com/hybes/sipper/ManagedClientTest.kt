package com.hybes.sipper

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import net.openid.appauth.AuthorizationResponse
import net.openid.appauth.AuthorizationException
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.ServerSocket
import java.net.URLDecoder
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

@RunWith(AndroidJUnit4::class)
class ManagedClientTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    @Test fun meetingRequestsBindExactRetriesSessionsAndControlsWithoutArchivingGrants() = runBlocking<Unit> {
        withContext(Dispatchers.Main) { Fixture().use { fixture ->
            val vault = SecureVault(context, "meetings-test-${UUID.randomUUID()}")
            val client = ManagedClient(context, fixture.origin, vault) { }
            fixture.meetingHandler = { request -> 200 to fixture.meetingReply(request) }
            try {
                authenticate(client, fixture); client.connect(fixture.org)
                assertEquals(fixture.meetingId, client.currentMeeting(fixture.device, fixture.conversationId).meeting?.id)
                val start = UUID.randomUUID().toString(); val session = UUID.randomUUID().toString()
                repeat(2) { client.startMeeting(fixture.device, fixture.conversationId, start); client.joinMeeting(fixture.device, fixture.meetingId, session) }
                assertEquals(listOf(start, start), fixture.requests.filter { it.method == "POST" && it.path.endsWith("/meeting") }.map { JSONObject(it.body).getString("id") })
                assertEquals(listOf(session, session), fixture.requests.filter { it.path.endsWith("/join") }.map { JSONObject(it.body).getString("id") })
                assertTrue(client.meetingDetails(fixture.device, fixture.meetingId).canJoin)
                val grant = client.joinMeeting(fixture.device, fixture.meetingId, session)
                assertFalse(grant.toString().contains(grant.token)); assertFalse(grant.toString().contains(grant.url))
                val saved = vault.read()!!.toString(Charsets.UTF_8)
                assertFalse(saved.contains(grant.token)); assertFalse(saved.contains("sipper-${fixture.meetingId}")); assertFalse(saved.contains("meet.example.invalid"))
                client.leaveMeeting(fixture.device, fixture.meetingId, session)
                assertTrue(fixture.requests.last().path.endsWith("/sessions/$session/leave"))
                assertNotNull(client.endMeeting(fixture.device, fixture.meetingId).endedAt)
                val person = "peer @+%é"
                client.removeMeetingPerson(fixture.device, fixture.meetingId, person)
                assertEquals(person, URLDecoder.decode(fixture.requests.last().path.substringAfterLast('/'), "UTF-8"))
                val count = fixture.requests.size
                assertEquals("invalid_meeting_input", (runCatching { client.removeMeetingPerson(fixture.device, fixture.meetingId, "fictional-user") }.exceptionOrNull() as? ManagedFailure)?.kind)
                assertEquals(count, fixture.requests.size)
                for (status in listOf(409, 429, 503)) {
                    fixture.meetingHandler = { status to JSONObject() }
                    assertEquals(when (status) { 409 -> "meeting_changed"; 429 -> "meeting_rate_limit"; else -> "unavailable" },
                        (runCatching { client.joinMeeting(fixture.device, fixture.meetingId, session) }.exceptionOrNull() as? ManagedFailure)?.kind)
                }
            } finally { client.close(); vault.clear() }
        } }
    }
    @Test fun meetingsRejectForeignStaleMetadataAndBroaderOrUnsafeMediaGrants() = runBlocking<Unit> {
        withContext(Dispatchers.Main) { Fixture().use { fixture ->
            val vault = SecureVault(context, "meeting-invalid-test-${UUID.randomUUID()}")
            val client = ManagedClient(context, fixture.origin, vault) { }
            try {
                authenticate(client, fixture); client.connect(fixture.org)
                val session = UUID.randomUUID().toString()
                val poison = listOf<(JSONObject) -> Unit>(
                    { it.put("organisationId", UUID.randomUUID().toString()) }, { it.put("sessionId", UUID.randomUUID().toString()) },
                    { it.put("meetingId", UUID.randomUUID().toString()) }, { it.put("identity", "sipper:foreign") },
                    { it.put("url", "ws://remote.example.invalid") }, { it.put("url", "wss://user:secret@meet.example.invalid") },
                    { it.put("url", "wss://meet.example.invalid/rtc") }, { it.put("url", "wss://meet.example.invalid?token=secret") },
                    { it.put("url", "wss://meet.example.invalid:0") }, { it.put("expiresAt", Instant.now().minusSeconds(1).toString()) },
                    { it.put("expiresAt", Instant.now().plusSeconds(200).toString()) }, { it.put("token", "malformed") })
                for (alter in poison) {
                    fixture.meetingHandler = { 200 to fixture.grant(session).also(alter) }
                    assertEquals("invalid_meeting", (runCatching { client.joinMeeting(fixture.device, fixture.meetingId, session) }.exceptionOrNull() as? ManagedFailure)?.kind)
                }
                for (extra in listOf("canPublishData", "canUpdateOwnMetadata", "roomAdmin")) {
                    fixture.meetingHandler = { 200 to fixture.grant(session, extra) }
                    assertEquals("invalid_meeting", (runCatching { client.joinMeeting(fixture.device, fixture.meetingId, session) }.exceptionOrNull() as? ManagedFailure)?.kind)
                }
                fixture.meetingHandler = { 200 to fixture.messageScope().put("available", true).put("meeting", fixture.meetingRecord().put("conversationId", UUID.randomUUID().toString())) }
                assertEquals("invalid_meeting", (runCatching { client.currentMeeting(fixture.device, fixture.conversationId) }.exceptionOrNull() as? ManagedFailure)?.kind)
                fixture.meetingHandler = { request -> 200 to fixture.meetingReply(request).put("expiresAt", Instant.now().minusSeconds(1).toString()) }
                assertEquals("invalid_meeting", (runCatching { client.meetingDetails(fixture.device, fixture.meetingId) }.exceptionOrNull() as? ManagedFailure)?.kind)
                val local = fixture.grant(session).put("url", "ws://127.0.0.1:17881")
                assertNotNull(parseMeetingGrant(local, fixture.org, fixture.meetingId, session, true))
                assertTrue(runCatching { parseMeetingGrant(local, fixture.org, fixture.meetingId, session, false) }.isFailure)
            } finally { client.close(); vault.clear() }
        } }
    }
    @Test fun meetingScreenExpiresMetadataRefusesPhoneAudioAndWithdrawsAnExactPendingJoin() = runBlocking<Unit> {
        withContext(Dispatchers.Main) { Fixture().use { fixture ->
            val vault = SecureVault(context, "meeting-screen-test-${UUID.randomUUID()}")
            val client = ManagedClient(context, fixture.origin, vault) { }
            val work = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
            var allowAudio = false; var releases = 0
            fixture.meetingHandler = { request -> 200 to fixture.meetingReply(request) }
            try {
                authenticate(client, fixture); client.connect(fixture.org)
                val screen = AndroidMeetingSession(context, client, fixture.device, fixture.conversationId, work, { allowAudio }, { releases++ })
                fixture.meetingHandler = { request -> 200 to fixture.meetingReply(request).also {
                    if (!request.path.endsWith("/meeting")) it.getJSONObject("meeting").put("conversationId", UUID.randomUUID().toString())
                } }
                screen.refresh(); assertFalse(screen.canJoin); assertNull(screen.details); assertNull(screen.room)
                fixture.meetingHandler = { request -> 200 to fixture.meetingReply(request) }
                screen.refresh(); assertTrue(screen.canJoin)
                val count = fixture.requests.size
                screen.join(); assertFalse(screen.joining); assertEquals(count, fixture.requests.size); assertEquals(0, releases)
                screen.clearExpiredMetadata(System.currentTimeMillis() + 61_000); assertNull(screen.details); assertNull(screen.current); assertFalse(screen.canJoin)
                screen.refresh(); allowAudio = true; fixture.holdMeetingJoin = true
                screen.join()
                assertTrue(withContext(Dispatchers.IO) { fixture.meetingJoinStarted.await(5, TimeUnit.SECONDS) })
                val joining = fixture.requests.last { it.path.endsWith("/join") }; val session = JSONObject(joining.body).getString("id")
                screen.stop(); assertTrue(screen.stopping); assertEquals(0, releases); assertNull(screen.room)
                fixture.releaseMeetingJoin.countDown()
                withTimeout(10_000) { screen.waitForStop() }
                assertFalse(screen.stopping); assertEquals(1, releases); assertNull(screen.room)
                assertTrue(fixture.requests.any { it.path.endsWith("/sessions/$session/leave") })
                assertFalse(vault.read()!!.toString(Charsets.UTF_8).contains(session))
                fixture.meetingHandler = { 403 to JSONObject() }
                assertTrue(runCatching { client.currentMeeting(fixture.device, fixture.conversationId) }.isFailure)
                assertFalse(screen.authorised)
                screen.refresh(); screen.waitForStop()
                assertNull(screen.current); assertNull(screen.details); assertFalse(screen.canJoin)
            } finally { fixture.releaseMeetingJoin.countDown(); work.cancel(); client.close(); vault.clear() }
        } }
    }
    @Test fun lateMeetingGrantsCannotRestoreDisconnectedOrSignedOutAccess() = runBlocking<Unit> {
        withContext(Dispatchers.Main) { for (signOut in listOf(false, true)) Fixture().use { fixture ->
            val vault = SecureVault(context, "meeting-race-test-${UUID.randomUUID()}")
            val client = ManagedClient(context, fixture.origin, vault) { }
            fixture.meetingHandler = { request -> 200 to fixture.meetingReply(request) }
            try {
                authenticate(client, fixture); client.connect(fixture.org)
                fixture.holdMeetingJoin = true
                val joining = async { runCatching { client.joinMeeting(fixture.device, fixture.meetingId, UUID.randomUUID().toString()) } }
                assertTrue(withContext(Dispatchers.IO) { fixture.meetingJoinStarted.await(5, TimeUnit.SECONDS) })
                val withdrawing = async { if (signOut) client.signOut() else client.disconnect(fixture.device) }
                yield(); assertTrue(client.status.value.connections.isEmpty())
                fixture.releaseMeetingJoin.countDown()
                assertTrue((joining.await().exceptionOrNull() as? ManagedFailure)?.kind in setOf("cancelled", "access_denied"))
                withdrawing.await(); assertTrue(client.status.value.connections.isEmpty())
            } finally { fixture.releaseMeetingJoin.countDown(); client.close(); vault.clear() }
        } }
    }
    @Test fun messageNotificationTokensAndHintsStayOwnedAndSeparateFromCalls() = runBlocking<Unit> {
        withContext(Dispatchers.Main) { Fixture().use { fixture ->
            val vault = SecureVault(context, "message-push-test-${UUID.randomUUID()}")
            val client = ManagedClient(context, fixture.origin, vault) { }
            var wrong = false
            fixture.messageHandler = { request ->
                assertTrue(request.path.endsWith("/messages/push"))
                val value = JSONObject().put("deviceId", if (wrong) UUID.randomUUID().toString() else fixture.device)
                if (request.method == "DELETE") value.put("removed", true)
                else { assertEquals("fictional-message-fcm-token", JSONObject(request.body).getString("token")); value.put("registered", true).put("provider", "fcm") }
                200 to value
            }
            try {
                authenticate(client, fixture); client.connect(fixture.org)
                assertTrue(client.hasMessageAccess()); assertNotNull(client.messageEnrollment(fixture.device)); assertNull(client.messageEnrollment(UUID.randomUUID().toString()))
                client.syncMessagePushToken("fictional-message-fcm-token")
                val count = fixture.requests.size; client.syncMessagePushToken("fictional-message-fcm-token"); assertEquals(count, fixture.requests.size)
                assertFalse(fixture.requests.any { it.path.endsWith("/push") && !it.path.endsWith("/messages/push") })
                wrong = true
                assertNotNull(runCatching { client.syncMessagePushToken(null) }.exceptionOrNull())
                wrong = false; client.syncMessagePushToken(null)
                val now = System.currentTimeMillis()
                val data = mapOf("type" to "message", "schemaVersion" to "1", "deviceId" to fixture.device,
                    "conversationId" to fixture.conversationId, "expiresAt" to Instant.ofEpochMilli(now + 60000).toString())
                assertEquals(fixture.device, messageNotification(data, now)?.deviceId)
                assertNull(incomingCallPush(data)); assertNull(messageNotification(data + ("text" to "No preview"), now))
                assertNull(messageNotification(data + ("schemaVersion" to "true"), now))
                assertNull(messageNotification(data + ("deviceId" to "not-a-device"), now))
                assertNull(messageNotification(data + ("expiresAt" to Instant.ofEpochMilli(now + 300001).toString()), now))
                val old = data + ("expiresAt" to Instant.ofEpochMilli(now - 60000).toString())
                assertNull(messageNotification(old, now)); assertNotNull(messageNotification(old, now, forRouting = true))
                val intent = android.content.Intent().apply { old.forEach { (key, value) -> putExtra(key, value) } }
                assertNotNull(MessageNotifications.fromIntent(intent)); assertNull(intent.getStringExtra("conversationId"))
                fixture.suspended = true; client.refresh()
                assertFalse(client.hasMessageAccess()); assertNull(client.messageEnrollment(fixture.device))
                client.syncMessagePushToken("fictional-message-fcm-token")
                assertEquals("DELETE", fixture.requests.last { it.path.endsWith("/messages/push") }.method)
                client.signOut(); assertFalse(client.hasMessageAccess())
            } finally { client.close(); vault.clear() }
        } }
    }
    private suspend fun authenticate(client: ManagedClient, fixture: Fixture) {
        val request = client.prepareSignIn()
        assertEquals("S256", request.codeVerifierChallengeMethod)
        assertNotNull(request.codeVerifier)
        assertEquals("${fixture.origin}/api/client", request.additionalParameters["resource"])
        val response = AuthorizationResponse.Builder(request).setAuthorizationCode("fictional-code").setState(request.state).build()
        client.finishSignIn(response.toIntent())
        assertTrue(client.status.value.signedIn)
        val form = fixture.requests.last { it.path.endsWith("/token") }.body.split('&').associate {
            val pair = it.split('=', limit = 2); pair[0] to URLDecoder.decode(pair.getOrElse(1) { "" }, "UTF-8")
        }
        assertEquals(request.codeVerifier, form["code_verifier"])
        assertEquals("${fixture.origin}/api/client", form["resource"])
        assertEquals("sipper-android", form["client_id"])
        assertFalse(form.containsKey("client_secret"))
    }
    @Test fun directSnapshotsExcludePersonalGatewayAndEndedCalls() {
        val direct = SipAccount(label = "Direct", username = "fixture", password = "private-secret", domain = "example.invalid",
            managedDeviceId = UUID.randomUUID().toString(), managedMode = "direct", expiresAt = System.currentTimeMillis() + 60000)
        val personal = direct.copy(id = UUID.randomUUID().toString(), managedDeviceId = null)
        val gateway = direct.copy(id = UUID.randomUUID().toString(), managedMode = "gateway")
        val call = PhoneCall("call", direct.id, "private-caller", true, "Ringing")
        val reports = directCallReport(listOf(direct, personal, gateway), listOf("remote", "personal", "gateway"), listOf(
            call, call.copy(incoming = false), call.copy(connected = true), call.copy(connected = true, held = true),
            call.copy(state = "Ended"), call.copy(accountId = personal.id), call.copy(accountId = gateway.id)))
        assertEquals(1, reports.length())
        val report = reports.getJSONObject(0)
        assertEquals("remote", report.getString("accountId"))
        for (key in listOf("ringing", "dialling", "connected", "held")) assertEquals(1, report.getInt(key))
        assertFalse(reports.toString().contains("private"))
    }

    @Test fun changedReportsRetryWithoutDuplicateTrafficAndKeepHeartbeats() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            Fixture().use { fixture ->
                val vault = SecureVault(context, "report-test-${UUID.randomUUID()}")
                val engine = SipEngine(context, silentAudio = true)
                val client = ManagedClient(context, fixture.origin, vault) { }
                try {
                    engine.start(); client.load(); authenticate(client, fixture); client.connect(fixture.org)
                    fixture.reportAccepted = false
                    try { client.report(engine, onlyIfChanged = true); fail("Unacknowledged report must fail") } catch (_: ManagedFailure) { }
                    fun count() = fixture.requests.count { it.path.endsWith("/report") }
                    assertEquals(1, count())
                    client.report(engine, onlyIfChanged = true); assertEquals(1, count())
                    fixture.reportAccepted = true; delay(5100)
                    client.report(engine, onlyIfChanged = true); assertEquals(2, count())
                    client.report(engine, onlyIfChanged = true); assertEquals(2, count())
                    client.report(engine); assertEquals(3, count())
                    client.disconnect(fixture.device); client.connect(fixture.org)
                    client.report(engine, onlyIfChanged = true); assertEquals(4, count())
                } finally { client.close(); engine.close(); vault.clear() }
            }
        }
    }

    @Test fun sdkPkceProvisioningEncryptedReloadAndEngineReports() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            Fixture().use { fixture ->
                val name = "test-managed-${UUID.randomUUID()}"
                val vault = SecureVault(context, name)
                val engine = SipEngine(context, silentAudio = true)
                val personal = SipAccount(label = "Personal fixture", username = "100", password = "personal-only", domain = "example.invalid",
                    server = "127.0.0.1", port = 59998, transport = "udp", srtp = "disabled", ice = false)
                val client = ManagedClient(context, fixture.origin, vault) { engine.sync(listOf(personal) + it) }
                var restored: ManagedClient? = null
                try {
                    engine.start(); engine.sync(listOf(personal)); client.load()
                    authenticate(client, fixture); client.connect(fixture.org)
                    assertTrue(client.status.value.connections.single().configured)
                    assertEquals("Fixture business", client.status.value.connections.single().name)
                    client.report(engine)
                    val report = JSONObject(fixture.requests.last { it.path.endsWith("/report") }.body)
                    assertEquals("a".repeat(64), report.getString("appliedRevision"))
                    assertEquals(fixture.account, report.getJSONArray("registrations").getJSONObject(0).getString("accountId"))
                    assertEquals(fixture.account, report.getJSONArray("directCalls").getJSONObject(0).getString("accountId"))
                    assertEquals(0, report.getJSONArray("directCalls").getJSONObject(0).getInt("connected"))
                    assertFalse(report.toString().contains("fictional-sip-secret"))
                    // A transport/engine restart must not acknowledge settings it has lost.
                    engine.sync(listOf(personal)); client.report(engine)
                    assertFalse(JSONObject(fixture.requests.last { it.path.endsWith("/report") }.body).has("appliedRevision"))
                    assertFalse(JSONObject(fixture.requests.last { it.path.endsWith("/report") }.body).has("directCalls"))
                    val refresh = fixture.requests.filter { it.path.endsWith("/token") }.last().body
                    assertTrue(refresh.contains("grant_type=refresh_token"))
                    assertTrue(refresh.contains("resource="))
                    val encrypted = File(context.noBackupFilesDir, "$name.enc").readBytes().toString(Charsets.UTF_8)
                    assertFalse(encrypted.contains("fictional-sip-secret")); assertFalse(encrypted.contains("fixture-access"))
                    var loaded = emptyList<SipAccount>()
                    restored = ManagedClient(context, fixture.origin, SecureVault(context, name)) { loaded = it }
                    restored.load(); restored.reconcile()
                    assertEquals(1, loaded.size); assertNotEquals(fixture.account, loaded.single().id)
                    assertNotEquals(personal.id, loaded.single().id)
                    client.signOut()
                    assertTrue(engine.hasApplied(listOf(personal)))
                    assertFalse(client.status.value.signedIn)
                    assertNull(vault.read())
                } finally { restored?.close(); client.close(); engine.close(); vault.clear() }
            }
        }
    }
    @Test fun revocationAndInvalidDeviceBindingsWithdrawOnlyManagedAccounts() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            Fixture().use { fixture ->
                val vault = SecureVault(context, "test-revoke-${UUID.randomUUID()}")
                var applied = emptyList<SipAccount>()
                val client = ManagedClient(context, fixture.origin, vault) { applied = it }
                try {
                    authenticate(client, fixture); client.connect(fixture.org); assertEquals(1, applied.size)
                    fixture.wrongDevice = true
                    assertTrue(runCatching { client.refresh() }.isFailure)
                    assertTrue(applied.isEmpty()); assertFalse(client.status.value.connections.single().configured)
                    fixture.wrongDevice = false; client.refresh(); assertEquals(1, applied.size)
                    fixture.suspended = true; client.refresh()
                    assertTrue(applied.isEmpty()); assertEquals("suspended", client.status.value.organisations.single().status)
                    fixture.suspended = false; client.refresh(); assertEquals(1, applied.size)
                    fixture.configurationStatus = 403
                    assertTrue(runCatching { client.refresh() }.isFailure); assertTrue(applied.isEmpty())
                    fixture.configurationStatus = 200; client.refresh(); assertEquals(1, applied.size)
                    fixture.organisationStatus = 401
                    assertTrue(runCatching { client.refresh() }.isFailure)
                    assertTrue(applied.isEmpty()); assertFalse(client.status.value.signedIn)
                } finally { client.close(); vault.clear() }
            }
        }
    }
    @Test fun offlineExpiryAndLateConfigurationCannotRestoreSignedOutAccess() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            Fixture().use { fixture ->
                val vault = SecureVault(context, "test-race-${UUID.randomUUID()}")
                var applied = emptyList<SipAccount>()
                val client = ManagedClient(context, fixture.origin, vault) { applied = it }
                try {
                    fixture.expiry = Instant.now().plusSeconds(2).toString()
                    authenticate(client, fixture); client.connect(fixture.org); assertEquals(1, applied.size)
                    fixture.configurationStatus = 503
                    assertTrue(runCatching { client.refresh() }.isFailure)
                    assertEquals(1, applied.size)
                    delay(2200); client.reconcile(); assertTrue(applied.isEmpty())
                    fixture.configurationStatus = 200; fixture.expiry = Instant.now().plusSeconds(600).toString()
                    client.refresh(); assertEquals(1, applied.size)
                    fixture.holdConfiguration = true
                    val refreshing = async { runCatching { client.refresh() } }
                    assertTrue(withContext(Dispatchers.IO) { fixture.configurationStarted.await(5, TimeUnit.SECONDS) })
                    val signingOut = async { client.signOut() }
                    yield(); assertFalse(client.status.value.signedIn); assertTrue(applied.isEmpty())
                    fixture.releaseConfiguration.countDown()
                    val cancelled = refreshing.await().exceptionOrNull()
                    assertEquals("cancelled", (cancelled as? ManagedFailure)?.kind)
                    signingOut.await()
                    assertFalse(client.status.value.signedIn); assertTrue(applied.isEmpty()); assertNull(vault.read())
                } finally { fixture.releaseConfiguration.countDown(); client.close(); vault.clear() }
            }
        }
    }
    @Test fun unsolicitedCallbackAndForeignOriginsAreRejected() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            assertThrows(ManagedFailure::class.java) { managedOrigin("http://pbx.example.invalid", true) }
            assertThrows(ManagedFailure::class.java) { managedOrigin("http://127.0.0.1", false) }
            assertThrows(ManagedFailure::class.java) { managedOrigin("https://sipper.dev@evil.example.invalid/path", false) }
            Fixture().use { fixture ->
                val vault = SecureVault(context, "test-callback-${UUID.randomUUID()}")
                val client = ManagedClient(context, fixture.origin, vault) { }
                try {
                    val request = client.prepareSignIn()
                    val response = AuthorizationResponse.Builder(request).setAuthorizationCode("fictional-code").setState("wrong-state").build()
                    assertTrue(runCatching { client.finishSignIn(response.toIntent()) }.isFailure)
                    assertFalse(client.status.value.signedIn); assertTrue(fixture.requests.isEmpty())
                    client.cancelSignIn()
                    val valid = AuthorizationResponse.Builder(request).setAuthorizationCode("fictional-code").setState(request.state).build()
                    assertTrue(runCatching { client.finishSignIn(valid.toIntent()) }.isFailure)
                    assertFalse(client.status.value.signedIn); assertTrue(fixture.requests.isEmpty())
                } finally { client.close(); vault.clear() }
            }
        }
    }
    @Test fun browserCancellationIsQuietButProviderErrorsRemainVisible() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            Fixture().use { fixture ->
                val vault = SecureVault(context, "test-cancel-${UUID.randomUUID()}")
                val client = ManagedClient(context, fixture.origin, vault) { }
                try {
                    for (result in listOf(null, AuthorizationException.GeneralErrors.USER_CANCELED_AUTH_FLOW.toIntent(),
                        AuthorizationException.GeneralErrors.PROGRAM_CANCELED_AUTH_FLOW.toIntent())) {
                        client.prepareSignIn()
                        assertEquals("cancelled", (runCatching { client.finishSignIn(result) }.exceptionOrNull() as? ManagedFailure)?.kind)
                        assertFalse(client.status.value.signingIn); assertFalse(client.status.value.busy)
                        assertFalse(client.status.value.signedIn); assertNull(client.status.value.error)
                    }
                    client.prepareSignIn()
                    assertEquals("sign_in_failed", (runCatching {
                        client.finishSignIn(AuthorizationException.GeneralErrors.SERVER_ERROR.toIntent())
                    }.exceptionOrNull() as? ManagedFailure)?.kind)
                    assertFalse(client.status.value.signingIn); assertNotNull(client.status.value.error)
                    assertTrue(fixture.requests.isEmpty())
                    authenticate(client, fixture); client.connect(fixture.org)
                    val connections = client.status.value.connections
                    client.prepareSignIn()
                    assertEquals("cancelled", (runCatching { client.finishSignIn(null) }.exceptionOrNull() as? ManagedFailure)?.kind)
                    assertTrue(client.status.value.signedIn); assertEquals(connections, client.status.value.connections)
                    assertNull(client.status.value.error)
                    val restored = ManagedClient(context, fixture.origin, vault) { }
                    try { restored.load(); assertFalse(restored.status.value.signingIn); assertTrue(restored.status.value.signedIn) }
                    finally { restored.close() }
                } finally { client.close(); vault.clear() }
            }
        }
    }
    @Test fun configurationValidationRejectsUnsafeOrUnboundSettings() {
        Fixture().use { fixture ->
            fun rejects(change: (JSONObject) -> Unit) {
                val value = fixture.configuration(); change(value)
                assertThrows(ManagedFailure::class.java) { parseConfiguration(value, fixture.origin, fixture.org, fixture.device) }
            }
            assertEquals(1, parseConfiguration(fixture.configuration(), fixture.origin, fixture.org, fixture.device).accounts.size)
            rejects { it.put("expiresAt", Instant.now().plusSeconds(172800).toString()) }
            rejects { it.put("expiresAt", Instant.now().minusSeconds(1).toString()) }
            rejects { it.getJSONObject("organisation").put("id", UUID.randomUUID().toString()) }
            rejects { it.getJSONArray("accounts").put(it.getJSONArray("accounts").getJSONObject(0)) }
            rejects { it.getJSONArray("accounts").getJSONObject(0).put("mode", "unsupported") }
            rejects { it.getJSONArray("accounts").getJSONObject(0).put("mode", "gateway") } // UDP/unencrypted fixture
            val gateway = fixture.configuration().also {
                val entry = it.getJSONArray("accounts").getJSONObject(0).put("mode", "gateway")
                entry.getJSONObject("settings").put("transport", "tls").put("srtp", "required")
            }
            assertEquals("gateway", parseConfiguration(gateway, fixture.origin, fixture.org, fixture.device).accounts.single().managedMode)
            rejects { it.getJSONArray("accounts").getJSONObject(0).getJSONObject("settings").put("domain", "example.invalid;transport=udp") }
            rejects { it.getJSONArray("accounts").getJSONObject(0).getJSONObject("settings").put("port", "5060") }
            rejects { it.getJSONArray("accounts").getJSONObject(0).getJSONObject("settings").put("stunServer", "https://stun.example.invalid") }
            val configured = fixture.configuration().also {
                it.getJSONArray("accounts").getJSONObject(0).getJSONObject("settings")
                    .put("stunServer", "stun.example.invalid:3478").put("displayName", "Test caller").put("voicemailNumber", "*98")
            }
            val mapped = parseConfiguration(configured, fixture.origin, fixture.org, fixture.device).accounts.single()
            assertEquals("stun.example.invalid:3478", mapped.stunServer)
            assertEquals("Test caller", mapped.displayName); assertEquals("*98", mapped.voicemailNumber)
        }
    }

    @Test fun incomingCallApiChecksDeviceBindingAndRejectsInvalidSnapshots() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            Fixture(gateway = true).use { fixture ->
                val vault = SecureVault(context, "test-calls-${UUID.randomUUID()}")
                var accounts = emptyList<SipAccount>()
                val client = ManagedClient(context, fixture.origin, vault) { accounts = it }
                try {
                    authenticate(client, fixture); client.connect(fixture.org)
                    assertEquals(fixture.device to fixture.account, client.gatewayBinding(accounts.single().id))
                    assertNull(client.gatewayBinding(UUID.randomUUID().toString()))
                    val requests = fixture.requests.size
                    assertEquals("access_denied", (runCatching { client.call(UUID.randomUUID().toString(), fixture.callId) }.exceptionOrNull() as ManagedFailure).kind)
                    assertTrue(runCatching { client.call(fixture.device, "../other") }.isFailure)
                    assertTrue(runCatching { client.call(fixture.device, fixture.callId, "delete") }.isFailure)
                    assertEquals(requests, fixture.requests.size)
                    val ringing = client.call(fixture.device, fixture.callId)
                    assertEquals("Fixture caller", ringing.caller); assertEquals("2000", ringing.callerNumber); assertFalse(ringing.unavailable())
                    assertEquals("GET", fixture.requests.last().method)
                    assertEquals("ringing", client.call(fixture.device, fixture.callId, "wake").state)
                    val answer = client.call(fixture.device, fixture.callId, "answer")
                    assertTrue(answer.claimedByThisDevice); assertEquals("answering", answer.state)
                    assertEquals("POST", fixture.requests.last().method)
                    assertEquals("{}", fixture.requests.last().body)
                    assertTrue(client.call(fixture.device, fixture.callId, "decline").unavailable())
                    fixture.callStatus = 409
                    assertEquals("call_unavailable", (runCatching { client.call(fixture.device, fixture.callId, "answer") }.exceptionOrNull() as ManagedFailure).kind)
                    fixture.callStatus = 200
                    fixture.wrongCall = true
                    assertEquals("invalid_response", (runCatching { client.call(fixture.device, fixture.callId) }.exceptionOrNull() as ManagedFailure).kind)
                    fixture.wrongCall = false
                    val snapshot = fixture.callSnapshot().put("caller", JSONObject().put("name", "Untrusted\r\nname").put("number", "2000"))
                    assertThrows(ManagedFailure::class.java) { parseManagedCall(snapshot, fixture.callId) }
                    assertFalse(client.status.value.busy)
                    assertNull(client.status.value.error) // Call polling must not replace the managed-account status.
                    client.signOut()
                    assertNull(client.gatewayBinding(accounts.firstOrNull()?.id ?: ""))
                    assertTrue(runCatching { client.call(fixture.device, fixture.callId) }.isFailure)
                } finally { client.close(); vault.clear() }
            }
        }
    }

    @Test fun pushTokensRotatePerDeviceAndRevokedCustomersDoNotBlockOthers() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            Fixture(gateway = true, multipleOrganisations = true).use { fixture ->
                val vault = SecureVault(context, "test-push-${UUID.randomUUID()}")
                val client = ManagedClient(context, fixture.origin, vault) { }
                try {
                    authenticate(client, fixture); client.connect(fixture.org); client.connect(fixture.secondOrg)
                    val first = "fictional-notification-token-1"; val second = "fictional-notification-token-2"
                    fun writes() = fixture.requests.filter { it.path.endsWith("/push") }
                    client.syncPushToken(first)
                    assertEquals(2, writes().size)
                    assertTrue(writes().all { it.method == "PUT" && JSONObject(it.body).getString("token") == first })
                    client.syncPushToken(first); assertEquals(2, writes().size)
                    client.syncPushToken(second); assertEquals(4, writes().size)
                    assertEquals(second, JSONObject(writes().last().body).getString("token"))
                    client.syncPushToken(null); assertEquals(6, writes().size)
                    assertTrue(writes().takeLast(2).all { it.method == "DELETE" })
                    client.syncPushToken(null); assertEquals(6, writes().size)
                    assertTrue(runCatching { client.syncPushToken("short") }.isFailure)
                    fixture.pushDenied = fixture.device
                    client.syncPushToken(first)
                    assertEquals("/api/client/devices/${fixture.secondDevice}/push", writes().last().path)
                    assertEquals("PUT", writes().last().method)
                    assertFalse(client.status.value.connections.first { it.deviceId == fixture.device }.configured)
                    assertTrue(client.status.value.connections.first { it.deviceId == fixture.secondDevice }.configured)
                    client.signOut()
                    val count = writes().size
                    client.syncPushToken(second); assertEquals(count, writes().size)
                } finally { client.close(); vault.clear() }
            }
        }
    }
    @Test fun pushWakeRefreshesOnlyAnEnrolledLiveCallAndCannotReviveSignedOutAccess() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            Fixture(gateway = true).use { fixture ->
                val vault = SecureVault(context, "test-wake-${UUID.randomUUID()}")
                var applied = emptyList<SipAccount>()
                val client = ManagedClient(context, fixture.origin, vault) { applied = it }
                try {
                    authenticate(client, fixture); client.connect(fixture.org)
                    val push = IncomingCallPush(fixture.device, fixture.callId, System.currentTimeMillis() + 45_000)
                    val count = fixture.requests.size
                    assertNull(client.wake(push.copy(deviceId = UUID.randomUUID().toString())))
                    assertNull(client.wake(push.copy(expiresAt = System.currentTimeMillis() - 1)))
                    assertEquals(count, fixture.requests.size)
                    assertEquals(applied.single().id, client.wake(push)?.id)
                    assertTrue(fixture.requests.takeLast(2).map { it.path.substringAfterLast('/') } == listOf("wake", "configuration"))
                    client.call(fixture.device, fixture.callId, "decline")
                    assertNull(client.wake(push))
                    assertTrue(fixture.requests.last().path.endsWith("/wake"))
                    fixture.callState = "ringing"
                    fixture.holdConfiguration = true
                    val waking = async { runCatching { client.wake(push) } }
                    assertTrue(withContext(Dispatchers.IO) { fixture.configurationStarted.await(3, TimeUnit.SECONDS) })
                    val signingOut = async { client.signOut() }; yield()
                    fixture.releaseConfiguration.countDown()
                    assertEquals("cancelled", (waking.await().exceptionOrNull() as? ManagedFailure)?.kind)
                    signingOut.await()
                    assertTrue(applied.isEmpty()); assertNull(vault.read())
                    val after = fixture.requests.size
                    assertNull(client.wake(push)); assertEquals(after, fixture.requests.size)
                } finally { fixture.releaseConfiguration.countDown(); client.close(); vault.clear() }
            }
        }
    }
    @Test fun directAccountsNeverReceiveAPushTokenAndMalformedWakeBindingIsRejected() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            Fixture().use { fixture ->
                val vault = SecureVault(context, "test-direct-push-${UUID.randomUUID()}")
                val client = ManagedClient(context, fixture.origin, vault) { }
                try {
                    authenticate(client, fixture); client.connect(fixture.org)
                    assertFalse(client.hasGatewayAccounts())
                    client.syncPushToken("fictional-notification-token")
                    assertEquals("DELETE", fixture.requests.last().method)
                    assertEquals("", fixture.requests.last().body)
                    assertTrue(runCatching { client.wake(IncomingCallPush(fixture.device, fixture.callId, System.currentTimeMillis() + 45_000)) }.isFailure)
                    fixture.wrongDevice = true
                    assertTrue(runCatching { client.wake(IncomingCallPush(fixture.device, fixture.callId, System.currentTimeMillis() + 45_000)) }.isFailure)
                    assertFalse(client.status.value.connections.single().configured)
                } finally { client.close(); vault.clear() }
            }
        }
    }

    @Test fun setupRedemptionBindsIdentityAndNeverSavesTheReference() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            Fixture().use { fixture ->
                val vault = SecureVault(context, "test-setup-${UUID.randomUUID()}")
                var applied = emptyList<SipAccount>()
                val client = ManagedClient(context, fixture.origin, vault) { applied = it }
                val reference = "b".repeat(43)
                val link = "${fixture.origin}/portal/setup#ref=$reference"
                try {
                    assertEquals("sign_in_required", (runCatching { client.connectSetupLink(link) }.exceptionOrNull() as? ManagedFailure)?.kind)
                    assertTrue(fixture.requests.isEmpty())
                    authenticate(client, fixture)
                    val before = fixture.requests.size
                    assertEquals("invalid_setup_link", (runCatching { client.connectSetupLink(link.replace("127.0.0.1", "localhost")) }.exceptionOrNull() as? ManagedFailure)?.kind)
                    assertEquals(before, fixture.requests.size)
                    fixture.setupUser = "other-person"
                    assertEquals("invalid_response", (runCatching { client.connectSetupLink(link) }.exceptionOrNull() as? ManagedFailure)?.kind)
                    assertTrue(client.status.value.connections.isEmpty()); assertTrue(applied.isEmpty())
                    fixture.setupUser = "fictional-user"; fixture.setupStatus = 404
                    assertEquals("setup_unavailable", (runCatching { client.connectSetupLink(link) }.exceptionOrNull() as? ManagedFailure)?.kind)
                    fixture.setupStatus = 200; fixture.setupOrg = fixture.secondOrg
                    client.connectSetupLink(link)
                    assertEquals(fixture.secondOrg, client.status.value.connections.single().organisationId)
                    assertTrue(client.status.value.connections.single().configured); assertEquals(1, applied.size)
                    val request = fixture.requests.first { it.path.endsWith("/setup-links/redeem") }
                    assertEquals("POST", request.method); assertEquals("Bearer fixture-access", request.authorization)
                    assertEquals(reference, JSONObject(request.body).getString("reference")); assertFalse(request.path.contains(reference))
                    val stored = vault.read()!!
                    try { assertFalse(stored.toString(Charsets.UTF_8).contains(reference)) } finally { stored.fill(0) }
                    assertFalse(client.status.value.toString().contains(reference))
                } finally { client.close(); vault.clear() }
            }
        }
    }
    @Test fun setupRedemptionCannotConnectAfterSignOut() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            Fixture().use { fixture ->
                val vault = SecureVault(context, "test-setup-race-${UUID.randomUUID()}")
                var applied = emptyList<SipAccount>()
                val client = ManagedClient(context, fixture.origin, vault) { applied = it }
                try {
                    authenticate(client, fixture); fixture.holdSetup = true
                    val connecting = async { runCatching { client.connectSetupLink("${fixture.origin}/portal/setup#ref=${"c".repeat(43)}") } }
                    assertTrue(withContext(Dispatchers.IO) { fixture.setupStarted.await(5, TimeUnit.SECONDS) })
                    val signingOut = async { client.signOut() }; yield()
                    fixture.releaseSetup.countDown()
                    assertEquals("cancelled", (connecting.await().exceptionOrNull() as? ManagedFailure)?.kind)
                    signingOut.await()
                    assertTrue(applied.isEmpty()); assertTrue(client.status.value.connections.isEmpty()); assertFalse(client.status.value.signedIn)
                    assertFalse(fixture.requests.any { it.path.endsWith("/devices") }); assertNull(vault.read())
                } finally { fixture.releaseSetup.countDown(); client.close(); vault.clear() }
            }
        }
    }

    @Test fun directoryPagesAreBoundCompleteEncryptedAndRestorable() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            Fixture().use { fixture ->
                val name = "test-directory-${UUID.randomUUID()}"; val vault = SecureVault(context, name, 16_000_000)
                val client = ManagedClient(context, fixture.origin, vault) { }
                var restored: ManagedClient? = null
                try {
                    authenticate(client, fixture); client.connect(fixture.org)
                    val contacts = List(101) { fixture.contact() }; val revision = UUID.randomUUID().toString()
                    val early = Instant.now().plusSeconds(300)
                    fixture.directoryHandler = { path ->
                        assertTrue(client.directories.value.isEmpty())
                        val page = if (!path.contains('?')) fixture.directory(contacts.take(100), revision).put("nextCursor", contacts[99].getString("id"))
                        else {
                            assertTrue(path.endsWith("?after=${contacts[99].getString("id")}&revision=$revision"))
                            fixture.directory(contacts.drop(100), revision).put("expiresAt", early.toString())
                        }
                        200 to page
                    }
                    val result = client.refreshDirectory(fixture.device)
                    assertEquals(101, result.contacts.size); assertEquals(early.toEpochMilli(), result.expiresAt)
                    assertEquals(result, client.directories.value[fixture.device])
                    assertEquals("+12025550101", client.directoryNumber(fixture.device, contacts[0].getString("id"), "+12025550101"))
                    assertThrows(ManagedFailure::class.java) { client.directoryNumber(fixture.device, contacts[0].getString("id"), "999") }
                    assertThrows(ManagedFailure::class.java) { client.directoryNumber(fixture.secondDevice, contacts[0].getString("id"), "+12025550101") }
                    val encrypted = File(context.noBackupFilesDir, "$name.enc").readText()
                    assertFalse(encrypted.contains("Example Reception")); assertFalse(encrypted.contains("+12025550101"))
                    assertFalse(client.status.value.toString().contains("Example Reception"))
                    restored = ManagedClient(context, fixture.origin, vault) { }; restored.load()
                    assertEquals(result, restored.directories.value[fixture.device])
                    // Same bounded vault implementation supports directory snapshots larger than the personal-store limit.
                    val large = SecureVault(context, "$name-large", 16_000_000)
                    try { val bytes = ByteArray(1_100_000) { 65 }; large.write(bytes); assertArrayEquals(bytes, large.read()) }
                    finally { large.clear() }
                } finally { restored?.close(); client.close(); vault.clear() }
            }
        }
    }
    @Test fun directoryStatusIsBoundEphemeralAndClearsOnDeniedAccess() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            Fixture().use { fixture ->
                val vault = SecureVault(context, "test-directory-status-${UUID.randomUUID()}")
                val client = ManagedClient(context, fixture.origin, vault) { }
                try {
                    authenticate(client, fixture); client.connect(fixture.org)
                    val contact = fixture.contact(); val id = contact.getString("id"); val revision = UUID.randomUUID().toString()
                    fixture.directoryHandler = { 200 to fixture.directory(listOf(contact), revision) }
                    client.refreshDirectory(fixture.device)
                    val saved = vault.read()!!
                    val base = JSONObject().put("deviceId", fixture.device).put("organisationId", fixture.org).put("revision", revision)
                        .put("expiresAt", Instant.now().plusSeconds(50).toString()).put("contacts", JSONArray().put(JSONObject()
                            .put("contactId", id).put("availability", "away").put("doNotDisturb", true)))
                    var response = base
                    fixture.directoryHandler = { path -> assertTrue(path.endsWith("/directory/status")); 200 to response }
                    val value = client.directoryStatus(fixture.device, listOf(id))
                    assertEquals("Away · Do Not Disturb", value.label(id)); assertTrue(value.expiresAt <= System.currentTimeMillis() + 30_000)
                    assertEquals("Status unavailable", value.label(id, value.expiresAt))
                    val request = fixture.requests.last(); assertEquals("POST", request.method)
                    assertEquals(revision, JSONObject(request.body).getString("revision")); assertEquals(id, JSONObject(request.body).getJSONArray("contactIds").getString(0))
                    response = JSONObject(base.toString()).put("contacts", JSONArray().put(JSONObject().put("contactId", id)
                        .put("availability", JSONObject.NULL).put("doNotDisturb", JSONObject.NULL)))
                    assertEquals("Status unavailable", client.directoryStatus(fixture.device, listOf(id)).label(id))
                    val activity = JSONObject().put("state", "in_call").put("source", "device").put("observedAt", Instant.now().toString())
                    response = JSONObject(base.toString()).put("contacts", JSONArray().put(JSONObject().put("contactId", id)
                        .put("availability", JSONObject.NULL).put("doNotDisturb", JSONObject.NULL).put("activity", activity)))
                    assertEquals("In a call · App report", client.directoryStatus(fixture.device, listOf(id)).label(id))
                    for ((field, invalid) in listOf("state" to "online", "source" to "pbx", "observedAt" to "2020-01-01T00:00:00Z",
                        "observedAt" to Instant.now().plusSeconds(120).toString(), "observedAt" to Instant.now().minusSeconds(160).toString())) {
                        response.getJSONArray("contacts").getJSONObject(0).put("activity", JSONObject(activity.toString()).put(field, invalid))
                        assertTrue(runCatching { client.directoryStatus(fixture.device, listOf(id)) }.isFailure)
                    }
                    for (field in listOf("deviceId", "organisationId", "revision", "expiresAt", "contacts")) {
                        response = JSONObject(base.toString()).put(field, when (field) {
                            "expiresAt" -> "2020-01-01T00:00:00Z"; "contacts" -> JSONArray(); else -> UUID.randomUUID().toString()
                        })
                        assertTrue(runCatching { client.directoryStatus(fixture.device, listOf(id)) }.isFailure)
                    }
                    for (variant in listOf("missing", "unknown", "partial", "string", "foreign", "duplicate")) {
                        val row = JSONObject().put("contactId", id).put("availability", "away").put("doNotDisturb", false)
                        when (variant) {
                            "missing" -> row.remove("doNotDisturb")
                            "unknown" -> row.put("availability", "online")
                            "partial" -> row.put("availability", JSONObject.NULL)
                            "string" -> row.put("doNotDisturb", "true")
                            "foreign" -> row.put("contactId", UUID.randomUUID().toString())
                        }
                        response = JSONObject(base.toString()).put("contacts", JSONArray().put(row).also { if (variant == "duplicate") it.put(row) })
                        assertTrue(runCatching { client.directoryStatus(fixture.device, listOf(id)) }.isFailure)
                    }
                    val count = fixture.requests.size
                    for (ids in listOf(emptyList(), listOf(id, id), listOf(UUID.randomUUID().toString()), List(101) { id }))
                        assertTrue(runCatching { client.directoryStatus(fixture.device, ids) }.isFailure)
                    assertEquals(count, fixture.requests.size); assertArrayEquals(saved, vault.read()); saved.fill(0)
                    fixture.directoryHandler = { 403 to JSONObject() }
                    assertTrue(runCatching { client.directoryStatus(fixture.device, listOf(id)) }.isFailure)
                    assertTrue(client.directories.value.isEmpty())
                    fixture.directoryHandler = { 200 to fixture.directory(listOf(contact), revision) }
                    client.refreshDirectory(fixture.device)
                    fixture.directoryHandler = { 200 to base }; fixture.holdDirectory = true
                    val loading = async { runCatching { client.directoryStatus(fixture.device, listOf(id)) } }
                    assertTrue(withContext(Dispatchers.IO) { fixture.directoryStarted.await(5, TimeUnit.SECONDS) })
                    val signingOut = async { client.signOut() }; yield(); fixture.releaseDirectory.countDown()
                    assertTrue(loading.await().isFailure); signingOut.await(); assertTrue(client.directories.value.isEmpty())
                } finally { fixture.releaseDirectory.countDown(); client.close(); vault.clear() }
            }
        }
    }

    @Test fun directoryRejectsInvalidDataAndRestartsRevisionChangesOnlyOnce() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            Fixture().use { fixture ->
                val vault = SecureVault(context, "test-directory-validation-${UUID.randomUUID()}")
                val client = ManagedClient(context, fixture.origin, vault) { }
                try {
                    authenticate(client, fixture); client.connect(fixture.org)
                    val original = client.refreshDirectory(fixture.device)
                    val changes: List<(JSONObject) -> Unit> = listOf(
                        { it.put("deviceId", fixture.secondDevice) }, { it.getJSONObject("organisation").put("id", fixture.secondOrg) },
                        { it.put("expiresAt", Instant.now().minusSeconds(1).toString()) },
                        { it.put("expiresAt", Instant.now().plusSeconds(172800).toString()) },
                        { it.getJSONArray("contacts").getJSONObject(0).put("name", "bad\nname") },
                        { it.getJSONArray("contacts").put(it.getJSONArray("contacts").getJSONObject(0)) },
                        { it.put("nextCursor", UUID.randomUUID().toString()) }, { it.remove("nextCursor") },
                        { it.getJSONArray("contacts").getJSONObject(0).getJSONArray("numbers").getJSONObject(0).put("number", "sip:100@example.invalid") },
                        { it.getJSONArray("contacts").getJSONObject(0).getJSONArray("numbers").put(it.getJSONArray("contacts").getJSONObject(0).getJSONArray("numbers").getJSONObject(0)) },
                    )
                    for (change in changes) {
                        fixture.directoryHandler = { 200 to fixture.directory().also(change) }
                        assertEquals("invalid_directory", (runCatching { client.refreshDirectory(fixture.device) }.exceptionOrNull() as? ManagedFailure)?.kind)
                        assertEquals(original, client.directories.value[fixture.device])
                    }
                    val contacts = List(100) { fixture.contact() }; var requests = 0
                    fixture.directoryHandler = { path ->
                        requests++
                        when (requests) {
                            1 -> 200 to fixture.directory(contacts).put("nextCursor", contacts.last().getString("id"))
                            2 -> 409 to JSONObject()
                            else -> { assertFalse(path.contains('?')); 200 to fixture.directory(emptyList()) }
                        }
                    }
                    assertTrue(client.refreshDirectory(fixture.device).contacts.isEmpty()); assertEquals(3, requests)
                    requests = 0
                    fixture.directoryHandler = { requests++; 200 to fixture.directory(contacts).put("nextCursor", contacts.last().getString("id")) }
                    assertEquals("directory_changed", (runCatching { client.refreshDirectory(fixture.device) }.exceptionOrNull() as? ManagedFailure)?.kind)
                    assertEquals(4, requests)
                    val repeated = fixture.directory(contacts).put("nextCursor", contacts.last().getString("id"))
                    fixture.directoryHandler = { 200 to repeated }
                    assertEquals("invalid_directory", (runCatching { client.refreshDirectory(fixture.device) }.exceptionOrNull() as? ManagedFailure)?.kind)
                    val archive = JSONObject(vault.read()!!.toString(Charsets.UTF_8))
                    archive.getJSONArray("enrollments").getJSONObject(0).getJSONObject("directory").put("userId", "someone-else")
                    vault.write(archive.toString().toByteArray())
                    val wrongUser = ManagedClient(context, fixture.origin, vault) { }
                    try { wrongUser.load(); assertFalse(wrongUser.status.value.signedIn); assertTrue(wrongUser.directories.value.isEmpty()) }
                    finally { wrongUser.close() }
                } finally { client.close(); vault.clear() }
            }
        }
    }
    @Test fun directoryExpiryDenialAndMembershipWithdrawalRemoveAccess() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            Fixture().use { fixture ->
                val vault = SecureVault(context, "test-directory-expiry-${UUID.randomUUID()}")
                val client = ManagedClient(context, fixture.origin, vault) { }
                try {
                    authenticate(client, fixture); client.connect(fixture.org)
                    val original = client.refreshDirectory(fixture.device)
                    fixture.directoryStatus = 503
                    assertEquals("unavailable", (runCatching { client.refreshDirectory(fixture.device) }.exceptionOrNull() as? ManagedFailure)?.kind)
                    assertEquals(original, client.directories.value[fixture.device])
                    fixture.directoryStatus = 403
                    assertEquals("access_denied", (runCatching { client.refreshDirectory(fixture.device) }.exceptionOrNull() as? ManagedFailure)?.kind)
                    assertTrue(client.directories.value.isEmpty())
                    fixture.directoryStatus = 200; client.refreshDirectory(fixture.device)
                    fixture.suspended = true; client.refresh(); assertTrue(client.directories.value.isEmpty())
                    fixture.suspended = false; client.refresh()
                    fixture.directoryHandler = { 200 to fixture.directory().put("expiresAt", Instant.now().plusSeconds(1).toString()) }
                    client.refreshDirectory(fixture.device); delay(1100)
                    assertThrows(ManagedFailure::class.java) { client.directoryNumber(fixture.device, original.contacts.first().id, "+12025550101") }
                    val restored = ManagedClient(context, fixture.origin, vault) { }
                    try { restored.load(); assertTrue(restored.directories.value.isEmpty()) }
                    finally { restored.close() }
                    client.reconcile(); assertTrue(client.directories.value.isEmpty())
                    fixture.directoryHandler = null; client.refreshDirectory(fixture.device)
                    fixture.configurationStatus = 403; runCatching { client.refresh() }; assertTrue(client.directories.value.isEmpty())
                } finally { client.close(); vault.clear() }
            }
        }
    }
    @Test fun lateDirectoryCannotRestoreDisconnectedOrSignedOutAccess() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            for (signOut in listOf(false, true)) Fixture().use { fixture ->
                val vault = SecureVault(context, "test-directory-race-${UUID.randomUUID()}")
                val client = ManagedClient(context, fixture.origin, vault) { }
                try {
                    authenticate(client, fixture); client.connect(fixture.org); client.refreshDirectory(fixture.device)
                    fixture.holdDirectory = true
                    val refreshing = async { runCatching { client.refreshDirectory(fixture.device) } }
                    assertTrue(withContext(Dispatchers.IO) { fixture.directoryStarted.await(5, TimeUnit.SECONDS) })
                    val removing = async { if (signOut) client.signOut() else client.disconnect(fixture.device) }
                    yield(); assertTrue(client.directories.value.isEmpty())
                    fixture.releaseDirectory.countDown()
                    assertEquals("cancelled", (refreshing.await().exceptionOrNull() as? ManagedFailure)?.kind)
                    removing.await(); assertTrue(client.directories.value.isEmpty()); assertTrue(client.status.value.connections.isEmpty())
                } finally { fixture.releaseDirectory.countDown(); client.close(); vault.clear() }
            }
        }
    }
    @Test fun directorySaveFailurePreservesTheLastSnapshotAndWithdrawalStillClearsRuntimeAccess() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            Fixture().use { fixture ->
                val name = "test-directory-save-${UUID.randomUUID()}"; val vault = SecureVault(context, name)
                val client = ManagedClient(context, fixture.origin, vault) { }
                try {
                    authenticate(client, fixture); client.connect(fixture.org)
                    val original = client.refreshDirectory(fixture.device)
                    // Delete only this disposable fixture's key, leaving its ciphertext to force a safe write failure.
                    java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry("${context.packageName}.$name") }
                    assertTrue(runCatching { client.refreshDirectory(fixture.device) }.isFailure)
                    assertEquals(original, client.directories.value[fixture.device])
                    client.signOut(); assertTrue(client.directories.value.isEmpty()); assertNull(vault.read())
                } finally { client.close(); vault.clear() }
            }
        }
    }

    @Test fun availabilityIsConfirmedIndependentlyAndClearedAfterUncertainWrites() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            Fixture(multipleOrganisations = true).use { fixture ->
                val vault = SecureVault(context, "test-availability-${UUID.randomUUID()}")
                val client = ManagedClient(context, fixture.origin, vault) { }
                try {
                    fixture.doNotDisturb = true; authenticate(client, fixture)
                    client.setAvailability(fixture.org, ManagedAvailability.AWAY)
                    assertEquals(listOf(ManagedAvailability.AWAY, ManagedAvailability.UNSET), client.status.value.organisations.map { it.availability })
                    assertEquals(true, client.status.value.organisations.first().doNotDisturb)
                    val body = JSONObject(fixture.requests.last { it.path.endsWith("/calling-preference") }.body)
                    assertEquals("away", body.getString("availability")); assertFalse(body.has("doNotDisturb"))
                    assertTrue(runCatching { client.setAvailability(UUID.randomUUID().toString(), ManagedAvailability.BUSY) }.isFailure)
                    fixture.availabilityResponse = "available"
                    assertTrue(runCatching { client.setAvailability(fixture.org, ManagedAvailability.BUSY) }.isFailure)
                    assertNull(client.status.value.organisations.first().availability)
                    assertEquals(true, client.status.value.organisations.first().doNotDisturb)
                    fixture.availabilityResponse = null; client.refresh(); fixture.preferenceStatus = 503
                    assertTrue(runCatching { client.setAvailability(fixture.org, ManagedAvailability.BUSY) }.isFailure)
                    assertNull(client.status.value.organisations.first().availability)
                    val restored = ManagedClient(context, fixture.origin, vault) { }
                    try { restored.load(); assertTrue(restored.status.value.organisations.all { it.availability == null }) } finally { restored.close() }
                    fixture.preferenceStatus = 200; fixture.legacyPreferences = true; client.refresh()
                    assertTrue(runCatching { client.setAvailability(fixture.org, ManagedAvailability.BUSY) }.isFailure)
                } finally { client.close(); vault.clear() }
            }
        }
    }

    @Test fun callingPreferencesAreCustomerBoundConfirmedAndUnavailableAfterFailure() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            Fixture(multipleOrganisations = true).use { fixture ->
                val vault = SecureVault(context, "test-preference-${UUID.randomUUID()}")
                val client = ManagedClient(context, fixture.origin, vault) { }
                try {
                    fixture.licensed = false
                    authenticate(client, fixture)
                    client.setDoNotDisturb(fixture.org, true)
                    assertEquals(listOf(true, false), client.status.value.organisations.map { it.doNotDisturb })
                    assertTrue(client.status.value.connections.isEmpty())
                    val write = fixture.requests.last { it.path.endsWith("/calling-preference") }
                    assertEquals("/api/client/organisations/${fixture.org}/calling-preference", write.path)
                    assertEquals("PATCH", write.method); assertEquals("Bearer fixture-access", write.authorization)
                    assertEquals(true, JSONObject(write.body).get("doNotDisturb"))
                    val writes = fixture.requests.count { it.path.endsWith("/calling-preference") }
                    assertTrue(runCatching { client.setDoNotDisturb(UUID.randomUUID().toString(), true) }.isFailure)
                    assertEquals(writes, fixture.requests.count { it.path.endsWith("/calling-preference") })
                    fixture.preferenceStatus = 403
                    assertTrue(runCatching { client.setDoNotDisturb(fixture.org, false) }.isFailure)
                    assertNull(client.status.value.organisations.first().doNotDisturb)
                    client.refresh(); assertEquals(true, client.status.value.organisations.first().doNotDisturb)
                    fixture.preferenceStatus = 200; fixture.preferenceResponse = "false"
                    assertTrue(runCatching { client.setDoNotDisturb(fixture.org, false) }.isFailure)
                    assertNull(client.status.value.organisations.first().doNotDisturb)
                    client.refresh(); fixture.preferenceResponse = true
                    assertTrue(runCatching { client.setDoNotDisturb(fixture.org, false) }.isFailure)
                    assertNull(client.status.value.organisations.first().doNotDisturb)
                    fixture.preferenceResponse = null; client.refresh()
                    val restored = ManagedClient(context, fixture.origin, vault) { }
                    try { restored.load(); assertTrue(restored.status.value.organisations.all { it.doNotDisturb == null }) }
                    finally { restored.close() }
                    fixture.organisationStatus = 503
                    assertTrue(runCatching { client.refresh() }.isFailure)
                    assertTrue(client.status.value.organisations.all { it.doNotDisturb == null })
                    fixture.organisationStatus = 200; fixture.suspended = true; client.refresh()
                    assertTrue(runCatching { client.setDoNotDisturb(fixture.org, true) }.isFailure)
                    fixture.suspended = false; fixture.legacyPreferences = true; client.refresh()
                    assertTrue(client.status.value.organisations.all { it.doNotDisturb == null })
                    assertTrue(runCatching { client.setDoNotDisturb(fixture.org, true) }.isFailure)
                } finally { client.close(); vault.clear() }
            }
        }
    }
    @Test fun directPolicyRemainsInTheProtectedConfigurationWhenPreferenceReadsAreUnavailable() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            Fixture().use { fixture ->
                val vault = SecureVault(context, "test-direct-policy-${UUID.randomUUID()}")
                var applied = emptyList<SipAccount>()
                val client = ManagedClient(context, fixture.origin, vault) { applied = it }
                try {
                    fixture.doNotDisturb = true; authenticate(client, fixture); client.connect(fixture.org)
                    assertTrue(applied.single().managedDoNotDisturb)
                    client.setDoNotDisturb(fixture.org, false); assertFalse(applied.single().managedDoNotDisturb)
                    client.setDoNotDisturb(fixture.org, true); assertTrue(applied.single().managedDoNotDisturb)
                    val restored = ManagedClient(context, fixture.origin, vault) { applied = it }
                    try { restored.load(); restored.reconcile(); assertTrue(applied.single().managedDoNotDisturb) }
                    finally { restored.close() }
                    fixture.organisationStatus = 503
                    assertTrue(runCatching { client.refresh() }.isFailure)
                    assertNull(client.status.value.organisations.single().doNotDisturb)
                    assertTrue(applied.single().managedDoNotDisturb)
                    for (value in listOf("true", 1, JSONObject.NULL)) {
                        val malformed = fixture.configuration().also { it.getJSONArray("accounts").getJSONObject(0).put("doNotDisturb", value) }
                        assertThrows(ManagedFailure::class.java) { parseConfiguration(malformed, fixture.origin, fixture.org, fixture.device) }
                    }
                    val legacy = fixture.configuration().also { it.getJSONArray("accounts").getJSONObject(0).remove("doNotDisturb") }
                    assertFalse(parseConfiguration(legacy, fixture.origin, fixture.org, fixture.device).accounts.single().managedDoNotDisturb)
                } finally { client.close(); vault.clear() }
            }
        }
    }
    @Test fun preferenceChangesWaitForConfirmationAndLateResponsesCannotSurviveSignOut() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            Fixture().use { fixture ->
                val vault = SecureVault(context, "test-preference-race-${UUID.randomUUID()}")
                val client = ManagedClient(context, fixture.origin, vault) { }
                try {
                    authenticate(client, fixture); fixture.holdPreference = true
                    val writing = async { runCatching { client.setDoNotDisturb(fixture.org, true) } }
                    assertTrue(withContext(Dispatchers.IO) { fixture.preferenceStarted.await(5, TimeUnit.SECONDS) })
                    assertEquals(false, client.status.value.organisations.single().doNotDisturb)
                    val signingOut = async { client.signOut() }
                    yield(); assertFalse(client.status.value.signedIn); assertTrue(client.status.value.organisations.isEmpty())
                    fixture.releasePreference.countDown()
                    assertEquals("cancelled", (writing.await().exceptionOrNull() as? ManagedFailure)?.kind)
                    signingOut.await(); assertTrue(client.status.value.organisations.isEmpty())
                } finally { fixture.releasePreference.countDown(); client.close(); vault.clear() }
            }
        }
    }

    @Test fun groupChangesVerifyExactStateJoiningHistoryAndLeaveWithoutAnArchive() = runBlocking<Unit> {
        withContext(Dispatchers.Main) { Fixture().use { fixture ->
            val vault = SecureVault(context, "test-group-${UUID.randomUUID()}")
            val client = ManagedClient(context, fixture.origin, vault) { }
            try {
                authenticate(client, fixture); client.connect(fixture.org)
                val saved = vault.read()!!.toString(Charsets.UTF_8); val id = fixture.conversationId
                val users = listOf("fictional-user", "peer", "second-peer")
                val c = fixture.conversation(id, users.drop(1), "Project").put("revision", "9007199254740994").put("ownerId", "peer")
                var result = fixture.messageScope().put("conversation", c)
                fixture.messageHandler = { request ->
                    if (request.path.endsWith("/group")) assertEquals("PUT", request.method)
                    200 to result
                }
                repeat(2) { assertEquals("peer", client.updateMessageGroup(fixture.device, id.uppercase(), "9007199254740993", " Project ", users, "peer").ownerId) }
                val writes = fixture.requests.filter { it.path.endsWith("/group") }
                assertEquals(2, writes.size); assertEquals(writes[0].body, writes[1].body)
                for ((field, invalid) in listOf("revision" to "9007199254740992", "ownerId" to "outsider", "title" to "Another name")) {
                    val previous = c.getString(field); c.put(field, invalid)
                    assertEquals("invalid_messages", (runCatching { client.updateMessageGroup(fixture.device, id, "9007199254740993", "Project", users, "peer") }.exceptionOrNull() as? ManagedFailure)?.kind)
                    c.put(field, previous)
                }
                val count = fixture.requests.size
                assertTrue(runCatching { client.updateMessageGroup(fixture.device, id, "01", "Project", users, "peer") }.isFailure)
                assertTrue(runCatching { client.updateMessageGroup(fixture.device, id, "1", " ", users, "peer") }.isFailure)
                assertTrue(runCatching { client.updateMessageGroup(fixture.device, id, "1", "Project", listOf("peer"), "peer") }.isFailure)
                assertEquals(count, fixture.requests.size)
                c.getJSONArray("participants").let { array -> repeat(array.length()) { array.getJSONObject(it).put("joinedSequence", "9007199254740993").put("lastReadSequence", "9007199254740993") } }
                result = fixture.messageScope().put("conversation", c).put("messages", JSONArray().put(fixture.message())).put("nextCursor", JSONObject.NULL)
                assertEquals("invalid_messages", (runCatching { client.conversationMessages(fixture.device, id) }.exceptionOrNull() as? ManagedFailure)?.kind)
                result.put("messages", JSONArray()); assertTrue(client.conversationMessages(fixture.device, id).messages.isEmpty())
                result = fixture.messageScope().put("conversationId", id).put("left", true)
                client.leaveMessageGroup(fixture.device, id.uppercase())
                result.put("conversationId", UUID.randomUUID().toString())
                assertEquals("invalid_messages", (runCatching { client.leaveMessageGroup(fixture.device, id) }.exceptionOrNull() as? ManagedFailure)?.kind)
                assertEquals(saved, vault.read()!!.toString(Charsets.UTF_8))
            } finally { client.close(); vault.clear() }
        } }
    }
    @Test fun messagesUseBoundBearerRoutesExactRetriesAndNoArchive() = runBlocking<Unit> {
        withContext(Dispatchers.Main) { Fixture().use { fixture ->
            val vault = SecureVault(context, "test-messages-${UUID.randomUUID()}")
            val client = ManagedClient(context, fixture.origin, vault) { }
            try {
                authenticate(client, fixture); client.connect(fixture.org)
                val saved = vault.read()!!.toString(Charsets.UTF_8)
                fixture.messageHandler = { request ->
                    assertEquals("Bearer fixture-access", request.authorization)
                    val input = if (request.body.isEmpty()) JSONObject() else JSONObject(request.body)
                    200 to fixture.messageScope().apply { when {
                        request.path.contains("/people") -> put("people", JSONArray().put(JSONObject().put("id", "peer").put("name", "Example colleague"))).put("nextCursor", JSONObject.NULL)
                        request.path.endsWith("/read") -> put("sequence", input.getString("sequence"))
                        request.path.endsWith("/conversations") -> if (request.method == "POST") put("conversation", if (input.getJSONArray("userIds").length() == 1) fixture.conversation()
                            else fixture.conversation(input.getString("id"), listOf("peer", "second-peer"), input.getString("title")))
                            else put("conversations", JSONArray().put(fixture.conversation())).put("nextCursor", JSONObject.NULL)
                        request.method == "POST" -> put("message", fixture.message().put("id", input.getString("id")).put("text", input.getString("text")))
                        else -> put("conversation", fixture.conversation()).put("messages", JSONArray().put(fixture.message())).put("nextCursor", JSONObject.NULL)
                    } }
                }
                assertEquals("peer", client.messagePeople(fixture.device, " Example ", "older-peer").people.single().id)
                assertTrue(fixture.requests.last().path.endsWith("/people?q=Example&after=older-peer"))
                assertEquals(fixture.conversationId, client.conversations(fixture.device).conversations.single().id)
                assertEquals(fixture.conversationId, client.createConversation(fixture.device, UUID.randomUUID().toString(), listOf("peer")).id)
                val group = UUID.randomUUID().toString()
                assertEquals(group, client.createConversation(fixture.device, group.uppercase(), listOf("peer", "second-peer"), " Team ").id)
                val nonce = UUID.randomUUID().toString(); val text = "<b>literal text</b>\n🌱"
                assertEquals(text, client.sendMessage(fixture.device, fixture.conversationId.uppercase(), nonce.uppercase(), text).text)
                assertEquals("9007199254740993", client.sendMessage(fixture.device, fixture.conversationId, nonce, text).sequence)
                val writes = fixture.requests.filter { it.path.endsWith(fixture.conversationId) && it.method == "POST" }
                assertEquals(2, writes.size); assertEquals(writes.first().body, writes.last().body)
                assertEquals("9007199254740993", client.conversationMessages(fixture.device, fixture.conversationId, after = "9007199254740992").messages.single().sequence)
                assertEquals("9007199254740993", client.markConversationRead(fixture.device, fixture.conversationId, "9007199254740993"))
                assertEquals(saved, vault.read()!!.toString(Charsets.UTF_8)); assertFalse(client.status.value.toString().contains("literal text"))
                val count = fixture.requests.size
                for (invalid in listOf("", " ", "x".repeat(4097), "x\u0000")) assertTrue(runCatching { client.sendMessage(fixture.device, fixture.conversationId, nonce, invalid) }.isFailure)
                for (invalid in listOf("01", "-1", "1.1", "9223372036854775808")) assertTrue(runCatching { client.markConversationRead(fixture.device, fixture.conversationId, invalid) }.isFailure)
                assertTrue(runCatching { client.conversationMessages(fixture.device, fixture.conversationId, before = "1", after = "2") }.isFailure)
                assertTrue(runCatching { client.conversationMessages(fixture.device, fixture.conversationId, after = "0") }.isFailure)
                assertTrue(runCatching { client.createConversation(fixture.device, nonce, listOf("fictional-user")) }.isFailure)
                assertTrue(runCatching { client.createConversation(fixture.device, nonce, listOf("peer", "peer")) }.isFailure)
                assertTrue(runCatching { client.conversations(fixture.device, "invalid cursor") }.isFailure)
                assertEquals(count, fixture.requests.size)
            } finally { client.close(); vault.clear() }
        } }
    }
    @Test fun messagesRejectPoisonedScopesHistoriesSendBindingsAndQuotas() = runBlocking<Unit> {
        withContext(Dispatchers.Main) { Fixture().use { fixture ->
            val vault = SecureVault(context, "test-message-validation-${UUID.randomUUID()}")
            val client = ManagedClient(context, fixture.origin, vault) { }
            try {
                authenticate(client, fixture); client.connect(fixture.org)
                fun page() = fixture.messageScope().put("conversation", fixture.conversation()).put("messages", JSONArray().put(fixture.message())).put("nextCursor", JSONObject.NULL)
                val mutations: List<(JSONObject) -> Unit> = listOf(
                    { it.put("schemaVersion", 2) }, { it.put("userId", "another-user") }, { it.put("deviceId", UUID.randomUUID().toString()) },
                    { it.getJSONObject("organisation").put("id", UUID.randomUUID().toString()) },
                    { it.put("expiresAt", Instant.now().minusSeconds(1).toString()) }, { it.put("expiresAt", Instant.now().plusSeconds(61).toString()) },
                    { it.put("retentionDays", 0) }, { it.put("retentionDays", 3651) },
                    { it.getJSONObject("conversation").put("id", UUID.randomUUID().toString()) },
                    { it.getJSONObject("conversation").put("participants", JSONArray().put(JSONObject().put("id", "peer").put("name", "Peer").put("lastReadSequence", "0"))) },
                    { it.getJSONObject("conversation").put("lastSequence", "1.1") },
                    { it.getJSONArray("messages").getJSONObject(0).put("sequence", "0") },
                    { it.getJSONArray("messages").getJSONObject(0).put("sequence", "1.1") },
                    { it.getJSONArray("messages").getJSONObject(0).put("sequence", "9223372036854775808") },
                    { it.getJSONArray("messages").put(it.getJSONArray("messages").getJSONObject(0)) },
                    { it.getJSONArray("messages").put(fixture.message("1")) },
                    { it.getJSONArray("messages").getJSONObject(0).put("text", "x\u0000") },
                    { it.getJSONArray("messages").getJSONObject(0).put("text", "x".repeat(4097)) },
                    { it.put("nextCursor", "9007199254740993") }, { it.remove("nextCursor") }
                )
                for (mutate in mutations) {
                    fixture.messageHandler = { 200 to page().also(mutate) }
                    assertEquals("invalid_messages", (runCatching { client.conversationMessages(fixture.device, fixture.conversationId) }.exceptionOrNull() as? ManagedFailure)?.kind)
                }
                fixture.messageHandler = { 200 to page() }
                assertEquals("invalid_messages", (runCatching { client.conversationMessages(fixture.device, fixture.conversationId, after = "9007199254740993") }.exceptionOrNull() as? ManagedFailure)?.kind)
                fixture.messageHandler = { 200 to fixture.messageScope().put("message", fixture.message().put("senderId", "peer")) }
                assertEquals("invalid_messages", (runCatching { client.sendMessage(fixture.device, fixture.conversationId, UUID.randomUUID().toString(), "Hello") }.exceptionOrNull() as? ManagedFailure)?.kind)
                fixture.messageHandler = { 200 to fixture.messageScope().put("sequence", "1") }
                assertEquals("invalid_messages", (runCatching { client.markConversationRead(fixture.device, fixture.conversationId, "2") }.exceptionOrNull() as? ManagedFailure)?.kind)
                for ((status, kind) in listOf(400 to "invalid_message_input", 409 to "messages_changed", 429 to "message_rate_limit", 503 to "unavailable")) {
                    fixture.messageHandler = { status to JSONObject() }
                    assertEquals(kind, (runCatching { client.conversations(fixture.device) }.exceptionOrNull() as? ManagedFailure)?.kind)
                }
            } finally { client.close(); vault.clear() }
        } }
    }
    @Test fun messagesBoundUnicodePagesAndDirectionalCursors() = runBlocking<Unit> {
        withContext(Dispatchers.Main) { Fixture().use { fixture ->
            val vault = SecureVault(context, "test-message-pages-${UUID.randomUUID()}")
            val client = ManagedClient(context, fixture.origin, vault) { }
            try {
                authenticate(client, fixture); client.connect(fixture.org)
                val messages = JSONArray((2..101).map { fixture.message(it.toString()).put("text", "界".repeat(4096)) })
                var cursor = "2"
                fixture.messageHandler = { 200 to fixture.messageScope().put("conversation", fixture.conversation()).put("messages", messages).put("nextCursor", cursor) }
                assertEquals(100, client.conversationMessages(fixture.device, fixture.conversationId).messages.size)
                cursor = "101"; assertEquals("101", client.conversationMessages(fixture.device, fixture.conversationId, after = "1").nextCursor)
                assertEquals("invalid_messages", (runCatching { client.conversationMessages(fixture.device, fixture.conversationId) }.exceptionOrNull() as? ManagedFailure)?.kind)
                fixture.messageHandler = { 200 to fixture.messageScope().put("padding", "x".repeat(2_000_001)) }
                assertEquals("invalid_messages", (runCatching { client.conversations(fixture.device) }.exceptionOrNull() as? ManagedFailure)?.kind)
            } finally { client.close(); vault.clear() }
        } }
    }
    @Test fun lateMessagesCannotRestoreDisconnectedOrSignedOutAccess() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            for (signOut in listOf(false, true)) Fixture().use { fixture ->
                val vault = SecureVault(context, "test-message-race-${UUID.randomUUID()}")
                val client = ManagedClient(context, fixture.origin, vault) { }
                try {
                    authenticate(client, fixture); client.connect(fixture.org)
                    fixture.messageHandler = { 200 to fixture.messageScope().put("conversation", fixture.conversation()).put("messages", JSONArray().put(fixture.message())).put("nextCursor", JSONObject.NULL) }
                    fixture.holdMessages = true
                    val reading = async { runCatching { client.conversationMessages(fixture.device, fixture.conversationId) } }
                    assertTrue(withContext(Dispatchers.IO) { fixture.messagesStarted.await(5, TimeUnit.SECONDS) })
                    val removing = async { if (signOut) client.signOut() else client.disconnect(fixture.device) }
                    yield(); assertTrue(client.status.value.connections.isEmpty())
                    fixture.releaseMessages.countDown()
                    assertTrue((reading.await().exceptionOrNull() as? ManagedFailure)?.kind in setOf("cancelled", "access_denied"))
                    removing.await(); assertTrue(client.status.value.connections.isEmpty())
                } finally { fixture.releaseMessages.countDown(); client.close(); vault.clear() }
            }
        }
    }

    private data class Request(val path: String, val body: String, val method: String, val authorization: String? = null)
    /** Protocol fixture only: it neither opens a browser nor authenticates a real person. */
    private class Fixture(private val gateway: Boolean = false, private val multipleOrganisations: Boolean = false) : AutoCloseable {
        private val socket = ServerSocket(0, 10, java.net.InetAddress.getByName("127.0.0.1"))
        val origin = "http://127.0.0.1:${socket.localPort}"
        val org = UUID.randomUUID().toString(); val device = UUID.randomUUID().toString(); val account = UUID.randomUUID().toString()
        val secondOrg = UUID.randomUUID().toString(); val secondDevice = UUID.randomUUID().toString()
        val requests = CopyOnWriteArrayList<Request>()
        @Volatile var wrongDevice = false
        @Volatile var suspended = false
        @Volatile var reportAccepted = true
        @Volatile var configurationStatus = 200
        @Volatile var organisationStatus = 200
        @Volatile var licensed = true
        @Volatile var doNotDisturb = false
        @Volatile var preferenceStatus = 200
        @Volatile var preferenceResponse: Any? = null
        @Volatile var legacyPreferences = false
        @Volatile var holdPreference = false
        val preferenceStarted = CountDownLatch(1); val releasePreference = CountDownLatch(1)
        @Volatile var expiry = Instant.now().plusSeconds(600).toString()
        @Volatile var holdConfiguration = false
        val callId = UUID.randomUUID().toString()
        @Volatile var wrongCall = false
        @Volatile var availability = "unset"
        @Volatile var availabilityResponse: Any? = null
        @Volatile var callStatus = 200
        @Volatile var callState = "ringing"
        @Volatile var pushDenied: String? = null
        @Volatile var setupUser = "fictional-user"
        @Volatile var setupOrg = org
        @Volatile var setupStatus = 200
        @Volatile var holdSetup = false
        val setupStarted = CountDownLatch(1); val releaseSetup = CountDownLatch(1)
        val configurationStarted = CountDownLatch(1); val releaseConfiguration = CountDownLatch(1)
        @Volatile var directoryStatus = 200
        @Volatile var directoryHandler: ((String) -> Pair<Int, JSONObject>)? = null
        @Volatile var holdDirectory = false
        val directoryStarted = CountDownLatch(1); val releaseDirectory = CountDownLatch(1)
        val conversationId = UUID.randomUUID().toString()
        val meetingId = UUID.randomUUID().toString()
        @Volatile var meetingHandler: ((Request) -> Pair<Int, JSONObject>)? = null
        @Volatile var holdMeetingJoin = false
        val meetingJoinStarted = CountDownLatch(1); val releaseMeetingJoin = CountDownLatch(1)
        @Volatile var messageHandler: ((Request) -> Pair<Int, JSONObject>)? = null
        @Volatile var holdMessages = false
        val messagesStarted = CountDownLatch(1); val releaseMessages = CountDownLatch(1)
        private val worker = thread(isDaemon = true, name = "Sipper managed fixture") {
            while (!socket.isClosed) {
                val client = try { socket.accept() } catch (_: Exception) { break }
                client.use {
                    try {
                        client.soTimeout = 5000
                        val input = client.getInputStream().buffered()
                        fun line(): String? {
                            val bytes = java.io.ByteArrayOutputStream()
                            while (true) { val byte = input.read(); if (byte == -1) return null; if (byte == 10) return bytes.toString("UTF-8").removeSuffix("\r"); bytes.write(byte) }
                        }
                        val request = line()?.split(' ') ?: return@use
                        var length = 0
                        var authorization: String? = null
                        while (true) { val line = line() ?: break; if (line.isEmpty()) break
                            if (line.startsWith("content-length:", true)) length = line.substringAfter(':').trim().toInt()
                            if (line.startsWith("authorization:", true)) authorization = line.substringAfter(':').trim()
                        }
                        require(length in 0..1_000_000)
                        val bytes = ByteArray(length); var read = 0
                        while (read < length) { val count = input.read(bytes, read, length - read); check(count > 0); read += count }
                        val bodyText = bytes.toString(Charsets.UTF_8)
                        val path = request[1]; val observed = Request(path, bodyText, request[0], authorization); requests.add(observed)
                        if (path.endsWith("/setup-links/redeem") && holdSetup) { setupStarted.countDown(); releaseSetup.await(5, TimeUnit.SECONDS) }
                        if (path.endsWith("/configuration") && holdConfiguration) { configurationStarted.countDown(); releaseConfiguration.await(5, TimeUnit.SECONDS) }
                        if (path.contains("/directory") && holdDirectory) { directoryStarted.countDown(); releaseDirectory.await(5, TimeUnit.SECONDS) }
                        if (path.endsWith("/calling-preference") && holdPreference) { preferenceStarted.countDown(); releasePreference.await(5, TimeUnit.SECONDS) }
                        if (path.contains("/messages/") && holdMessages) { messagesStarted.countDown(); releaseMessages.await(5, TimeUnit.SECONDS) }
                        if (path.contains("/conferencing/") && path.endsWith("/join") && holdMeetingJoin) { meetingJoinStarted.countDown(); releaseMeetingJoin.await(5, TimeUnit.SECONDS) }
                        val meeting = if (path.contains("/conferencing/")) meetingHandler?.invoke(observed) else null
                        val messages = if (path.contains("/messages/")) messageHandler?.invoke(observed) else null
                        val directory = if (path.contains("/directory")) directoryHandler?.invoke(path) ?: (directoryStatus to directory()) else null
                        val status = meeting?.first ?: messages?.first ?: directory?.first ?: when { path.endsWith("/calling-preference") -> preferenceStatus; path.endsWith("/setup-links/redeem") -> setupStatus; path.endsWith("/push") && path.contains(pushDenied ?: "never-match") -> 403; path.endsWith("/configuration") -> configurationStatus; path.endsWith("/organisations") -> organisationStatus; path.contains("/calls/") -> callStatus; else -> 200 }
                        val body = when {
                            status != 200 -> JSONObject().put("error", "fixture_failure")
                            meeting != null -> meeting.second
                            messages != null -> messages.second
                            directory != null -> directory.second
                            path.endsWith("/calling-preference") -> {
                                val input = JSONObject(bodyText)
                                if (input.has("doNotDisturb")) doNotDisturb = input.getBoolean("doNotDisturb")
                                if (input.has("availability")) availability = input.getString("availability")
                                JSONObject().put("doNotDisturb", preferenceResponse ?: doNotDisturb).put("availability", availabilityResponse ?: availability)
                            }
                            path.endsWith("/setup-links/redeem") -> JSONObject().put("userId", setupUser).put("organisation", JSONObject()
                                .put("id", setupOrg).put("name", "Fixture business").put("status", "active").put("licensed", true))
                            path.endsWith("/token") -> JSONObject().put("access_token", "fixture-access").put("refresh_token", "fixture-refresh").put("token_type", "Bearer").put("expires_in", if (requests.count { it.path.endsWith("/token") } == 1) 30 else 3600)
                            path.endsWith("/organisations") -> JSONObject().put("user", JSONObject().put("id", "fictional-user").put("email", "android@example.invalid"))
                                .put("organisations", JSONArray().apply { for (id in if (multipleOrganisations) listOf(org, secondOrg) else listOf(org)) put(JSONObject().put("id", id).put("name", "Fixture business").put("status", if (suspended) "suspended" else "active").put("licensed", licensed).also { if (!legacyPreferences) it.put("doNotDisturb", id == org && doNotDisturb).put("availability", if (id == org) availability else "unset") }) })
                            path.endsWith("/devices") -> JSONObject().put("id", if (path.contains(secondOrg)) secondDevice else device).put("name", "Sipper on Android").put("platform", "android")
                            path.endsWith("/configuration") -> configuration().also { if (path.contains(secondDevice)) { it.put("deviceId", secondDevice); it.getJSONObject("organisation").put("id", secondOrg) } }
                            path.endsWith("/push") -> if (request[0] == "DELETE") JSONObject().put("removed", true) else JSONObject().put("registered", true).put("provider", "fcm")
                            path.contains("/calls/") -> {
                                if (path.endsWith("/answer")) callState = "answering"
                                if (path.endsWith("/decline")) callState = "ended"
                                callSnapshot()
                            }
                            path.endsWith("/report") -> JSONObject().put("accepted", reportAccepted)
                            else -> JSONObject().put("accepted", true)
                        }.toString().toByteArray()
                        client.getOutputStream().write("HTTP/1.1 $status Fixture\r\nContent-Type: application/json\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray() + body)
                    } catch (_: Exception) { }
                }
            }
        }
        fun configuration() = JSONObject().put("schemaVersion", 1).put("organisation", JSONObject().put("id", org).put("name", "Fixture business"))
            .put("deviceId", if (wrongDevice) UUID.randomUUID().toString() else device).put("revision", "a".repeat(64)).put("expiresAt", expiry)
            .put("accounts", JSONArray().put(JSONObject().put("id", account).put("label", "Managed fixture").put("mode", if (gateway) "gateway" else "direct").put("revision", 1).put("doNotDisturb", doNotDisturb).put("password", "fictional-sip-secret")
                .put("settings", JSONObject().put("username", "100").put("authUsername", "").put("domain", "example.invalid").put("server", "127.0.0.1").put("port", 59999)
                    .put("transport", if (gateway) "tls" else "udp").put("srtp", if (gateway) "required" else "disabled").put("displayName", "").put("voicemailNumber", "*97").put("useICE", false).put("stunServer", ""))))
        fun callSnapshot() = JSONObject().put("id", if (wrongCall) UUID.randomUUID().toString() else callId)
            .put("configurationId", account).put("state", callState).put("version", 1).put("expiresAt", expiry)
            .put("claimedByThisDevice", callState == "answering")
            .put("caller", JSONObject().put("name", "Fixture caller").put("number", "2000"))
        fun contact() = JSONObject().put("id", UUID.randomUUID().toString()).put("name", "Example Reception").put("company", "Fictional Company")
            .put("revision", 1).put("updatedAt", Instant.now().toString())
            .put("numbers", JSONArray().put(JSONObject().put("label", "Work").put("number", "+12025550101")))
        fun directory(contacts: List<JSONObject> = listOf(contact()), revision: String = UUID.randomUUID().toString()) =
            JSONObject().put("organisation", JSONObject().put("id", org).put("name", "Fixture business")).put("deviceId", device)
                .put("revision", revision).put("expiresAt", Instant.now().plusSeconds(600).toString()).put("contacts", JSONArray(contacts)).put("nextCursor", JSONObject.NULL)
        fun messageScope() = JSONObject().put("schemaVersion", 1).put("organisation", JSONObject().put("id", org).put("name", "Fixture business"))
            .put("deviceId", device).put("userId", "fictional-user").put("expiresAt", Instant.now().plusSeconds(30).toString()).put("retentionDays", 30)
        fun conversation(id: String = conversationId, peers: List<String> = listOf("peer"), title: String = "Example colleague") =
            JSONObject().put("id", id).put("kind", if (peers.size == 1) "direct" else "group").put("title", title)
                .put("createdAt", "2026-01-01T00:00:00Z").put("updatedAt", Instant.now().toString()).put("unread", 1).put("lastSequence", "9007199254740993")
                .put("participants", JSONArray((listOf("fictional-user") + peers).map { JSONObject().put("id", it).put("name", it).put("lastReadSequence", "0") }))
        fun message(sequence: String = "9007199254740993") = JSONObject().put("id", UUID.randomUUID().toString()).put("sequence", sequence)
            .put("senderId", "fictional-user").put("senderName", "Example person").put("text", "<b>literal text</b>\n🌱").put("createdAt", Instant.now().toString())
        fun meetingRecord() = JSONObject().put("id", meetingId).put("conversationId", conversationId).put("createdBy", "fictional-user")
            .put("createdAt", Instant.now().minusSeconds(60).toString()).put("expiresAt", Instant.now().plusSeconds(3600).toString())
            .put("endedAt", JSONObject.NULL).put("controlConfirmedAt", JSONObject.NULL)
        fun grant(session: String, extra: String? = null): JSONObject {
            val expiry = Instant.now().epochSecond + 119
            val video = JSONObject().put("room", "sipper-$meetingId").put("roomJoin", true).put("canSubscribe", true).put("canPublish", true)
                .put("canPublishSources", JSONArray(listOf("microphone", "camera", "screen_share", "screen_share_audio"))).put("canPublishData", false).put("canUpdateOwnMetadata", false)
            if (extra != null) video.put(extra, true)
            val claims = JSONObject().put("iss", "fictional-key").put("sub", "sipper:$session").put("exp", expiry).put("nbf", Instant.now().epochSecond).put("video", video)
            fun base(bytes: ByteArray) = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
            val token = base(JSONObject().put("alg", "HS256").put("typ", "JWT").toString().toByteArray()) + "." + base(claims.toString().toByteArray()) + "." + base(ByteArray(32))
            // Deliberately unsigned protocol fixture; only the real proxy/SFU verifies signatures.
            return JSONObject().put("schemaVersion", 1).put("organisationId", org).put("meetingId", meetingId).put("sessionId", session)
                .put("identity", "sipper:$session").put("url", "wss://meet.example.invalid").put("token", token).put("expiresAt", Instant.ofEpochSecond(expiry).toString())
        }
        fun meetingReply(request: Request): JSONObject = when {
            request.path.endsWith("/join") -> grant(JSONObject(request.body).getString("id"))
            request.path.endsWith("/leave") -> messageScope().put("meetingId", meetingId).put("sessionId", request.path.substringAfter("/sessions/").substringBefore('/')).put("leaveRequested", true)
            request.path.contains("/people/") -> messageScope().put("meetingId", meetingId).put("targetUserId", URLDecoder.decode(request.path.substringAfterLast('/'), "UTF-8")).put("removalRequested", true)
            request.path.endsWith("/end") -> messageScope().put("meeting", meetingRecord().put("endedAt", Instant.now().toString()))
            request.path.endsWith("/meeting") -> messageScope().put("available", true).put("meeting", meetingRecord())
            else -> messageScope().put("available", true).put("canJoin", true).put("title", "Example meeting").put("hostName", "Fictional user").put("meeting", meetingRecord()).put("sessions", JSONArray())
        }
        override fun close() { releaseMeetingJoin.countDown(); releaseMessages.countDown(); releasePreference.countDown(); releaseDirectory.countDown(); releaseSetup.countDown(); releaseConfiguration.countDown(); socket.close(); worker.join(1000) }
    }
}
