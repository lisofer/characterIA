package com.lisofer.characteria.musetalk

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Rect
import android.media.MediaMetadataRetriever
import android.os.Build
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetectorOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.max

object MuseTalkAvatarPreprocessor {
    sealed interface State {
        data object Idle : State
        data class Preparing(val frame: Int, val total: Int, val detail: String) : State
        data class Ready(val frameCount: Int) : State
        data class Error(val message: String) : State
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    suspend fun prepare(context: Context, avatar: MuseTalkAvatar): MuseTalkPreparedAvatar {
        val app = context.applicationContext
        val video = File(avatar.videoPath)
        require(video.isFile) { "No encuentro el MP4 del personaje" }
        check(MuseTalkModelStore.isReady(app)) { "Descargá MuseTalk antes de preparar el avatar" }

        val staging = File(app.cacheDir, "musetalk-prep-${avatar.profileId}-${System.nanoTime()}")
        staging.mkdirs()
        return try {
            val frames = withContext(Dispatchers.IO) { extractFrames(video) }
            require(frames.isNotEmpty()) { "No pude extraer fotogramas del MP4" }
            val engine = MuseTalkOrtEngine(app)
            val prepared = mutableListOf<MuseTalkPreparedFrame>()
            try {
                engine.loadEncoder()
                frames.forEachIndexed { index, bitmap ->
                    _state.value = State.Preparing(index + 1, frames.size, "Detectando rostro…")
                    val face = detectLargestFace(bitmap)
                        ?: error("No detecté el rostro en el fotograma ${index + 1}. Usá un video frontal y bien iluminado.")
                    val crop = expandedFaceRect(face, bitmap.width, bitmap.height)
                    val faceBitmap = Bitmap.createBitmap(bitmap, crop.left, crop.top, crop.width(), crop.height())
                    val face256 = Bitmap.createScaledBitmap(faceBitmap, 256, 256, true)
                    if (faceBitmap !== face256) faceBitmap.recycle()

                    _state.value = State.Preparing(index + 1, frames.size, "Codificando latentes VAE…")
                    val reference = bitmapToTensor(face256, maskLowerHalf = false)
                    val masked = bitmapToTensor(face256, maskLowerHalf = true)
                    val refLatent = withContext(Dispatchers.Default) { engine.encodeFace(reference) }
                    val maskedLatent = withContext(Dispatchers.Default) { engine.encodeFace(masked) }
                    val combined = engine.combineLatents(maskedLatent, refLatent)

                    val imageFile = File(staging, "frame_%03d.jpg".format(index))
                    withContext(Dispatchers.IO) {
                        imageFile.outputStream().buffered().use { out ->
                            bitmap.compress(Bitmap.CompressFormat.JPEG, 94, out)
                        }
                    }
                    val latentFile = File(staging, "latent_%03d.bin".format(index))
                    withContext(Dispatchers.IO) { MuseTalkPreparedStore.writeLatent(latentFile, combined) }

                    prepared += MuseTalkPreparedFrame(
                        framePath = imageFile.absolutePath,
                        latentPath = latentFile.absolutePath,
                        faceLeft = crop.left.toFloat() / bitmap.width,
                        faceTop = crop.top.toFloat() / bitmap.height,
                        faceRight = crop.right.toFloat() / bitmap.width,
                        faceBottom = crop.bottom.toFloat() / bitmap.height,
                    )
                    face256.recycle()
                    bitmap.recycle()
                }
            } finally {
                engine.releaseEncoder()
                engine.close()
                frames.forEach { if (!it.isRecycled) it.recycle() }
            }

            val result = withContext(Dispatchers.IO) {
                MuseTalkPreparedStore.save(
                    context = app,
                    profileId = avatar.profileId,
                    sourceUpdatedAt = video.lastModified(),
                    stagedDir = staging,
                    frameMetadata = prepared,
                )
            }
            _state.value = State.Ready(result.frames.size)
            result
        } catch (t: Throwable) {
            staging.deleteRecursively()
            _state.value = State.Error(t.message ?: "No pude preparar el avatar MuseTalk")
            throw t
        }
    }

    fun isCurrent(context: Context, avatar: MuseTalkAvatar): Boolean {
        val cached = MuseTalkPreparedStore.load(context, avatar.profileId) ?: return false
        return cached.sourceUpdatedAt == File(avatar.videoPath).lastModified() && cached.frames.isNotEmpty()
    }

    private fun extractFrames(video: File): List<Bitmap> {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(video.absolutePath)
            val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
            require(durationMs > 100L) { "El MP4 es demasiado corto" }
            val srcW = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 720
            val srcH = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 1280
            val count = (durationMs / 250L).toInt().coerceIn(8, 16)
            val startMs = if (durationMs > 1000L) 300L else 0L
            val usable = (durationMs - startMs - 100L).coerceAtLeast(100L)
            val maxSide = 960f
            val scale = (maxSide / max(srcW, srcH).toFloat()).coerceAtMost(1f)
            val targetW = (srcW * scale).toInt().coerceAtLeast(64)
            val targetH = (srcH * scale).toInt().coerceAtLeast(64)

            return buildList {
                for (i in 0 until count) {
                    val ms = startMs + (usable * i / count)
                    val us = ms * 1000L
                    val bitmap = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                        retriever.getScaledFrameAtTime(us, MediaMetadataRetriever.OPTION_CLOSEST, targetW, targetH)
                    } else {
                        retriever.getFrameAtTime(us, MediaMetadataRetriever.OPTION_CLOSEST)
                    }
                    bitmap?.let(::add)
                }
            }
        } finally {
            runCatching { retriever.release() }
        }
    }

    private suspend fun detectLargestFace(bitmap: Bitmap): Rect? = suspendCancellableCoroutine { continuation ->
        val options = FaceDetectorOptions.Builder()
            .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_ACCURATE)
            .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_NONE)
            .setContourMode(FaceDetectorOptions.CONTOUR_MODE_NONE)
            .setMinFaceSize(.15f)
            .build()
        val detector = FaceDetection.getClient(options)
        detector.process(InputImage.fromBitmap(bitmap, 0))
            .addOnSuccessListener { faces ->
                val box = faces.maxByOrNull { it.boundingBox.width() * it.boundingBox.height() }?.boundingBox
                detector.close()
                if (continuation.isActive) continuation.resume(box)
            }
            .addOnFailureListener { error ->
                detector.close()
                if (continuation.isActive) continuation.resumeWithException(error)
            }
    }

    private fun expandedFaceRect(box: Rect, width: Int, height: Int): Rect {
        val w = box.width().coerceAtLeast(20)
        val h = box.height().coerceAtLeast(20)
        // MuseTalk V1.5 benefits from a little extra jaw/chin context.
        val l = (box.left - w * .08f).toInt().coerceIn(0, width - 2)
        val r = (box.right + w * .08f).toInt().coerceIn(l + 1, width)
        val t = (box.top - h * .04f).toInt().coerceIn(0, height - 2)
        val b = (box.bottom + h * .12f + 10f).toInt().coerceIn(t + 1, height)
        return Rect(l, t, r, b)
    }

    private fun bitmapToTensor(bitmap: Bitmap, maskLowerHalf: Boolean): FloatArray {
        val pixels = IntArray(256 * 256)
        bitmap.getPixels(pixels, 0, 256, 0, 0, 256, 256)
        val plane = 256 * 256
        val out = FloatArray(3 * plane)
        for (y in 0 until 256) {
            val mask = !maskLowerHalf || y < 128
            for (x in 0 until 256) {
                val index = y * 256 + x
                val p = pixels[index]
                val r = if (mask) (p shr 16) and 0xff else 0
                val g = if (mask) (p shr 8) and 0xff else 0
                val b = if (mask) p and 0xff else 0
                out[index] = r * (2f / 255f) - 1f
                out[plane + index] = g * (2f / 255f) - 1f
                out[2 * plane + index] = b * (2f / 255f) - 1f
            }
        }
        return out
    }
}
