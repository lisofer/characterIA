package com.lisofer.characteria.vision

import android.content.Context
import android.graphics.Bitmap
import android.graphics.PointF
import android.graphics.RectF
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.Face
import com.google.mlkit.vision.face.FaceContour
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetector
import com.google.mlkit.vision.face.FaceDetectorOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * CharacterIA Visión v0.3.
 * En vez de "abrir" una foto de la boca, guarda varias bocas reales del propio video.
 */
data class VisionAvatar(
    val profileId: String,
    val displayName: String,
    val videoPath: String,
    val restPath: String,
    val closedPath: String,
    val widePath: String,
    val openPath: String,
    val roundPath: String,
    val sourceWidth: Int,
    val sourceHeight: Int,
    val patchX: Float,
    val patchY: Float,
    val patchWidth: Float,
    val patchHeight: Float,
    val quality: Float,
    val analyzedFrames: Int,
)

private data class MouthObservation(
    val timeMs: Long,
    val centerX: Float,
    val centerY: Float,
    val patchWidth: Float,
    val patchHeight: Float,
    val openRatio: Float,
    val widthRatio: Float,
)

object VisionAvatarStore {
    private const val SCHEMA_VERSION = 3
    private const val MAX_VIDEO_BYTES = 150L * 1024L * 1024L
    private const val METADATA_NAME = "vision.json"
    private const val VIDEO_NAME = "avatar.mp4"
    private const val REST_NAME = "mouth_rest.png"
    private const val CLOSED_NAME = "mouth_closed.png"
    private const val WIDE_NAME = "mouth_wide.png"
    private const val OPEN_NAME = "mouth_open.png"
    private const val ROUND_NAME = "mouth_round.png"

    private val _updates = MutableStateFlow(0L)
    val updates: StateFlow<Long> = _updates.asStateFlow()

    private fun profileDir(context: Context, profileId: String): File =
        File(File(context.filesDir, "character_profiles"), profileId).apply { mkdirs() }

    private fun visionDir(context: Context, profileId: String): File =
        File(profileDir(context, profileId), "vision")

    fun load(context: Context, profileId: String): VisionAvatar? = runCatching {
        if (profileId.isBlank()) return null
        val dir = visionDir(context, profileId)
        val metadata = File(dir, METADATA_NAME)
        if (!metadata.exists()) return null
        val json = JSONObject(metadata.readText())
        if (json.optInt("schemaVersion", 0) < SCHEMA_VERSION) return null

        val video = File(dir, VIDEO_NAME)
        val rest = File(dir, REST_NAME)
        val closed = File(dir, CLOSED_NAME)
        val wide = File(dir, WIDE_NAME)
        val open = File(dir, OPEN_NAME)
        val round = File(dir, ROUND_NAME)
        if (listOf(video, rest, closed, wide, open, round).any { !it.exists() }) return null

        VisionAvatar(
            profileId = profileId,
            displayName = json.optString("displayName", "avatar.mp4"),
            videoPath = video.absolutePath,
            restPath = rest.absolutePath,
            closedPath = closed.absolutePath,
            widePath = wide.absolutePath,
            openPath = open.absolutePath,
            roundPath = round.absolutePath,
            sourceWidth = json.getInt("sourceWidth"),
            sourceHeight = json.getInt("sourceHeight"),
            patchX = json.getDouble("patchX").toFloat(),
            patchY = json.getDouble("patchY").toFloat(),
            patchWidth = json.getDouble("patchWidth").toFloat(),
            patchHeight = json.getDouble("patchHeight").toFloat(),
            quality = json.optDouble("quality", 0.5).toFloat(),
            analyzedFrames = json.optInt("analyzedFrames", 0),
        )
    }.getOrNull()

    fun remove(context: Context, profileId: String) {
        if (profileId.isBlank()) return
        runCatching { visionDir(context, profileId).deleteRecursively() }
        bump()
    }

    /**
     * El trabajo pesado ocurre sólo al importar el video. Se muestrean fotogramas,
     * se detectan labios reales y se guardan cinco texturas con borde feathered.
     * Durante una conversación no se ejecuta ML Kit.
     */
    suspend fun importVideo(context: Context, profileId: String, uri: Uri): VisionAvatar {
        require(profileId.isNotBlank()) { "Primero elegí un perfil" }
        val appContext = context.applicationContext
        val root = profileDir(appContext, profileId)
        val incoming = File(root, "vision_incoming")
        incoming.deleteRecursively()
        incoming.mkdirs()
        val incomingVideo = File(incoming, VIDEO_NAME)
        val displayName = queryDisplayName(appContext, uri)

        try {
            withContext(Dispatchers.IO) {
                appContext.contentResolver.openInputStream(uri)?.use { input ->
                    incomingVideo.outputStream().buffered().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        var total = 0L
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            total += read
                            require(total <= MAX_VIDEO_BYTES) { "El video supera 150 MB" }
                            output.write(buffer, 0, read)
                        }
                    }
                } ?: error("No se pudo leer el video")
                require(incomingVideo.length() > 0L) { "El archivo de video está vacío" }
            }

            val analysis = analyzeAndBuildTextures(incomingVideo, incoming)
            val json = JSONObject()
                .put("schemaVersion", SCHEMA_VERSION)
                .put("displayName", displayName)
                .put("sourceWidth", analysis.sourceWidth)
                .put("sourceHeight", analysis.sourceHeight)
                .put("patchX", analysis.patchX.toDouble())
                .put("patchY", analysis.patchY.toDouble())
                .put("patchWidth", analysis.patchWidth.toDouble())
                .put("patchHeight", analysis.patchHeight.toDouble())
                .put("quality", analysis.quality.toDouble())
                .put("analyzedFrames", analysis.analyzedFrames)
                .put("updatedAt", System.currentTimeMillis())
            withContext(Dispatchers.IO) {
                File(incoming, METADATA_NAME).writeText(json.toString())
                val finalDir = visionDir(appContext, profileId)
                finalDir.deleteRecursively()
                if (!incoming.renameTo(finalDir)) {
                    incoming.copyRecursively(finalDir, overwrite = true)
                    incoming.deleteRecursively()
                }
            }
            bump()
            return load(appContext, profileId) ?: error("No se pudo abrir el avatar preparado")
        } catch (error: Throwable) {
            incoming.deleteRecursively()
            throw error
        }
    }

    private data class AnalysisResult(
        val sourceWidth: Int,
        val sourceHeight: Int,
        val patchX: Float,
        val patchY: Float,
        val patchWidth: Float,
        val patchHeight: Float,
        val quality: Float,
        val analyzedFrames: Int,
    )

    private suspend fun analyzeAndBuildTextures(video: File, outDir: File): AnalysisResult {
        val retriever = MediaMetadataRetriever()
        val detector = FaceDetection.getClient(
            FaceDetectorOptions.Builder()
                .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_ACCURATE)
                .setContourMode(FaceDetectorOptions.CONTOUR_MODE_ALL)
                .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_ALL)
                .setMinFaceSize(0.14f)
                .build()
        )
        try {
            retriever.setDataSource(video.absolutePath)
            val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                ?.toLongOrNull()?.coerceAtLeast(1L) ?: 1L
            val rawWidth = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
                ?.toIntOrNull()?.coerceAtLeast(1) ?: 720
            val rawHeight = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
                ?.toIntOrNull()?.coerceAtLeast(1) ?: 1280

            val scale = (960f / max(rawWidth, rawHeight).toFloat()).coerceAtMost(1f)
            val targetWidth = (rawWidth * scale).toInt().coerceAtLeast(160)
            val targetHeight = (rawHeight * scale).toInt().coerceAtLeast(160)

            val sampleCount = when {
                durationMs < 4_000L -> 20
                durationMs < 12_000L -> 34
                else -> 42
            }
            val observations = ArrayList<MouthObservation>(sampleCount)

            repeat(sampleCount) { index ->
                val fraction = if (sampleCount == 1) 0.0 else index.toDouble() / (sampleCount - 1).toDouble()
                val timeMs = (durationMs * fraction).toLong().coerceIn(0L, max(0L, durationMs - 1L))
                val frame = withContext(Dispatchers.IO) {
                    extractFrame(retriever, timeMs, targetWidth, targetHeight)
                } ?: return@repeat
                try {
                    val face = detectLargestFace(detector, frame) ?: return@repeat
                    analyzeMouth(face, timeMs)?.let(observations::add)
                } finally {
                    frame.recycle()
                }
            }

            require(observations.size >= 6) {
                "No pude seguir bien el rostro. Usá un video frontal, nítido y con buena luz."
            }

            val closed = observations.minByOrNull { it.openRatio }!!
            val open = observations.maxByOrNull { it.openRatio }!!

            val openMin = observations.minOf { it.openRatio }
            val openMax = observations.maxOf { it.openRatio }
            val widthMin = observations.minOf { it.widthRatio }
            val widthMax = observations.maxOf { it.widthRatio }
            val openRange = (openMax - openMin).coerceAtLeast(0.0001f)
            val widthRange = (widthMax - widthMin).coerceAtLeast(0.0001f)

            fun openN(o: MouthObservation) = ((o.openRatio - openMin) / openRange).coerceIn(0f, 1f)
            fun widthN(o: MouthObservation) = ((o.widthRatio - widthMin) / widthRange).coerceIn(0f, 1f)

            val wide = observations.maxByOrNull { widthN(it) * .72f + openN(it) * .28f } ?: open
            val round = observations.maxByOrNull { openN(it) * .72f + (1f - widthN(it)) * .28f } ?: open
            val rest = closed

            val anchorW = median(observations.map { it.patchWidth }).coerceAtLeast(24f)
            val anchorH = median(observations.map { it.patchHeight }).coerceAtLeast(16f)
            val anchorLeft = (rest.centerX - anchorW / 2f).coerceIn(0f, targetWidth - 2f)
            val anchorTop = (rest.centerY - anchorH / 2f).coerceIn(0f, targetHeight - 2f)
            val safeAnchorW = min(anchorW, targetWidth - anchorLeft).coerceAtLeast(2f)
            val safeAnchorH = min(anchorH, targetHeight - anchorTop).coerceAtLeast(2f)

            saveTexture(retriever, rest, targetWidth, targetHeight, anchorW, anchorH, File(outDir, REST_NAME))
            saveTexture(retriever, closed, targetWidth, targetHeight, anchorW, anchorH, File(outDir, CLOSED_NAME))
            saveTexture(retriever, wide, targetWidth, targetHeight, anchorW, anchorH, File(outDir, WIDE_NAME))
            saveTexture(retriever, open, targetWidth, targetHeight, anchorW, anchorH, File(outDir, OPEN_NAME))
            saveTexture(retriever, round, targetWidth, targetHeight, anchorW, anchorH, File(outDir, ROUND_NAME))

            val motionQuality = ((openMax - openMin) / .085f).coerceIn(0f, 1f)
            val shapeQuality = ((widthMax - widthMin) / .055f).coerceIn(0f, 1f)
            val quality = (motionQuality * .72f + shapeQuality * .28f).coerceIn(0f, 1f)

            return AnalysisResult(
                sourceWidth = targetWidth,
                sourceHeight = targetHeight,
                patchX = anchorLeft / targetWidth,
                patchY = anchorTop / targetHeight,
                patchWidth = safeAnchorW / targetWidth,
                patchHeight = safeAnchorH / targetHeight,
                quality = quality,
                analyzedFrames = observations.size,
            )
        } finally {
            detector.close()
            runCatching { retriever.release() }
        }
    }

    private suspend fun saveTexture(
        retriever: MediaMetadataRetriever,
        observation: MouthObservation,
        targetWidth: Int,
        targetHeight: Int,
        anchorW: Float,
        anchorH: Float,
        output: File,
    ) {
        val frame = withContext(Dispatchers.IO) {
            extractFrame(retriever, observation.timeMs, targetWidth, targetHeight)
        } ?: error("No se pudo extraer un fotograma del avatar")
        try {
            val desired = RectF(
                observation.centerX - anchorW / 2f,
                observation.centerY - anchorH / 2f,
                observation.centerX + anchorW / 2f,
                observation.centerY + anchorH / 2f,
            ).clampTo(frame.width, frame.height)
            val left = floor(desired.left).toInt().coerceIn(0, frame.width - 1)
            val top = floor(desired.top).toInt().coerceIn(0, frame.height - 1)
            val right = ceil(desired.right).toInt().coerceIn(left + 1, frame.width)
            val bottom = ceil(desired.bottom).toInt().coerceIn(top + 1, frame.height)
            val crop = Bitmap.createBitmap(frame, left, top, right - left, bottom - top)
            val fixedW = anchorW.toInt().coerceAtLeast(16)
            val fixedH = anchorH.toInt().coerceAtLeast(12)
            val sized = if (crop.width != fixedW || crop.height != fixedH) {
                Bitmap.createScaledBitmap(crop, fixedW, fixedH, true).also { crop.recycle() }
            } else crop
            val feathered = feather(sized)
            sized.recycle()
            withContext(Dispatchers.IO) {
                output.outputStream().buffered().use { out ->
                    check(feathered.compress(Bitmap.CompressFormat.PNG, 100, out)) {
                        "No se pudo guardar una textura real de labios"
                    }
                }
            }
            feathered.recycle()
        } finally {
            frame.recycle()
        }
    }

    /** Borde alpha suave: desaparece la costura rectangular sin dibujar nada artificial. */
    private fun feather(source: Bitmap): Bitmap {
        val result = source.copy(Bitmap.Config.ARGB_8888, true)
        val w = result.width
        val h = result.height
        val pixels = IntArray(w * h)
        result.getPixels(pixels, 0, w, 0, 0, w, h)
        val featherX = max(4f, w * .20f)
        val featherY = max(4f, h * .24f)

        fun smooth(v: Float): Float {
            val x = v.coerceIn(0f, 1f)
            return x * x * (3f - 2f * x)
        }

        for (y in 0 until h) {
            val edgeY = min(y.toFloat(), (h - 1 - y).toFloat()) / featherY
            for (x in 0 until w) {
                val edgeX = min(x.toFloat(), (w - 1 - x).toFloat()) / featherX
                val a = smooth(min(edgeX, edgeY))
                val index = y * w + x
                val color = pixels[index]
                val originalAlpha = color ushr 24 and 0xFF
                val alpha = (originalAlpha * a).toInt().coerceIn(0, 255)
                pixels[index] = (color and 0x00FFFFFF) or (alpha shl 24)
            }
        }
        result.setPixels(pixels, 0, w, 0, 0, w, h)
        return result
    }

    private fun extractFrame(
        retriever: MediaMetadataRetriever,
        timeMs: Long,
        targetWidth: Int,
        targetHeight: Int,
    ): Bitmap? {
        val timeUs = timeMs * 1000L
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            retriever.getScaledFrameAtTime(
                timeUs,
                MediaMetadataRetriever.OPTION_CLOSEST,
                targetWidth,
                targetHeight,
            )
        } else {
            retriever.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST)?.let { raw ->
                Bitmap.createScaledBitmap(raw, targetWidth, targetHeight, true).also { raw.recycle() }
            }
        }
    }

    private suspend fun detectLargestFace(detector: FaceDetector, bitmap: Bitmap): Face? =
        suspendCoroutine { continuation ->
            detector.process(InputImage.fromBitmap(bitmap, 0))
                .addOnSuccessListener { faces ->
                    continuation.resume(faces.maxByOrNull { it.boundingBox.width() * it.boundingBox.height() })
                }
                .addOnFailureListener(continuation::resumeWithException)
        }

    private fun analyzeMouth(face: Face, timeMs: Long): MouthObservation? {
        val upperOuter = face.getContour(FaceContour.UPPER_LIP_TOP)?.points.orEmpty()
        val upperInner = face.getContour(FaceContour.UPPER_LIP_BOTTOM)?.points.orEmpty()
        val lowerInner = face.getContour(FaceContour.LOWER_LIP_TOP)?.points.orEmpty()
        val lowerOuter = face.getContour(FaceContour.LOWER_LIP_BOTTOM)?.points.orEmpty()
        val all = ArrayList<PointF>(upperOuter.size + upperInner.size + lowerInner.size + lowerOuter.size)
        all.addAll(upperOuter)
        all.addAll(upperInner)
        all.addAll(lowerInner)
        all.addAll(lowerOuter)
        if (all.size < 8) return null

        val minX = all.minOf { it.x }
        val maxX = all.maxOf { it.x }
        val minY = all.minOf { it.y }
        val maxY = all.maxOf { it.y }
        val lipW = (maxX - minX).coerceAtLeast(5f)
        val lipH = (maxY - minY).coerceAtLeast(3f)
        val centerX = (minX + maxX) * .5f
        val centerY = (minY + maxY) * .5f

        fun centralAverageY(points: List<PointF>): Float? {
            if (points.isEmpty()) return null
            val sorted = points.sortedBy { it.x }
            val from = (sorted.size * .28f).toInt().coerceIn(0, sorted.lastIndex)
            val to = ceil(sorted.size * .72f).toInt().coerceIn(from + 1, sorted.size)
            return sorted.subList(from, to).map { it.y }.average().toFloat()
        }

        val upperY = centralAverageY(upperInner)
        val lowerY = centralAverageY(lowerInner)
        val innerGap = if (upperY != null && lowerY != null) max(0f, lowerY - upperY) else lipH * .18f
        val faceW = face.boundingBox.width().toFloat().coerceAtLeast(1f)
        val faceH = face.boundingBox.height().toFloat().coerceAtLeast(1f)

        val patchW = max(lipW * 1.92f, faceW * .47f)
        val patchH = max(lipH * 3.05f, faceH * .205f)
        return MouthObservation(
            timeMs = timeMs,
            centerX = centerX,
            centerY = centerY + patchH * .015f,
            patchWidth = patchW,
            patchHeight = patchH,
            openRatio = innerGap / lipW,
            widthRatio = lipW / faceW,
        )
    }

    private fun median(values: List<Float>): Float {
        val sorted = values.sorted()
        if (sorted.isEmpty()) return 0f
        val middle = sorted.size / 2
        return if (sorted.size % 2 == 0) (sorted[middle - 1] + sorted[middle]) * .5f else sorted[middle]
    }

    private fun queryDisplayName(context: Context, uri: Uri): String = runCatching {
        context.contentResolver.query(
            uri,
            arrayOf(OpenableColumns.DISPLAY_NAME),
            null,
            null,
            null,
        )?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
    }.getOrNull().orEmpty().ifBlank { "avatar.mp4" }

    private fun RectF.clampTo(width: Int, height: Int): RectF {
        val l = left.coerceIn(0f, width - 2f)
        val t = top.coerceIn(0f, height - 2f)
        val r = right.coerceIn(l + 1f, width.toFloat())
        val b = bottom.coerceIn(t + 1f, height.toFloat())
        return RectF(l, t, r, b)
    }

    private fun bump() {
        _updates.value = _updates.value + 1L
    }
}
