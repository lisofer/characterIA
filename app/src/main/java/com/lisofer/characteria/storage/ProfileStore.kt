package com.lisofer.characteria.storage

import android.content.Context
import com.lisofer.characteria.AppConfig
import com.lisofer.characteria.CharacterProfileSummary
import com.lisofer.characteria.ChatMessage
import com.lisofer.characteria.Speaker
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class ProfileStore(context: Context) {
    private val root = File(context.filesDir, "character_profiles").apply { mkdirs() }
    private val groupRoot = File(context.filesDir, "character_groups").apply { mkdirs() }

    private fun profileDir(id: String): File = File(root, id).apply { mkdirs() }
    private fun configFile(id: String) = File(profileDir(id), "profile.json")
    private fun voiceFile(id: String) = File(profileDir(id), "voice_sample.bin")
    private fun chatFile(id: String) = File(profileDir(id), "chat.json")
    private fun groupChatFile(profileIds: List<String>): File {
        val key = profileIds.distinct().sorted().joinToString("__")
        return File(groupRoot, "$key.json")
    }

    fun listProfiles(): List<CharacterProfileSummary> = root.listFiles()
        ?.asSequence()
        ?.filter { it.isDirectory }
        ?.mapNotNull { dir ->
            runCatching {
                val json = JSONObject(File(dir, "profile.json").readText())
                CharacterProfileSummary(
                    id = dir.name,
                    name = json.optString("name").ifBlank { "Sin nombre" },
                ) to json.optLong("createdAt", Long.MAX_VALUE)
            }.getOrNull()
        }
        ?.sortedWith(compareBy<Pair<CharacterProfileSummary, Long>> { it.second }.thenBy { it.first.name.lowercase() })
        ?.map { it.first }
        ?.toList()
        ?: emptyList()

    fun loadProfile(id: String, geminiKey: String, fishKey: String): AppConfig? = runCatching {
        val file = configFile(id)
        if (!file.exists()) return null
        val json = JSONObject(file.readText())
        AppConfig(
            profileId = id,
            profileName = json.optString("name"),
            geminiApiKey = geminiKey,
            fishApiKey = fishKey,
            geminiModel = json.optString("model", "gemini-3.1-flash-live-preview"),
            personality = json.optString("personality", ""),
            voiceTranscript = json.optString("voiceTranscript", ""),
            voiceName = json.optString("voiceName", ""),
            voiceSpeed = json.optDouble("voiceSpeed", 1.0).toFloat(),
        )
    }.getOrNull()

    fun saveProfile(config: AppConfig) {
        require(config.profileId.isNotBlank()) { "El perfil no tiene ID" }
        val file = configFile(config.profileId)
        val oldCreatedAt = runCatching {
            if (file.exists()) JSONObject(file.readText()).optLong("createdAt", System.currentTimeMillis())
            else System.currentTimeMillis()
        }.getOrDefault(System.currentTimeMillis())

        val json = JSONObject()
            .put("name", config.profileName.trim())
            .put("model", config.geminiModel)
            .put("personality", config.personality)
            .put("voiceTranscript", config.voiceTranscript)
            .put("voiceName", config.voiceName)
            .put("voiceSpeed", config.voiceSpeed.toDouble())
            .put("createdAt", oldCreatedAt)
            .put("updatedAt", System.currentTimeMillis())
        file.writeText(json.toString())
    }

    fun saveVoice(profileId: String, bytes: ByteArray) {
        require(profileId.isNotBlank()) { "El perfil no tiene ID" }
        voiceFile(profileId).writeBytes(bytes)
    }

    fun voiceBytes(profileId: String): ByteArray? {
        val file = voiceFile(profileId)
        return if (file.exists() && file.length() > 0) file.readBytes() else null
    }

    fun hasVoice(profileId: String): Boolean {
        if (profileId.isBlank()) return false
        val file = voiceFile(profileId)
        return file.exists() && file.length() > 0
    }

    fun saveChat(profileId: String, messages: List<ChatMessage>) {
        if (profileId.isBlank()) return
        writeMessages(chatFile(profileId), messages)
    }

    fun loadChat(profileId: String): List<ChatMessage> = readMessages(chatFile(profileId))

    fun clearChat(profileId: String) {
        if (profileId.isBlank()) return
        chatFile(profileId).delete()
    }

    fun saveGroupChat(profileIds: List<String>, messages: List<ChatMessage>) {
        if (profileIds.distinct().size != 2) return
        writeMessages(groupChatFile(profileIds), messages)
    }

    fun loadGroupChat(profileIds: List<String>): List<ChatMessage> {
        if (profileIds.distinct().size != 2) return emptyList()
        return readMessages(groupChatFile(profileIds))
    }

    fun clearGroupChat(profileIds: List<String>) {
        if (profileIds.distinct().size != 2) return
        groupChatFile(profileIds).delete()
    }

    private fun writeMessages(file: File, messages: List<ChatMessage>) {
        val array = JSONArray()
        messages.forEach { message ->
            array.put(
                JSONObject()
                    .put("id", message.id)
                    .put("speaker", message.speaker.name)
                    .put("text", message.text)
                    .put("isPartial", false)
                    .put("characterProfileId", message.characterProfileId)
                    .put("characterName", message.characterName)
            )
        }
        file.writeText(array.toString())
    }

    private fun readMessages(file: File): List<ChatMessage> = runCatching {
        if (!file.exists()) return emptyList()
        val array = JSONArray(file.readText())
        buildList {
            for (i in 0 until array.length()) {
                val item = array.getJSONObject(i)
                val text = item.optString("text")
                if (text.isBlank()) continue
                add(
                    ChatMessage(
                        id = item.optLong("id", i.toLong() + 1L),
                        speaker = runCatching { Speaker.valueOf(item.optString("speaker")) }
                            .getOrDefault(Speaker.USER),
                        text = text,
                        isPartial = false,
                        characterProfileId = item.optString("characterProfileId", ""),
                        characterName = item.optString("characterName", ""),
                    )
                )
            }
        }
    }.getOrDefault(emptyList())
}
