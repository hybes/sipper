package com.hybes.sipper

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class ManagedCallTest {
    private val id = "6c1147c3-d9ee-48a9-a12d-95881db886f0"
    @Test fun pushHintsRequireBoundIdentifiersAndAShortLiveDeadline() {
        val now = 1_800_000_000_000L
        val data = mapOf("type" to "incoming_call", "schemaVersion" to "1", "deviceId" to id,
            "callId" to id, "expiresAt" to Instant.ofEpochMilli(now + 45_000).toString())
        assertEquals(IncomingCallPush(id, id, now + 45_000), incomingCallPush(data, now))
        for (invalid in listOf(data - "deviceId", data + ("caller" to "Injected caller"),
            data + ("type" to "other"), data + ("schemaVersion" to "2"), data + ("callId" to "1-1-1-1-1"),
            data + ("deviceId" to "../other"), data + ("expiresAt" to "invalid"),
            data + ("expiresAt" to Instant.ofEpochMilli(now).toString()),
            data + ("expiresAt" to Instant.ofEpochMilli(now + 120_001).toString()))) {
            assertNull(incomingCallPush(invalid, now))
        }
        assertNull(incomingCallPush(data, now + 45_000))
    }
    @Test fun gatewayReferenceMustBeOneUnfoldedHeaderInAnInvite() {
        fun invite(headers: String, body: String = "") = "INVITE sip:100@example.invalid SIP/2.0\r\n$headers\r\n\r\n$body"
        assertEquals(id, gatewayCallId(invite("x-sipper-call-id: ${id.uppercase()}")))
        assertNull(gatewayCallId(invite("X-Sipper-Call-ID: $id\r\nX-Sipper-Call-ID: $id")))
        assertNull(gatewayCallId(invite("X-Sipper-Call-ID: $id\r\n folded")))
        assertNull(gatewayCallId(invite("Subject: Example", "X-Sipper-Call-ID: $id")))
        assertNull(gatewayCallId(invite("Subject: X-Sipper-Call-ID: $id")))
        assertNull(gatewayCallId(invite("X-Sipper-Call-ID: 1-1-1-1-1")))
        assertNull(gatewayCallId(invite("X-Sipper-Call-ID: $id").replace("INVITE ", "MESSAGE ")))
        assertNull(gatewayCallId("INVITE sip:100@example.invalid SIP/2.0\r\nX-Sipper-Call-ID: $id"))
        assertNull(gatewayCallId(invite("X-Sipper-Call-ID: $id", "x".repeat(65536))))
    }
    @Test fun terminalOtherDeviceAndExpiredCallsCannotRingOrAnswer() {
        val call = ManagedCallState(id, id, "ringing", false, 1, 2000, "Fixture caller")
        assertFalse(call.unavailable(1000))
        assertTrue(call.unavailable(2000))
        assertTrue(call.copy(state = "ended").unavailable(1000))
        assertTrue(call.copy(state = "answering").unavailable(1000))
        assertTrue(call.copy(state = "answered").unavailable(1000))
        assertFalse(call.copy(state = "answering", claimedByThisDevice = true).unavailable(1000))
        assertTrue(call.copy(state = "answering", claimedByThisDevice = true).unavailable(2000))
        assertFalse(call.copy(state = "answered", claimedByThisDevice = true).unavailable(3000))
    }
}
