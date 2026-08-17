package com.lisofer.characteria.vision

import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.math.sqrt

/**
 * Señal visual derivada del mismo PCM que se envía a AudioTrack.
 * No agrega buffer: sólo toma una muestra liviana de cada chunk antes de reproducirlo.
 */
object LipSyncBus {
    private val _level = MutableStateFlow(0f)
    val level: StateFlow<Float> = _level.asStateFlow()

    private val handler = Handler(Looper.getMainLooper())
    private var generation = 0L

    @Synchronized
    fun pushPcm16Le(bytes: ByteArray) {
        if (bytes.size < 2) return

        var sumSquares = 0.0
        var count = 0
        // Un sample de cada 4 alcanza para estimar energía de voz y mantiene el costo ínfimo.
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
        val raw = ((rms - 0.010f) / 0.105f).coerceIn(0f, 1f)
        val previous = _level.value
        val smoothed = if (raw >= previous) {
            previous * .24f + raw * .76f
        } else {
            previous * .70f + raw * .30f
        }
        _level.value = smoothed

        val token = ++generation
        handler.postDelayed({
            synchronized(this) {
                if (token == generation) _level.value = 0f
            }
        }, 150L)
    }

    @Synchronized
    fun reset() {
        generation++
        _level.value = 0f
    }
}
