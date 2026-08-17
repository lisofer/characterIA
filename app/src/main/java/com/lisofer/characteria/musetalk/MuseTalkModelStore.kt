package com.lisofer.characteria.musetalk

import android.content.Context
import android.os.StatFs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.TimeUnit

/**
 * Los pesos NO se incluyen en el APK. Se descargan una sola vez al almacenamiento
 * privado de la app. La descarga es reanudable porque el UNet FP16 ronda 1.64 GB.
 */
object MuseTalkModelStore {
    private const val MODEL_REVISION = "dgdev91-main-2026-08-v2"
    private const val MIN_FREE_BYTES = 2_500_000_000L

    data class ModelFile(
        val fileName: String,
        val url: String,
        val expectedBytes: Long,
    )

    // Pesos ONNX usados por el port on-device de MuseTalk. UNet/VAE tienen pesos FP16
    // pero I/O float32; Whisper y PE quedan FP32 para compatibilidad y fidelidad.
    val files = listOf(
        ModelFile(
            "unet_fp16.onnx",
            "https://huggingface.co/DgDev91/MuseTalk-ONNX/resolve/main/unet_fp16.onnx?download=true",
            1_640_000_000L,
        ),
        ModelFile(
            "vae_encoder_fp16.onnx",
            "https://huggingface.co/DgDev91/MuseTalk-ONNX/resolve/main/vae_encoder_fp16.onnx?download=true",
            68_404_864L,
        ),
        ModelFile(
            "vae_decoder_fp16.onnx",
            "https://huggingface.co/DgDev91/MuseTalk-ONNX/resolve/main/vae_decoder_fp16.onnx?download=true",
            99_082_054L,
        ),
        ModelFile(
            "whisper_encoder.onnx",
            "https://huggingface.co/DgDev91/MuseTalk-ONNX/resolve/main/whisper_encoder.onnx?download=true",
            32_891_369L,
        ),
        ModelFile(
            "positional_encoding.onnx",
            "https://huggingface.co/DgDev91/MuseTalk-ONNX/resolve/main/positional_encoding.onnx?download=true",
            7_680_000L,
        ),
    )

    sealed interface State {
        data object Missing : State
        data class Downloading(
            val fileName: String,
            val fileIndex: Int,
            val fileCount: Int,
            val downloadedBytes: Long,
            val totalBytes: Long,
            val fraction: Float,
        ) : State
        data object Ready : State
        data class Error(val message: String) : State
    }

    private val _state = MutableStateFlow<State>(State.Missing)
    val state: StateFlow<State> = _state.asStateFlow()

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(0, TimeUnit.MILLISECONDS)
        .followRedirects(true)
        .followSslRedirects(true)
        .build()

    fun modelDir(context: Context): File =
        File(context.filesDir, "musetalk/$MODEL_REVISION").apply { mkdirs() }

    fun modelFile(context: Context, fileName: String): File = File(modelDir(context), fileName)

    fun refresh(context: Context) {
        _state.value = if (isReady(context)) State.Ready else State.Missing
    }

    fun isReady(context: Context): Boolean = files.all { spec ->
        val file = modelFile(context, spec.fileName)
        file.isFile && file.length() >= (spec.expectedBytes * 0.94).toLong()
    }

    fun remove(context: Context) {
        runCatching { modelDir(context).deleteRecursively() }
        _state.value = State.Missing
    }

    suspend fun install(context: Context) = withContext(Dispatchers.IO) {
        val app = context.applicationContext
        try {
            val free = StatFs(app.filesDir.absolutePath).availableBytes
            if (free < MIN_FREE_BYTES && !isReady(app)) {
                error("MuseTalk necesita unos 2,5 GB libres para descargar y preparar el motor.")
            }

            val overallTotal = files.sumOf { it.expectedBytes }
            var completedBefore = 0L
            files.forEachIndexed { index, spec ->
                val destination = modelFile(app, spec.fileName)
                if (destination.isFile && destination.length() >= (spec.expectedBytes * .94).toLong()) {
                    completedBefore += spec.expectedBytes
                    return@forEachIndexed
                }
                downloadResumable(spec, destination, index, completedBefore, overallTotal)
                completedBefore += spec.expectedBytes
            }

            check(isReady(app)) { "La descarga terminó, pero faltan archivos del motor MuseTalk." }
            _state.value = State.Ready
        } catch (t: Throwable) {
            _state.value = State.Error(t.message ?: "No se pudo instalar MuseTalk")
            throw t
        }
    }

    private fun downloadResumable(
        spec: ModelFile,
        destination: File,
        fileIndex: Int,
        overallCompletedBefore: Long,
        overallTotal: Long,
    ) {
        destination.parentFile?.mkdirs()
        val part = File(destination.parentFile, destination.name + ".part")
        var existing = part.takeIf { it.exists() }?.length() ?: 0L

        fun newRequest(offset: Long): Request = Request.Builder()
            .url(spec.url)
            .apply { if (offset > 0L) header("Range", "bytes=$offset-") }
            .header("User-Agent", "CharacterIA-MuseTalk-Android")
            .build()

        var response = client.newCall(newRequest(existing)).execute()
        if (existing > 0L && response.code != 206) {
            response.close()
            part.delete()
            existing = 0L
            response = client.newCall(newRequest(0L)).execute()
        }

        response.use { r ->
            if (!r.isSuccessful) error("Descarga ${spec.fileName}: HTTP ${r.code}")
            val body = r.body ?: error("Descarga vacía: ${spec.fileName}")
            RandomAccessFile(part, "rw").use { raf ->
                raf.seek(existing)
                body.byteStream().use { input ->
                    val buffer = ByteArray(256 * 1024)
                    var current = existing
                    var lastEmit = existing
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        raf.write(buffer, 0, n)
                        current += n
                        if (current - lastEmit >= 2L * 1024L * 1024L) {
                            lastEmit = current
                            val overall = (overallCompletedBefore + current).coerceAtMost(overallTotal)
                            _state.value = State.Downloading(
                                fileName = spec.fileName,
                                fileIndex = fileIndex + 1,
                                fileCount = files.size,
                                downloadedBytes = overall,
                                totalBytes = overallTotal,
                                fraction = (overall.toDouble() / overallTotal.toDouble()).toFloat().coerceIn(0f, 1f),
                            )
                        }
                    }
                }
            }
        }

        if (part.length() < spec.expectedBytes * .90) {
            error("${spec.fileName} quedó incompleto (${part.length() / 1_000_000} MB)")
        }
        destination.delete()
        if (!part.renameTo(destination)) {
            part.copyTo(destination, overwrite = true)
            part.delete()
        }
    }
}
