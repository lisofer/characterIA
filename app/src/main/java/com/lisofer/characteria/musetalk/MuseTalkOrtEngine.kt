package com.lisofer.characteria.musetalk

import android.content.Context
import android.os.Build
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import ai.onnxruntime.providers.NNAPIFlags
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.EnumSet
import kotlin.math.floor
import kotlin.math.roundToInt

/**
 * MuseTalk 1.5 ONNX runtime for Android.
 *
 * Runtime graph:
 *  PCM16 16k -> mel -> Whisper -> 50x384 -> positional encoding
 *                                  +
 * avatar latent 8x32x32 ----------> UNet -> 4x32x32 -> VAE -> RGB 256x256
 *
 * It contains no sprite/viseme fallback. If neural inference cannot run, it fails
 * explicitly and the source avatar remains visible.
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

    private val env = OrtEnvironment.getEnvironment("CharacterIA-MuseTalk")
    private var unet: OrtSession? = null
    private var decoder: OrtSession? = null
    private var encoder: OrtSession? = null
    private var whisper: OrtSession? = null
    private var positional: OrtSession? = null

    @Synchronized
    fun loadGenerator() {
        check(MuseTalkModelStore.isReady(context)) { "Primero descargá el motor MuseTalk." }
        if (unet == null) unet = createSession("unet_fp16.onnx", preferNnapi = true)
        if (decoder == null) decoder = createSession("vae_decoder_fp16.onnx", preferNnapi = true)
        if (whisper == null) whisper = createSession("whisper_encoder.onnx", preferNnapi = true)
        if (positional == null) positional = createSession("positional_encoding.onnx", preferNnapi = false)
    }

    /** VAE encoder is needed only while preparing an avatar. */
    @Synchronized
    fun loadEncoder() {
        check(MuseTalkModelStore.isReady(context)) { "Primero descargá el motor MuseTalk." }
        if (encoder == null) encoder = createSession("vae_encoder_fp16.onnx", preferNnapi = true)
    }

    @Synchronized
    fun releaseEncoder() {
        runCatching { encoder?.close() }
        encoder = null
    }

    /**
     * RGB CHW [1,3,256,256], already normalized to [-1,1] exactly like MuseTalk.
     */
    @Synchronized
    fun encodeFace(normalizedRgbChw: FloatArray): FloatArray {
        require(normalizedRgbChw.size == 3 * 256 * 256) { "Face tensor debe ser 3x256x256" }
        loadEncoder()
        val session = requireNotNull(encoder)
        val input = tensor(normalizedRgbChw, longArrayOf(1, 3, 256, 256))
        try {
            val inputName = session.inputNames.firstOrNull() ?: error("VAE encoder sin entrada")
            session.run(mapOf(inputName to input)).use { result ->
                return outputFloats(result, preferredName = "latents")
            }
        } finally {
            input.close()
        }
    }

    /** Concatenates masked + reference VAE latents into MuseTalk's [1,8,32,32]. */
    fun combineLatents(masked: FloatArray, reference: FloatArray): FloatArray {
        require(masked.size == 4 * 32 * 32 && reference.size == masked.size) {
            "Latents VAE inesperados: ${masked.size}/${reference.size}"
        }
        return FloatArray(masked.size + reference.size).also {
            masked.copyInto(it, 0)
            reference.copyInto(it, masked.size)
        }
    }

    /**
     * Extracts the latest MuseTalk 50x384 prompt from a rolling 16 kHz audio window.
     * The original pipeline is 25 FPS video / 50 FPS Whisper features with L/R padding=2.
     */
    @Synchronized
    fun audioPrompt16k(audio16k: FloatArray): FloatArray {
        require(audio16k.isNotEmpty()) { "Ventana de audio vacía" }
        loadGenerator()
        val mel = MuseTalkMel.extract(audio16k)
        val w = requireNotNull(whisper)
        val melTensor = tensor(mel, longArrayOf(1, MuseTalkMel.N_MELS.toLong(), MuseTalkMel.TARGET_FRAMES.toLong()))
        val rawPrompt = try {
            val inputName = w.inputNames.firstOrNull() ?: error("Whisper sin entrada")
            w.run(mapOf(inputName to melTensor)).use { result ->
                val value = result.get("audio_features_all_layers").orElseGet { result.get(0) }
                val tensor = value as? OnnxTensor ?: error("Salida Whisper no es tensor")
                val shape = tensor.info.shape
                val data = tensor.floatBuffer?.let { buffer ->
                    FloatArray(buffer.remaining()).also { buffer.get(it) }
                } ?: error("Whisper no devolvió FloatBuffer")
                makeLatestWhisperChunk(data, shape, audio16k.size)
            }
        } finally {
            melTensor.close()
        }

        val pe = requireNotNull(positional)
        val promptTensor = tensor(rawPrompt, longArrayOf(1, 50, 384))
        try {
            val inputName = pe.inputNames.firstOrNull() ?: error("Positional encoding sin entrada")
            pe.run(mapOf(inputName to promptTensor)).use { result ->
                return outputFloats(result)
            }
        } finally {
            promptTensor.close()
        }
    }

    /** Runs one actual MuseTalk neural face frame. Returns CHW RGB, usually 3x256x256. */
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
            // The converted graph keeps the same ordered inputs as the on-device reference.
            u.run(mapOf(names[0] to latentTensor, names[1] to audioTensor)).use { result ->
                outputFloats(result)
            }
        } finally {
            latentTensor.close()
            audioTensor.close()
        }

        val d = requireNotNull(decoder)
        val predictedTensor = tensor(predicted, longArrayOf(1, 4, 32, 32))
        try {
            val inputName = d.inputNames.firstOrNull() ?: error("VAE decoder sin entrada")
            d.run(mapOf(inputName to predictedTensor)).use { result ->
                return outputFloats(result)
            }
        } finally {
            predictedTensor.close()
        }
    }

    /** Executes the actual UNet+decoder models to measure this phone before enabling live rendering. */
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
            } finally {
                lt.close(); at.close()
            }
        }

        fun runDecoderOnly(latent: FloatArray) {
            val dt = tensor(latent, longArrayOf(1, 4, 32, 32))
            try {
                val name = d.inputNames.first()
                d.run(mapOf(name to dt)).close()
            } finally { dt.close() }
        }

        val warm = runUnetOnly()
        runDecoderOnly(warm)
        val n = iterations.coerceIn(1, 6)
        var unetNs = 0L
        var decoderNs = 0L
        repeat(n) {
            val u0 = System.nanoTime()
            val predicted = runUnetOnly()
            unetNs += System.nanoTime() - u0
            val d0 = System.nanoTime()
            runDecoderOnly(predicted)
            decoderNs += System.nanoTime() - d0
        }
        val unetMs = unetNs / 1_000_000.0 / n
        val decoderMs = decoderNs / 1_000_000.0 / n
        val total = unetMs + decoderMs
        return BenchmarkResult(
            backend = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) "NNAPI + ORT CPU fallback" else "ORT CPU",
            unetMs = unetMs,
            decoderMs = decoderMs,
            neuralFrameMs = total,
            estimatedFps = if (total > 0.0) 1000.0 / total else 0.0,
            device = "${Build.MANUFACTURER} ${Build.MODEL}",
        )
    }

    private fun makeLatestWhisperChunk(data: FloatArray, shape: LongArray, audioSamples: Int): FloatArray {
        check(shape.size == 4) { "Whisper shape inesperado: ${shape.contentToString()}" }
        val batch = shape[0].toInt()
        val seqLen = shape[1].toInt()
        val layers = shape[2].toInt()
        val features = shape[3].toInt()
        check(batch >= 1 && seqLen > 0 && layers > 0 && features == 384) {
            "Whisper shape incompatible: ${shape.contentToString()}"
        }

        val actualLength = minOf(floor(audioSamples / 16_000.0 * 50.0).toInt().coerceAtLeast(1), seqLen)
        val numVideoFrames = floor(audioSamples / 16_000.0 * 25.0).toInt().coerceAtLeast(1)
        val frameIndex = (numVideoFrames - 1).coerceAtLeast(0)
        val audioIndex = floor(frameIndex * 2.0).toInt()
        val leftPadding = 4 // ceil(50/25) * audioPaddingLeft(2)
        val rowsPerPrompt = 50
        val timeSteps = 10
        val result = FloatArray(rowsPerPrompt * 384)

        // Official shape uses 5 hidden-state layers: 10 time positions × 5 = 50 rows.
        val usedLayers = minOf(layers, 5)
        for (t in 0 until timeSteps) {
            val sourceSeq = audioIndex + t - leftPadding
            if (sourceSeq !in 0 until actualLength) continue
            for (layer in 0 until usedLayers) {
                val dstRow = t * 5 + layer
                val srcBase = ((sourceSeq * layers + layer) * features)
                val dstBase = dstRow * 384
                if (srcBase + 384 <= data.size) {
                    data.copyInto(result, destinationOffset = dstBase, startIndex = srcBase, endIndex = srcBase + 384)
                }
            }
        }
        return result
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
        val bytes = ByteBuffer.allocateDirect(data.size * 4).order(ByteOrder.nativeOrder())
        val floats = bytes.asFloatBuffer()
        floats.put(data)
        floats.rewind()
        return OnnxTensor.createTensor(env, floats, shape)
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
    return buildString {
        append("$device · $backend\n")
        append("UNet: ${unetMs.roundToInt()} ms · VAE: ${decoderMs.roundToInt()} ms\n")
        append("Frame neural: ${neuralFrameMs.roundToInt()} ms · ~${fps} FPS")
    }
}
