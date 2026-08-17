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
    fun simliKey(): String = secrets.get("simli")

    /** Modelo que eligió el usuario. Un fallback automático nunca modifica esta preferencia. */
    fun geminiModel(): String {
        val preferred = prefs.getString("preferredGeminiModel", null)
        return normalizeGeminiModel(preferred ?: DEFAULT_GEMINI_MODEL)
    }

    /** Modelo que debe intentar la próxima sesión con la API key actual. */
    fun activeGeminiModel(): String {
        val active = prefs.getString("activeGeminiModel", null)
            ?: prefs.getString("geminiModel", null) // migración desde Debug 157 y anteriores
            ?: geminiModel()
        return normalizeGeminiModel(active)
    }

    fun saveGlobalKeys(geminiApiKey: String, fishApiKey: String, simliApiKey: String = simliKey()) {
        secrets.put("gemini", geminiApiKey.trim())
        secrets.put("fish", fishApiKey.trim())
        secrets.put("simli", simliApiKey.trim())
    }

    /** Selección manual: pasa a ser preferida y activa inmediatamente. */
    fun setGeminiModel(model: String) {
        val normalized = normalizeGeminiModel(model)
        prefs.edit()
            .putString("preferredGeminiModel", normalized)
            .putString("activeGeminiModel", normalized)
            .putString("geminiModel", normalized) // compatibilidad hacia atrás
            .apply()
    }

    /** Fallback automático: cambia sólo el modelo activo de esta API key. */
    fun setActiveGeminiModel(model: String) {
        prefs.edit().putString("activeGeminiModel", normalizeGeminiModel(model)).apply()
    }

    fun resetActiveGeminiModelToPreferred() {
        prefs.edit().putString("activeGeminiModel", geminiModel()).apply()
    }

    /**
     * Guarda la conexión global. Si cambió la API key de Gemini, cualquier fallback de la
     * key anterior deja de tener sentido y el modelo activo vuelve automáticamente al preferido.
     * Devuelve true cuando la key de Gemini efectivamente cambió.
     */
    fun saveGlobalConnection(
        geminiApiKey: String,
        fishApiKey: String,
        simliApiKey: String,
        geminiModel: String,
    ): Boolean {
        val normalizedKey = geminiApiKey.trim()
        val previousGeminiKey = geminiKey().trim()
        val keyChanged = normalizedKey != previousGeminiKey
        val preferred = normalizeGeminiModel(geminiModel)

        saveGlobalKeys(normalizedKey, fishApiKey, simliApiKey)
        prefs.edit()
            .putString("preferredGeminiModel", preferred)
            .putString("geminiModel", preferred)
            .apply()

        if (keyChanged || !prefs.contains("activeGeminiModel")) {
            prefs.edit().putString("activeGeminiModel", preferred).apply()
        }
        return keyChanged
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
            simliApiKey = simliKey(),
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
