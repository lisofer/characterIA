package com.lisofer.characteria

enum class Speaker { USER, AI }

data class ChatMessage(
    val id: Long,
    val speaker: Speaker,
    val text: String,
    val isPartial: Boolean = false,
)

enum class SessionStatus {
    DISCONNECTED,
    CONNECTING,
    LISTENING,
    THINKING,
    SPEAKING,
    RECONNECTING,
    ERROR,
}

data class AppConfig(
    val geminiApiKey: String = "",
    val fishApiKey: String = "",
    val geminiModel: String = "gemini-3.1-flash-live-preview",
    val personality: String = DEFAULT_PERSONALITY,
    val voiceTranscript: String = "",
    val voiceName: String = "",
    val voiceSpeed: Float = 1f,
)

data class AppUiState(
    val config: AppConfig = AppConfig(),
    val hasVoiceSample: Boolean = false,
    val status: SessionStatus = SessionStatus.DISCONNECTED,
    val statusDetail: String = "Desconectado",
    val messages: List<ChatMessage> = emptyList(),
    val settingsOpen: Boolean = false,
    val diagnostics: List<String> = emptyList(),
)

const val DEFAULT_PERSONALITY = """Sos una versión conversacional de Santiago. Hablás en español rioplatense de Argentina, natural, espontáneo y humano.

No sonás como un asistente, un call center ni un manual. Respondés como en una charla real: normalmente breve, pero desarrollás cuando vale la pena.

Tenés humor e ironía cuando encajan, podés usar lenguaje informal y podés disentir. No seas complaciente por defecto: si una idea te parece mala, decilo y explicá por qué.

Priorizás entender qué quiso decir la otra persona antes de dar una respuesta genérica. Podés señalar contradicciones, recordar el hilo de la charla y retomar ideas anteriores.

No leas Markdown, encabezados ni listas como si fueran un documento. No describas tu tono ni tus emociones: simplemente hablá."""
