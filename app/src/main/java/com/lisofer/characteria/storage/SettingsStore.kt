package com.lisofer.characteria.storage

import android.content.Context
import com.lisofer.characteria.AppConfig
import com.lisofer.characteria.DEFAULT_PERSONALITY
import java.io.File

class SettingsStore(private val context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)
    private val secrets = SecretStore(context)
    private val voiceFile = File(context.filesDir, "voice_sample.bin")

    fun load(): AppConfig = AppConfig(
        geminiApiKey = secrets.get("gemini"),
        fishApiKey = secrets.get("fish"),
        geminiModel = prefs.getString("model", "gemini-3.1-flash-live-preview")
            ?: "gemini-3.1-flash-live-preview",
        personality = prefs.getString("personality", DEFAULT_PERSONALITY) ?: DEFAULT_PERSONALITY,
        voiceTranscript = prefs.getString("voiceTranscript", "") ?: "",
        voiceName = prefs.getString("voiceName", "") ?: "",
        voiceSpeed = prefs.getFloat("voiceSpeed", 1f),
    )

    fun save(config: AppConfig) {
        secrets.put("gemini", config.geminiApiKey)
        secrets.put("fish", config.fishApiKey)
        prefs.edit()
            .putString("model", config.geminiModel)
            .putString("personality", config.personality)
            .putString("voiceTranscript", config.voiceTranscript)
            .putString("voiceName", config.voiceName)
            .putFloat("voiceSpeed", config.voiceSpeed)
            .apply()
    }

    fun saveVoice(bytes: ByteArray, displayName: String) {
        voiceFile.writeBytes(bytes)
        prefs.edit().putString("voiceName", displayName).apply()
    }

    fun voiceBytes(): ByteArray? = if (voiceFile.exists()) voiceFile.readBytes() else null
    fun hasVoice(): Boolean = voiceFile.exists() && voiceFile.length() > 0
}
