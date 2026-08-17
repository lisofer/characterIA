package com.lisofer.characteria.musetalk

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File

/** Disk cache produced once per avatar; runtime never VAE-encodes source faces again. */
data class MuseTalkPreparedFrame(
    val framePath: String,
    val latentPath: String,
    val faceLeft: Float,
    val faceTop: Float,
    val faceRight: Float,
    val faceBottom: Float,
)

data class MuseTalkPreparedAvatar(
    val profileId: String,
    val sourceUpdatedAt: Long,
    val frames: List<MuseTalkPreparedFrame>,
)

object MuseTalkPreparedStore {
    private const val META = "prepared.json"

    private fun dir(context: Context, profileId: String): File =
        File(context.filesDir, "character_profiles/$profileId/musetalk/prepared").apply { mkdirs() }

    fun invalidate(context: Context, profileId: String) {
        runCatching { dir(context, profileId).deleteRecursively() }
    }

    fun load(context: Context, profileId: String): MuseTalkPreparedAvatar? = runCatching {
        val d = dir(context, profileId)
        val meta = File(d, META)
        if (!meta.isFile) return null
        val json = JSONObject(meta.readText())
        val array = json.getJSONArray("frames")
        val frames = buildList {
            for (i in 0 until array.length()) {
                val item = array.getJSONObject(i)
                val image = File(d, item.getString("image"))
                val latent = File(d, item.getString("latent"))
                if (!image.isFile || !latent.isFile) continue
                add(
                    MuseTalkPreparedFrame(
                        framePath = image.absolutePath,
                        latentPath = latent.absolutePath,
                        faceLeft = item.getDouble("l").toFloat(),
                        faceTop = item.getDouble("t").toFloat(),
                        faceRight = item.getDouble("r").toFloat(),
                        faceBottom = item.getDouble("b").toFloat(),
                    )
                )
            }
        }
        if (frames.isEmpty()) return null
        MuseTalkPreparedAvatar(profileId, json.optLong("sourceUpdatedAt", 0L), frames)
    }.getOrNull()

    fun save(
        context: Context,
        profileId: String,
        sourceUpdatedAt: Long,
        stagedDir: File,
        frameMetadata: List<MuseTalkPreparedFrame>,
    ): MuseTalkPreparedAvatar {
        val finalDir = dir(context, profileId)
        finalDir.deleteRecursively()
        finalDir.mkdirs()

        val items = JSONArray()
        frameMetadata.forEachIndexed { index, frame ->
            val imageName = "frame_%03d.jpg".format(index)
            val latentName = "latent_%03d.bin".format(index)
            File(frame.framePath).copyTo(File(finalDir, imageName), overwrite = true)
            File(frame.latentPath).copyTo(File(finalDir, latentName), overwrite = true)
            items.put(
                JSONObject()
                    .put("image", imageName)
                    .put("latent", latentName)
                    .put("l", frame.faceLeft.toDouble())
                    .put("t", frame.faceTop.toDouble())
                    .put("r", frame.faceRight.toDouble())
                    .put("b", frame.faceBottom.toDouble())
            )
        }
        File(finalDir, META).writeText(
            JSONObject()
                .put("sourceUpdatedAt", sourceUpdatedAt)
                .put("frames", items)
                .toString()
        )
        stagedDir.deleteRecursively()
        return load(context, profileId) ?: error("No se pudo abrir el avatar MuseTalk preparado")
    }

    fun writeLatent(file: File, values: FloatArray) {
        file.parentFile?.mkdirs()
        DataOutputStream(file.outputStream().buffered()).use { out ->
            out.writeInt(values.size)
            values.forEach(out::writeFloat)
        }
    }

    fun readLatent(filePath: String): FloatArray {
        DataInputStream(File(filePath).inputStream().buffered()).use { input ->
            val size = input.readInt()
            require(size == 8 * 32 * 32) { "Latent MuseTalk corrupto: $size" }
            return FloatArray(size) { input.readFloat() }
        }
    }
}
