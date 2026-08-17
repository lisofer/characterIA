package com.lisofer.characteria.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import com.lisofer.characteria.musetalk.MuseTalkAudioBus
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

class PcmPlayer(private val sampleRate: Int = 44_100) {
    private val lock = ReentrantLock()
    private var track: AudioTrack? = null

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
        created.play()
        track = created
        created
    }

    fun write(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        val t = ensureTrack()
        var offset = 0
        while (offset < bytes.size) {
            val n = t.write(bytes, offset, bytes.size - offset, AudioTrack.WRITE_BLOCKING)
            if (n <= 0) break
            offset += n
        }

        // MuseTalk escucha DESPUÉS de AudioTrack. Si el renderer va lento, sólo pierde
        // fotogramas; jamás retrasa una sílaba de Fish.
        if (offset > 0) MuseTalkAudioBus.offerPlayedPcm44100(bytes)
    }

    fun interrupt() = lock.withLock {
        MuseTalkAudioBus.reset()
        track?.let {
            runCatching { it.pause() }
            runCatching { it.flush() }
            runCatching { it.play() }
        }
    }

    fun release() = lock.withLock {
        MuseTalkAudioBus.reset()
        track?.let {
            runCatching { it.stop() }
            runCatching { it.release() }
        }
        track = null
    }
}
