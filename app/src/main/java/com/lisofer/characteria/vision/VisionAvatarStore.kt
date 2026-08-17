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
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

data class MouthTrackPoint(
    val timeMs: Long,
    val centerX: Float,
    val centerY: Float,
    val patchWidth: Float,
    val patchHeight: Float,
    val rotationZ: Float,
)

data class VisionAvatar(
    val profileId: String,
    val displayName: String,
    val videoPath: String,
    val neutralPath: String,
    val restPath: String,
    val closedPath: String,
    val widePath: String,
    val openPath: String,
    val roundPath: String,
    val sourceWidth: Int,
    val sourceHeight: Int,
    val durationMs: Long,
    val patchX: Float,
    val patchY: Float,
    val patchWidth: Float,
    val patchHeight: Float,
    val neutralScaleW: Float,
    val neutralScaleH: Float,
    val neutralYOffset: Float,
    val motionTrack: List<MouthTrackPoint>,
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
    val faceWidth: Float,
    val faceHeight: Float,
    val rotationZ: Float,
)

object VisionAvatarStore {
    private const val SCHEMA_VERSION = 4
    private const val MAX_VIDEO_BYTES = 150L * 1024L * 1024L
    private const val METADATA_NAME = "vision.json"
    private const val VIDEO_NAME = "avatar.mp4"
    private const val NEUTRAL_NAME = "lower_face_neutral.png"
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
        val neutral = File(dir, NEUTRAL_NAME)
        val rest = File(dir, REST_NAME)
        val closed = File(dir, CLOSED_NAME)
        val wide = File(dir, WIDE_NAME)
        val open = File(dir, OPEN_NAME)
        val round = File(dir, ROUND_NAME)
        if (listOf(video, neutral, rest, closed, wide, open, round).any { !it.exists() }) return null

        val trackJson = json.optJSONArray("motionTrack") ?: JSONArray()
        val track = buildList {
            for (i in 0 until trackJson.length()) {
                val p = trackJson.optJSONObject(i) ?: continue
                add(
                    MouthTrackPoint(
                        timeMs = p.optLong("t", 0L),
                        centerX = p.optDouble("cx", 0.5).toFloat(),
                        centerY = p.optDouble("cy", 0.5).toFloat(),
                        patchWidth = p.optDouble("w", 0.2).toFloat(),
                        patchHeight = p.optDouble("h", 0.1).toFloat(),
                        rotationZ = p.optDouble("rz", 0.0).toFloat(),
                    )
                )
            }
        }.sortedBy { it.timeMs }

        VisionAvatar(
            profileId = profileId,
            displayName = json.optString("displayName", "avatar.mp4"),
            videoPath = video.absolutePath,
            neutralPath = neutral.absolutePath,
            restPath = rest.absolutePath,
            closedPath = closed.absolutePath,
            widePath = wide.absolutePath,
            openPath = open.absolutePath,
            roundPath = round.absolutePath,
            sourceWidth = json.getInt("sourceWidth"),
            sourceHeight = json.getInt("sourceHeight"),
            durationMs = json.optLong("durationMs", 1L).coerceAtLeast(1L),
            patchX = json.getDouble("patchX").toFloat(),
            patchY = json.getDouble("patchY").toFloat(),
            patchWidth = json.getDouble("patchWidth").toFloat(),
            patchHeight = json.getDouble("patchHeight").toFloat(),
            neutralScaleW = json.optDouble("neutralScaleW", 1.56).toFloat(),
            neutralScaleH = json.optDouble("neutralScaleH", 2.10).toFloat(),
            neutralYOffset = json.optDouble("neutralYOffset", 0.20).toFloat(),
            motionTrack = track,
            quality = json.optDouble("quality", 0.5).toFloat(),
            analyzedFrames = json.optInt("analyzedFrames", 0),
        )
    }.getOrNull()

    fun remove(context: Context, profileId: String) {
        if (profileId.isBlank()) return
        runCatching { visionDir(context, profileId).deleteRecursively() }
        bump()
    }

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
            val motionJson = JSONArray().apply {
                analysis.motionTrack.forEach { p ->
                    put(
                        JSONObject()
                            .put("t", p.timeMs)
                            .put("cx", p.centerX.toDouble())
                            .put("cy", p.centerY.toDouble())
                            .put("w", p.patchWidth.toDouble())
                            .put("h", p.patchHeight.toDouble())
                            .put("rz", p.rotationZ.toDouble())
                    )
                }
            }
            val json = JSONObject()
                .put("schemaVersion", SCHEMA_VERSION)
                .put("displayName", displayName)
                .put("sourceWidth", analysis.sourceWidth)
                .put("sourceHeight", analysis.sourceHeight)
                .put("durationMs", analysis.durationMs)
                .put("patchX", analysis.patchX.toDouble())
                .put("patchY", analysis.patchY.toDouble())
                .put("patchWidth", analysis.patchWidth.toDouble())
                .put("patchHeight", analysis.patchHeight.toDouble())
                .put("neutralScaleW", analysis.neutralScaleW.toDouble())
                .put("neutralScaleH", analysis.neutralScaleH.toDouble())
                .put("neutralYOffset", analysis.neutralYOffset.toDouble())
                .put("motionTrack", motionJson)
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
        val durationMs: Long,
        val patchX: Float,
        val patchY: Float,
        val patchWidth: Float,
        val patchHeight: Float,
        val neutralScaleW: Float,
        val neutralScaleH: Float,
        val neutralYOffset: Float,
        val motionTrack: List<MouthTrackPoint>,
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
            val requestWidth = (rawWidth * scale).toInt().coerceAtLeast(160)
            val requestHeight = (rawHeight * scale).toInt().coerceAtLeast(160)

            // Un MP4 vertical puede estar almacenado apaisado + rotación. La 213 usaba el ancho/
            // alto del archivo y por eso el parche podía terminar en la franja negra. Acá usamos
            // las dimensiones REALES del bitmap decodificado, que son las mismas que analiza ML Kit.
            val probe = withContext(Dispatchers.IO) {
                extractFrame(retriever, 0L, requestWidth, requestHeight)
            } ?: error("No pude leer el primer fotograma del video")
            val frameWidth = probe.width.coerceAtLeast(1)
            val frameHeight = probe.height.coerceAtLeast(1)
            probe.recycle()

            val sampleCount = when {
                durationMs < 4_000L -> 36
                durationMs < 12_000L -> 72
                else -> 96
            }
            val observations = ArrayList<MouthObservation>(sampleCount)

            repeat(sampleCount) { index ->
                val fraction = if (sampleCount == 1) 0.0 else index.toDouble() / (sampleCount - 1).toDouble()
                val timeMs = (durationMs * fraction).toLong().coerceIn(0L, max(0L, durationMs - 1L))
                val frame = withContext(Dispatchers.IO) {
                    extractFrame(retriever, timeMs, requestWidth, requestHeight)
                } ?: return@repeat
                try {
                    val face = detectLargestFace(detector, frame) ?: return@repeat
                    analyzeMouth(face, timeMs)?.let(observations::add)
                } finally {
                    frame.recycle()
                }
            }

            require(observations.size >= 10) {
                "No pude seguir bien el rostro. Usá un video frontal, nítido y con buena luz."
            }

            val openMin = observations.minOf { it.openRatio }
            val openMax = observations.maxOf { it.openRatio }
            val widthMin = observations.minOf { it.widthRatio }
            val widthMax = observations.maxOf { it.widthRatio }
            val openRange = (openMax - openMin).coerceAtLeast(0.0001f)
            val widthRange = (widthMax - widthMin).coerceAtLeast(0.0001f)

            fun openN(o: MouthObservation) = ((o.openRatio - openMin) / openRange).coerceIn(0f, 1f)
            fun widthN(o: MouthObservation) = ((o.widthRatio - widthMin) / widthRange).coerceIn(0f, 1f)

            val rest = observations.minByOrNull { openN(it) + abs(it.rotationZ) / 90f * .22f }!!
            val closed = observations.minByOrNull { openN(it) + abs(it.rotationZ) / 90f * .12f } ?: rest
            val open = observations.maxByOrNull { openN(it) - abs(it.rotationZ) / 90f * .08f } ?: rest
            val wide = observations.maxByOrNull {
                widthN(it) * .72f + openN(it) * .28f - abs(it.rotationZ) / 90f * .05f
            } ?: open
            val round = observations.maxByOrNull {
                openN(it) * .72f + (1f - widthN(it)) * .28f - abs(it.rotationZ) / 90f * .05f
            } ?: open

            val anchorW = median(observations.map { it.patchWidth }).coerceAtLeast(24f)
            val anchorH = median(observations.map { it.patchHeight }).coerceAtLeast(16f)
            val medianFaceW = median(observations.map { it.faceWidth }).coerceAtLeast(1f)
            val medianFaceH = median(observations.map { it.faceHeight }).coerceAtLeast(1f)

            val anchorLeft = (rest.centerX - anchorW / 2f).coerceIn(0f, frameWidth - 2f)
            val anchorTop = (rest.centerY - anchorH / 2f).coerceIn(0f, frameHeight - 2f)
            val safeAnchorW = min(anchorW, frameWidth - anchorLeft).coerceAtLeast(2f)
            val safeAnchorH = min(anchorH, frameHeight - anchorTop).coerceAtLeast(2f)

            // El parche neutral tapa boca + parte de mandíbula del video original. Después la boca
            // elegida por Fish se dibuja arriba. Así nunca quedan dos bocas hablando a la vez.
            val neutralScaleW = 1.56f
            val neutralScaleH = 2.10f
            val neutralYOffset = 0.20f

            savePatch(
                retriever = retriever,
                timeMs = rest.timeMs,
                requestWidth = requestWidth,
                requestHeight = requestHeight,
                centerX = rest.centerX,
                centerY = rest.centerY + anchorH * neutralYOffset,
                cropW = anchorW * neutralScaleW,
                cropH = anchorH * neutralScaleH,
                output = File(outDir, NEUTRAL_NAME),
                featherXRatio = .13f,
                featherYRatio = .17f,
            )
            saveMouthTexture(retriever, rest, requestWidth, requestHeight, anchorW, anchorH, File(outDir, REST_NAME))
            saveMouthTexture(retriever, closed, requestWidth, requestHeight, anchorW, anchorH, File(outDir, CLOSED_NAME))
            saveMouthTexture(retriever, wide, requestWidth, requestHeight, anchorW, anchorH, File(outDir, WIDE_NAME))
            saveMouthTexture(retriever, open, requestWidth, requestHeight, anchorW, anchorH, File(outDir, OPEN_NAME))
            saveMouthTexture(retriever, round, requestWidth, requestHeight, anchorW, anchorH, File(outDir, ROUND_NAME))

            // Guardamos la trayectoria de la cara. En runtime sólo interpolamos números; ML Kit no
            // corre durante la conversación y el parche puede seguir la cabeza a ~60 fps.
            val track = observations.sortedBy { it.timeMs }.map { o ->
                val scaleX = (o.faceWidth / medianFaceW).coerceIn(.78f, 1.28f)
                val scaleY = (o.faceHeight / medianFaceH).coerceIn(.78f, 1.28f)
                MouthTrackPoint(
                    timeMs = o.timeMs,
                    centerX = (o.centerX / frameWidth).coerceIn(0f, 1f),
                    centerY = (o.centerY / frameHeight).coerceIn(0f, 1f),
                    patchWidth = (anchorW * scaleX / frameWidth).coerceIn(.02f, .8f),
                    patchHeight = (anchorH * scaleY / frameHeight).coerceIn(.015f, .6f),
                    rotationZ = o.rotationZ.coerceIn(-20f, 20f),
                )
            }

            val motionQuality = ((openMax - openMin) / .085f).coerceIn(0f, 1f)
            val shapeQuality = ((widthMax - widthMin) / .055f).coerceIn(0f, 1f)
            val trackingQuality = (observations.size.toFloat() / sampleCount.toFloat()).coerceIn(0f, 1f)
            val quality = (motionQuality * .55f + shapeQuality * .20f + trackingQuality * .25f).coerceIn(0f, 1f)

            return AnalysisResult(
                sourceWidth = frameWidth,
                sourceHeight = frameHeight,
                durationMs = durationMs,
                patchX = anchorLeft / frameWidth,
                patchY = anchorTop / frameHeight,
                patchWidth = safeAnchorW / frameWidth,
                patchHeight = safeAnchorH / frameHeight,
                neutralScaleW = neutralScaleW,
                neutralScaleH = neutralScaleH,
                neutralYOffset = neutralYOffset,
                motionTrack = track,
                quality = quality,
                analyzedFrames = observations.size,
            )
        } finally {
            detector.close()
            runCatching { retriever.release() }
        }
    }

    private suspend fun saveMouthTexture(
        retriever: MediaMetadataRetriever,
        observation: MouthObservation,
        requestWidth: Int,
        requestHeight: Int,
        anchorW: Float,
        anchorH: Float,
        output: File,
    ) {
        savePatch(
            retriever = retriever,
            timeMs = observation.timeMs,
            requestWidth = requestWidth,
            requestHeight = requestHeight,
            centerX = observation.centerX,
            centerY = observation.centerY,
            cropW = anchorW,
            cropH = anchorH,
            output = output,
            featherXRatio = .20f,
            featherYRatio = .24f,
        )
    }

    private suspend fun savePatch(
        retriever: MediaMetadataRetriever,
        timeMs: Long,
        requestWidth: Int,
        requestHeight: Int,
        centerX: Float,
        centerY: Float,
        cropW: Float,
        cropH: Float,
        output: File,
        featherXRatio: Float,
        featherYRatio: Float,
    ) {
        val frame = withContext(Dispatchers.IO) {
            extractFrame(retriever, timeMs, requestWidth, requestHeight)
        } ?: error("No se pudo extraer un fotograma del avatar")
        try {
            val desired = RectF(
                centerX - cropW / 2f,
                centerY - cropH / 2f,
                centerX + cropW / 2f,
                centerY + cropH / 2f,
            ).clampTo(frame.width, frame.height)
            val left = floor(desired.left).toInt().coerceIn(0, frame.width - 1)
            val top = floor(desired.top).toInt().coerceIn(0, frame.height - 1)
            val right = ceil(desired.right).toInt().coerceIn(left + 1, frame.width)
            val bottom = ceil(desired.bottom).toInt().coerceIn(top + 1, frame.height)
            val crop = Bitmap.createBitmap(frame, left, top, right - left, bottom - top)
            val fixedW = cropW.toInt().coerceAtLeast(16)
            val fixedH = cropH.toInt().coerceAtLeast(12)
            val sized = if (crop.width != fixedW || crop.height != fixedH) {
                Bitmap.createScaledBitmap(crop, fixedW, fixedH, true).also { crop.recycle() }
            } else crop
            val feathered = feather(sized, featherXRatio, featherYRatio)
            sized.recycle()
            withContext(Dispatchers.IO) {
                output.outputStream().buffered().use { out ->
                    check(feathered.compress(Bitmap.CompressFormat.PNG, 100, out)) {
                        "No se pudo guardar una textura del avatar"
                    }
                }
            }
            feathered.recycle()
        } finally {
            frame.recycle()
        }
    }

    private fun feather(source: Bitmap, featherXRatio: Float, featherYRatio: Float): Bitmap {
        val result = source.copy(Bitmap.Config.ARGB_8888, true)
        val w = result.width
        val h = result.height
        val pixels = IntArray(w * h)
        result.getPixels(pixels, 0, w, 0, 0, w, h)
        val featherX = max(3f, w * featherXRatio)
        val featherY = max(3f, h * featherYRatio)

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
                val originalAlpha = color ushr 24 and 0xff
                val alpha = (originalAlpha * a).toInt().coerceIn(0, 255)
                pixels[index] = (color and 0x00ffffff) or (alpha shl 24)
            }
        }
        result.setPixels(pixels, 0, w, 0, 0, w, h)
        return result
    }

    private fun extractFrame(
        retriever: MediaMetadataRetriever,
        timeMs: Long,
        requestWidth: Int,
        requestHeight: Int,
    ): Bitmap? {
        val timeUs = timeMs * 1000L
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            retriever.getScaledFrameAtTime(
                timeUs,
                MediaMetadataRetriever.OPTION_CLOSEST,
                requestWidth,
                requestHeight,
            )
        } else {
            retriever.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST)?.let { raw ->
                val scale = min(
                    requestWidth / raw.width.toFloat(),
                    requestHeight / raw.height.toFloat(),
                ).coerceAtMost(1f)
                val w = (raw.width * scale).toInt().coerceAtLeast(1)
                val h = (raw.height * scale).toInt().coerceAtLeast(1)
                Bitmap.createScaledBitmap(raw, w, h, true).also { raw.recycle() }
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
            faceWidth = faceW,
            faceHeight = faceH,
            rotationZ = face.headEulerAngleZ,
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
