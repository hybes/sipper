package com.hybes.sipper

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.security.KeyStore
import android.util.AtomicFile
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import org.json.JSONObject
import org.json.JSONArray
import java.util.Base64

@RunWith(AndroidJUnit4::class)
class EngineTest {
    @Test fun consultationEntryUsesTelecomHoldAndReturnsToCallControls() = runBlocking<Unit> {
        assumeTrue(InstrumentationRegistry.getArguments().getString("dndRegistrar") == "10.0.2.2")
        assertEquals("Grant microphone permission on the QA emulator before running the consultation test.",
            android.content.pm.PackageManager.PERMISSION_GRANTED, context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO))
        // Run only in a clean, disposable app profile; never register saved accounts.
        assumeTrue(AccountStore(SecureVault(context, "personal-accounts")).accounts.isEmpty())
        assumeTrue(!File(context.noBackupFilesDir, "managed-session.enc").exists())
        val names = listOf("personal-accounts", "call-history", "managed-session")
        val saved = names.associateWith { File(context.noBackupFilesDir, "$it.enc").takeIf(File::exists)?.readBytes() }
        val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existed = names.associateWith { keys.containsAlias("${context.packageName}.$it") }
        withContext(Dispatchers.Main) {
            val model = PhoneModel(context.applicationContext as android.app.Application, SipEngine(context, silentAudio = true))
            try {
                withTimeout(15_000) { model.awaitReady() }
                val account = SipAccount(label = "Consultation fixture", username = "dnd-user", password = "fictional-dnd", domain = "sipper.test",
                    server = "10.0.2.2", port = 5098, transport = "udp", srtp = "disabled", ice = false)
                assertTrue(model.save(account))
                withTimeout(6000) { model.registrations.first { it[account.id]?.state == "registered" } }
                suspend fun connected(number: String = "*97"): PhoneCall {
                    val before = model.calls.value.map { it.id }.toSet()
                    model.error.value = null
                    val placed = model.dial(account.id, number)
                    assertTrue("Could not place fixture call: ${model.error.value}", placed)
                    assertTrue("The previous call must be held before the consultation is placed", model.calls.value.filter { it.id in before && it.connected }.all { it.held })
                    val connected = withTimeoutOrNull(10_000) { model.calls.first { values -> values.any { it.id !in before && it.connected } } }
                    assertNotNull("Call did not connect: ${model.error.value}", connected)
                    val call = connected!!.single { it.id !in before && it.connected }
                    assertTrue(model.bridge!!.awaitPresentation(call.id))
                    return call
                }
                val first = connected("sip:*slowhold@sipper.test;transport=udp")
                assertTrue(model.prepareNewCall(first.id))
                assertEquals(first.id, model.newCallFrom.value)
                assertFalse(model.calls.value.single().held)
                model.returnToCalls()
                assertNull(model.newCallFrom.value)
                assertFalse("Cancelling never holds a call", model.calls.value.single().held)
                assertTrue(model.prepareNewCall(first.id))
                assertFalse(model.dial(account.id, "()"))
                assertEquals("Failed dial keeps the draft", first.id, model.newCallFrom.value)
                assertFalse(model.calls.value.single().held)
                val second = connected()
                assertNull(model.newCallFrom.value)
                withTimeout(10_000) { model.calls.first { values -> values.any { it.id == first.id && it.held } } }
                model.engine.attendedTransfer(first.id, second.id)
                withTimeout(10_000) { model.calls.first { it.isEmpty() }; model.bridge!!.routes.first { it.isEmpty() } }
                assertFalse(model.prepareNewCall(first.id))
                val last = connected()
                assertTrue(model.prepareNewCall(last.id))
                assertTrue(model.callAction(last.id, "hangup"))
                withTimeout(10_000) { model.calls.first { it.isEmpty() }; model.newCallFrom.first { it == null }; model.bridge!!.routes.first { it.isEmpty() } }
                val rejected = connected("sip:*nohold@sipper.test;transport=udp")
                assertTrue(model.prepareNewCall(rejected.id))
                assertFalse("The phone system's hold rejection must prevent the next call", model.dial(account.id, "*97"))
                assertTrue(model.error.value?.contains("SIP 488") == true)
                assertEquals(rejected.id, model.newCallFrom.value)
                assertEquals(1, model.calls.value.size)
                assertFalse(model.calls.value.single().held)
                model.callAction(rejected.id, "hangup")
                withTimeout(10_000) { model.calls.first { it.isEmpty() }; model.bridge!!.routes.first { it.isEmpty() } }

                val firstParticipant = connected(); val secondParticipant = connected(); val unrelated = connected()
                model.bridge!!.merge(firstParticipant.id, secondParticipant.id)
                assertTrue(model.bridge!!.awaitPresentation(firstParticipant.id))
                fun current(id: String) = model.calls.value.single { it.id == id }
                val group = current(firstParticipant.id).conferenceId!!
                assertEquals(group, current(secondParticipant.id).conferenceId)
                assertTrue(current(unrelated.id).held)
                assertEquals(setOf("conference:$group", unrelated.id), model.bridge!!.presentationIdsForTest())
                assertEquals(setOf(firstParticipant.id, secondParticipant.id, unrelated.id), model.bridge!!.routes.value.keys)
                model.engine.mute(firstParticipant.id, true)
                assertTrue(current(firstParticipant.id).muted && current(secondParticipant.id).muted)
                model.bridge!!.hold(firstParticipant.id, true)
                assertTrue(current(firstParticipant.id).held && current(secondParticipant.id).held)
                model.bridge!!.hold(secondParticipant.id, false)
                assertFalse(current(firstParticipant.id).held || current(secondParticipant.id).held)
                model.bridge!!.separate(firstParticipant.id, group)
                assertTrue(model.bridge!!.awaitPresentation(secondParticipant.id))
                assertNull(current(firstParticipant.id).conferenceId); assertNull(current(secondParticipant.id).conferenceId)
                assertFalse(current(firstParticipant.id).held); assertTrue(current(secondParticipant.id).held)
                assertEquals(setOf(firstParticipant.id, secondParticipant.id, unrelated.id), model.bridge!!.presentationIdsForTest())
                // A notification from the earlier conference cannot end the separated or regrouped dialogs.
                CallActionReceiver().onReceive(context, android.content.Intent("hangup").putExtra("callId", firstParticipant.id)
                    .putExtra("presentationId", "conference:$group"))
                assertEquals(3, model.calls.value.size)
                model.bridge!!.merge(firstParticipant.id, secondParticipant.id)
                val nextGroup = current(firstParticipant.id).conferenceId!!
                assertNotEquals(group, nextGroup)
                assertTrue("A system-session handover must retain shared mute", current(firstParticipant.id).muted && current(secondParticipant.id).muted)
                assertFalse(model.callAction(firstParticipant.id, "hangup", "conference:$group"))
                model.error.value = null
                model.bridge!!.endParticipant(secondParticipant.id, nextGroup)
                withTimeout(6000) { model.calls.first { values -> values.none { it.id == secondParticipant.id } } }
                assertTrue(model.bridge!!.awaitPresentation(firstParticipant.id))
                assertNull(current(firstParticipant.id).conferenceId)
                assertEquals(setOf(firstParticipant.id, unrelated.id), model.bridge!!.presentationIdsForTest())
                assertTrue(model.callAction(firstParticipant.id, "hangup"))
                withTimeout(6000) { model.calls.first { values -> values.none { it.id == firstParticipant.id } } }
                assertTrue(current(unrelated.id).connected)
                assertTrue(model.callAction(unrelated.id, "hangup"))
                withTimeout(6000) { model.calls.first { it.isEmpty() }; model.bridge!!.routes.first { it.isEmpty() } }
            } finally {
                model.scope.coroutineContext.job.cancelAndJoin()
                model.engine.close()
                for (name in names) {
                    AtomicFile(File(context.noBackupFilesDir, "$name.enc")).delete()
                    saved[name]?.let { File(context.noBackupFilesDir, "$name.enc").writeBytes(it) }
                    if (existed[name] != true) keys.deleteEntry("${context.packageName}.$name")
                }
            }
        }
    }

    @Test fun holdWaitsForRealNegotiationFencesLateResultsAndAllowsHangup() = runBlocking<Unit> {
        assumeTrue(InstrumentationRegistry.getArguments().getString("dndRegistrar") == "10.0.2.2")
        val engine = SipEngine(context, silentAudio = true)
        try {
            engine.start()
            val account = SipAccount(label = "Hold fixture", username = "dnd-user", password = "fictional-dnd", domain = "sipper.test",
                server = "10.0.2.2", port = 5098, transport = "udp", srtp = "disabled", ice = false)
            engine.sync(listOf(account))
            withTimeout(6000) { engine.registrations.first { it[account.id]?.state == "registered" } }
            suspend fun connected(number: String): String {
                val token = engine.dial(account.id, "sip:$number@sipper.test;transport=udp")
                withTimeout(6000) { engine.calls.first { values -> values.any { it.id == token && it.connected } } }
                return token
            }
            suspend fun end(token: String) { engine.hangup(token); withTimeout(6000) { engine.calls.first { it.isEmpty() } } }
            val rejected = connected("*nohold")
            assertTrue(runCatching { engine.hold(rejected, true) }.exceptionOrNull()?.message?.contains("SIP 488") == true)
            assertFalse(engine.calls.value.single().held)
            end(rejected)
            val slow = connected("*slowhold")
            val hold = async { engine.hold(slow, true) }
            delay(200)
            assertFalse(hold.isCompleted)
            assertFalse(engine.calls.value.single().held)
            assertTrue(runCatching { engine.dial(account.id, "*97") }.isFailure)
            assertTrue(runCatching { engine.hold(slow, true) }.isFailure)
            hold.await()
            assertTrue(engine.calls.value.single().held)
            engine.hold(slow, false)
            assertFalse(engine.calls.value.single().held)
            end(slow)
            val late = connected("*latehold")
            assertTrue(runCatching { engine.hold(late, true) }.exceptionOrNull()?.message?.contains("did not confirm") == true)
            assertTrue(runCatching { engine.dial(account.id, "*97") }.isFailure)
            withTimeout(6000) { engine.calls.first { it.singleOrNull()?.held == true } }
            val admitted = engine.dial(account.id, "*97")
            engine.hangup(admitted); withTimeout(6000) { engine.calls.first { values -> values.none { it.id == admitted } } }
            end(late)
            val silent = connected("*silenthold")
            val unresolved = async { runCatching { engine.hold(silent, true) } }
            delay(200)
            val endedAt = android.os.SystemClock.elapsedRealtime()
            engine.hangup(silent)
            assertTrue(unresolved.await().exceptionOrNull()?.message?.contains("ended") == true)
            assertTrue(android.os.SystemClock.elapsedRealtime() - endedAt < 1000)
            withTimeout(6000) { engine.calls.first { it.isEmpty() } }
            val peer = account.copy(id = UUID.randomUUID().toString(), username = "dnd-peer")
            engine.sync(listOf(account, peer))
            withTimeout(6000) { engine.registrations.first { it[peer.id]?.state == "registered" } }
            val outgoing = engine.dial(account.id, "sip:dnd-peer@sipper.test;transport=udp")
            val incoming = withTimeout(6000) { engine.calls.first { values -> values.any { it.incoming } } }.single { it.incoming }.id
            engine.answer(incoming)
            withTimeout(6000) { engine.calls.first { it.size == 2 && it.all { call -> call.connected } } }
            engine.hold(outgoing, true); engine.hold(incoming, true)
            assertTrue(engine.calls.value.all { it.held })
            engine.hold(outgoing, false)
            assertFalse(engine.calls.value.single { it.id == outgoing }.held)
            assertTrue(engine.calls.value.single { it.id == incoming }.held)
            engine.hold(incoming, false)
            assertTrue(engine.calls.value.none { it.held })
            engine.hangup(outgoing); withTimeout(6000) { engine.calls.first { it.isEmpty() } }
        } finally { engine.close() }
    }

    @Test fun directTransfersKeepFailedCallsAndRejectWithdrawnOrUnrelatedCalls() = runBlocking<Unit> {
        assumeTrue(InstrumentationRegistry.getArguments().getString("dndRegistrar") == "10.0.2.2")
        val engine = SipEngine(context, silentAudio = true)
        try {
            engine.start()
            val account = SipAccount(label = "Transfer fixture", username = "dnd-user", password = "fictional-dnd", domain = "sipper.test",
                server = "10.0.2.2", port = 5098, transport = "udp", srtp = "disabled", ice = false,
                managedDeviceId = UUID.randomUUID().toString(), expiresAt = System.currentTimeMillis() + 120_000)
            val other = account.copy(id = UUID.randomUUID().toString(), username = "dnd-peer", managedDeviceId = null, expiresAt = null)
            engine.sync(listOf(account, other))
            withTimeout(6000) { engine.registrations.first { it[account.id]?.state == "registered" && it[other.id]?.state == "registered" } }
            suspend fun connected(account: SipAccount): String {
                val token = engine.dial(account.id, "sip:*echo@sipper.test;transport=udp")
                withTimeout(6000) { engine.calls.first { values -> values.any { it.id == token && it.connected } } }
                return token
            }
            val call = connected(account); val unrelated = connected(other)
            assertTrue(runCatching { engine.attendedTransfer(call, call) }.isFailure)
            assertTrue(runCatching { engine.attendedTransfer(call, unrelated) }.isFailure)
            for (target in listOf("", "()", "fictional-secret", "sip:100@sipper.test\r\nInjected: value", "1".repeat(513))) {
                assertTrue(runCatching { engine.transfer(call, target) }.isFailure)
            }
            engine.transfer(call, "*404")
            assertTrue(engine.calls.value.single { it.id == call }.transferring)
            assertTrue(runCatching { engine.transfer(call, "*97") }.isFailure)
            withTimeout(6000) { engine.calls.first { values -> values.any { it.id == call && !it.transferring && it.transferStatus?.startsWith("Transfer failed") == true } } }
            assertTrue(engine.calls.value.any { it.id == call && it.connected && it.state != "Ended" })
            engine.transfer(call, "*97")
            withTimeout(6000) { engine.calls.first { values -> values.none { it.id == call } } }
            assertTrue(engine.calls.value.any { it.id == unrelated && it.connected })
            val first = connected(account); val second = connected(account)
            assertTrue(runCatching { engine.transfer(call, "*97") }.isFailure)
            engine.attendedTransfer(first, second)
            assertTrue(runCatching { engine.transfer(second, "*97") }.isFailure)
            withTimeout(6000) { engine.calls.first { values -> values.none { it.accountId == account.id } } }
            val withdrawn = connected(account)
            engine.sync(listOf(other))
            assertTrue(runCatching { engine.transfer(withdrawn, "*97") }.isFailure)
            assertTrue(runCatching { engine.attendedTransfer(withdrawn, unrelated) }.isFailure)
            assertTrue(engine.calls.value.any { it.id == withdrawn && it.connected && it.state != "Ended" })
            engine.hangup(withdrawn); engine.hangup(unrelated)
            withTimeout(6000) { engine.calls.first { it.isEmpty() } }
        } finally { engine.close() }
    }

    @Test fun conferencesUseExactParticipantsConfirmHoldAndKeepUnrelatedCalls() = runBlocking<Unit> {
        assumeTrue(InstrumentationRegistry.getArguments().getString("dndRegistrar") == "10.0.2.2")
        // Native SIP/mixer checks use the null sound device, independently of Telecom and microphone consent.
        val engine = SipEngine(context, silentAudio = true)
        try {
            engine.start(); engine.enableAudio(true)
            val account = SipAccount(label = "Conference fixture", username = "dnd-user", password = "fictional-dnd", domain = "sipper.test",
                server = "10.0.2.2", port = 5098, transport = "udp", srtp = "disabled", ice = false,
                managedDeviceId = UUID.randomUUID().toString(), expiresAt = System.currentTimeMillis() + 120_000)
            val other = account.copy(id = UUID.randomUUID().toString(), username = "dnd-peer", managedDeviceId = null, expiresAt = null)
            engine.sync(listOf(account, other))
            withTimeout(6000) { engine.registrations.first { it[account.id]?.state == "registered" && it[other.id]?.state == "registered" } }
            suspend fun connected(number: String = "*97", on: SipAccount = account): String {
                val token = engine.dial(on.id, "sip:$number@sipper.test;transport=udp")
                withTimeout(6000) { engine.calls.first { values -> values.any { it.id == token && it.connected } } }
                return token
            }
            fun call(token: String) = engine.calls.value.single { it.id == token }
            suspend fun ended(vararg tokens: String) {
                withTimeout(6000) { engine.calls.first { values -> values.none { it.id in tokens } } }
            }
            val first = connected(); val second = connected(); val unrelated = connected(on = other)
            assertTrue(runCatching { engine.beginConference(first, first) }.isFailure)
            assertTrue(runCatching { engine.beginConference(first, unrelated) }.isFailure)
            assertTrue(runCatching { engine.beginConference(first, "stale-call") }.isFailure)
            assertTrue("An unrelated active call must prevent merging", runCatching { engine.beginConference(first, second) }.isFailure)
            engine.hold(unrelated, true); engine.hold(first, true)
            assertTrue("Both participants must be resumed", runCatching { engine.beginConference(first, second) }.isFailure)
            engine.hold(first, false)
            engine.mute(second, true)
            val reference = engine.beginConference(first, second)
            assertEquals(reference, call(first).conferenceId); assertEquals(reference, call(second).conferenceId)
            assertTrue(call(first).muted && call(second).muted); assertFalse(call(unrelated).muted)
            engine.mute(first, false)
            assertFalse(call(first).muted || call(second).muted)
            assertTrue(runCatching { engine.dtmf(first, "1") }.isFailure)
            assertTrue(runCatching { engine.transfer(first, "*97") }.isFailure)
            assertTrue(runCatching { engine.attendedTransfer(first, second) }.isFailure)
            assertTrue(runCatching { engine.splitConference(first, reference) }.isFailure)
            engine.hold(second, true)
            assertTrue(call(first).held && call(second).held && call(unrelated).held)
            assertTrue(runCatching { engine.dtmf(first, "1", reference) }.isFailure)
            engine.conferenceHold(first, reference, false)
            assertFalse(call(first).held || call(second).held); assertTrue(call(unrelated).held)
            engine.conferenceHold(first, reference, true)
            engine.splitConference(first, reference)
            assertNull(call(first).conferenceId); assertNull(call(second).conferenceId)
            assertTrue(call(first).held && call(second).held)
            engine.hold(first, false); engine.hold(second, false)
            val regrouped = engine.beginConference(first, second)
            assertNotEquals("Each merge must have its own identity", reference, regrouped)
            assertTrue(runCatching { engine.hangupConference(first, reference) }.isFailure)
            assertTrue(runCatching { engine.splitConference(second, reference) }.isFailure)
            assertTrue(runCatching { engine.hangup(first, reference) }.isFailure)
            assertTrue(runCatching { engine.hold(first, true, "conference:$reference") }.isFailure)
            assertTrue(runCatching { engine.mute(second, true, "conference:$reference") }.isFailure)
            assertTrue(runCatching { engine.dtmf(second, "1", reference) }.isFailure)
            engine.hangup(first); ended(first)
            assertNull(call(second).conferenceId); assertFalse(call(second).held)
            assertTrue(call(unrelated).connected && call(unrelated).held)
            engine.hangup(second); ended(second)

            val normal = connected(); val rejecting = connected("*nohold")
            val rejectedGroup = engine.beginConference(normal, rejecting)
            assertTrue(runCatching { engine.conferenceHold(normal, rejectedGroup, true) }.exceptionOrNull()?.message?.contains("SIP 488") == true)
            assertFalse("A rejected second hold must restore the first participant", call(normal).held || call(rejecting).held)
            assertEquals(rejectedGroup, call(normal).conferenceId)
            engine.hangupConference(normal, rejectedGroup); ended(normal, rejecting)
            assertTrue(call(unrelated).connected)

            val waiting = connected(); val late = connected("*latehold")
            val lateGroup = engine.beginConference(waiting, late)
            val pending = async { runCatching { engine.conferenceHold(waiting, lateGroup, true) } }
            delay(200)
            assertFalse(pending.isCompleted)
            assertTrue(runCatching { engine.dial(account.id, "*97") }.isFailure)
            assertTrue(runCatching { engine.splitConference(waiting, lateGroup) }.isFailure)
            val failure = pending.await().exceptionOrNull()
            assertTrue(failure?.message?.contains("did not confirm") == true)
            assertTrue("An unresolved native request must still fence dialling", runCatching { engine.dial(account.id, "*97") }.isFailure)
            withTimeout(6000) { engine.calls.first { values -> values.filter { it.id == waiting || it.id == late }.all { it.held } } }
            engine.splitConference(waiting, lateGroup)
            assertNull(call(waiting).conferenceId); assertNull(call(late).conferenceId)
            assertTrue(call(waiting).held && call(late).held)
            engine.hangup(waiting); engine.hangup(late); ended(waiting, late)

            val cancelledFirst = connected(); val silent = connected("*silenthold")
            val cancelledGroup = engine.beginConference(cancelledFirst, silent)
            val cancelled = launch { engine.conferenceHold(cancelledFirst, cancelledGroup, true) }
            withTimeout(6000) { engine.calls.first { values -> values.any { it.id == cancelledFirst && it.held } } }
            delay(100); cancelled.cancelAndJoin()
            assertTrue(runCatching { engine.dial(account.id, "*97") }.isFailure)
            val endedAt = android.os.SystemClock.elapsedRealtime()
            engine.hangupConference(cancelledFirst, cancelledGroup); ended(cancelledFirst, silent)
            assertTrue("An unresolved hold must not delay ending the conference", android.os.SystemClock.elapsedRealtime() - endedAt < 1000)
            assertTrue(call(unrelated).connected)

            val withdrawnFirst = connected(); val withdrawnSecond = connected()
            val withdrawnGroup = engine.beginConference(withdrawnFirst, withdrawnSecond)
            engine.sync(listOf(other))
            assertTrue(call(withdrawnFirst).connected && call(withdrawnSecond).connected)
            engine.mute(withdrawnFirst, true)
            assertTrue(call(withdrawnFirst).muted && call(withdrawnSecond).muted)
            engine.conferenceHold(withdrawnFirst, withdrawnGroup, true)
            engine.conferenceHold(withdrawnFirst, withdrawnGroup, false)
            engine.conferenceHold(withdrawnFirst, withdrawnGroup, true)
            engine.splitConference(withdrawnFirst, withdrawnGroup)
            engine.hold(withdrawnFirst, false); engine.hold(withdrawnSecond, false)
            assertTrue("Withdrawn accounts cannot admit a new conference", runCatching { engine.beginConference(withdrawnFirst, withdrawnSecond) }.isFailure)
            engine.hangup(withdrawnFirst); engine.hangup(withdrawnSecond); ended(withdrawnFirst, withdrawnSecond)
            engine.hangup(unrelated); ended(unrelated)
            assertTrue(engine.calls.value.isEmpty())
        } finally { engine.close() }
    }

    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun importLink(value: JSONObject): String = "sipper://add-accounts?payload=" + Base64.getUrlEncoder().withoutPadding().encodeToString(value.toString().toByteArray())
    @Test fun accountImportsReviewBeforeSavingAndPreserveIdentityAtomically() {
        val name = "test-import-${UUID.randomUUID()}"
        val vault = SecureVault(context, name)
        val file = File(context.noBackupFilesDir, "$name.enc")
        val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        try {
            val store = AccountStore(vault)
            val old = SipAccount(label = "My account", username = "100", password = "previous", domain = "example.invalid", enabled = false)
            store.save(old)
            val payload = JSONObject().put("version", 1).put("accounts", JSONArray()
                .put(JSONObject().put("username", "100").put("domain", "EXAMPLE.invalid").put("password", "  fictional password  ").put("label", "New label").put("server", "sip.example.invalid").put("transport", "TCP"))
                .put(JSONObject().put("username", "200").put("domain", "example.invalid").put("password", "new").put("managedDeviceId", "ignored")))
            val review = store.reviewImport(importLink(payload))
            assertEquals(listOf(old), store.accounts)
            val update = review.candidates.first()
            assertTrue(update.updating); assertEquals(old.id, update.account.id); assertEquals("My account", update.account.label)
            assertFalse(update.account.enabled); assertTrue(update.account.ice); assertEquals("required", update.account.srtp)
            assertNull(review.candidates[1].account.managedDeviceId)
            val selected = review.candidates.map { it.account.id }.toSet()
            assertThrows(IllegalStateException::class.java) { store.importAccounts(review, selected, setOf(old.id)) }
            assertThrows(IllegalArgumentException::class.java) { store.importAccounts(review, emptySet(), emptySet()) }
            store.importAccounts(review, selected, emptySet())
            val restored = AccountStore(vault)
            assertEquals(2, restored.accounts.size); assertEquals("  fictional password  ", restored.accounts[0].password)
            assertEquals(old.id, restored.accounts[0].id); assertEquals("sip.example.invalid", restored.accounts[0].server)
            assertThrows(IllegalStateException::class.java) { store.importAccounts(review, selected, emptySet()) }
            val fresh = store.reviewImport(importLink(payload))
            store.save(store.accounts[0].copy(label = "Changed during review"))
            assertThrows(IllegalStateException::class.java) { store.importAccounts(fresh, fresh.candidates.map { it.account.id }.toSet(), emptySet()) }
            val retry = store.reviewImport(importLink(payload))
            val before = store.accounts; val encrypted = file.readBytes()
            keys.deleteEntry("${context.packageName}.$name")
            assertThrows(IllegalStateException::class.java) { store.importAccounts(retry, retry.candidates.map { it.account.id }.toSet(), emptySet()) }
            assertEquals(before, store.accounts); assertArrayEquals(encrypted, file.readBytes())
        } finally { AtomicFile(file).delete(); keys.deleteEntry("${context.packageName}.$name") }
    }
    @Test fun accountImportsRejectInvalidDuplicateAndOversizedInputWithoutEchoingSecrets() {
        fun document(vararg accounts: JSONObject) = JSONObject().put("version", 1).put("accounts", JSONArray(accounts.toList()))
        fun account() = JSONObject().put("username", "100").put("domain", "example.invalid").put("password", "fictional-secret")
        for (value in listOf("sipper://setup?payload=fictional-secret", "sipper://add-accounts?payload=fictional-secret!",
            importLink(document(account()).put("version", 2)), importLink(document(account().put("port", "fictional-secret"))),
            importLink(document(account()).put("padding", "x".repeat(MAX_IMPORT_BYTES))))) {
            val failure = assertThrows(IllegalArgumentException::class.java) { parseAccountImport(value) }
            assertFalse(failure.message!!.contains("fictional-secret"))
        }
        val nested = "[".repeat(1000) + "0" + "]".repeat(1000)
        assertThrows(IllegalArgumentException::class.java) { parseAccountImport("sipper://add-accounts?payload=" + Base64.getUrlEncoder().encodeToString(nested.toByteArray())) }
        assertNotNull(parseAccountImport(importLink(document(account().put("password", "a\u0000b")))).candidates[0].error)
        assertNotNull(parseAccountImport(importLink(document(account().put("username", "injected\r\nheader")))).candidates[0].error)
        val name = "test-import-limits-${UUID.randomUUID()}"
        val vault = SecureVault(context, name)
        try {
            val store = AccountStore(vault)
            val duplicates = store.reviewImport(importLink(document(account(), account())))
            assertTrue(duplicates.candidates.all { it.error != null })
            assertThrows(IllegalArgumentException::class.java) { store.importAccounts(duplicates, duplicates.candidates.map { it.account.id }.toSet(), emptySet()) }
            assertThrows(IllegalArgumentException::class.java) { store.reviewImport(importLink(document(*Array(17) { account() }))) }
            repeat(16) { store.save(SipAccount(label = "Fixture", username = it.toString(), password = "fixture", domain = "existing.invalid")) }
            val full = store.reviewImport(importLink(document(account())))
            assertThrows(IllegalArgumentException::class.java) { store.importAccounts(full, full.candidates.map { it.account.id }.toSet(), emptySet()) }
            assertEquals(16, store.accounts.size)
        } finally {
            vault.clear()
            KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry("${context.packageName}.$name") }
        }
    }
    @Test fun recentCallsPreserveTargetsAndOwnershipInEncryptedStorage() {
        val name = "test-history-${UUID.randomUUID()}"
        val vault = SecureVault(context, name)
        val file = File(context.noBackupFilesDir, "$name.enc")
        val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        try {
            val call = RecentCall("call", "account", "Fixture caller", true, false, 123, "2000", "device", "Fixture office")
            vault.write(call.json().toString().toByteArray())
            assertFalse(file.readText().contains("Fixture caller"))
            assertEquals(call, RecentCall.read(JSONObject(vault.read()!!.toString(Charsets.UTF_8))))
            val legacy = call.json().apply { remove("destination"); remove("managedDeviceId"); remove("accountTitle") }
            val restored = RecentCall.read(legacy)
            assertEquals("Fixture caller", restored.remote); assertNull(restored.destination)
            assertNull(restored.managedDeviceId); assertEquals("", restored.accountTitle)
        } finally { AtomicFile(file).delete(); keys.deleteEntry("${context.packageName}.$name") }
    }
    @Test fun androidDefaultNetworkSnapshotDoesNotTriggerSipRecovery() = runBlocking<Unit> {
        withContext(Dispatchers.Main) {
            val manager = context.getSystemService(android.net.ConnectivityManager::class.java)
            assertNotNull("Run on a connected QA emulator.", manager.activeNetwork?.let(manager::getLinkProperties))
            val observed = CompletableDeferred<Boolean>()
            val monitor = NetworkMonitor(context, this) { observed.complete(it) }
            try { assertNull("The initial route is not a network change", withTimeoutOrNull(1200) { observed.await() }) }
            finally { monitor.close() }
        }
    }
    @Test fun encryptedAccountsRoundTripAndRejectTampering() {
        val name = "test-accounts-${UUID.randomUUID()}"
        val vault = SecureVault(context, name)
        val account = SipAccount(label = "Local test", username = "100", password = "fictional-secret", domain = "pbx.example.invalid",
            displayName = "Test caller", voicemailNumber = "*98", stunServer = "stun.example.invalid:3478")
        AccountStore(vault).save(account)
        assertEquals(listOf(account), AccountStore(SecureVault(context, name)).accounts)
        val file = File(context.noBackupFilesDir, "$name.enc")
        assertFalse(file.readBytes().toString(Charsets.UTF_8).contains(account.password))
        val data = file.readBytes(); data[data.lastIndex] = (data.last().toInt() xor 1).toByte(); file.writeBytes(data)
        assertThrows(Exception::class.java) { AccountStore(SecureVault(context, name)) }
        file.delete()
    }
    @Test fun interruptedWriteRecoversAndMissingKeyPreservesCiphertext() {
        val name = "test-recovery-${UUID.randomUUID()}"
        val file = File(context.noBackupFilesDir, "$name.enc")
        val alias = "${context.packageName}.$name"
        val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        try {
            val account = SipAccount(label = "Recovery test", username = "100", password = "fictional-secret", domain = "pbx.example.invalid")
            AccountStore(SecureVault(context, name)).save(account)
            // Reproduce an interrupted AtomicFile replacement on older Android versions.
            assertTrue(file.renameTo(File("${file.path}.bak")))
            assertEquals(listOf(account), AccountStore(SecureVault(context, name)).accounts)
            val ciphertext = file.readBytes()
            keys.deleteEntry(alias)
            assertThrows(IllegalStateException::class.java) { SecureVault(context, name).read() }
            assertThrows(IllegalStateException::class.java) { SecureVault(context, name).write(byteArrayOf(1)) }
            assertArrayEquals(ciphertext, file.readBytes())
        } finally { AtomicFile(file).delete(); keys.deleteEntry(alias) }
    }
    @Test fun nativeEngineStartsWithOpusAndSystemTrust() = runBlocking {
        val engine = SipEngine(context, silentAudio = true)
        try {
            engine.start()
            assertTrue(engine.codecs().any { it.startsWith("opus/") })
            val account = SipAccount(label = "TLS test", username = "100", password = "fixture", domain = "example.invalid", server = "127.0.0.1", port = 59999)
            engine.sync(listOf(account))
            assertTrue(engine.hasApplied(listOf(account)))
            assertNotEquals("registered", engine.registration(account.id).state)
            assertTrue(engine.calls.value.isEmpty())
        } finally { engine.close() }
    }
    @Test fun directDndPreservesAdmittedCallsAndOnlyRejectsNewManagedIncomingCalls() = runBlocking<Unit> {
        assumeTrue(InstrumentationRegistry.getArguments().getString("dndRegistrar") == "10.0.2.2")
        val engine = SipEngine(context, silentAudio = true)
        val ended = java.util.concurrent.CopyOnWriteArrayList<PhoneCall>()
        engine.onEnded = { ended.add(it) }
        try {
            engine.start()
            var managed = SipAccount(label = "DND fixture", username = "dnd-user", password = "fictional-dnd", domain = "sipper.test",
                server = "10.0.2.2", port = 5098, transport = "udp", srtp = "disabled", ice = false,
                managedDeviceId = UUID.randomUUID().toString(), expiresAt = System.currentTimeMillis() + 120_000)
            val personal = managed.copy(id = UUID.randomUUID().toString(), username = "dnd-peer", managedDeviceId = null, expiresAt = null)
            engine.sync(listOf(managed, personal))
            withTimeout(6000) { engine.registrations.first { it[managed.id]?.state == "registered" && it[personal.id]?.state == "registered" } }
            val original = engine.dial(personal.id, "sip:dnd-user@sipper.test;transport=udp")
            val admitted = withTimeout(6000) { engine.calls.first { calls -> calls.any { it.incoming && it.accountId == managed.id } } }.first { it.incoming }
            assertEquals("sip:dnd-peer@sipper.test", admitted.destination)
            assertEquals(managed.managedDeviceId, admitted.managedDeviceId)
            managed = managed.copy(managedDoNotDisturb = true); engine.sync(listOf(managed, personal))
            assertTrue(engine.hasApplied(listOf(managed, personal)))
            assertEquals("registered", engine.registration(managed.id).state)
            engine.answer(admitted.id)
            withTimeout(6000) { engine.calls.first { it.count { call -> call.connected } == 2 } }
            val blocked = engine.dial(personal.id, "sip:dnd-user@sipper.test;transport=udp")
            withTimeout(6000) { while (ended.none { it.id == blocked }) delay(20) }
            assertEquals(2, engine.calls.value.count { it.connected })
            assertFalse(engine.calls.value.any { it.incoming && it.id != admitted.id })
            engine.hangup(original); withTimeout(6000) { engine.calls.first { it.isEmpty() } }
            assertEquals(admitted.destination, ended.single { it.id == admitted.id }.destination)
            val outgoing = engine.dial(managed.id, "sip:dnd-peer@sipper.test;transport=udp")
            val offered = withTimeout(6000) { engine.calls.first { calls -> calls.any { it.incoming } } }.first { it.incoming }
            assertEquals(personal.id, offered.accountId)
            engine.answer(offered.id)
            withTimeout(6000) { engine.calls.first { it.count { call -> call.connected } == 2 } }
            engine.hangup(outgoing); withTimeout(6000) { engine.calls.first { it.isEmpty() } }
            managed = managed.copy(managedDoNotDisturb = false); engine.sync(listOf(managed, personal))
            val restored = engine.dial(personal.id, "sip:dnd-user@sipper.test;transport=udp")
            withTimeout(6000) { engine.calls.first { calls -> calls.any { it.incoming && it.accountId == managed.id } } }
            engine.hangup(restored); withTimeout(6000) { engine.calls.first { it.isEmpty() } }
        } finally { engine.close() }
    }
    @Test fun realSipRegistrationAndEstablishedCallSurviveManagedExpiry() = runBlocking<Unit> {
        // Opt-in only: this fixture address is the emulator's host-loopback alias.
        assumeTrue(InstrumentationRegistry.getArguments().getString("sipperRegistrar") == "10.0.2.2")
        val engine = SipEngine(context, silentAudio = true)
        try {
            engine.start()
            val account = SipAccount(label = "Android test", username = "android-test", password = "local-android-test", domain = "sipper.test",
                server = "10.0.2.2", port = 5096, transport = "udp", srtp = "disabled", ice = false,
                managedDeviceId = UUID.randomUUID().toString(), expiresAt = System.currentTimeMillis() + 10_000)
            engine.sync(listOf(account))
            withTimeout(6000) { engine.registrations.first { it[account.id]?.state == "registered" } }
            assertEquals(200, engine.registration(account.id).code)
            val call = engine.dial(account.id, "*97")
            withTimeout(6000) { engine.calls.first { values -> values.any { it.id == call && it.connected } } }
            assertEquals("*97", engine.calls.value.single { it.id == call }.destination)
            assertEquals(account.managedDeviceId, engine.calls.value.single { it.id == call }.managedDeviceId)
            delay(11_000)
            assertTrue(engine.calls.value.any { it.id == call && it.connected && it.state != "Ended" })
            assertFalse(engine.hasApplied(listOf(account)))
            var denied = false
            try { engine.dial(account.id, "*97") } catch (_: IllegalStateException) { denied = true }
            assertTrue("Expired managed access must reject a new call", denied)
            assertTrue("Expired managed access must reject transfers too", runCatching { engine.transfer(call, "*97") }.isFailure)
            engine.hangup(call)
            withTimeout(5000) { engine.calls.first { values -> values.none { it.id == call } } }
        } finally { engine.close() }
    }
    @Test fun leaseRenewalAndNetworkRecoveryPreserveCallsWithoutRevivingRevokedRegistration() = runBlocking<Unit> {
        assumeTrue(InstrumentationRegistry.getArguments().getString("sipperRegistrar") == "10.0.2.2")
        for (transport in listOf("udp", "tcp")) {
            val engine = SipEngine(context, silentAudio = true)
            try {
                engine.start()
                val account = SipAccount(label = "Network fixture", username = "android-test", password = "local-android-test", domain = "sipper.test",
                    server = "10.0.2.2", port = 5096, transport = transport, srtp = "disabled", ice = false,
                    displayName = "Fictional \"Android\"", managedDeviceId = UUID.randomUUID().toString(), expiresAt = System.currentTimeMillis() + 6000)
                engine.sync(listOf(account))
                withTimeout(5000) { engine.registrations.first { it[account.id]?.state == "registered" } }
                val call = engine.dial(account.id, "*97")
                withTimeout(5000) { engine.calls.first { values -> values.any { it.id == call && it.connected } } }
                val renewed = account.copy(expiresAt = System.currentTimeMillis() + 60_000)
                engine.sync(listOf(renewed)); delay(6500)
                assertTrue(engine.hasApplied(listOf(renewed)))
                assertEquals("registered", engine.registration(account.id).state)
                engine.networkChanged(false)
                assertEquals("unknown", engine.registration(account.id).state)
                assertEquals("No network connection", runCatching { engine.refreshRegistration(account.id) }.exceptionOrNull()?.message)
                assertEquals("unknown", engine.registrations.value[account.id]?.state)
                engine.networkChanged(true)
                withTimeout(7000) { engine.registrations.first { it[account.id]?.state == "registered" } }
                assertTrue(engine.calls.value.any { it.id == call && it.connected && it.state != "Ended" })
                engine.sync(emptyList())
                engine.networkEventsForTest(clear = true)
                engine.networkChanged(true); delay(1500)
                assertEquals("unregistered", engine.registration(account.id).state)
                assertFalse("Recovery must not revive a withdrawn binding", engine.networkEventsForTest().contains("register"))
                assertTrue(engine.calls.value.any { it.id == call && it.connected && it.state != "Ended" })
                assertTrue(runCatching { engine.dial(account.id, "*97") }.isFailure)
                engine.hangup(call)
                withTimeout(5000) { engine.calls.first { values -> values.none { it.id == call } } }
                engine.sync(listOf(renewed))
                withTimeout(5000) { engine.registrations.first { it[account.id]?.state == "registered" } }
                engine.sync(listOf(renewed.copy(password = "wrong-fixture-password")))
                withTimeout(5000) { engine.registrations.first { it[account.id]?.state == "failed" } }
                engine.networkChanged(false); engine.networkChanged(true)
                delay(1000)
                assertEquals("failed", engine.registration(account.id).state)
                assertEquals("failed", engine.registrations.value[account.id]?.state)
            } finally { engine.close() }
        }
    }
    @Test fun nativeStunSelectionCanBeRemovedWithoutContactingTheOldServer() = runBlocking<Unit> {
        StunFixture().use { stun ->
            val engine = SipEngine(context, silentAudio = true)
            try {
                engine.start()
                val account = SipAccount(label = "STUN fixture", username = "100", password = "fixture", domain = "example.invalid",
                    server = "127.0.0.1", port = 59999, transport = "udp", srtp = "disabled", ice = false, stunServer = "127.0.0.1:${stun.port}")
                engine.sync(listOf(account))
                withTimeout(5000) { while (stun.requests.get() == 0) delay(20) }
                assertTrue(engine.hasApplied(listOf(account)))
                val cleared = account.copy(stunServer = "")
                engine.sync(listOf(cleared)); delay(200)
                val before = stun.requests.get()
                engine.networkChanged(); delay(600)
                assertEquals(before, stun.requests.get())
                assertTrue(engine.hasApplied(listOf(cleared)))
            } finally { engine.close() }
        }
    }
    /** RFC 5389 Binding success responses for local native-library checks only. */
    private class StunFixture : AutoCloseable {
        private val socket = DatagramSocket(0, InetAddress.getByName("127.0.0.1"))
        val port get() = socket.localPort
        val requests = AtomicInteger()
        private val worker = thread(isDaemon = true, name = "Sipper STUN fixture") {
            while (!socket.isClosed) {
                val packet = DatagramPacket(ByteArray(2048), 2048)
                try {
                    socket.receive(packet)
                    if (packet.length < 20 || packet.data[0] != 0.toByte() || packet.data[1] != 1.toByte()) continue
                    requests.incrementAndGet()
                    val cookie = byteArrayOf(0x21, 0x12, 0xA4.toByte(), 0x42)
                    val response = ByteBuffer.allocate(32).putShort(0x0101).putShort(12).put(cookie)
                        .put(packet.data, 8, 12).putShort(0x0020).putShort(8).put(0).put(1)
                        .putShort((packet.port xor 0x2112).toShort())
                    packet.address.address.forEachIndexed { i, byte -> response.put((byte.toInt() xor cookie[i].toInt()).toByte()) }
                    socket.send(DatagramPacket(response.array(), 32, packet.address, packet.port))
                } catch (_: Exception) { if (!socket.isClosed) continue }
            }
        }
        override fun close() { socket.close(); worker.join(1000) }
    }
}
