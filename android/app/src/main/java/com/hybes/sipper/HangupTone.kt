package com.hybes.sipper

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import kotlin.math.PI
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/** The short three-beep tone played when a call ends, matching the desktop apps. */
internal object HangupTone {
    const val SAMPLE_RATE = 16_000
    private const val BEEP_MS = 120
    private const val GAP_MS = 60
    private const val FADE_MS = 8
    private const val LEVEL = 0.25
    private val FREQUENCIES = listOf(880.0, 660.0, 440.0)
    private const val PREFERENCES = "call-settings"
    private const val KEY = "hangupTone"

    /** Ended calls that were connected here, or outgoing calls, get a tone unless another call is still connected. */
    fun shouldPlay(ended: PhoneCall, others: List<PhoneCall>, enabled: Boolean): Boolean =
        enabled && (ended.connected || !ended.incoming) &&
            others.none { it.id != ended.id && it.connected && it.state != "Ended" }

    fun samples(sampleRate: Int = SAMPLE_RATE): ShortArray {
        val beep = sampleRate * BEEP_MS / 1000
        val gap = sampleRate * GAP_MS / 1000
        val fade = sampleRate * FADE_MS / 1000
        val output = ShortArray(beep * FREQUENCIES.size + gap * (FREQUENCIES.size - 1))
        FREQUENCIES.forEachIndexed { index, frequency ->
            val start = index * (beep + gap)
            for (n in 0 until beep) {
                val envelope = min(1.0, min(n, beep - 1 - n).toDouble() / fade)
                val value = sin(2 * PI * frequency * n / sampleRate) * LEVEL * envelope
                output[start + n] = (value * Short.MAX_VALUE).roundToInt().toShort()
            }
        }
        return output
    }

    fun enabled(context: Context) = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getBoolean(KEY, true)
    fun setEnabled(context: Context, value: Boolean) {
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putBoolean(KEY, value).apply()
    }

    /**
     * Plays through the voice-communication path, so it follows the call's route while
     * Android is still in communication mode and the normal output afterwards.
     */
    fun play() {
        val data = samples()
        val track = try {
            AudioTrack.Builder()
                .setAudioAttributes(AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                .setAudioFormat(AudioFormat.Builder().setSampleRate(SAMPLE_RATE)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                .setTransferMode(AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(data.size * 2)
                .build()
        } catch (_: Exception) { return } // A missing tone must never affect call handling.
        try {
            track.write(data, 0, data.size)
            track.play()
        } catch (_: Exception) { track.release(); return }
        val duration = data.size * 1000L / SAMPLE_RATE
        Handler(Looper.getMainLooper()).postDelayed({ runCatching { track.stop() }; track.release() }, duration + 200)
    }
}
