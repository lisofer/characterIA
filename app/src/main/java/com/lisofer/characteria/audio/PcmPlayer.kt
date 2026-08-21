package com.lisofer.characteria.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Reproductor PCM no bloqueante.
 *
 * Fish entrega audio desde el callback de su WebSocket. Antes, ese callback hacía
 * AudioTrack.write(..., WRITE_BLOCKING) directamente, por lo que el hilo de red
 * quedaba ocupado esperando que el teléfono reprodujera el audio. Eso podía
 * acumular frames y hacer que la voz se sintiera "tildada" o con mucha latencia.
 *
 * Ahora el callback solo encola el audio y un hilo dedicado se encarga de
 * reproducirlo a velocidad real.
 */
class PcmPlayer(private val sampleRate: Int = 44_100) {
    private data class Chunk(
        val generation: Long,
        val bytes: ByteArray,
    )

    private val lock = ReentrantLock()
    private val queue = LinkedBlockingQueue<Chunk>()
    private val generation = AtomicLong(0)
    private val released = AtomicBoolean(false)
    private var track: AudioTrack? = null

    private val playbackThread = Thread({ playbackLoop() }, "CharacterIA-PcmPlayer").apply {
        priority = Thread.NORM_PRIORITY + 1
        start()
    }

    private fun ensureTrack(): AudioTrack = lock.withLock {
        track?.let { return it }

        val platformMin = AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        ).coerceAtLeast(1)

        // ~120 ms como piso. El código anterior forzaba un buffer cercano a 1 s
        // en muchos equipos, agregando latencia audible antes de escuchar a Fish.
        val targetBuffer = (sampleRate * 2 * 120 / 1000)
        val bufferBytes = maxOf(platformMin, targetBuffer)

        val created = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .build()
            )
            .setBufferSizeInBytes(bufferBytes)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setSessionId(AudioManager.AUDIO_SESSION_ID_GENERATE)
            .build()

        created.play()
        track = created
        created
    }

    /**
     * Retorna inmediatamente. La reproducción ocurre en playbackThread.
     */
    fun write(bytes: ByteArray) {
        if (bytes.isEmpty() || released.get()) return
        queue.offer(Chunk(generation.get(), bytes.copyOf()))
    }

    private fun playbackLoop() {
        while (!released.get()) {
            val chunk = try {
                queue.take()
            } catch (_: InterruptedException) {
                if (released.get()) break
                continue
            }

            val expectedGeneration = chunk.generation
            if (expectedGeneration != generation.get()) continue

            val t = runCatching { ensureTrack() }.getOrNull() ?: continue
            var offset = 0
            while (
                offset < chunk.bytes.size &&
                !released.get() &&
                expectedGeneration == generation.get()
            ) {
                val n = t.write(
                    chunk.bytes,
                    offset,
                    chunk.bytes.size - offset,
                    AudioTrack.WRITE_BLOCKING,
                )
                if (n <= 0) break
                offset += n
            }
        }
    }

    fun interrupt() {
        generation.incrementAndGet()
        queue.clear()
        lock.withLock {
            track?.let {
                runCatching { it.pause() }
                runCatching { it.flush() }
                runCatching { it.play() }
            }
        }
    }

    fun release() {
        if (!released.compareAndSet(false, true)) return
        generation.incrementAndGet()
        queue.clear()
        playbackThread.interrupt()
        lock.withLock {
            track?.let {
                runCatching { it.stop() }
                runCatching { it.flush() }
                runCatching { it.release() }
            }
            track = null
        }
    }
}
