package com.lisofer.characteria.musetalk

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File

/** Avatar fuente para MuseTalk. No recorta ni altera la boca. */
data class MuseTalkAvatar(
    val profileId: String,
    val displayName: String,
    val videoPath: String,
)

object MuseTalkAvatarStore {
    private const val MAX_VIDEO_BYTES = 250L * 1024L * 1024L
    private val _updates = MutableStateFlow(0L)
    val updates: StateFlow<Long> = _updates.asStateFlow()

    private fun dir(context: Context, profileId: String): File =
        File(File(context.filesDir, "character_profiles/$profileId"), "musetalk").apply { mkdirs() }

    fun load(context: Context, profileId: String): MuseTalkAvatar? = runCatching {
        if (profileId.isBlank()) return null
        val d = dir(context, profileId)
        val video = File(d, "avatar.mp4")
        val meta = File(d, "avatar.json")
        if (!video.isFile || !meta.isFile) return null
        val json = JSONObject(meta.readText())
        MuseTalkAvatar(
            profileId = profileId,
            displayName = json.optString("displayName", "avatar.mp4"),
            videoPath = video.absolutePath,
        )
    }.getOrNull()

    suspend fun importVideo(context: Context, profileId: String, uri: Uri): MuseTalkAvatar {
        require(profileId.isNotBlank()) { "Primero elegí un perfil" }
        val app = context.applicationContext
        val d = dir(app, profileId)
        val incoming = File(d, ".avatar-incoming.mp4")
        val name = displayName(app, uri)

        try {
            withContext(Dispatchers.IO) {
                incoming.delete()
                app.contentResolver.openInputStream(uri)?.use { input ->
                    incoming.outputStream().buffered().use { output ->
                        val buffer = ByteArray(128 * 1024)
                        var total = 0L
                        while (true) {
                            val n = input.read(buffer)
                            if (n < 0) break
                            total += n
                            require(total <= MAX_VIDEO_BYTES) { "El video supera 250 MB" }
                            output.write(buffer, 0, n)
                        }
                    }
                } ?: error("No se pudo leer el MP4")
                require(incoming.length() > 0) { "El video está vacío" }

                val final = File(d, "avatar.mp4")
                final.delete()
                if (!incoming.renameTo(final)) {
                    incoming.copyTo(final, overwrite = true)
                    incoming.delete()
                }
                File(d, "avatar.json").writeText(
                    JSONObject()
                        .put("displayName", name)
                        .put("updatedAt", System.currentTimeMillis())
                        .toString()
                )
            }
            _updates.value++
            return load(app, profileId) ?: error("No se pudo guardar el avatar")
        } catch (t: Throwable) {
            incoming.delete()
            throw t
        }
    }

    fun remove(context: Context, profileId: String) {
        runCatching { dir(context, profileId).deleteRecursively() }
        _updates.value++
    }

    private fun displayName(context: Context, uri: Uri): String = runCatching {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    }.getOrNull().orEmpty().ifBlank { "avatar.mp4" }
}
