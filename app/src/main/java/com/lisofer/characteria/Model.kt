package com.lisofer.characteria

enum class Speaker { USER, AI }

data class ChatMessage(
    val id: Long,
    val speaker: Speaker,
    val text: String,
    val isPartial: Boolean = false,
    val characterProfileId: String = "",
    val characterName: String = "",
)

data class CharacterProfileSummary(
    val id: String,
    val name: String,
)

data class GeminiModelOption(
    val id: String,
    val label: String,
)

val GEMINI_LIVE_MODELS = listOf(
    GeminiModelOption(
        id = "gemini-3.1-flash-live-preview",
        label = "Gemini 3.1 Flash Live · más rápido",
    ),
    GeminiModelOption(
        id = "gemini-2.5-flash-native-audio-preview-12-2025",
        label = "Gemini 2.5 Flash Live",
    ),
)

const val DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-live-preview"

fun normalizeGeminiModel(model: String): String =
    model.takeIf { candidate -> GEMINI_LIVE_MODELS.any { it.id == candidate } }
        ?: DEFAULT_GEMINI_MODEL

fun geminiFallbackChain(model: String): List<String> {
    val normalized = normalizeGeminiModel(model)
    val ids = GEMINI_LIVE_MODELS.map { it.id }
    val index = ids.indexOf(normalized).coerceAtLeast(0)
    return ids.drop(index)
}

enum class SessionStatus {
    DISCONNECTED,
    CONNECTING,
    LISTENING,
    THINKING,
    SPEAKING,
    INVOCATION_ARMED,
    INVOCATION_ACTIVE,
    RECONNECTING,
    ERROR,
}

data class AppConfig(
    val profileId: String = "",
    val profileName: String = "",
    val geminiApiKey: String = "",
    val fishApiKey: String = "",
    val simliApiKey: String = "",
    /** Modelo preferido elegido por el usuario. */
    val geminiModel: String = DEFAULT_GEMINI_MODEL,
    val personality: String = "",
    val voiceTranscript: String = "",
    val voiceName: String = "",
    val voiceSpeed: Float = 1f,
    val simliEnabled: Boolean = false,
    val simliFaceId: String = "",
)

data class AppUiState(
    val config: AppConfig = AppConfig(),
    val profiles: List<CharacterProfileSummary> = emptyList(),
    val hasVoiceSample: Boolean = false,
    val status: SessionStatus = SessionStatus.DISCONNECTED,
    val statusDetail: String = "Desconectado",
    val messages: List<ChatMessage> = emptyList(),
    val settingsOpen: Boolean = false,
    val backgroundModeEnabled: Boolean = false,
    val invocationActive: Boolean = false,
    val activeCharacterNames: List<String> = emptyList(),
    /** Puede diferir del preferido cuando hay fallback por cuota. */
    val activeGeminiModel: String = DEFAULT_GEMINI_MODEL,
    val simliStatus: String = "Simli apagado",
    val simliSessionActive: Boolean = false,
    val simliVideoReady: Boolean = false,
    val diagnostics: List<String> = emptyList(),
)
