package com.lisofer.characteria.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import com.lisofer.characteria.vision.LipSyncBus
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

class PcmPlayer(private val sampleRate: Int = 44_100) {
    private val lock = ReentrantLock()
    private var track: AudioTrack? = null
    private var totalFramesWritten = 0L

    private fun ensureTrack(): AudioTrack = lock.withLock {
        track?.let { return it }
        val min = AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        ).coerceAtLeast(sampleRate / 2)

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
            .setBufferSizeInBytes(min * 4)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setSessionId(AudioManager.AUDIO_SESSION_ID_GENERATE)
            .build()
        totalFramesWritten = 0L
        created.play()
        track = created
        created
    }

    fun write(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        val t = ensureTrack()
        var offset = 0
        while (offset < bytes.size) {
            val beforeFrames = totalFramesWritten
            val n = t.write(bytes, offset, bytes.size - offset, AudioTrack.WRITE_BLOCKING)
            if (n <= 0) break

            val writtenBytes = n - (n % 2)
            if (writtenBytes > 0) {
                // La 213 movía la boca ANTES de meter el PCM en AudioTrack. Acá usamos el
                // playbackHead para saber cuánto audio había delante de este bloque y programar
                // la animación para el instante en que realmente va a sonar.
                val playedFrames = t.playbackHeadPosition.toLong() and 0xffff_ffffL
                val backlogFrames = (beforeFrames - playedFrames).coerceAtLeast(0L)
                val backlogMs = (backlogFrames * 1000L / sampleRate).coerceIn(0L, 450L)
                val slice = if (offset == 0 && writtenBytes == bytes.size) {
                    bytes
                } else {
                    bytes.copyOfRange(offset, offset + writtenBytes)
                }
                LipSyncBus.pushPcm16Le(slice, backlogMs)
                totalFramesWritten += writtenBytes / 2L
            }
            offset += n
        }
    }

    fun interrupt() = lock.withLock {
        LipSyncBus.reset()
        track?.let {
            runCatching { it.pause() }
            runCatching { it.flush() }
            totalFramesWritten = 0L
            runCatching { it.play() }
        }
    }

    fun release() = lock.withLock {
        LipSyncBus.reset()
        track?.let {
            runCatching { it.stop() }
            runCatching { it.release() }
        }
        track = null
        totalFramesWritten = 0L
    }
}
