package com.lisofer.characteria.musetalk

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.ArrayDeque
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlin.math.floor

/**
 * Video-side copy of Fish PCM. AudioTrack always gets priority; this queue may drop
 * stale work if neural rendering cannot keep up.
 */
object MuseTalkAudioBus {
    data class Chunk(val pcm: ByteArray, val playedAtNanos: Long)
    data class Snapshot(val audio16k: FloatArray, val totalSamples16k: Long, val revision: Long)

    private const val INPUT_RATE = 44_100
    private const val OUTPUT_RATE = 16_000
    private const val MAX_RING_SAMPLES = OUTPUT_RATE * 4

    private val queue = ArrayBlockingQueue<Chunk>(10)
    private val ring = ArrayDeque<Float>(MAX_RING_SAMPLES)
    private val running = AtomicBoolean(true)
    private val _revision = MutableStateFlow(0L)
    val revision: StateFlow<Long> = _revision.asStateFlow()

    @Volatile private var lastAudioNanos: Long = 0L
    @Volatile private var totalSamples: Long = 0L

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
                        totalSamples += converted.size
                    }
                    lastAudioNanos = chunk.playedAtNanos
                    _revision.value = _revision.value + 1L
                }
            }
        }
    }

    fun offerPlayedPcm44100(bytes: ByteArray, playedAtNanos: Long = System.nanoTime()) {
        if (bytes.size < 2) return
        val copy = bytes.copyOf()
        if (!queue.offer(Chunk(copy, playedAtNanos))) {
            queue.poll()
            queue.offer(Chunk(copy, playedAtNanos))
        }
    }

    fun hasRecentSpeech(maxAgeMs: Long = 650L): Boolean {
        val last = lastAudioNanos
        return last != 0L && (System.nanoTime() - last) <= maxAgeMs * 1_000_000L
    }

    fun snapshot(samples: Int = 8_000): Snapshot {
        val wanted = samples.coerceIn(160, OUTPUT_RATE * 2)
        val result = FloatArray(wanted)
        val total: Long
        synchronized(ring) {
            val available = minOf(wanted, ring.size)
            val skip = ring.size - available
            var index = 0
            var out = wanted - available
            ring.forEach { value ->
                if (index++ >= skip && out < wanted) result[out++] = value
            }
            total = totalSamples
        }
        return Snapshot(result, total, _revision.value)
    }

    fun latestWindow(samples: Int = 8_000): FloatArray = snapshot(samples).audio16k

    fun reset() {
        queue.clear()
        synchronized(ring) {
            ring.clear()
            totalSamples = 0L
        }
        lastAudioNanos = 0L
        _revision.value = _revision.value + 1L
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
