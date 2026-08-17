package com.lisofer.characteria.vision

import android.content.Context
import android.graphics.Bitmap
import android.graphics.PointF
import android.media.MediaMetadataRetriever
import android.os.Build
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.Face
import com.google.mlkit.vision.face.FaceContour
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetector
import com.google.mlkit.vision.face.FaceDetectorOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Analiza UN solo MP4 y encuentra automáticamente un tramo corto donde la boca esté lo más
 * relajada posible. Ese tramo se usa como idle visible; el mismo MP4 sigue aportando las texturas
 * de boca que ya prepara VisionAvatarStore.
 *
 * El resultado queda cacheado junto al video. En runtime no corre ML Kit.
 */
object VisionIdleAnalyzer {
    data class Result(
        val startMs: Long,
        val endMs: Long,
        val track: List<MouthTrackPoint>,
    )

    private data class Observation(
        val timeMs: Long,
        val centerX: Float,
        val centerY: Float,
        val openRatio: Float,
        val faceWidth: Float,
        val faceHeight: Float,
        val rotationZ: Float,
    )

    private const val CACHE_VERSION = 1
    private const val CACHE_NAME = "idle_track_v1.json"

    suspend fun loadOrAnalyze(context: Context, avatar: VisionAvatar): Result = withContext(Dispatchers.Default) {
        val video = File(avatar.videoPath)
        val cache = File(video.parentFile, CACHE_NAME)
        readCache(cache, video)?.let { return@withContext it }

        val result = analyze(video, avatar)
        runCatching { writeCache(cache, video, result) }
        result
    }

    private suspend fun analyze(video: File, avatar: VisionAvatar): Result {
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
                ?.toLongOrNull()?.coerceAtLeast(1L) ?: avatar.durationMs.coerceAtLeast(1L)
            val rawWidth = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
                ?.toIntOrNull()?.coerceAtLeast(1) ?: avatar.sourceWidth.coerceAtLeast(1)
            val rawHeight = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
                ?.toIntOrNull()?.coerceAtLeast(1) ?: avatar.sourceHeight.coerceAtLeast(1)
            val scale = (720f / max(rawWidth, rawHeight).toFloat()).coerceAtMost(1f)
            val requestW = (rawWidth * scale).toInt().coerceAtLeast(160)
            val requestH = (rawHeight * scale).toInt().coerceAtLeast(160)

            val probe = extractFrame(retriever, 0L, requestW, requestH)
                ?: error("No pude analizar el video del avatar")
            val frameW = probe.width.coerceAtLeast(1)
            val frameH = probe.height.coerceAtLeast(1)
            probe.recycle()

            val coarseCount = when {
                durationMs < 4_000L -> 48
                durationMs < 12_000L -> 72
                else -> 90
            }
            val coarse = ArrayList<Observation>(coarseCount)
            repeat(coarseCount) { index ->
                val fraction = if (coarseCount <= 1) 0.0 else index.toDouble() / (coarseCount - 1).toDouble()
                val t = (durationMs * fraction).toLong().coerceIn(0L, max(0L, durationMs - 1L))
                val frame = extractFrame(retriever, t, requestW, requestH) ?: return@repeat
                try {
                    val face = detectLargestFace(detector, frame) ?: return@repeat
                    observe(face, t)?.let(coarse::add)
                } finally {
                    frame.recycle()
                }
            }
            require(coarse.size >= 8) { "No pude seguir la boca con suficiente precisión." }
            val sorted = coarse.sortedBy { it.timeMs }
            val minOpen = sorted.minOf { it.openRatio }
            val maxOpen = sorted.maxOf { it.openRatio }
            val range = (maxOpen - minOpen).coerceAtLeast(.0001f)
            fun openN(o: Observation) = ((o.openRatio - minOpen) / range).coerceIn(0f, 1f)

            val desired = when {
                durationMs < 2_500L -> (durationMs * .52).toLong().coerceAtLeast(650L)
                durationMs < 6_000L -> 1_050L
                else -> 1_350L
            }.coerceAtMost(durationMs)
            val latestStart = max(0L, durationMs - desired)
            var bestStart = 0L
            var bestScore = Float.MAX_VALUE

            sorted.forEach { anchor ->
                val start = (anchor.timeMs - desired / 2L).coerceIn(0L, latestStart)
                val end = (start + desired).coerceAtMost(durationMs)
                val window = sorted.filter { it.timeMs in start..end }
                if (window.size < 4) return@forEach
                val meanOpen = window.map(::openN).average().toFloat()
                var change = 0f
                var motion = 0f
                for (i in 1 until window.size) {
                    change += abs(openN(window[i]) - openN(window[i - 1]))
                    val dx = (window[i].centerX - window[i - 1].centerX) / window[i].faceWidth.coerceAtLeast(1f)
                    val dy = (window[i].centerY - window[i - 1].centerY) / window[i].faceHeight.coerceAtLeast(1f)
                    motion += sqrt(dx * dx + dy * dy)
                }
                val denom = (window.size - 1).coerceAtLeast(1).toFloat()
                change /= denom
                motion /= denom
                val rotation = window.map { abs(it.rotationZ) / 20f }.average().toFloat().coerceIn(0f, 1f)
                val score = meanOpen * .66f + change * .23f + motion.coerceIn(0f, .35f) * .07f + rotation * .04f
                if (score < bestScore) {
                    bestScore = score
                    bestStart = start
                }
            }
            val bestEnd = (bestStart + desired).coerceAtMost(durationMs)

            // Segunda pasada sólo sobre el idle: ~30 Hz para que la boca siga la cara con precisión.
            val dense = ArrayList<Observation>()
            var t = bestStart
            while (t <= bestEnd) {
                val frame = extractFrame(retriever, t, requestW, requestH)
                if (frame != null) {
                    try {
                        val face = detectLargestFace(detector, frame)
                        if (face != null) observe(face, t)?.let(dense::add)
                    } finally {
                        frame.recycle()
                    }
                }
                t += 33L
            }
            val useful = if (dense.size >= 4) dense else sorted.filter { it.timeMs in bestStart..bestEnd }
            require(useful.isNotEmpty()) { "No pude construir el tramo idle del avatar." }

            val medianFaceW = median(useful.map { it.faceWidth }).coerceAtLeast(1f)
            val medianFaceH = median(useful.map { it.faceHeight }).coerceAtLeast(1f)
            val rawTrack = useful.map { o ->
                val sx = (o.faceWidth / medianFaceW).coerceIn(.82f, 1.22f)
                val sy = (o.faceHeight / medianFaceH).coerceIn(.82f, 1.22f)
                MouthTrackPoint(
                    timeMs = o.timeMs,
                    centerX = (o.centerX / frameW).coerceIn(0f, 1f),
                    centerY = (o.centerY / frameH).coerceIn(0f, 1f),
                    patchWidth = (avatar.patchWidth * sx).coerceIn(.02f, .8f),
                    patchHeight = (avatar.patchHeight * sy).coerceIn(.015f, .6f),
                    rotationZ = o.rotationZ.coerceIn(-20f, 20f),
                )
            }
            val track = smooth(rawTrack)
            return Result(bestStart, bestEnd, track)
        } finally {
            detector.close()
            runCatching { retriever.release() }
        }
    }

    private fun observe(face: Face, timeMs: Long): Observation? {
        val upperOuter = face.getContour(FaceContour.UPPER_LIP_TOP)?.points.orEmpty()
        val upperInner = face.getContour(FaceContour.UPPER_LIP_BOTTOM)?.points.orEmpty()
        val lowerInner = face.getContour(FaceContour.LOWER_LIP_TOP)?.points.orEmpty()
        val lowerOuter = face.getContour(FaceContour.LOWER_LIP_BOTTOM)?.points.orEmpty()
        val all = ArrayList<PointF>()
        all.addAll(upperOuter); all.addAll(upperInner); all.addAll(lowerInner); all.addAll(lowerOuter)
        if (all.size < 8) return null
        val minX = all.minOf { it.x }; val maxX = all.maxOf { it.x }
        val minY = all.minOf { it.y }; val maxY = all.maxOf { it.y }
        val lipW = (maxX - minX).coerceAtLeast(5f)
        val lipH = (maxY - minY).coerceAtLeast(3f)
        val cx = (minX + maxX) * .5f
        val cy = (minY + maxY) * .5f

        fun centerY(points: List<PointF>): Float? {
            if (points.isEmpty()) return null
            val s = points.sortedBy { it.x }
            val from = (s.size * .28f).toInt().coerceIn(0, s.lastIndex)
            val to = ceil(s.size * .72f).toInt().coerceIn(from + 1, s.size)
            return s.subList(from, to).map { it.y }.average().toFloat()
        }
        val upperY = centerY(upperInner)
        val lowerY = centerY(lowerInner)
        val gap = if (upperY != null && lowerY != null) max(0f, lowerY - upperY) else lipH * .18f
        val faceW = face.boundingBox.width().toFloat().coerceAtLeast(1f)
        val faceH = face.boundingBox.height().toFloat().coerceAtLeast(1f)
        return Observation(
            timeMs = timeMs,
            centerX = cx,
            centerY = cy,
            openRatio = gap / lipW,
            faceWidth = faceW,
            faceHeight = faceH,
            rotationZ = face.headEulerAngleZ,
        )
    }

    private fun smooth(points: List<MouthTrackPoint>): List<MouthTrackPoint> = points.mapIndexed { i, p ->
        val from = max(0, i - 1); val to = min(points.lastIndex, i + 1)
        val n = points.subList(from, to + 1)
        p.copy(
            centerX = n.map { it.centerX }.average().toFloat(),
            centerY = n.map { it.centerY }.average().toFloat(),
            patchWidth = n.map { it.patchWidth }.average().toFloat(),
            patchHeight = n.map { it.patchHeight }.average().toFloat(),
            rotationZ = n.map { it.rotationZ }.average().toFloat(),
        )
    }

    private suspend fun detectLargestFace(detector: FaceDetector, bitmap: Bitmap): Face? =
        suspendCoroutine { continuation ->
            detector.process(InputImage.fromBitmap(bitmap, 0))
                .addOnSuccessListener { faces -> continuation.resume(faces.maxByOrNull { it.boundingBox.width() * it.boundingBox.height() }) }
                .addOnFailureListener(continuation::resumeWithException)
        }

    private fun extractFrame(retriever: MediaMetadataRetriever, timeMs: Long, width: Int, height: Int): Bitmap? {
        val us = timeMs * 1000L
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            retriever.getScaledFrameAtTime(us, MediaMetadataRetriever.OPTION_CLOSEST, width, height)
        } else {
            retriever.getFrameAtTime(us, MediaMetadataRetriever.OPTION_CLOSEST)?.let { raw ->
                val scale = min(width / raw.width.toFloat(), height / raw.height.toFloat()).coerceAtMost(1f)
                val w = (raw.width * scale).toInt().coerceAtLeast(1)
                val h = (raw.height * scale).toInt().coerceAtLeast(1)
                Bitmap.createScaledBitmap(raw, w, h, true).also { raw.recycle() }
            }
        }
    }

    private fun median(values: List<Float>): Float {
        val s = values.sorted(); if (s.isEmpty()) return 0f
        val m = s.size / 2
        return if (s.size % 2 == 0) (s[m - 1] + s[m]) * .5f else s[m]
    }

    private fun readCache(cache: File, video: File): Result? = runCatching {
        if (!cache.isFile) return null
        val j = JSONObject(cache.readText())
        if (j.optInt("version") != CACHE_VERSION) return null
        if (j.optLong("videoModified") != video.lastModified() || j.optLong("videoLength") != video.length()) return null
        val arr = j.optJSONArray("track") ?: return null
        val track = buildList {
            for (i in 0 until arr.length()) {
                val p = arr.getJSONObject(i)
                add(MouthTrackPoint(p.getLong("t"), p.getDouble("x").toFloat(), p.getDouble("y").toFloat(), p.getDouble("w").toFloat(), p.getDouble("h").toFloat(), p.getDouble("r").toFloat()))
            }
        }
        Result(j.getLong("start"), j.getLong("end"), track)
    }.getOrNull()

    private fun writeCache(cache: File, video: File, result: Result) {
        val arr = JSONArray()
        result.track.forEach { p ->
            arr.put(JSONObject().put("t", p.timeMs).put("x", p.centerX).put("y", p.centerY).put("w", p.patchWidth).put("h", p.patchHeight).put("r", p.rotationZ))
        }
        cache.writeText(JSONObject().put("version", CACHE_VERSION).put("videoModified", video.lastModified()).put("videoLength", video.length()).put("start", result.startMs).put("end", result.endMs).put("track", arr).toString())
    }
}
