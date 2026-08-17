package com.lisofer.characteria.musetalk

import android.content.Context
import android.os.Build
import ai.onnxruntime.OnnxJavaType
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
 *
 * Primer objetivo: cargar exactamente el UNet y VAE de MuseTalk en el teléfono y
 * medir su velocidad. El pipeline de streaming usa estas mismas sesiones.
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

    /**
     * Ejecuta UNet + VAE decoder con las dimensiones reales de MuseTalk 1.5.
     * No es un benchmark sintético de CPU: son los dos modelos neuronales reales.
     */
    @Synchronized
    fun benchmark(iterations: Int = 3): BenchmarkResult {
        load()
        val u = requireNotNull(unet)
        val d = requireNotNull(decoder)

        // MuseTalk V1.5: concatenación masked+reference latents => 8x32x32.
        val latent = fp16Tensor(longArrayOf(1, 8, 32, 32))
        val timestep = int64Tensor(longArrayOf(1), 0L)
        // 10 posiciones temporales x 5 capas Whisper = 50 tokens, dimensión 384.
        val audio = fp16Tensor(longArrayOf(1, 50, 384))
        val decodedLatent = fp16Tensor(longArrayOf(1, 4, 32, 32))

        try {
            // Warmup: también obliga a NNAPI a terminar compilación/particionado.
            runUnet(u, latent, timestep, audio)
            runDecoder(d, decodedLatent)

            val n = iterations.coerceIn(1, 8)
            var unetNs = 0L
            var decoderNs = 0L
            repeat(n) {
                val u0 = System.nanoTime()
                runUnet(u, latent, timestep, audio)
                unetNs += System.nanoTime() - u0

                val d0 = System.nanoTime()
                runDecoder(d, decodedLatent)
                decoderNs += System.nanoTime() - d0
            }

            val unetMs = unetNs / 1_000_000.0 / n
            val decoderMs = decoderNs / 1_000_000.0 / n
            val total = unetMs + decoderMs
            return BenchmarkResult(
                backend = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) "NNAPI FP16 + ORT fallback" else "ORT CPU",
                unetMs = unetMs,
                decoderMs = decoderMs,
                neuralFrameMs = total,
                estimatedFps = if (total > 0.0) 1000.0 / total else 0.0,
                device = "${Build.MANUFACTURER} ${Build.MODEL}",
            )
        } finally {
            latent.close()
            timestep.close()
            audio.close()
            decodedLatent.close()
        }
    }

    private fun runUnet(
        session: OrtSession,
        latent: OnnxTensor,
        timestep: OnnxTensor,
        audio: OnnxTensor,
    ) {
        val names = session.inputNames
        val latentName = names.firstOrNull { it.contains("latent", true) } ?: names.elementAtOrNull(0)
        val timestepName = names.firstOrNull { it.contains("time", true) } ?: names.elementAtOrNull(1)
        val audioName = names.firstOrNull {
            it.contains("encoder", true) || it.contains("hidden", true) || it.contains("audio", true)
        } ?: names.elementAtOrNull(2)
        check(latentName != null && timestepName != null && audioName != null) {
            "Entradas UNet inesperadas: $names"
        }
        session.run(mapOf(latentName to latent, timestepName to timestep, audioName to audio)).close()
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
            // NNAPI existe desde API 27, pero en Android 9+ suele tener drivers útiles.
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

    private fun fp16Tensor(shape: LongArray): OnnxTensor {
        val count = elementCount(shape)
        val bytes = ByteBuffer.allocateDirect(count * 2).order(ByteOrder.nativeOrder())
        val shorts = bytes.asShortBuffer()
        // 0.0 en IEEE FP16 = 0x0000. El direct buffer nuevo ya viene en cero.
        return OnnxTensor.createTensor(env, shorts, shape, OnnxJavaType.FLOAT16)
    }

    private fun int64Tensor(shape: LongArray, value: Long): OnnxTensor {
        val count = elementCount(shape)
        val bytes = ByteBuffer.allocateDirect(count * 8).order(ByteOrder.nativeOrder())
        val longs = bytes.asLongBuffer()
        repeat(count) { longs.put(value) }
        longs.rewind()
        return OnnxTensor.createTensor(env, longs, shape)
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
