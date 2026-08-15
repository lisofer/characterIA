package com.lisofer.characteria

enum class Speaker { USER, AI }

data class ChatMessage(
    val id: Long,
    val speaker: Speaker,
    val text: String,
    val isPartial: Boolean = false,
)

data class CharacterProfileSummary(
    val id: String,
    val name: String,
)

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
    val geminiModel: String = "gemini-3.1-flash-live-preview",
    val personality: String = "",
    val voiceTranscript: String = "",
    val voiceName: String = "",
    val voiceSpeed: Float = 1f,
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
    val diagnostics: List<String> = emptyList(),
)
