package com.lisofer.characteria.musetalk

import java.util.ArrayDeque
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlin.math.floor

/**
 * Copia del audio que YA salió por AudioTrack. Nunca está en el camino crítico de voz.
 * Un worker lo convierte 44.1 kHz -> 16 kHz, que es lo que usa Whisper/MuseTalk.
 */
object MuseTalkAudioBus {
    data class Chunk(val pcm: ByteArray, val playedAtNanos: Long)

    private const val INPUT_RATE = 44_100
    private const val OUTPUT_RATE = 16_000
    private const val MAX_RING_SAMPLES = OUTPUT_RATE * 4 // 4 s; lo viejo se descarta.

    private val queue = ArrayBlockingQueue<Chunk>(10)
    private val ring = ArrayDeque<Float>(MAX_RING_SAMPLES)
    private val running = AtomicBoolean(true)

    init {
        thread(name = "MuseTalkAudio", isDaemon = true) {
            while (running.get()) {
                runCatching {
                    val chunk = queue.take()
                    val converted = resample44100To16000(chunk.pcm)
                    synchronized(ring) {
                        converted.forEach { sample ->
                            while (ring.size >= MAX_RING_SAMPLES) ring.removeFirst()
                            ring.addLast(sample)
                        }
                    }
                }
            }
        }
    }

    /** Se llama DESPUÉS de escribir el PCM al AudioTrack. */
    fun offerPlayedPcm44100(bytes: ByteArray, playedAtNanos: Long = System.nanoTime()) {
        if (bytes.size < 2) return
        val copy = bytes.copyOf()
        if (!queue.offer(Chunk(copy, playedAtNanos))) {
            queue.poll() // el video puede perder audio viejo; la voz jamás espera.
            queue.offer(Chunk(copy, playedAtNanos))
        }
    }

    /**
     * Devuelve la ventana MÁS RECIENTE sin bloquear. 3200 samples = 200 ms a 16 kHz.
     * Si todavía no hay suficiente audio, completa el comienzo con silencio.
     */
    fun latestWindow(samples: Int = 3_200): FloatArray {
        val wanted = samples.coerceIn(160, OUTPUT_RATE * 2)
        val result = FloatArray(wanted)
        synchronized(ring) {
            val available = minOf(wanted, ring.size)
            val skip = ring.size - available
            var index = 0
            var out = wanted - available
            ring.forEach { value ->
                if (index++ >= skip && out < wanted) result[out++] = value
            }
        }
        return result
    }

    fun reset() {
        queue.clear()
        synchronized(ring) { ring.clear() }
    }

    private fun resample44100To16000(pcm: ByteArray): FloatArray {
        val inputCount = pcm.size / 2
        if (inputCount <= 1) return FloatArray(0)
        val input = FloatArray(inputCount)
        var p = 0
        var i = 0
        while (p + 1 < pcm.size) {
            val lo = pcm[p].toInt() and 0xff
            val hi = pcm[p + 1].toInt()
            input[i++] = (((hi shl 8) or lo).toShort().toInt() / 32768f).coerceIn(-1f, 1f)
            p += 2
        }

        val outputCount = ((inputCount.toLong() * OUTPUT_RATE) / INPUT_RATE).toInt().coerceAtLeast(1)
        val output = FloatArray(outputCount)
        val ratio = INPUT_RATE.toDouble() / OUTPUT_RATE.toDouble()
        for (o in 0 until outputCount) {
            val source = o * ratio
            val left = floor(source).toInt().coerceIn(0, inputCount - 1)
            val right = (left + 1).coerceAtMost(inputCount - 1)
            val frac = (source - left).toFloat()
            output[o] = input[left] * (1f - frac) + input[right] * frac
        }
        return output
    }
}
