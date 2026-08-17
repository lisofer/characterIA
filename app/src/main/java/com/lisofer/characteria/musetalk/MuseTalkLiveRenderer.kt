package com.lisofer.characteria.musetalk

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import kotlin.math.max
import kotlin.math.min

/**
 * Live on-device renderer.
 *
 * Preparing an avatar must stay cheap after it reaches 16/16: the heavy ONNX sessions are
 * created only after Fish actually starts delivering PCM. Audio always remains the master
 * clock and video work is allowed to drop frames. After a long silence the neural sessions
 * are released so CharacterIA gives RAM back to Android.
 */
object MuseTalkLiveRenderer {
    data class RenderedFrame(
        val profileId: String,
        val bitmap: Bitmap,
        val generatedAtNanos: Long,
    )

    sealed interface State {
        data object Idle : State
        data class Loading(val detail: String) : State
        data class Speaking(val neuralMs: Long, val outputFps: Float, val skippedFrames: Long) : State
        data class Error(val message: String) : State
    }

    private const val RELEASE_AFTER_SILENCE_MS = 15_000L

    private val _frame = MutableStateFlow<RenderedFrame?>(null)
    val frame: StateFlow<RenderedFrame?> = _frame.asStateFlow()
    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    suspend fun run(context: Context, prepared: MuseTalkPreparedAvatar) = withContext(Dispatchers.Default) {
        val app = context.applicationContext
        // Latents are tiny (~32 KB/frame). Reading these does not load MuseTalk itself.
        val latents = prepared.frames.map { MuseTalkPreparedStore.readLatent(it.latentPath) }

        var engine: MuseTalkOrtEngine? = null
        var audioFrameClock = 0L
        var avatarFrameClock = 0L
        var lastNeuralMs = 40L
        var skipped = 0L
        var fpsWindowStart = System.nanoTime()
        var fpsFrames = 0
        var measuredFps = 0f
        var lastSpeechNanos = 0L
        var waitForFreshSpeechAfterError = false
        _state.value = State.Idle

        try {
            while (currentCoroutineContext().isActive) {
                val speakingNow = MuseTalkAudioBus.hasRecentSpeech()

                if (!speakingNow) {
                    _frame.value = null
                    if (_state.value !is State.Error) _state.value = State.Idle

                    if (waitForFreshSpeechAfterError) {
                        waitForFreshSpeechAfterError = false
                        _state.value = State.Idle
                    }

                    if (engine != null && lastSpeechNanos != 0L) {
                        val idleMs = (System.nanoTime() - lastSpeechNanos) / 1_000_000L
                        if (idleMs >= RELEASE_AFTER_SILENCE_MS) {
                            engine?.close()
                            engine = null
                        }
                    }
                    delay(20)
                    continue
                }

                lastSpeechNanos = System.nanoTime()
                if (waitForFreshSpeechAfterError) {
                    // Do not hammer the same failing inference continuously during one Fish turn.
                    delay(30)
                    continue
                }

                val snapshot = MuseTalkAudioBus.snapshot(8_000) // 500 ms rolling context
                val currentClock = snapshot.totalSamples16k / 640L // 16 kHz / 25 fps
                if (currentClock < audioFrameClock) audioFrameClock = currentClock
                var newFrames = (currentClock - audioFrameClock).toInt()
                if (newFrames <= 0) {
                    delay(4)
                    continue
                }
                audioFrameClock = currentClock

                val capacity = when {
                    lastNeuralMs <= 45L -> 4
                    lastNeuralMs <= 85L -> 2
                    else -> 1
                }
                if (newFrames > capacity) {
                    skipped += (newFrames - capacity)
                    newFrames = capacity
                }

                try {
                    val activeEngine = engine ?: MuseTalkOrtEngine(app).also {
                        engine = it
                        _state.value = State.Loading("Iniciando lipsync con la voz…")
                    }

                    // Both the audio front-end and renderer are lazy. No large model is loaded
                    // merely because the 16/16 preparation has completed.
                    val prompts = activeEngine.audioPrompts16k(snapshot.audio16k, newFrames)
                    for (promptIndex in prompts.indices) {
                        if (!currentCoroutineContext().isActive) break
                        if (lastNeuralMs > 70 && promptIndex < prompts.lastIndex &&
                            MuseTalkAudioBus.revision.value != snapshot.revision
                        ) {
                            skipped++
                            continue
                        }

                        val sourceIndex = pingPongIndex(avatarFrameClock++, prepared.frames.size)
                        val meta = prepared.frames[sourceIndex]
                        val latent = latents[sourceIndex]
                        _state.value = State.Loading("Generando labios…")
                        val started = System.nanoTime()
                        val face = activeEngine.generateFace(latent, prompts[promptIndex])
                        val source = BitmapFactory.decodeFile(meta.framePath)
                            ?: error("No pude abrir frame MuseTalk ${meta.framePath}")
                        val output = blendNeuralFace(source, face, meta)
                        if (source !== output && !source.isRecycled) source.recycle()
                        lastNeuralMs = (System.nanoTime() - started) / 1_000_000L

                        _frame.value = RenderedFrame(prepared.profileId, output, System.nanoTime())
                        fpsFrames++
                        val now = System.nanoTime()
                        val elapsed = (now - fpsWindowStart) / 1_000_000_000.0
                        if (elapsed >= 1.0) {
                            measuredFps = (fpsFrames / elapsed).toFloat()
                            fpsFrames = 0
                            fpsWindowStart = now
                        }
                        _state.value = State.Speaking(lastNeuralMs, measuredFps, skipped)
                    }
                } catch (t: Throwable) {
                    _frame.value = null
                    engine?.close()
                    engine = null
                    audioFrameClock = currentClock
                    waitForFreshSpeechAfterError = true
                    _state.value = State.Error(
                        t.message ?: "No pude generar el lipsync. Voy a reintentar en la próxima respuesta."
                    )
                }
            }
        } finally {
            _frame.value = null
            engine?.close()
            _state.value = State.Idle
        }
    }

    private fun pingPongIndex(clock: Long, count: Int): Int {
        if (count <= 1) return 0
        val period = count * 2 - 2
        val p = (clock % period).toInt()
        return if (p < count) p else period - p
    }

    /** Converts MuseTalk VAE output [-1,1] CHW and blends the generated face into the full source frame. */
    private fun blendNeuralFace(
        source: Bitmap,
        neuralChw: FloatArray,
        meta: MuseTalkPreparedFrame,
    ): Bitmap {
        require(neuralChw.size >= 3 * 256 * 256) { "VAE devolvió ${neuralChw.size} valores" }
        val face256 = neuralBitmap(neuralChw)
        val left = (meta.faceLeft * source.width).toInt().coerceIn(0, source.width - 2)
        val top = (meta.faceTop * source.height).toInt().coerceIn(0, source.height - 2)
        val right = (meta.faceRight * source.width).toInt().coerceIn(left + 1, source.width)
        val bottom = (meta.faceBottom * source.height).toInt().coerceIn(top + 1, source.height)
        val w = right - left
        val h = bottom - top
        val generated = Bitmap.createScaledBitmap(face256, w, h, true)
        face256.recycle()

        val mutable = source.copy(Bitmap.Config.ARGB_8888, true)
        val srcPixels = IntArray(w * h)
        val genPixels = IntArray(w * h)
        mutable.getPixels(srcPixels, 0, w, left, top, w, h)
        generated.getPixels(genPixels, 0, w, 0, 0, w, h)

        for (y in 0 until h) {
            val ny = y.toFloat() / max(1, h - 1)
            val vertical = smoothStep(.36f, .60f, ny)
            for (x in 0 until w) {
                val nx = x.toFloat() / max(1, w - 1)
                val edge = min(smoothStep(0f, .075f, nx), smoothStep(0f, .075f, 1f - nx))
                val alpha = (vertical * edge).coerceIn(0f, 1f)
                if (alpha <= 0f) continue
                val i = y * w + x
                srcPixels[i] = mixArgb(srcPixels[i], genPixels[i], alpha)
            }
        }
        mutable.setPixels(srcPixels, 0, w, left, top, w, h)
        generated.recycle()
        return mutable
    }

    private fun neuralBitmap(chw: FloatArray): Bitmap {
        val plane = 256 * 256
        val pixels = IntArray(plane)
        for (i in 0 until plane) {
            val r = (((chw[i].coerceIn(-1f, 1f) + 1f) * .5f) * 255f).toInt().coerceIn(0, 255)
            val g = (((chw[plane + i].coerceIn(-1f, 1f) + 1f) * .5f) * 255f).toInt().coerceIn(0, 255)
            val b = (((chw[2 * plane + i].coerceIn(-1f, 1f) + 1f) * .5f) * 255f).toInt().coerceIn(0, 255)
            pixels[i] = (0xff shl 24) or (r shl 16) or (g shl 8) or b
        }
        return Bitmap.createBitmap(pixels, 256, 256, Bitmap.Config.ARGB_8888)
    }

    private fun smoothStep(edge0: Float, edge1: Float, x: Float): Float {
        if (edge0 == edge1) return if (x < edge0) 0f else 1f
        val t = ((x - edge0) / (edge1 - edge0)).coerceIn(0f, 1f)
        return t * t * (3f - 2f * t)
    }

    private fun mixArgb(a: Int, b: Int, t: Float): Int {
        val ar = (a shr 16) and 0xff; val ag = (a shr 8) and 0xff; val ab = a and 0xff
        val br = (b shr 16) and 0xff; val bg = (b shr 8) and 0xff; val bb = b and 0xff
        val r = (ar + (br - ar) * t).toInt().coerceIn(0, 255)
        val g = (ag + (bg - ag) * t).toInt().coerceIn(0, 255)
        val bl = (ab + (bb - ab) * t).toInt().coerceIn(0, 255)
        return (0xff shl 24) or (r shl 16) or (g shl 8) or bl
    }
}
