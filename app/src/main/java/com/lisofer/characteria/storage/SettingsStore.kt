package com.lisofer.characteria.storage

import android.content.Context
import com.lisofer.characteria.AppConfig
import com.lisofer.characteria.DEFAULT_GEMINI_MODEL
import com.lisofer.characteria.normalizeGeminiModel
import java.io.File

class SettingsStore(private val context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)
    private val secrets = SecretStore(context)
    private val legacyVoiceFile = File(context.filesDir, "voice_sample.bin")

    fun geminiKey(): String = secrets.get("gemini")
    fun fishKey(): String = secrets.get("fish")

    fun geminiModel(): String {
        val saved = prefs.getString("geminiModel", null)
            ?: prefs.getString("model", DEFAULT_GEMINI_MODEL)
            ?: DEFAULT_GEMINI_MODEL
        return normalizeGeminiModel(saved)
    }

    fun saveGlobalKeys(geminiApiKey: String, fishApiKey: String) {
        secrets.put("gemini", geminiApiKey)
        secrets.put("fish", fishApiKey)
    }

    fun setGeminiModel(model: String) {
        prefs.edit().putString("geminiModel", normalizeGeminiModel(model)).apply()
    }

    fun saveGlobalConnection(geminiApiKey: String, fishApiKey: String, geminiModel: String) {
        saveGlobalKeys(geminiApiKey, fishApiKey)
        setGeminiModel(geminiModel)
    }

    fun activeProfileId(): String = prefs.getString("activeProfileId", "") ?: ""

    fun setActiveProfileId(id: String) {
        prefs.edit().putString("activeProfileId", id).apply()
    }

    fun profilesMigrated(): Boolean = prefs.getBoolean("profilesMigrated", false)

    fun markProfilesMigrated() {
        prefs.edit().putBoolean("profilesMigrated", true).apply()
    }

    fun loadLegacy(): AppConfig {
        val oldPersonality = prefs.getString("personality", "") ?: ""
        val personality = if (oldPersonality.startsWith("Sos una versión conversacional de Santiago.")) "" else oldPersonality
        return AppConfig(
            geminiApiKey = geminiKey(),
            fishApiKey = fishKey(),
            geminiModel = geminiModel(),
            personality = personality,
            voiceTranscript = prefs.getString("voiceTranscript", "") ?: "",
            voiceName = prefs.getString("voiceName", "") ?: "",
            voiceSpeed = prefs.getFloat("voiceSpeed", 1f),
        )
    }

    fun hasLegacyProfileData(): Boolean =
        legacyVoiceFile.exists() ||
            prefs.contains("voiceTranscript") ||
            prefs.contains("voiceName") ||
            prefs.contains("voiceSpeed") ||
            prefs.contains("personality")

    fun legacyVoiceBytes(): ByteArray? =
        if (legacyVoiceFile.exists() && legacyVoiceFile.length() > 0) legacyVoiceFile.readBytes() else null
}
