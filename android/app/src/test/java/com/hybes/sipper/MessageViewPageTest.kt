package com.hybes.sipper

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test

class MessageViewPageTest {
    @Test fun meetingsAndPhoneAudioHaveOneOwnerBeforeAnyPermissionOrCallWork() {
        var busy = true
        val guard = PhoneAudioGuard { busy }
        assertFalse(guard.claimMeeting())
        busy = false
        assertTrue(guard.claimMeeting())
        assertTrue(guard.meetingClaimed.value)
        assertFalse(guard.claimMeeting())
        assertTrue(runCatching { guard.requirePhone() }.exceptionOrNull() is IllegalStateException)
        guard.releaseMeeting()
        guard.requirePhone()
        busy = true
        assertFalse(guard.claimMeeting())
        assertFalse(guard.meetingClaimed.value)
    }
    @Test fun inactivePagesNeitherRequestNorAcceptMessageBodies() = runBlocking {
        withTimeout(5_000) {
            var active = false
            var requests = 0
            val entered = CompletableDeferred<Unit>()
            val reply = CompletableDeferred<Unit>()
            val page = MessageViewPage({
                requests++
                entered.complete(Unit)
                reply.await()
                "Fictional message" to (System.currentTimeMillis() + 30_000)
            }, { active })
            page.refresh()
            assertEquals(0, requests)
            assertNull(page.value)

            active = true
            val loading = launch { page.refresh() }
            entered.await()
            active = false
            reply.complete(Unit)
            loading.join()
            assertNull(page.value)
            assertFalse(page.busy)

            active = true
            page.refresh()
            assertEquals(2, requests)
            assertEquals("Fictional message", page.value)
            assertTrue(page.expiresAt > System.currentTimeMillis())
        }
    }
}
