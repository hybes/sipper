package com.hybes.sipper

import android.net.Uri
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

/** Real local portal and SIP only; the companion completes browser authorisation over HTTP. */
@RunWith(AndroidJUnit4::class)
class ManagedPortalTest {
    @Test fun portalIdentityDirectoryCallingAndWithdrawal() = runBlocking<Unit> {
        assumeTrue(InstrumentationRegistry.getArguments().getString("sipperPortal") == "isolated")
        withContext(Dispatchers.Main) {
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val fixture = JSONObject(File(context.filesDir, "portal-test.json").readText())
            val origin = fixture.getString("origin")
            require(origin.matches(Regex("http://127\\.0\\.0\\.1:[0-9]+")))
            val phaseFile = File(context.filesDir, "portal-test-phase.json")
            val replyFile = File(context.filesDir, "portal-test-reply.json")
            suspend fun checkpoint(phase: String, value: JSONObject = JSONObject()): JSONObject {
                replyFile.delete()
                phaseFile.writeText(value.put("phase", phase).toString())
                return withTimeout(30_000) {
                    while (!replyFile.exists()) delay(50)
                    JSONObject(replyFile.readText()).also { assertEquals(phase, it.getString("phase")) }
                }
            }
            val name = fixture.getString("vaultName")
            require(name.matches(Regex("portal-test-[a-f0-9]{24}")))
            val vault = SecureVault(context, name, maximumBytes = 16_000_000)
            val engine = SipEngine(context, silentAudio = true)
            val personal = SipAccount(label = "Personal fixture", username = "personal", password = "fixture-personal",
                domain = "sipper.test", server = "10.0.2.2", port = fixture.getInt("sipPort"), transport = "udp", srtp = "disabled", ice = false)
            var managed = emptyList<SipAccount>()
            fun newClient() = ManagedClient(context, origin, vault) { accounts -> managed = accounts; engine.sync(listOf(personal) + accounts) }
            var client = newClient()
            try {
                engine.start(); engine.sync(listOf(personal)); client.load()
                val request = client.prepareSignIn()
                val callback = checkpoint("authorise", JSONObject().put("url", request.toUri().toString())).getString("callback")
                client.finishSignIn(AuthorizationResponse.Builder(request).fromUri(Uri.parse(callback)).build().toIntent())
                assertTrue(client.status.value.signedIn)
                assertEquals(fixture.getString("userId"), client.status.value.identity?.id)
                client.connect(fixture.getString("organisationId"))
                val device = client.status.value.connections.single().deviceId
                val account = managed.single()
                suspend fun registered() = withTimeout(10_000) {
                    engine.registrations.first { it[managed.single().id]?.state == "registered" && it[personal.id]?.state == "registered" }
                }
                registered()
                client.setAvailability(fixture.getString("organisationId"), ManagedAvailability.AWAY)
                assertEquals(false, client.status.value.organisations.single().doNotDisturb)
                val directory = client.refreshDirectory(device)
                assertEquals(3, directory.contacts.size)
                val contact = directory.contacts.single { it.matches("Alex") }
                assertEquals("*97", client.directoryNumber(device, contact.id, "*97"))
                assertTrue(runCatching { directoryAccount(listOf(personal) + managed, personal.id, device) }.isFailure)
                // A new SDK instance must recover identity, enrolled device, SIP settings and contacts from encrypted storage.
                client.close(); client = newClient(); client.load(); client.reconcile()
                assertTrue(client.status.value.signedIn)
                assertEquals(device, client.status.value.connections.single().deviceId)
                assertEquals(directory, client.directories.value[device])
                val shared = client.directoryStatus(device, listOf(contact.id))
                assertEquals(ManagedAvailability.AWAY, shared.contacts.single().availability)
                assertEquals(false, shared.contacts.single().doNotDisturb)
                checkpoint("status-shared")
                val hidden = client.directoryStatus(device, listOf(contact.id))
                assertNull(hidden.contacts.single().availability); assertNull(hidden.contacts.single().doNotDisturb)
                val peers = fixture.getJSONArray("messageUserIds").let { ids -> List(ids.length()) { ids.getString(it) } }
                assertEquals(2, peers.size)
                assertEquals(peers.toSet(), client.messagePeople(device).people.map { it.id }.toSet())
                val direct = client.createConversation(device, UUID.randomUUID().toString(), listOf(peers.first()))
                val group = client.createConversation(device, UUID.randomUUID().toString().uppercase(), peers, "Native group")
                assertEquals("group", group.kind); assertEquals(3, group.participants.size)
                val nonce = UUID.randomUUID().toString().uppercase()
                val text = "From Android: <b>literal text</b>\n🌱"
                val sent = client.sendMessage(device, direct.id, nonce, text)
                assertEquals(sent, client.sendMessage(device, direct.id.uppercase(), nonce.lowercase(), text))
                client.sendMessage(device, group.id, UUID.randomUUID().toString(), "Native group text")
                assertEquals(2, client.conversations(device).conversations.size)
                client.syncMessagePushToken("fictional-message-fcm-token")
                checkpoint("messaging", JSONObject().put("conversationId", direct.id).put("groupId", group.id).put("deviceId", device))
                val replies = client.conversationMessages(device, direct.id)
                assertEquals(2, replies.messages.size); assertEquals("Reply from a fictional colleague.", replies.messages.last().text)
                assertEquals(1, client.conversationMessages(device, direct.id, after = sent.sequence).messages.size)
                client.markConversationRead(device, direct.id, replies.messages.last().sequence)
                val groupReply = client.conversationMessages(device, group.id)
                assertEquals("Reply to the native group.", groupReply.messages.last().text)
                client.markConversationRead(device, group.id, groupReply.messages.last().sequence)
                checkpoint("messages-read")
                val changed = client.updateMessageGroup(device, group.id.uppercase(), groupReply.conversation.revision!!, "Updated native group", listOf(fixture.getString("userId")) + peers, peers.first())
                assertEquals(peers.first(), changed.ownerId)
                assertEquals(changed, client.updateMessageGroup(device, group.id, groupReply.conversation.revision!!, "Updated native group", listOf(fixture.getString("userId")) + peers, peers.first()))
                client.leaveMessageGroup(device, group.id); client.leaveMessageGroup(device, group.id)
                assertTrue(runCatching { client.conversationMessages(device, group.id) }.isFailure)
                checkpoint("groups-left", JSONObject().put("deviceId", device))
                val rejoinedGroup = client.conversationMessages(device, group.id)
                assertEquals(1, rejoinedGroup.messages.size); assertEquals("After rejoining the group.", rejoinedGroup.messages.single().text)
                client.markConversationRead(device, group.id, rejoinedGroup.messages.single().sequence)
                val selected = directoryAccount(listOf(personal) + managed, account.id, device)
                val call = engine.dial(selected.id, client.directoryNumber(device, contact.id, "*97"))
                withTimeout(10_000) { engine.calls.first { calls -> calls.any { it.id == call && it.connected } } }
                client.report(engine)
                val activity = client.directoryStatus(device, listOf(contact.id))
                assertEquals("in_call", activity.contacts.single().activity?.state); assertEquals("device", activity.contacts.single().activity?.source)
                checkpoint("activity-shared")
                assertNull(client.directoryStatus(device, listOf(contact.id)).contacts.single().activity)
                checkpoint("calling", JSONObject().put("deviceId", device))
                client.refresh()
                assertEquals("suspended", client.status.value.organisations.single().status)
                assertTrue(managed.isEmpty()); assertTrue(client.directories.value.isEmpty())
                assertEquals("unregistered", engine.registration(account.id).state)
                assertEquals("registered", engine.registration(personal.id).state)
                assertTrue(engine.calls.value.single().connected)
                assertTrue(runCatching { client.directoryNumber(device, contact.id, "*97") }.isFailure)
                assertTrue(runCatching { client.conversationMessages(device, direct.id) }.isFailure)
                checkpoint("suspended")
                client.refresh(); registered(); client.refreshDirectory(device)
                assertTrue(client.status.value.connections.single().configured)
                engine.hangup(call)
                withTimeout(6000) { engine.calls.first { it.isEmpty() } }
                client.report(engine)
                client.setAvailability(fixture.getString("organisationId"), ManagedAvailability.UNSET)
                client.disconnect(device)
                assertTrue(managed.isEmpty()); assertTrue(client.directories.value.isEmpty())
                assertTrue(runCatching { client.conversations(device) }.isFailure)
                checkpoint("disconnected", JSONObject().put("deviceId", device))
                client.connect(fixture.getString("organisationId")); registered()
                val replacement = client.status.value.connections.single().deviceId
                assertNotEquals(device, replacement)
                val restoredHistory = client.conversationMessages(replacement, direct.id)
                assertEquals(2, restoredHistory.messages.size); assertEquals(0, restoredHistory.conversation.unread)
                client.signOut()
                assertNull(vault.read()); assertFalse(client.status.value.signedIn)
                assertTrue(managed.isEmpty()); assertTrue(client.directories.value.isEmpty())
                assertEquals("registered", engine.registration(personal.id).state)
                client.close(); client = newClient(); client.load(); client.reconcile()
                assertFalse(client.status.value.signedIn)
                checkpoint("signed-out", JSONObject().put("deviceId", replacement))
            } finally {
                client.close(); engine.close(); vault.clear()
                phaseFile.delete(); replyFile.delete()
            }
        }
    }
}
