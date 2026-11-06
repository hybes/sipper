package com.hybes.sipper

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.abs

class HangupToneTest {
    @Test fun threeFadedBeepsWithSilentGaps() {
        val samples = HangupTone.samples(16_000)
        assertEquals(16 * (120 * 3 + 60 * 2), samples.size)
        assertEquals(0, samples.first().toInt())
        assertEquals(0, samples.last().toInt())
        val gap = samples.copyOfRange(16 * 120, 16 * 180)
        assertTrue(gap.all { it.toInt() == 0 })
        val peak = samples.maxOf { abs(it.toInt()) }
        assertTrue(peak in 7_000..8_300) // About a quarter of full scale.
    }

    @Test fun onlyConnectedOrOutgoingCallsWithNoOtherConnectedCall() {
        val connected = PhoneCall("a", "x", "100", incoming = true, state = "Ended", connected = true)
        val missed = PhoneCall("b", "x", "100", incoming = true, state = "Ended")
        val outgoing = PhoneCall("c", "x", "100", incoming = false, state = "Ended")
        val other = PhoneCall("d", "x", "200", incoming = false, state = "Connected", connected = true)
        val ringing = PhoneCall("e", "x", "300", incoming = true, state = "Incoming")
        assertTrue(HangupTone.shouldPlay(connected, listOf(connected), enabled = true))
        assertTrue(HangupTone.shouldPlay(outgoing, listOf(ringing), enabled = true))
        assertFalse(HangupTone.shouldPlay(missed, emptyList(), enabled = true))
        assertFalse(HangupTone.shouldPlay(connected, listOf(other), enabled = true))
        assertFalse(HangupTone.shouldPlay(connected, emptyList(), enabled = false))
    }
}
