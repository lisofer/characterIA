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
import kotlin.math.roundToInt

/**
 * Runtime neural REAL de MuseTalk. No contiene lógica de visemas/sprites.
 * Los pesos UNet/VAE son FP16, pero el port ONNX mantiene I/O float32.
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

    @Synchronized
    fun load() {
        if (unet != null && decoder != null) return
        check(MuseTalkModelStore.isReady(context)) { "Primero descargá el motor MuseTalk." }
        try {
            unet = createSession(MuseTalkModelStore.modelFile(context, "unet_fp16.onnx").absolutePath)
            decoder = createSession(MuseTalkModelStore.modelFile(context, "vae_decoder_fp16.onnx").absolutePath)
        } catch (t: Throwable) {
            close()
            throw t
        }
    }

    /** Ejecuta los dos modelos que dominan el costo por frame: UNet + VAE decoder. */
    @Synchronized
    fun benchmark(iterations: Int = 3): BenchmarkResult {
        load()
        val u = requireNotNull(unet)
        val d = requireNotNull(decoder)

        val latent = floatTensor(longArrayOf(1, 8, 32, 32))
        val audio = floatTensor(longArrayOf(1, 50, 384))
        val decodedLatent = floatTensor(longArrayOf(1, 4, 32, 32))

        try {
            runUnet(u, latent, audio)
            runDecoder(d, decodedLatent)

            val n = iterations.coerceIn(1, 8)
            var unetNs = 0L
            var decoderNs = 0L
            repeat(n) {
                val u0 = System.nanoTime()
                runUnet(u, latent, audio)
                unetNs += System.nanoTime() - u0

                val d0 = System.nanoTime()
                runDecoder(d, decodedLatent)
                decoderNs += System.nanoTime() - d0
            }

            val unetMs = unetNs / 1_000_000.0 / n
            val decoderMs = decoderNs / 1_000_000.0 / n
            val total = unetMs + decoderMs
            return BenchmarkResult(
                backend = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) "NNAPI FP16 relaxation + ORT fallback" else "ORT CPU",
                unetMs = unetMs,
                decoderMs = decoderMs,
                neuralFrameMs = total,
                estimatedFps = if (total > 0.0) 1000.0 / total else 0.0,
                device = "${Build.MANUFACTURER} ${Build.MODEL}",
            )
        } finally {
            latent.close()
            audio.close()
            decodedLatent.close()
        }
    }

    private fun runUnet(session: OrtSession, latent: OnnxTensor, audio: OnnxTensor) {
        val names = session.inputNames
        val latentName = names.firstOrNull { it.contains("latent", true) } ?: names.elementAtOrNull(0)
        val audioName = names.firstOrNull {
            it.contains("encoder", true) || it.contains("hidden", true) || it.contains("audio", true)
        } ?: names.elementAtOrNull(1)
        check(latentName != null && audioName != null) { "Entradas UNet inesperadas: $names" }
        session.run(mapOf(latentName to latent, audioName to audio)).close()
    }

    private fun runDecoder(session: OrtSession, latent: OnnxTensor) {
        val name = session.inputNames.firstOrNull() ?: error("VAE decoder sin entrada")
        session.run(mapOf(name to latent)).close()
    }

    private fun createSession(path: String): OrtSession {
        val options = OrtSession.SessionOptions().apply {
            setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
            setInterOpNumThreads(1)
            setIntraOpNumThreads(Runtime.getRuntime().availableProcessors().coerceIn(2, 6))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                runCatching { addNnapi(EnumSet.of(NNAPIFlags.USE_FP16)) }
            }
        }
        return try {
            env.createSession(path, options)
        } finally {
            options.close()
        }
    }

    private fun floatTensor(shape: LongArray): OnnxTensor {
        val count = elementCount(shape)
        val bytes = ByteBuffer.allocateDirect(count * 4).order(ByteOrder.nativeOrder())
        val floats = bytes.asFloatBuffer()
        // Buffer directo en cero: suficiente para medir el grafo real sin asignaciones gigantes de Java.
        return OnnxTensor.createTensor(env, floats, shape)
    }

    private fun elementCount(shape: LongArray): Int {
        val total = shape.fold(1L) { acc, v -> acc * v.coerceAtLeast(1L) }
        check(total <= Int.MAX_VALUE) { "Tensor demasiado grande: ${shape.contentToString()}" }
        return total.toInt()
    }

    override fun close() {
        runCatching { unet?.close() }
        runCatching { decoder?.close() }
        unet = null
        decoder = null
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
