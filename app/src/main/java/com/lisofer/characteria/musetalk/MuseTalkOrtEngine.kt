package com.lisofer.characteria.musetalk

import android.content.Context
import android.os.Build
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import ai.onnxruntime.providers.NNAPIFlags
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.EnumSet
import kotlin.math.floor
import kotlin.math.roundToInt

/**
 * MuseTalk 1.5 ONNX runtime for Android.
 *
 * PCM 16k -> mel -> Whisper -> frame prompts 50x384 -> positional encoding
 * avatar latent 8x32x32 + prompt -> UNet -> 4x32x32 -> VAE -> RGB 256x256
 */
class MuseTalkOrtEngine(private val context: Context) : AutoCloseable {
    data class BenchmarkResult(
        val backend: String,
        val unetMs: Double,
        val decoderMs: Double,
        val neuralFrameMs: Double,
        val estimatedFps: Double,
        val device: String,
    )

    private data class WhisperOutput(
        val data: FloatArray,
        val shape: LongArray,
        val audioSamples: Int,
    )

    private val env = OrtEnvironment.getEnvironment("CharacterIA-MuseTalk")
    private var unet: OrtSession? = null
    private var decoder: OrtSession? = null
    private var encoder: OrtSession? = null
    private var whisper: OrtSession? = null
    private var positional: OrtSession? = null

    @Synchronized
    fun loadGenerator() {
        check(MuseTalkModelStore.isReady(context)) { "Primero descargá el motor MuseTalk." }
        if (unet == null) unet = createSession("unet_fp16.onnx", true)
        if (decoder == null) decoder = createSession("vae_decoder_fp16.onnx", true)
        if (whisper == null) whisper = createSession("whisper_encoder.onnx", true)
        if (positional == null) positional = createSession("positional_encoding.onnx", false)
    }

    @Synchronized
    fun loadEncoder() {
        check(MuseTalkModelStore.isReady(context)) { "Primero descargá el motor MuseTalk." }
        if (encoder == null) encoder = createSession("vae_encoder_fp16.onnx", true)
    }

    @Synchronized
    fun releaseEncoder() {
        runCatching { encoder?.close() }
        encoder = null
    }

    @Synchronized
    fun encodeFace(normalizedRgbChw: FloatArray): FloatArray {
        require(normalizedRgbChw.size == 3 * 256 * 256)
        loadEncoder()
        val session = requireNotNull(encoder)
        val input = tensor(normalizedRgbChw, longArrayOf(1, 3, 256, 256))
        try {
            val name = session.inputNames.firstOrNull() ?: error("VAE encoder sin entrada")
            session.run(mapOf(name to input)).use { return outputFloats(it, "latents") }
        } finally { input.close() }
    }

    fun combineLatents(masked: FloatArray, reference: FloatArray): FloatArray {
        require(masked.size == 4 * 32 * 32 && reference.size == masked.size)
        return FloatArray(masked.size + reference.size).also {
            masked.copyInto(it, 0)
            reference.copyInto(it, masked.size)
        }
    }

    /** Convenience for diagnostics/single-frame rendering. */
    @Synchronized
    fun audioPrompt16k(audio16k: FloatArray): FloatArray =
        audioPrompts16k(audio16k, 1).last()

    /**
     * One Whisper pass can feed several 25fps video frames. This is essential because
     * Fish commonly sends ~150ms chunks; mapping one chunk to one frame would cap us at ~7fps.
     */
    @Synchronized
    fun audioPrompts16k(audio16k: FloatArray, takeLastFrames: Int = 4): List<FloatArray> {
        require(audio16k.isNotEmpty()) { "Ventana de audio vacía" }
        loadGenerator()
        val raw = runWhisper(audio16k)
        val totalFrames = floor(audio16k.size / 16_000.0 * 25.0).toInt().coerceAtLeast(1)
        val count = takeLastFrames.coerceIn(1, totalFrames)
        val first = (totalFrames - count).coerceAtLeast(0)
        return buildList(count) {
            for (frame in first until totalFrames) {
                add(addPositionalEncoding(makeWhisperChunk(raw, frame)))
            }
        }
    }

    @Synchronized
    fun generateFace(latent8x32x32: FloatArray, encodedAudio50x384: FloatArray): FloatArray {
        require(latent8x32x32.size == 8 * 32 * 32) { "Avatar latent inválido" }
        require(encodedAudio50x384.size == 50 * 384) { "Audio MuseTalk inválido" }
        loadGenerator()

        val u = requireNotNull(unet)
        val latentTensor = tensor(latent8x32x32, longArrayOf(1, 8, 32, 32))
        val audioTensor = tensor(encodedAudio50x384, longArrayOf(1, 50, 384))
        val predicted = try {
            val names = u.inputNames.toList()
            check(names.size >= 2) { "UNet requiere 2 entradas, encontró $names" }
            u.run(mapOf(names[0] to latentTensor, names[1] to audioTensor)).use { outputFloats(it) }
        } finally {
            latentTensor.close(); audioTensor.close()
        }

        val d = requireNotNull(decoder)
        val predictedTensor = tensor(predicted, longArrayOf(1, 4, 32, 32))
        try {
            val name = d.inputNames.firstOrNull() ?: error("VAE decoder sin entrada")
            d.run(mapOf(name to predictedTensor)).use { return outputFloats(it) }
        } finally { predictedTensor.close() }
    }

    @Synchronized
    fun benchmark(iterations: Int = 3): BenchmarkResult {
        loadGenerator()
        val zeroLatent = FloatArray(8 * 32 * 32)
        val zeroAudio = FloatArray(50 * 384)
        val u = requireNotNull(unet)
        val d = requireNotNull(decoder)

        fun runUnetOnly(): FloatArray {
            val lt = tensor(zeroLatent, longArrayOf(1, 8, 32, 32))
            val at = tensor(zeroAudio, longArrayOf(1, 50, 384))
            try {
                val names = u.inputNames.toList()
                u.run(mapOf(names[0] to lt, names[1] to at)).use { return outputFloats(it) }
            } finally { lt.close(); at.close() }
        }
        fun runDecoderOnly(latent: FloatArray) {
            val dt = tensor(latent, longArrayOf(1, 4, 32, 32))
            try { d.run(mapOf(d.inputNames.first() to dt)).close() } finally { dt.close() }
        }

        val warm = runUnetOnly(); runDecoderOnly(warm)
        val n = iterations.coerceIn(1, 6)
        var unetNs = 0L; var decoderNs = 0L
        repeat(n) {
            val u0 = System.nanoTime(); val predicted = runUnetOnly(); unetNs += System.nanoTime() - u0
            val d0 = System.nanoTime(); runDecoderOnly(predicted); decoderNs += System.nanoTime() - d0
        }
        val unetMs = unetNs / 1_000_000.0 / n
        val decoderMs = decoderNs / 1_000_000.0 / n
        val total = unetMs + decoderMs
        return BenchmarkResult(
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) "NNAPI + ORT CPU fallback" else "ORT CPU",
            unetMs, decoderMs, total, if (total > 0) 1000.0 / total else 0.0,
            "${Build.MANUFACTURER} ${Build.MODEL}",
        )
    }

    private fun runWhisper(audio16k: FloatArray): WhisperOutput {
        val mel = MuseTalkMel.extract(audio16k)
        val session = requireNotNull(whisper)
        val input = tensor(mel, longArrayOf(1, 80, 3000))
        try {
            val name = session.inputNames.firstOrNull() ?: error("Whisper sin entrada")
            session.run(mapOf(name to input)).use { result ->
                val value = result.get("audio_features_all_layers").orElseGet { result.get(0) }
                val out = value as? OnnxTensor ?: error("Salida Whisper no es tensor")
                val buffer = out.floatBuffer ?: error("Whisper no devolvió float")
                return WhisperOutput(
                    FloatArray(buffer.remaining()).also { buffer.get(it) },
                    out.info.shape,
                    audio16k.size,
                )
            }
        } finally { input.close() }
    }

    private fun makeWhisperChunk(raw: WhisperOutput, frameIndex: Int): FloatArray {
        val shape = raw.shape
        check(shape.size == 4) { "Whisper shape inesperado: ${shape.contentToString()}" }
        val seqLen = shape[1].toInt()
        val layers = shape[2].toInt()
        val features = shape[3].toInt()
        check(seqLen > 0 && layers > 0 && features == 384)

        val actualLength = minOf(floor(raw.audioSamples / 16_000.0 * 50.0).toInt().coerceAtLeast(1), seqLen)
        val audioIndex = floor(frameIndex.coerceAtLeast(0) * 2.0).toInt()
        val result = FloatArray(50 * 384)
        val usedLayers = minOf(layers, 5)
        for (t in 0 until 10) {
            val sourceSeq = audioIndex + t - 4 // left padding = ceil(50/25)*2
            if (sourceSeq !in 0 until actualLength) continue
            for (layer in 0 until usedLayers) {
                val dstBase = (t * 5 + layer) * 384
                val srcBase = (sourceSeq * layers + layer) * 384
                if (srcBase + 384 <= raw.data.size) raw.data.copyInto(result, dstBase, srcBase, srcBase + 384)
            }
        }
        return result
    }

    private fun addPositionalEncoding(rawPrompt: FloatArray): FloatArray {
        val session = requireNotNull(positional)
        val input = tensor(rawPrompt, longArrayOf(1, 50, 384))
        try {
            val name = session.inputNames.firstOrNull() ?: error("Positional encoding sin entrada")
            session.run(mapOf(name to input)).use { return outputFloats(it) }
        } finally { input.close() }
    }

    private fun createSession(fileName: String, preferNnapi: Boolean): OrtSession {
        val path = MuseTalkModelStore.modelFile(context, fileName).absolutePath
        val options = OrtSession.SessionOptions().apply {
            setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
            setInterOpNumThreads(1)
            setIntraOpNumThreads(Runtime.getRuntime().availableProcessors().coerceIn(2, 6))
            if (preferNnapi && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                runCatching { addNnapi(EnumSet.of(NNAPIFlags.USE_FP16)) }
            }
        }
        return try { env.createSession(path, options) } finally { options.close() }
    }

    private fun tensor(data: FloatArray, shape: LongArray): OnnxTensor {
        val expected = shape.fold(1L) { a, b -> a * b }.toInt()
        require(data.size == expected) { "Tensor ${shape.contentToString()} esperaba $expected, recibió ${data.size}" }
        val buffer = ByteBuffer.allocateDirect(data.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()
        buffer.put(data); buffer.rewind()
        return OnnxTensor.createTensor(env, buffer, shape)
    }

    private fun outputFloats(result: OrtSession.Result, preferredName: String? = null): FloatArray {
        val value = preferredName?.let { result.get(it).orElse(null) } ?: result.get(0)
        val tensor = value as? OnnxTensor ?: error("Salida ONNX no es tensor")
        val buffer = tensor.floatBuffer ?: error("Salida ONNX no es Float/FP16 convertible")
        return FloatArray(buffer.remaining()).also { buffer.get(it) }
    }

    override fun close() {
        runCatching { encoder?.close() }; encoder = null
        runCatching { positional?.close() }; positional = null
        runCatching { whisper?.close() }; whisper = null
        runCatching { decoder?.close() }; decoder = null
        runCatching { unet?.close() }; unet = null
    }
}

fun MuseTalkOrtEngine.BenchmarkResult.pretty(): String {
    val fps = (estimatedFps * 10.0).roundToInt() / 10.0
    return "$device · $backend\nUNet: ${unetMs.roundToInt()} ms · VAE: ${decoderMs.roundToInt()} ms\nFrame neural: ${neuralFrameMs.roundToInt()} ms · ~$fps FPS"
}
