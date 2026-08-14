package com.lisofer.characteria.audio

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicBoolean

class MicStreamer(private val context: Context) {
    private val running = AtomicBoolean(false)
    private var recorder: AudioRecord? = null
    private var thread: Thread? = null
    private var echoCanceler: AcousticEchoCanceler? = null
    private var noiseSuppressor: NoiseSuppressor? = null

    @SuppressLint("MissingPermission")
    fun start(onChunk: (ByteArray) -> Unit): Result<Unit> {
        if (running.get()) return Result.success(Unit)
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return Result.failure(SecurityException("Falta permiso de micrófono"))
        }

        return runCatching {
            val sampleRate = 16_000
            val min = AudioRecord.getMinBufferSize(
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            )
            val chunkBytes = 3_200 // 100 ms: 1600 samples x 2 bytes
            val bufferBytes = maxOf(min * 2, chunkBytes * 4)

            val audioRecord = AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferBytes,
            )
            check(audioRecord.state == AudioRecord.STATE_INITIALIZED) { "No se pudo inicializar AudioRecord" }

            recorder = audioRecord
            if (AcousticEchoCanceler.isAvailable()) {
                echoCanceler = AcousticEchoCanceler.create(audioRecord.audioSessionId)?.apply { enabled = true }
            }
            if (NoiseSuppressor.isAvailable()) {
                noiseSuppressor = NoiseSuppressor.create(audioRecord.audioSessionId)?.apply { enabled = true }
            }

            running.set(true)
            audioRecord.startRecording()
            thread = Thread({
                val buffer = ByteArray(chunkBytes)
                while (running.get()) {
                    val read = audioRecord.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
                    if (read > 0) onChunk(buffer.copyOf(read))
                }
            }, "CharacterIA-Mic").apply {
                priority = Thread.MAX_PRIORITY
                start()
            }
        }
    }

    fun stop() {
        if (!running.getAndSet(false)) return
        runCatching { recorder?.stop() }
        runCatching { thread?.join(700) }
        runCatching { echoCanceler?.release() }
        runCatching { noiseSuppressor?.release() }
        runCatching { recorder?.release() }
        recorder = null
        thread = null
        echoCanceler = null
        noiseSuppressor = null
    }
}
