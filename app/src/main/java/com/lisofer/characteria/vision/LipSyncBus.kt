package com.lisofer.characteria.vision

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.text.Normalizer
import java.util.ArrayDeque
import kotlin.math.abs
import kotlin.math.sqrt

enum class MouthViseme {
    REST,
    CLOSED,
    WIDE,
    OPEN,
    ROUND,
}

data class LipSyncState(
    val level: Float = 0f,
    val openness: Float = 0f,
    val widthBias: Float = 0f,
    val viseme: MouthViseme = MouthViseme.REST,
    val speaking: Boolean = false,
)

/**
 * Lipsync liviano guiado por el mismo PCM que reproduce AudioTrack.
 * Fish suele entregar bloques bastante grandes; los dividimos en ventanas de 20 ms y un
 * ticker a ~60 Hz interpola los objetivos para que la boca se mueva de forma continua.
 * El texto sólo decide la forma aproximada; la energía del audio decide cuándo/cuánto se mueve.
 */
object LipSyncBus {
    private const val SAMPLE_RATE = 44_100
    private const val WINDOW_MS = 20L
    private const val WINDOW_SAMPLES = SAMPLE_RATE / 50
    private const val VISEME_STEP_MS = 60f
    private const val TICK_MS = 16L
    private const val SPEECH_GATE = 0.0048f
    private const val FORCE_REST_AFTER_MS = 220L

    private data class ScheduledTarget(
        val atMs: Long,
        val level: Float,
        val openness: Float,
        val widthBias: Float,
        val viseme: MouthViseme,
        val speaking: Boolean,
    )

    private val _state = MutableStateFlow(LipSyncState())
    val state: StateFlow<LipSyncState> = _state.asStateFlow()

    private val pendingVisemes = ArrayDeque<MouthViseme>()
    private val scheduled = ArrayDeque<ScheduledTarget>()
    private val handler = Handler(Looper.getMainLooper())

    private var visemeClockMs = 0f
    private var currentTextViseme = MouthViseme.REST
    private var currentTarget = LipSyncState()
    private var tickerRunning = false
    private var lastScheduledSpeechMs = 0L

    @Synchronized
    fun startTurn() {
        pendingVisemes.clear()
        scheduled.clear()
        visemeClockMs = 0f
        currentTextViseme = MouthViseme.REST
        currentTarget = LipSyncState()
        lastScheduledSpeechMs = 0L
        _state.value = LipSyncState()
        ensureTickerLocked()
    }

    @Synchronized
    fun queueText(text: String) {
        if (text.isEmpty()) return
        val normalized = Normalizer.normalize(text.lowercase(), Normalizer.Form.NFD)
            .replace("\\p{M}+".toRegex(), "")

        normalized.forEach { ch ->
            when (ch) {
                'a' -> appendViseme(MouthViseme.OPEN, 2)
                'e', 'i', 'y' -> appendViseme(MouthViseme.WIDE, 2)
                'o', 'u', 'w' -> appendViseme(MouthViseme.ROUND, 2)
                'm', 'p', 'b' -> appendViseme(MouthViseme.CLOSED, 1)
                'f', 'v' -> appendViseme(MouthViseme.WIDE, 1)
                'l', 'r', 't', 'd', 'n', 's', 'z', 'c', 'k', 'q', 'g', 'j', 'x', 'ñ' ->
                    appendViseme(MouthViseme.OPEN, 1)
                '.', '?', '!', '…', ';', ':' -> appendViseme(MouthViseme.REST, 2)
                ',', '\n' -> appendViseme(MouthViseme.REST, 1)
                ' ' -> if (pendingVisemes.lastOrNull() != MouthViseme.REST) {
                    appendViseme(MouthViseme.REST, 1)
                }
            }
        }
    }

    /**
     * Encola PCM que ya fue aceptado por AudioTrack. startDelayMs indica cuánto audio había
     * delante de este bloque en el buffer, para alinear labios con lo que realmente se escucha.
     */
    @Synchronized
    fun pushPcm16Le(bytes: ByteArray, startDelayMs: Long = 0L) {
        if (bytes.size < 2) return
        val now = SystemClock.uptimeMillis()
        val totalSamples = bytes.size / 2
        val windows = ((totalSamples + WINDOW_SAMPLES - 1) / WINDOW_SAMPLES).coerceAtLeast(1)

        for (window in 0 until windows) {
            val sampleFrom = window * WINDOW_SAMPLES
            val sampleTo = minOf(totalSamples, sampleFrom + WINDOW_SAMPLES)
            if (sampleFrom >= sampleTo) break

            var sumSquares = 0.0
            var count = 0
            var sampleIndex = sampleFrom
            while (sampleIndex < sampleTo) {
                val byteIndex = sampleIndex * 2
                val lo = bytes[byteIndex].toInt() and 0xff
                val hi = bytes[byteIndex + 1].toInt()
                val sample = ((hi shl 8) or lo).toShort().toInt() / 32768.0
                sumSquares += sample * sample
                count++
                sampleIndex++
            }
            if (count == 0) continue

            val rms = sqrt(sumSquares / count).toFloat()
            val level = ((rms - SPEECH_GATE) / 0.095f).coerceIn(0f, 1f)
            val speaking = rms >= SPEECH_GATE

            visemeClockMs += ((sampleTo - sampleFrom) / SAMPLE_RATE.toFloat()) * 1000f
            while (visemeClockMs >= VISEME_STEP_MS) {
                visemeClockMs -= VISEME_STEP_MS
                if (pendingVisemes.isNotEmpty()) currentTextViseme = pendingVisemes.removeFirst()
            }

            val viseme = when {
                !speaking -> MouthViseme.REST
                currentTextViseme == MouthViseme.REST && pendingVisemes.isEmpty() -> MouthViseme.OPEN
                else -> currentTextViseme
            }

            val openness = if (!speaking) {
                0f
            } else {
                when (viseme) {
                    MouthViseme.CLOSED -> 0.04f + level * 0.08f
                    MouthViseme.WIDE -> 0.18f + level * 0.55f
                    MouthViseme.OPEN -> 0.20f + level * 0.78f
                    MouthViseme.ROUND -> 0.18f + level * 0.66f
                    MouthViseme.REST -> 0.10f + level * 0.42f
                }.coerceIn(0f, 1f)
            }
            val widthBias = when (viseme) {
                MouthViseme.WIDE -> 0.22f + level * 0.12f
                MouthViseme.ROUND -> -(0.18f + level * 0.10f)
                else -> 0f
            }

            val at = now + startDelayMs.coerceIn(0L, 450L) + window * WINDOW_MS
            scheduled.addLast(
                ScheduledTarget(
                    atMs = at,
                    level = level,
                    openness = openness,
                    widthBias = widthBias,
                    viseme = viseme,
                    speaking = speaking,
                )
            )
            if (speaking) lastScheduledSpeechMs = at
        }

        while (scheduled.size > 120) scheduled.removeFirst()
        ensureTickerLocked()
    }

    @Synchronized
    fun reset() {
        pendingVisemes.clear()
        scheduled.clear()
        visemeClockMs = 0f
        currentTextViseme = MouthViseme.REST
        currentTarget = LipSyncState()
        lastScheduledSpeechMs = 0L
        _state.value = LipSyncState()
        ensureTickerLocked()
    }

    private val ticker = object : Runnable {
        override fun run() {
            val keepRunning = synchronized(LipSyncBus) {
                val now = SystemClock.uptimeMillis()
                while (scheduled.isNotEmpty() && scheduled.first().atMs <= now) {
                    val next = scheduled.removeFirst()
                    currentTarget = LipSyncState(
                        level = next.level,
                        openness = next.openness,
                        widthBias = next.widthBias,
                        viseme = next.viseme,
                        speaking = next.speaking,
                    )
                }

                if (scheduled.isEmpty() && lastScheduledSpeechMs > 0L && now - lastScheduledSpeechMs > FORCE_REST_AFTER_MS) {
                    currentTarget = LipSyncState()
                }

                val previous = _state.value
                val openAlpha = if (currentTarget.openness >= previous.openness) 0.48f else 0.30f
                val levelAlpha = if (currentTarget.level >= previous.level) 0.55f else 0.34f
                val openness = lerp(previous.openness, currentTarget.openness, openAlpha)
                val level = lerp(previous.level, currentTarget.level, levelAlpha)
                val width = lerp(previous.widthBias, currentTarget.widthBias, 0.34f)
                val speaking = currentTarget.speaking || openness > 0.035f || scheduled.any { it.speaking }

                _state.value = LipSyncState(
                    level = level,
                    openness = if (openness < 0.008f) 0f else openness,
                    widthBias = if (abs(width) < 0.005f) 0f else width,
                    viseme = if (speaking) currentTarget.viseme else MouthViseme.REST,
                    speaking = speaking,
                )

                val stillAnimating = scheduled.isNotEmpty() || openness > 0.008f || level > 0.008f || abs(width) > 0.005f
                tickerRunning = stillAnimating
                stillAnimating
            }

            if (keepRunning) handler.postDelayed(this, TICK_MS)
        }
    }

    private fun ensureTickerLocked() {
        if (tickerRunning) return
        tickerRunning = true
        handler.removeCallbacks(ticker)
        handler.post(ticker)
    }

    private fun appendViseme(state: MouthViseme, count: Int) {
        repeat(count) {
            if (pendingVisemes.size >= 420) return
            val duplicateRun = pendingVisemes.size >= 2 &&
                pendingVisemes.lastOrNull() == state &&
                pendingVisemes.elementAt(pendingVisemes.size - 2) == state
            if (!duplicateRun) pendingVisemes.addLast(state)
        }
    }

    private fun lerp(a: Float, b: Float, t: Float): Float = a + (b - a) * t.coerceIn(0f, 1f)
}
