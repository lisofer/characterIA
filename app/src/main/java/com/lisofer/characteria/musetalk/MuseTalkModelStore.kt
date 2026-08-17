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
 * Pesos de MuseTalk descargables. El UNet usa un pack mixed-precision preparado
 * específicamente para Android: los kernels pesados permanecen FP16 y las ops que
 * pueden caer al CPU quedan FP32. Los VAE quedan FP32 por compatibilidad de fallback.
 */
object MuseTalkModelStore {
    // Mantener el mismo directorio permite reutilizar Whisper/PE de la build 239.
    private const val MODEL_REVISION = "dgdev91-main-2026-08-v2"
    private const val EXTRA_FREE_BYTES = 350_000_000L

    data class ModelFile(
        val fileName: String,
        val url: String,
        val expectedBytes: Long,
    )

    val files = listOf(
        ModelFile(
            "unet_android_mixed.onnx",
            "https://github.com/lisofer/characterIA/releases/download/musetalk-android-mixed-v1/unet_android_mixed.onnx",
            767_163L,
        ),
        ModelFile(
            "unet_android_mixed.onnx.data",
            "https://github.com/lisofer/characterIA/releases/download/musetalk-android-mixed-v1/unet_android_mixed.onnx.data",
            1_700_551_680L,
        ),
        ModelFile(
            "vae_encoder.onnx",
            "https://huggingface.co/DgDev91/MuseTalk-ONNX/resolve/main/vae_encoder.onnx?download=true",
            136_729_981L,
        ),
        ModelFile(
            "vae_decoder.onnx",
            "https://huggingface.co/DgDev91/MuseTalk-ONNX/resolve/main/vae_decoder.onnx?download=true",
            198_059_649L,
        ),
        ModelFile(
            "whisper_encoder.onnx",
            "https://huggingface.co/DgDev91/MuseTalk-ONNX/resolve/main/whisper_encoder.onnx?download=true",
            32_891_369L,
        ),
        ModelFile(
            "positional_encoding.onnx",
            "https://huggingface.co/DgDev91/MuseTalk-ONNX/resolve/main/positional_encoding.onnx?download=true",
            7_681_028L,
        ),
    )

    private val obsoleteFp16Files = listOf(
        "unet_fp16.onnx",
        "vae_encoder_fp16.onnx",
        "vae_decoder_fp16.onnx",
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
        file.isFile && file.length() >= (spec.expectedBytes * 0.98).toLong()
    }

    fun remove(context: Context) {
        runCatching { modelDir(context).deleteRecursively() }
        _state.value = State.Missing
    }

    suspend fun install(context: Context) = withContext(Dispatchers.IO) {
        val app = context.applicationContext
        try {
            // La build 239 dejó estos pesos incompatibles. Se eliminan antes de medir
            // espacio libre para que el usuario no necesite guardar ambos packs a la vez.
            obsoleteFp16Files.forEach { name -> runCatching { modelFile(app, name).delete() } }

            val missing = files.filterNot { spec ->
                val f = modelFile(app, spec.fileName)
                f.isFile && f.length() >= (spec.expectedBytes * 0.98).toLong()
            }
            val missingBytes = missing.sumOf { it.expectedBytes }
            val free = StatFs(app.filesDir.absolutePath).availableBytes
            val required = missingBytes + EXTRA_FREE_BYTES
            if (free < required) {
                val gb = required / 1_000_000_000.0
                error("La actualización compatible de MuseTalk necesita ~${"%.1f".format(gb)} GB libres para completar la descarga.")
            }

            val overallTotal = files.sumOf { it.expectedBytes }
            var completedBefore = 0L
            files.forEachIndexed { index, spec ->
                val destination = modelFile(app, spec.fileName)
                if (destination.isFile && destination.length() >= (spec.expectedBytes * .98).toLong()) {
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

        if (part.length() < spec.expectedBytes * .98) {
            error("${spec.fileName} quedó incompleto (${part.length() / 1_000_000} MB)")
        }
        destination.delete()
        if (!part.renameTo(destination)) {
            part.copyTo(destination, overwrite = true)
            part.delete()
        }
    }
}
