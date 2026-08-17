package com.lisofer.characteria.vision

import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.text.Normalizer
import java.util.ArrayDeque
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
    val viseme: MouthViseme = MouthViseme.REST,
)

/**
 * El audio sigue siendo el reloj maestro. El texto que ya se envía a Fish sólo
 * anticipa qué forma real de boca conviene mostrar; jamás retrasa AudioTrack.
 */
object LipSyncBus {
    private const val SAMPLE_RATE = 44_100
    private const val VISEME_STEP_MS = 54f

    private val _state = MutableStateFlow(LipSyncState())
    val state: StateFlow<LipSyncState> = _state.asStateFlow()

    private val pending = ArrayDeque<MouthViseme>()
    private val handler = Handler(Looper.getMainLooper())
    private var generation = 0L
    private var elapsedForVisemeMs = 0f
    private var current = MouthViseme.REST

    @Synchronized
    fun startTurn() {
        pending.clear()
        elapsedForVisemeMs = 0f
        current = MouthViseme.REST
        generation++
        _state.value = LipSyncState()
    }

    /** Convierte texto incremental a una cola muy pequeña de formas de boca. */
    @Synchronized
    fun queueText(text: String) {
        if (text.isBlank()) {
            if (text.any { it.isWhitespace() }) pending.addLast(MouthViseme.REST)
            return
        }

        val normalized = Normalizer.normalize(text.lowercase(), Normalizer.Form.NFD)
            .replace("\\p{M}+".toRegex(), "")

        normalized.forEach { ch ->
            when (ch) {
                'a' -> repeatState(MouthViseme.OPEN, 2)
                'e', 'i', 'y' -> repeatState(MouthViseme.WIDE, 2)
                'o', 'u', 'w' -> repeatState(MouthViseme.ROUND, 2)
                'm', 'p', 'b' -> repeatState(MouthViseme.CLOSED, 1)
                'f', 'v' -> repeatState(MouthViseme.WIDE, 1)
                'l', 'r', 't', 'd', 'n', 's', 'z', 'c', 'k', 'q', 'g', 'j', 'x', 'ñ' ->
                    repeatState(MouthViseme.REST, 1)
                '.', '?', '!', '…', ';', ':' -> repeatState(MouthViseme.REST, 3)
                ',', '\n' -> repeatState(MouthViseme.REST, 2)
                ' ' -> repeatState(MouthViseme.REST, 1)
            }
        }
    }

    @Synchronized
    fun pushPcm16Le(bytes: ByteArray) {
        if (bytes.size < 2) return

        var sumSquares = 0.0
        var count = 0
        var i = 0
        while (i + 1 < bytes.size) {
            val lo = bytes[i].toInt() and 0xFF
            val hi = bytes[i + 1].toInt()
            val sample = ((hi shl 8) or lo).toShort().toInt()
            val normalized = sample / 32768.0
            sumSquares += normalized * normalized
            count++
            i += 8
        }
        if (count == 0) return

        val rms = sqrt(sumSquares / count).toFloat()
        val rawLevel = ((rms - 0.008f) / 0.11f).coerceIn(0f, 1f)
        val previousLevel = _state.value.level
        val level = if (rawLevel >= previousLevel) {
            previousLevel * .18f + rawLevel * .82f
        } else {
            previousLevel * .62f + rawLevel * .38f
        }

        val samples = bytes.size / 2f
        elapsedForVisemeMs += samples / SAMPLE_RATE.toFloat() * 1000f
        while (elapsedForVisemeMs >= VISEME_STEP_MS) {
            elapsedForVisemeMs -= VISEME_STEP_MS
            if (pending.isNotEmpty()) current = pending.removeFirst()
        }

        val visible = if (rms < .0055f) MouthViseme.REST else current
        _state.value = LipSyncState(level = level, viseme = visible)

        val token = ++generation
        handler.postDelayed({
            synchronized(this) {
                if (token == generation) {
                    current = MouthViseme.REST
                    _state.value = LipSyncState()
                }
            }
        }, 125L)
    }

    @Synchronized
    fun reset() {
        pending.clear()
        elapsedForVisemeMs = 0f
        current = MouthViseme.REST
        generation++
        _state.value = LipSyncState()
    }

    private fun repeatState(state: MouthViseme, count: Int) {
        repeat(count) {
            if (pending.size < 500) pending.addLast(state)
        }
    }
}
