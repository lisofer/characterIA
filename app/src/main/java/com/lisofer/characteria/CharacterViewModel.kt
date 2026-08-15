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
import com.lisofer.characteria.storage.ProfileStore
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
import java.text.Normalizer
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

class CharacterViewModel(application: Application) : AndroidViewModel(application) {
    private enum class ConnectionPurpose { NORMAL, WAKE, BACKGROUND_ACTIVE }

    private val settings = SettingsStore(application)
    private val profiles = ProfileStore(application)
    private val mic = MicStreamer(application)
    private val player = PcmPlayer()
    private val ids = AtomicLong(1)

    private val _ui = MutableStateFlow(AppUiState())
    val ui: StateFlow<AppUiState> = _ui.asStateFlow()

    private var pendingVoiceBytes: ByteArray? = null
    private var currentUserMessageId: Long? = null
    private var currentAiMessageId: Long? = null
    private var fish: FishTtsClient? = null
    private var turnFinalizeJob: Job? = null
    private var turnCompletePending = false
    private var desiredConnected = false
    private var connectionPurpose = ConnectionPurpose.NORMAL
    private var wakeDetected = false
    private var wakeTranscript = ""
    private var pendingInvocationText: String? = null

    init {
        initializeProfiles()
    }

    private val gemini = GeminiLiveClient(viewModelScope, object : GeminiLiveClient.Listener {
        override fun onStatus(message: String) {
            val status = if (message.startsWith("Reconect")) SessionStatus.RECONNECTING else SessionStatus.CONNECTING
            _ui.update { it.copy(status = status, statusDetail = message) }
            diag(message)
        }

        override fun onReady(resumed: Boolean) {
            diag(if (resumed) "Gemini reanudado" else "Gemini listo")
            when (connectionPurpose) {
                ConnectionPurpose.WAKE -> {
                    startMic()
                    val name = _ui.value.config.profileName.ifBlank { "CharacterIA" }
                    _ui.update {
                        it.copy(
                            status = SessionStatus.INVOCATION_ARMED,
                            statusDetail = "Esperando «yo te invoco»",
                            backgroundModeEnabled = true,
                            invocationActive = false,
                        )
                    }
                    InvocationForegroundService.update(name, active = false)
                    diag("Modo invocación armado")
                }

                ConnectionPurpose.BACKGROUND_ACTIVE -> {
                    startMic()
                    val name = _ui.value.config.profileName.ifBlank { "CharacterIA" }
                    _ui.update {
                        it.copy(
                            status = SessionStatus.INVOCATION_ACTIVE,
                            statusDetail = "$name activo · escuchando",
                            backgroundModeEnabled = true,
                            invocationActive = true,
                        )
                    }
                    InvocationForegroundService.update(name, active = true)

                    pendingInvocationText?.takeIf { it.isNotBlank() }?.let { text ->
                        pendingInvocationText = null
                        ensureFish()
                        updateMessage(Speaker.USER, text, partial = false)
                        finalizeUserMessage()
                        persistConversation()
                        if (gemini.sendTextTurn(text)) {
                            diag("Frase de invocación entregada al personaje")
                        } else {
                            diag("No se pudo entregar la frase de invocación")
                        }
                    }
                }

                ConnectionPurpose.NORMAL -> {
                    startMic()
                    _ui.update { it.copy(status = SessionStatus.LISTENING, statusDetail = "Escuchando") }
                }
            }
        }

        override fun onInputTranscript(fullText: String) {
            val normalized = normalizeCommand(fullText)

            if (_ui.value.backgroundModeEnabled) {
                if (normalized.contains(RETIRE_PHRASE)) {
                    if (connectionPurpose == ConnectionPurpose.BACKGROUND_ACTIVE) {
                        updateMessage(Speaker.USER, fullText, partial = false)
                        finalizeUserMessage()
                        persistConversation()
                    }
                    stopBackgroundMode("Comando «podés retirarte» detectado")
                    return
                }

                if (connectionPurpose == ConnectionPurpose.WAKE) {
                    wakeTranscript = fullText
                    if (normalized.contains(WAKE_PHRASE)) {
                        wakeDetected = true
                        _ui.update { it.copy(statusDetail = "Invocación detectada…") }
                    }
                    return
                }
            }

            if (turnCompletePending) {
                turnFinalizeJob?.cancel()
                turnFinalizeJob = null
                turnCompletePending = false
                finalizeAiMessage()
                persistConversation()
            }

            val startingNewTurn = currentUserMessageId == null
            if (startingNewTurn) {
                if (fish != null) cancelFish("Interrupción por voz")
                ensureFish()
            }

            updateMessage(Speaker.USER, fullText, partial = true)
            _ui.update {
                if (it.backgroundModeEnabled) {
                    it.copy(
                        status = SessionStatus.INVOCATION_ACTIVE,
                        statusDetail = "${it.config.profileName.ifBlank { "CharacterIA" }} te escucha…",
                    )
                } else {
                    it.copy(status = SessionStatus.LISTENING, statusDetail = "Te escucho…")
                }
            }
        }

        override fun onOutputTranscript(delta: String, fullText: String) {
            if (connectionPurpose == ConnectionPurpose.WAKE) return

            ensureFish()
            fish?.sendText(delta)
            updateMessage(Speaker.AI, fullText, partial = true)

            if (turnCompletePending) scheduleTurnSettlement()

            _ui.update { it.copy(status = SessionStatus.SPEAKING, statusDetail = "Respondiendo") }
        }

        override fun onTurnComplete() {
            if (connectionPurpose == ConnectionPurpose.WAKE) {
                if (wakeDetected) {
                    val transcript = wakeTranscript
                    wakeDetected = false
                    wakeTranscript = ""
                    activateBackgroundCharacter(transcript)
                } else {
                    wakeTranscript = ""
                }
                return
            }

            finalizeUserMessage()
            turnCompletePending = true
            scheduleTurnSettlement()
            diag("Turno Gemini completo · esperando transcripción final")
        }

        override fun onInterrupted() {
            if (connectionPurpose == ConnectionPurpose.WAKE) return

            turnFinalizeJob?.cancel()
            turnFinalizeJob = null
            turnCompletePending = false
            cancelFish("Gemini detectó interrupción")
            finalizeCurrentMessages()
            persistConversation()
            _ui.update {
                if (it.backgroundModeEnabled) {
                    it.copy(
                        status = SessionStatus.INVOCATION_ACTIVE,
                        statusDetail = "${it.config.profileName.ifBlank { "CharacterIA" }} activo · escuchando",
                    )
                } else {
                    it.copy(status = SessionStatus.LISTENING, statusDetail = "Escuchando")
                }
            }
        }

        override fun onError(message: String) {
            diag(message)
            if (_ui.value.backgroundModeEnabled) {
                val context = getApplication<Application>()
                desiredConnected = false
                mic.stop()
                cancelFish("Modo invocación detenido por error")
                InvocationForegroundService.stop(context)
                connectionPurpose = ConnectionPurpose.NORMAL
                wakeDetected = false
                wakeTranscript = ""
                pendingInvocationText = null
                _ui.update {
                    it.copy(
                        status = SessionStatus.ERROR,
                        statusDetail = message,
                        backgroundModeEnabled = false,
                        invocationActive = false,
                    )
                }
            } else {
                _ui.update { it.copy(status = SessionStatus.ERROR, statusDetail = message) }
            }
        }

        override fun onDiagnostic(message: String) = diag(message)
    })

    private fun initializeProfiles() {
        migrateLegacyProfileIfNeeded()

        var summaries = profiles.listProfiles()
        if (summaries.isEmpty()) {
            val id = UUID.randomUUID().toString()
            val blank = AppConfig(
                profileId = id,
                profileName = "Perfil 1",
                geminiApiKey = settings.geminiKey(),
                fishApiKey = settings.fishKey(),
            )
            profiles.saveProfile(blank)
            settings.setActiveProfileId(id)
            summaries = profiles.listProfiles()
        }

        val requested = settings.activeProfileId()
        val activeId = requested.takeIf { id -> summaries.any { it.id == id } }
            ?: summaries.first().id
        loadProfileIntoUi(activeId, summaries, keepSettingsOpen = false)
    }

    private fun migrateLegacyProfileIfNeeded() {
        if (settings.profilesMigrated()) return

        if (profiles.listProfiles().isEmpty() && settings.hasLegacyProfileData()) {
            val id = UUID.randomUUID().toString()
            val legacy = settings.loadLegacy().copy(
                profileId = id,
                profileName = "Perfil 1",
            )
            profiles.saveProfile(legacy)
            settings.legacyVoiceBytes()?.let { profiles.saveVoice(id, it) }
            settings.setActiveProfileId(id)
        }

        settings.markProfilesMigrated()
    }

    private fun loadProfileIntoUi(
        profileId: String,
        summaries: List<CharacterProfileSummary> = profiles.listProfiles(),
        keepSettingsOpen: Boolean,
    ) {
        val config = profiles.loadProfile(profileId, settings.geminiKey(), settings.fishKey()) ?: return
        val chat = profiles.loadChat(profileId)
        ids.set((chat.maxOfOrNull { it.id } ?: 0L) + 1L)
        pendingVoiceBytes = null
        currentUserMessageId = null
        currentAiMessageId = null
        settings.setActiveProfileId(profileId)
        _ui.value = _ui.value.copy(
            config = config,
            profiles = summaries,
            hasVoiceSample = profiles.hasVoice(profileId),
            messages = chat,
            status = SessionStatus.DISCONNECTED,
            statusDetail = "Desconectado",
            settingsOpen = keepSettingsOpen,
            backgroundModeEnabled = false,
            invocationActive = false,
        )
        diag("Perfil cargado: ${config.profileName} · ${chat.size} mensajes guardados")
    }

    fun setSettingsOpen(open: Boolean) = _ui.update { it.copy(settingsOpen = open) }

    fun updateConfig(transform: (AppConfig) -> AppConfig) {
        _ui.update { it.copy(config = transform(it.config)) }
    }

    fun newProfile() {
        if (desiredConnected) disconnect()
        val existing = profiles.listProfiles()
        var n = existing.size + 1
        var name = "Perfil $n"
        val used = existing.map { it.name.lowercase() }.toSet()
        while (name.lowercase() in used) {
            n++
            name = "Perfil $n"
        }

        val id = UUID.randomUUID().toString()
        val config = AppConfig(
            profileId = id,
            profileName = name,
            geminiApiKey = settings.geminiKey(),
            fishApiKey = settings.fishKey(),
        )
        profiles.saveProfile(config)
        settings.setActiveProfileId(id)
        loadProfileIntoUi(id, profiles.listProfiles(), keepSettingsOpen = true)
        diag("Nuevo perfil creado: $name")
    }

    fun selectProfile(profileId: String) {
        if (profileId == _ui.value.config.profileId) return
        if (desiredConnected) disconnect()
        loadProfileIntoUi(profileId, profiles.listProfiles(), keepSettingsOpen = true)
    }

    fun saveConfig() {
        val config = _ui.value.config
        if (config.profileName.isBlank()) {
            _ui.update { it.copy(status = SessionStatus.ERROR, statusDetail = "Poné un nombre al perfil") }
            return
        }

        settings.saveGlobalKeys(config.geminiApiKey, config.fishApiKey)
        profiles.saveProfile(config)
        pendingVoiceBytes?.let { bytes -> profiles.saveVoice(config.profileId, bytes) }
        pendingVoiceBytes = null
        settings.setActiveProfileId(config.profileId)

        _ui.update {
            it.copy(
                profiles = profiles.listProfiles(),
                hasVoiceSample = profiles.hasVoice(config.profileId),
                settingsOpen = false,
            )
        }
        diag("Perfil guardado: ${config.profileName}")
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

                pendingVoiceBytes = bytes
                _ui.update {
                    it.copy(
                        hasVoiceSample = true,
                        config = it.config.copy(voiceName = name),
                    )
                }
                diag("Muestra preparada para este perfil: $name (${bytes.size / 1024} KB)")
            }.onFailure {
                _ui.update { state -> state.copy(status = SessionStatus.ERROR, statusDetail = it.message ?: "Error leyendo audio") }
            }
        }
    }

    fun validateForConnect(): String? {
        val c = _ui.value.config
        return when {
            c.profileName.isBlank() -> "Poné un nombre al perfil"
            c.geminiApiKey.isBlank() -> "Falta la API key de Gemini"
            c.fishApiKey.isBlank() -> "Falta la API key de Fish Audio"
            !_ui.value.hasVoiceSample -> "Falta cargar una muestra de voz"
            c.voiceTranscript.isBlank() -> "Falta la transcripción exacta de la voz"
            else -> null
        }
    }

    fun connect() {
        validateForConnect()?.let { error ->
            _ui.update { it.copy(status = SessionStatus.ERROR, statusDetail = error, settingsOpen = true) }
            return
        }
        if (_ui.value.backgroundModeEnabled) stopBackgroundMode("Cambio a sesión normal")

        saveConfig()
        desiredConnected = true
        connectionPurpose = ConnectionPurpose.NORMAL
        currentUserMessageId = null
        currentAiMessageId = null
        turnCompletePending = false
        turnFinalizeJob?.cancel()
        turnFinalizeJob = null

        val c = _ui.value.config
        val history = historyForGemini(_ui.value.messages)
        _ui.update {
            it.copy(
                status = SessionStatus.CONNECTING,
                statusDetail = "Conectando…",
                backgroundModeEnabled = false,
                invocationActive = false,
            )
        }
        gemini.connect(
            GeminiLiveClient.Config(
                apiKey = c.geminiApiKey,
                model = c.geminiModel,
                personality = c.personality,
                history = history,
            )
        )
        diag("Memoria de ${c.profileName}: ${history.size} mensajes enviados a Gemini")
    }

    fun toggleBackgroundMode() {
        if (_ui.value.backgroundModeEnabled) {
            stopBackgroundMode("Modo invocación apagado desde la app")
        } else {
            startBackgroundMode()
        }
    }

    private fun startBackgroundMode() {
        validateForConnect()?.let { error ->
            _ui.update { it.copy(status = SessionStatus.ERROR, statusDetail = error, settingsOpen = true) }
            return
        }

        if (desiredConnected) disconnectNormalSession("Cambiando a modo invocación")
        saveConfig()

        val c = _ui.value.config
        val context = getApplication<Application>()
        runCatching {
            InvocationForegroundService.start(context, c.profileName, active = false)
        }.onFailure { error ->
            _ui.update {
                it.copy(
                    status = SessionStatus.ERROR,
                    statusDetail = "No se pudo activar el modo invocación: ${error.message}",
                )
            }
            diag("Foreground service: ${error::class.simpleName}: ${error.message}")
            return
        }

        desiredConnected = true
        connectionPurpose = ConnectionPurpose.WAKE
        wakeDetected = false
        wakeTranscript = ""
        pendingInvocationText = null
        currentUserMessageId = null
        currentAiMessageId = null
        turnCompletePending = false
        turnFinalizeJob?.cancel()
        turnFinalizeJob = null

        _ui.update {
            it.copy(
                status = SessionStatus.CONNECTING,
                statusDetail = "Armando modo invocación…",
                backgroundModeEnabled = true,
                invocationActive = false,
            )
        }

        gemini.connect(
            GeminiLiveClient.Config(
                apiKey = c.geminiApiKey,
                model = c.geminiModel,
                personality = WAKE_SYSTEM_PROMPT,
                history = emptyList(),
            )
        )
    }

    private fun activateBackgroundCharacter(triggerText: String) {
        if (!_ui.value.backgroundModeEnabled || connectionPurpose != ConnectionPurpose.WAKE) return

        val c = _ui.value.config
        val history = historyForGemini(_ui.value.messages)
        mic.stop()
        gemini.disconnect()
        connectionPurpose = ConnectionPurpose.BACKGROUND_ACTIVE
        pendingInvocationText = triggerText
        wakeDetected = false
        wakeTranscript = ""

        _ui.update {
            it.copy(
                status = SessionStatus.CONNECTING,
                statusDetail = "Invocando a ${c.profileName.ifBlank { "CharacterIA" }}…",
                invocationActive = true,
            )
        }
        InvocationForegroundService.update(c.profileName.ifBlank { "CharacterIA" }, active = true)

        gemini.connect(
            GeminiLiveClient.Config(
                apiKey = c.geminiApiKey,
                model = c.geminiModel,
                personality = c.personality,
                history = history,
            )
        )
        diag("Invocación confirmada · memoria cargada (${history.size} mensajes)")
    }

    private fun stopBackgroundMode(reason: String) {
        val context = getApplication<Application>()
        desiredConnected = false
        turnFinalizeJob?.cancel()
        turnFinalizeJob = null
        turnCompletePending = false
        mic.stop()
        gemini.disconnect()
        cancelFish(reason)
        player.interrupt()
        finalizeCurrentMessages()
        persistConversation()
        InvocationForegroundService.stop(context)
        connectionPurpose = ConnectionPurpose.NORMAL
        wakeDetected = false
        wakeTranscript = ""
        pendingInvocationText = null
        _ui.update {
            it.copy(
                status = SessionStatus.DISCONNECTED,
                statusDetail = "Modo invocación apagado",
                backgroundModeEnabled = false,
                invocationActive = false,
            )
        }
        diag(reason)
    }

    fun disconnect() {
        if (_ui.value.backgroundModeEnabled) {
            stopBackgroundMode("Modo invocación apagado")
            return
        }
        disconnectNormalSession("Sesión desconectada")
    }

    private fun disconnectNormalSession(detail: String) {
        desiredConnected = false
        turnFinalizeJob?.cancel()
        turnFinalizeJob = null
        turnCompletePending = false
        mic.stop()
        gemini.disconnect()
        cancelFish(detail)
        player.interrupt()
        finalizeCurrentMessages()
        persistConversation()
        connectionPurpose = ConnectionPurpose.NORMAL
        _ui.update {
            it.copy(
                status = SessionStatus.DISCONNECTED,
                statusDetail = "Desconectado",
                backgroundModeEnabled = false,
                invocationActive = false,
            )
        }
        diag(detail)
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
        if (fish != null || connectionPurpose == ConnectionPurpose.WAKE) return
        val profileId = _ui.value.config.profileId
        val voice = pendingVoiceBytes ?: profiles.voiceBytes(profileId) ?: return
        val c = _ui.value.config
        lateinit var client: FishTtsClient
        client = FishTtsClient(object : FishTtsClient.Listener {
            override fun onAudio(bytes: ByteArray) {
                player.write(bytes)
            }

            override fun onReady() {
                diag("Fish listo · TTS precargado")
            }

            override fun onFinished() {
                if (fish === client) fish = null
                _ui.update { state ->
                    if (state.status == SessionStatus.SPEAKING) {
                        if (state.backgroundModeEnabled && state.invocationActive) {
                            state.copy(
                                status = SessionStatus.INVOCATION_ACTIVE,
                                statusDetail = "${state.config.profileName.ifBlank { "CharacterIA" }} activo · escuchando",
                            )
                        } else {
                            state.copy(status = SessionStatus.LISTENING, statusDetail = "Escuchando")
                        }
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
            delay(800)
            fish?.finish()
            finalizeAiMessage()
            turnCompletePending = false
            turnFinalizeJob = null
            persistConversation()
            diag("Turno asentado · chat guardado · sigo escuchando")
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

    private fun persistConversation() {
        val state = _ui.value
        val id = state.config.profileId
        if (id.isBlank()) return
        val stable = state.messages.map { it.copy(isPartial = false) }
        profiles.saveChat(id, stable)
        val history = historyForGemini(stable)
        gemini.updateHistory(history)
    }

    private fun historyForGemini(messages: List<ChatMessage>): List<GeminiLiveClient.HistoryTurn> {
        val stable = messages.filter { !it.isPartial && it.text.isNotBlank() }
        if (stable.isEmpty()) return emptyList()

        val selected = ArrayDeque<ChatMessage>()
        var chars = 0
        for (message in stable.asReversed()) {
            if (selected.size >= 100) break
            if (chars + message.text.length > 50_000 && selected.isNotEmpty()) break
            selected.addFirst(message)
            chars += message.text.length
        }
        return selected.map { message ->
            GeminiLiveClient.HistoryTurn(
                role = if (message.speaker == Speaker.USER) "user" else "model",
                text = message.text,
            )
        }
    }

    fun clearChat() {
        if (desiredConnected) disconnect()
        currentUserMessageId = null
        currentAiMessageId = null
        turnCompletePending = false
        turnFinalizeJob?.cancel()
        turnFinalizeJob = null
        val profileId = _ui.value.config.profileId
        profiles.clearChat(profileId)
        gemini.updateHistory(emptyList())
        _ui.update {
            it.copy(
                messages = emptyList(),
                status = SessionStatus.DISCONNECTED,
                statusDetail = "Chat borrado",
                backgroundModeEnabled = false,
                invocationActive = false,
            )
        }
        diag("Chat del perfil borrado")
    }

    private fun normalizeCommand(text: String): String {
        val normalized = Normalizer.normalize(text.lowercase(Locale.ROOT), Normalizer.Form.NFD)
        return normalized
            .replace("\\p{M}+".toRegex(), "")
            .replace("[^a-z0-9ñ ]".toRegex(), " ")
            .replace("\\s+".toRegex(), " ")
            .trim()
    }

    private fun diag(message: String) {
        val stamp = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
        _ui.update { state ->
            state.copy(diagnostics = (state.diagnostics + "[$stamp] $message").takeLast(100))
        }
    }

    override fun onCleared() {
        turnFinalizeJob?.cancel()
        finalizeCurrentMessages()
        persistConversation()
        mic.stop()
        gemini.disconnect()
        fish?.cancel()
        InvocationForegroundService.stop(getApplication())
        player.release()
        super.onCleared()
    }

    companion object {
        private const val WAKE_PHRASE = "yo te invoco"
        private const val RETIRE_PHRASE = "podes retirarte"
        private const val WAKE_SYSTEM_PROMPT = """Sos un detector silencioso de una frase de activación. No converses, no respondas y no intentes ayudar. Tu única tarea es escuchar el audio para que la transcripción de entrada permita detectar la frase «yo te invoco». Aunque escuches preguntas o conversaciones, permanecé en silencio."""
    }
}
