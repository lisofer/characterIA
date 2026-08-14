package com.lisofer.characteria

import android.app.Application
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.lisofer.characteria.audio.MicStreamer
import com.lisofer.characteria.audio.PcmPlayer
import com.lisofer.characteria.fish.FishTtsClient
import com.lisofer.characteria.gemini.GeminiLiveClient
import com.lisofer.characteria.storage.SettingsStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong

class CharacterViewModel(application: Application) : AndroidViewModel(application) {
    private val store = SettingsStore(application)
    private val mic = MicStreamer(application)
    private val player = PcmPlayer()
    private val ids = AtomicLong(1)

    private val _ui = MutableStateFlow(
        AppUiState(
            config = store.load(),
            hasVoiceSample = store.hasVoice(),
        )
    )
    val ui: StateFlow<AppUiState> = _ui.asStateFlow()

    private var currentUserMessageId: Long? = null
    private var currentAiMessageId: Long? = null
    private var fish: FishTtsClient? = null
    private var turnFinalizeJob: Job? = null
    private var turnCompletePending = false
    private var desiredConnected = false

    private val gemini = GeminiLiveClient(viewModelScope, object : GeminiLiveClient.Listener {
        override fun onStatus(message: String) {
            val status = if (message.startsWith("Reconect")) SessionStatus.RECONNECTING else SessionStatus.CONNECTING
            _ui.update { it.copy(status = status, statusDetail = message) }
            diag(message)
        }

        override fun onReady(resumed: Boolean) {
            diag(if (resumed) "Gemini reanudado" else "Gemini listo")
            startMic()
            _ui.update { it.copy(status = SessionStatus.LISTENING, statusDetail = "Escuchando") }
        }

        override fun onInputTranscript(fullText: String) {
            // A new user turn may begin before a late output transcription has settled.
            // Close the previous AI bubble at that point so both turns never get mixed.
            if (turnCompletePending) {
                turnFinalizeJob?.cancel()
                turnFinalizeJob = null
                turnCompletePending = false
                finalizeAiMessage()
            }

            if (fish != null) {
                cancelFish("Interrupción por voz")
            }
            updateMessage(Speaker.USER, fullText, partial = true)
            _ui.update { it.copy(status = SessionStatus.LISTENING, statusDetail = "Te escucho…") }
        }

        override fun onOutputTranscript(delta: String, fullText: String) {
            ensureFish()
            fish?.sendText(delta)
            updateMessage(Speaker.AI, fullText, partial = true)

            // Gemini documents output transcription as independently ordered from
            // serverContent/turnComplete. If a late transcription arrives, extend the
            // quiet window instead of closing Fish or creating a second AI bubble.
            if (turnCompletePending) scheduleTurnSettlement()

            _ui.update { it.copy(status = SessionStatus.SPEAKING, statusDetail = "Respondiendo") }
        }

        override fun onTurnComplete() {
            // The user transcription belongs definitively to this turn, so it is safe
            // to close now. Keep the AI bubble open briefly for late transcript chunks.
            finalizeUserMessage()
            turnCompletePending = true
            scheduleTurnSettlement()
            diag("Turno Gemini completo · esperando transcripción final")
        }

        override fun onInterrupted() {
            turnFinalizeJob?.cancel()
            turnFinalizeJob = null
            turnCompletePending = false
            cancelFish("Gemini detectó interrupción")
            finalizeCurrentMessages()
            _ui.update { it.copy(status = SessionStatus.LISTENING, statusDetail = "Escuchando") }
        }

        override fun onError(message: String) {
            diag(message)
            _ui.update { it.copy(status = SessionStatus.ERROR, statusDetail = message) }
        }

        override fun onDiagnostic(message: String) = diag(message)
    })

    fun setSettingsOpen(open: Boolean) = _ui.update { it.copy(settingsOpen = open) }

    fun updateConfig(transform: (AppConfig) -> AppConfig) {
        _ui.update { it.copy(config = transform(it.config)) }
    }

    fun saveConfig() {
        store.save(_ui.value.config)
        _ui.update { it.copy(settingsOpen = false) }
        diag("Configuración guardada")
    }

    fun importVoiceSample(uri: Uri) {
        viewModelScope.launch {
            runCatching {
                val context = getApplication<Application>()
                val bytes = withContext(Dispatchers.IO) {
                    context.contentResolver.openInputStream(uri)?.use { input -> input.readBytes() }
                        ?: error("No se pudo leer el audio")
                }
                require(bytes.isNotEmpty()) { "El archivo está vacío" }
                require(bytes.size <= 20 * 1024 * 1024) { "La muestra supera 20 MB" }

                val name = context.contentResolver.query(
                    uri,
                    arrayOf(OpenableColumns.DISPLAY_NAME),
                    null, null, null,
                )?.use { cursor ->
                    if (cursor.moveToFirst()) cursor.getString(0) else null
                } ?: "muestra_de_voz"

                withContext(Dispatchers.IO) { store.saveVoice(bytes, name) }
                _ui.update {
                    it.copy(
                        hasVoiceSample = true,
                        config = it.config.copy(voiceName = name),
                    )
                }
                diag("Muestra de voz cargada: $name (${bytes.size / 1024} KB)")
            }.onFailure {
                _ui.update { state -> state.copy(status = SessionStatus.ERROR, statusDetail = it.message ?: "Error leyendo audio") }
            }
        }
    }

    fun validateForConnect(): String? {
        val c = _ui.value.config
        return when {
            c.geminiApiKey.isBlank() -> "Falta la API key de Gemini"
            c.fishApiKey.isBlank() -> "Falta la API key de Fish Audio"
            !_ui.value.hasVoiceSample -> "Falta cargar una muestra de voz"
            c.voiceTranscript.isBlank() -> "Falta la transcripción exacta de la voz"
            c.personality.isBlank() -> "La personalidad está vacía"
            else -> null
        }
    }

    fun connect() {
        validateForConnect()?.let { error ->
            _ui.update { it.copy(status = SessionStatus.ERROR, statusDetail = error, settingsOpen = true) }
            return
        }
        saveConfig()
        desiredConnected = true
        currentUserMessageId = null
        currentAiMessageId = null
        turnCompletePending = false
        turnFinalizeJob?.cancel()
        turnFinalizeJob = null
        val c = _ui.value.config
        _ui.update { it.copy(status = SessionStatus.CONNECTING, statusDetail = "Conectando…") }
        gemini.connect(GeminiLiveClient.Config(c.geminiApiKey, c.geminiModel, c.personality))
    }

    fun disconnect() {
        desiredConnected = false
        turnFinalizeJob?.cancel()
        turnFinalizeJob = null
        turnCompletePending = false
        mic.stop()
        gemini.disconnect()
        cancelFish("Desconectado")
        player.interrupt()
        finalizeCurrentMessages()
        _ui.update { it.copy(status = SessionStatus.DISCONNECTED, statusDetail = "Desconectado") }
        diag("Sesión desconectada")
    }

    private fun startMic() {
        if (!desiredConnected) return
        mic.start { pcm -> gemini.sendPcm16(pcm) }
            .onFailure {
                _ui.update { state -> state.copy(status = SessionStatus.ERROR, statusDetail = it.message ?: "Error de micrófono") }
            }
            .onSuccess { diag("Micrófono 16 kHz activo · bloques de 40 ms") }
    }

    private fun ensureFish() {
        if (fish != null) return
        val voice = store.voiceBytes() ?: return
        val c = _ui.value.config
        lateinit var client: FishTtsClient
        client = FishTtsClient(object : FishTtsClient.Listener {
            override fun onAudio(bytes: ByteArray) {
                player.write(bytes)
            }

            override fun onReady() {
                diag("Fish listo")
            }

            override fun onFinished() {
                if (fish === client) fish = null
                _ui.update { state ->
                    if (state.status == SessionStatus.SPEAKING) {
                        state.copy(status = SessionStatus.LISTENING, statusDetail = "Escuchando")
                    } else state
                }
                diag("Fish terminó el turno")
            }

            override fun onError(message: String) {
                if (fish === client) fish = null
                diag(message)
                _ui.update { state -> state.copy(statusDetail = "$message · Gemini sigue conectado") }
            }

            override fun onDiagnostic(message: String) = diag(message)
        })
        fish = client
        client.start(
            apiKey = c.fishApiKey,
            referenceAudio = voice,
            referenceTranscript = c.voiceTranscript,
            speed = c.voiceSpeed,
        )
    }

    private fun scheduleTurnSettlement() {
        turnFinalizeJob?.cancel()
        turnFinalizeJob = viewModelScope.launch {
            // Output transcription has no guaranteed ordering relative to turnComplete.
            // A short quiet window absorbs late fragments without delaying streamed speech.
            delay(800)
            fish?.finish()
            finalizeAiMessage()
            turnCompletePending = false
            turnFinalizeJob = null
            diag("Turno asentado · sigo escuchando")
        }
    }

    private fun cancelFish(reason: String) {
        fish?.cancel()
        fish = null
        player.interrupt()
        diag(reason)
    }

    private fun updateMessage(speaker: Speaker, text: String, partial: Boolean) {
        if (text.isBlank()) return
        val currentId = if (speaker == Speaker.USER) currentUserMessageId else currentAiMessageId
        if (currentId == null) {
            val id = ids.getAndIncrement()
            if (speaker == Speaker.USER) currentUserMessageId = id else currentAiMessageId = id
            _ui.update { state ->
                state.copy(messages = state.messages + ChatMessage(id, speaker, text, partial))
            }
        } else {
            _ui.update { state ->
                state.copy(messages = state.messages.map {
                    if (it.id == currentId) it.copy(text = text, isPartial = partial) else it
                })
            }
        }
    }

    private fun finalizeUserMessage() {
        val id = currentUserMessageId ?: return
        _ui.update { state ->
            state.copy(messages = state.messages.map {
                if (it.id == id) it.copy(isPartial = false) else it
            })
        }
        currentUserMessageId = null
    }

    private fun finalizeAiMessage() {
        val id = currentAiMessageId ?: return
        _ui.update { state ->
            state.copy(messages = state.messages.map {
                if (it.id == id) it.copy(isPartial = false) else it
            })
        }
        currentAiMessageId = null
    }

    private fun finalizeCurrentMessages() {
        finalizeUserMessage()
        finalizeAiMessage()
    }

    fun clearChat() {
        currentUserMessageId = null
        currentAiMessageId = null
        _ui.update { it.copy(messages = emptyList()) }
    }

    private fun diag(message: String) {
        val stamp = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
        _ui.update { state ->
            state.copy(diagnostics = (state.diagnostics + "[$stamp] $message").takeLast(80))
        }
    }

    override fun onCleared() {
        turnFinalizeJob?.cancel()
        mic.stop()
        gemini.disconnect()
        fish?.cancel()
        player.release()
        super.onCleared()
    }
}
