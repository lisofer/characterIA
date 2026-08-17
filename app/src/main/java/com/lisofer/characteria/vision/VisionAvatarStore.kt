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
import com.google.mlkit.vision.face.FaceDetectorOptions
import com.google.mlkit.vision.face.FaceLandmark
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

/** Datos preprocesados del avatar. Todo queda dentro del almacenamiento privado del perfil. */
data class VisionAvatar(
    val profileId: String,
    val displayName: String,
    val videoPath: String,
    val mouthImagePath: String,
    val sourceWidth: Int,
    val sourceHeight: Int,
    val mouthX: Float,
    val mouthY: Float,
    val mouthWidth: Float,
    val mouthHeight: Float,
) {
    val aspectRatio: Float
        get() = sourceWidth.toFloat() / sourceHeight.coerceAtLeast(1).toFloat()
}

object VisionAvatarStore {
    private const val MAX_VIDEO_BYTES = 150L * 1024L * 1024L
    private const val METADATA_NAME = "vision.json"
    private const val VIDEO_NAME = "avatar.mp4"
    private const val MOUTH_NAME = "mouth.png"

    private val _updates = MutableStateFlow(0L)
    val updates: StateFlow<Long> = _updates.asStateFlow()

    private fun profileDir(context: Context, profileId: String): File =
        File(File(context.filesDir, "character_profiles"), profileId)

    private fun visionDir(context: Context, profileId: String): File =
        File(profileDir(context, profileId), "vision").apply { mkdirs() }

    fun load(context: Context, profileId: String): VisionAvatar? = runCatching {
        if (profileId.isBlank()) return null
        val dir = visionDir(context, profileId)
        val metadata = File(dir, METADATA_NAME)
        val video = File(dir, VIDEO_NAME)
        val mouth = File(dir, MOUTH_NAME)
        if (!metadata.exists() || !video.exists() || !mouth.exists()) return null

        val json = JSONObject(metadata.readText())
        VisionAvatar(
            profileId = profileId,
            displayName = json.optString("displayName", "avatar.mp4"),
            videoPath = video.absolutePath,
            mouthImagePath = mouth.absolutePath,
            sourceWidth = json.getInt("sourceWidth"),
            sourceHeight = json.getInt("sourceHeight"),
            mouthX = json.getDouble("mouthX").toFloat(),
            mouthY = json.getDouble("mouthY").toFloat(),
            mouthWidth = json.getDouble("mouthWidth").toFloat(),
            mouthHeight = json.getDouble("mouthHeight").toFloat(),
        )
    }.getOrNull()

    fun remove(context: Context, profileId: String) {
        if (profileId.isBlank()) return
        runCatching { visionDir(context, profileId).deleteRecursively() }
        bump()
    }

    /**
     * Copia el MP4 al perfil, extrae un frame y detecta la boca una sola vez con ML Kit.
     * El video previo no se toca hasta que el nuevo avatar fue analizado correctamente.
     */
    suspend fun importVideo(context: Context, profileId: String, uri: Uri): VisionAvatar {
        require(profileId.isNotBlank()) { "Primero elegí un perfil" }
        val appContext = context.applicationContext
        val dir = visionDir(appContext, profileId)
        val incomingVideo = File(dir, ".avatar-incoming.mp4")
        val incomingMouth = File(dir, ".mouth-incoming.png")

        val displayName = queryDisplayName(appContext, uri)
        try {
            withContext(Dispatchers.IO) {
                incomingVideo.delete()
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

            val frame = withContext(Dispatchers.IO) { extractAnalysisFrame(incomingVideo) }
            val mouthRect = detectMouth(frame)
            val avatar = withContext(Dispatchers.IO) {
                val safeRect = mouthRect.clampTo(frame.width, frame.height)
                val left = floor(safeRect.left).toInt().coerceIn(0, frame.width - 1)
                val top = floor(safeRect.top).toInt().coerceIn(0, frame.height - 1)
                val right = ceil(safeRect.right).toInt().coerceIn(left + 1, frame.width)
                val bottom = ceil(safeRect.bottom).toInt().coerceIn(top + 1, frame.height)
                val mouthBitmap = Bitmap.createBitmap(frame, left, top, right - left, bottom - top)

                incomingMouth.delete()
                incomingMouth.outputStream().buffered().use { out ->
                    check(mouthBitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) {
                        "No se pudo preparar la región de la boca"
                    }
                }

                val finalVideo = File(dir, VIDEO_NAME)
                val finalMouth = File(dir, MOUTH_NAME)
                finalVideo.delete()
                finalMouth.delete()
                if (!incomingVideo.renameTo(finalVideo)) {
                    incomingVideo.copyTo(finalVideo, overwrite = true)
                    incomingVideo.delete()
                }
                if (!incomingMouth.renameTo(finalMouth)) {
                    incomingMouth.copyTo(finalMouth, overwrite = true)
                    incomingMouth.delete()
                }

                val result = VisionAvatar(
                    profileId = profileId,
                    displayName = displayName,
                    videoPath = finalVideo.absolutePath,
                    mouthImagePath = finalMouth.absolutePath,
                    sourceWidth = frame.width,
                    sourceHeight = frame.height,
                    mouthX = left.toFloat() / frame.width,
                    mouthY = top.toFloat() / frame.height,
                    mouthWidth = (right - left).toFloat() / frame.width,
                    mouthHeight = (bottom - top).toFloat() / frame.height,
                )

                File(dir, METADATA_NAME).writeText(
                    JSONObject()
                        .put("displayName", result.displayName)
                        .put("sourceWidth", result.sourceWidth)
                        .put("sourceHeight", result.sourceHeight)
                        .put("mouthX", result.mouthX.toDouble())
                        .put("mouthY", result.mouthY.toDouble())
                        .put("mouthWidth", result.mouthWidth.toDouble())
                        .put("mouthHeight", result.mouthHeight.toDouble())
                        .put("updatedAt", System.currentTimeMillis())
                        .toString()
                )
                mouthBitmap.recycle()
                frame.recycle()
                result
            }
            bump()
            return avatar
        } catch (error: Throwable) {
            incomingVideo.delete()
            incomingMouth.delete()
            throw error
        }
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

    private fun extractAnalysisFrame(file: File): Bitmap {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(file.absolutePath)
            val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                ?.toLongOrNull()
                ?: 0L
            val timeUs = when {
                durationMs <= 0L -> 0L
                durationMs < 1000L -> durationMs * 500L
                else -> 500_000L
            }
            val width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
                ?.toIntOrNull()
                ?: 0
            val height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
                ?.toIntOrNull()
                ?: 0

            val frame = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1 && width > 0 && height > 0) {
                val maxSide = 1280f
                val scale = (maxSide / max(width, height).toFloat()).coerceAtMost(1f)
                val targetW = (width * scale).toInt().coerceAtLeast(32)
                val targetH = (height * scale).toInt().coerceAtLeast(32)
                retriever.getScaledFrameAtTime(
                    timeUs,
                    MediaMetadataRetriever.OPTION_CLOSEST_SYNC,
                    targetW,
                    targetH,
                )
            } else {
                retriever.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
            }
            return frame ?: retriever.getFrameAtTime(0L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                ?: error("No se pudo extraer una imagen del video")
        } finally {
            runCatching { retriever.release() }
        }
    }

    private suspend fun detectMouth(bitmap: Bitmap): RectF = suspendCoroutine { continuation ->
        val options = FaceDetectorOptions.Builder()
            .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_ACCURATE)
            .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_ALL)
            .setContourMode(FaceDetectorOptions.CONTOUR_MODE_ALL)
            .setMinFaceSize(0.15f)
            .build()
        val detector = FaceDetection.getClient(options)
        detector.process(InputImage.fromBitmap(bitmap, 0))
            .addOnSuccessListener { faces ->
                runCatching {
                    val face = faces.maxByOrNull { it.boundingBox.width() * it.boundingBox.height() }
                        ?: error("No pude detectar un rostro. Probá con un video frontal y bien iluminado.")
                    mouthRect(face)
                }.onSuccess(continuation::resume)
                    .onFailure(continuation::resumeWithException)
                detector.close()
            }
            .addOnFailureListener { error ->
                detector.close()
                continuation.resumeWithException(error)
            }
    }

    private fun mouthRect(face: Face): RectF {
        val contourTypes = intArrayOf(
            FaceContour.UPPER_LIP_TOP,
            FaceContour.UPPER_LIP_BOTTOM,
            FaceContour.LOWER_LIP_TOP,
            FaceContour.LOWER_LIP_BOTTOM,
        )
        val contourPoints = buildList<PointF> {
            contourTypes.forEach { type ->
                face.getContour(type)?.points?.let(::addAll)
            }
        }

        if (contourPoints.size >= 4) {
            val minX = contourPoints.minOf { it.x }
            val maxX = contourPoints.maxOf { it.x }
            val minY = contourPoints.minOf { it.y }
            val maxY = contourPoints.maxOf { it.y }
            val w = (maxX - minX).coerceAtLeast(4f)
            val h = (maxY - minY).coerceAtLeast(3f)
            val padX = w * .34f
            val padY = max(h * .72f, face.boundingBox.height() * .018f)
            return RectF(minX - padX, minY - padY, maxX + padX, maxY + padY)
        }

        val left = face.getLandmark(FaceLandmark.MOUTH_LEFT)?.position
        val right = face.getLandmark(FaceLandmark.MOUTH_RIGHT)?.position
        val bottom = face.getLandmark(FaceLandmark.MOUTH_BOTTOM)?.position
        if (left != null && right != null && bottom != null) {
            val w = kotlin.math.abs(right.x - left.x).coerceAtLeast(face.boundingBox.width() * .16f)
            val estimatedH = face.boundingBox.height() * .10f
            val centerX = (left.x + right.x) * .5f
            return RectF(
                centerX - w * .70f,
                bottom.y - estimatedH * .92f,
                centerX + w * .70f,
                bottom.y + estimatedH * .50f,
            )
        }

        // Último fallback: región anatómica estimada dentro del rostro detectado.
        val box = face.boundingBox
        val centerX = box.exactCenterX()
        val centerY = box.top + box.height() * .72f
        return RectF(
            centerX - box.width() * .20f,
            centerY - box.height() * .065f,
            centerX + box.width() * .20f,
            centerY + box.height() * .065f,
        )
    }

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
