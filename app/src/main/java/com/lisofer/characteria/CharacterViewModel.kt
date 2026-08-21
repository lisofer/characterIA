package com.lisofer.characteria

import android.app.Application
import android.net.Uri
import android.os.SystemClock
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
import java.io.ByteArrayOutputStream
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
    private var fishProfileId: String? = null
    private var turnFinalizeJob: Job? = null
    private var turnCompletePending = false
    private var desiredConnected = false
    private var connectionPurpose = ConnectionPurpose.NORMAL

    private var manualConnectRequested = false
    private var manualInputMode = false
    private var pushToTalkPressed = false
    private var pendingTypedText: String? = null
    private val pttAudioLock = Any()
    private val pttAudioBuffer = ByteArrayOutputStream()
    @Volatile private var pttBuffering = false
    private var pendingPttEnd = false

    private var pendingInvocationProfileIds: List<String>? = null
    private var activeBackgroundProfileIds: List<String> = emptyList()
    private var conversationProfileIds: List<String> = emptyList()
    private var ignoreInvocationCommandsUntilMs: Long = 0L
    private var invocationConnectStartedAtMs: Long = 0L

    private data class GroupSegment(val speakerId: String, val text: String)

    private var groupLastSpeakerId: String? = null
    private var groupLikelySpeakerId: String? = null
    private var groupParsedSegments: List<GroupSegment> = emptyList()
    private val groupSegmentMessageIds = mutableListOf<Long>()
    private var groupTtsSegmentIndex = 0
    private var groupTtsSentText = ""
    private var groupTtsFinishing = false
    private var groupModelTurnComplete = false

    init {
        initializeProfiles()
    }

    private val gemini: GeminiLiveClient = GeminiLiveClient(viewModelScope, object : GeminiLiveClient.Listener {
        override fun onStatus(message: String) {
            val reconnecting = message.startsWith("Reconect") || message.startsWith("Renovando")
            _ui.update {
                it.copy(
                    status = if (reconnecting) SessionStatus.RECONNECTING else SessionStatus.CONNECTING,
                    statusDetail = message,
                )
            }
            if (manualInputMode && reconnecting && pushToTalkPressed) {
                pttBuffering = true
            }
            diag(message)
        }

        override fun onReady(resumed: Boolean) {
            diag(if (resumed) "Gemini reanudado sin perder contexto" else "Gemini listo")
            when (connectionPurpose) {
                ConnectionPurpose.WAKE -> {
                    startMic()
                    _ui.update {
                        it.copy(
                            status = SessionStatus.INVOCATION_ARMED,
                            statusDetail = "Esperando «[personaje], are you here?»",
                            backgroundModeEnabled = true,
                            invocationActive = false,
                            activeCharacterNames = emptyList(),
                        )
                    }
                    InvocationForegroundService.update("CharacterIA", active = false)
                    diag("Modo invocación armado")
                }

                ConnectionPurpose.BACKGROUND_ACTIVE -> {
                    startMic()
                    val name = activeDisplayName()
                    val startedAt = invocationConnectStartedAtMs
                    if (startedAt > 0L) {
                        diag("Invocación lista en ${SystemClock.elapsedRealtime() - startedAt} ms · $name")
                        invocationConnectStartedAtMs = 0L
                    }
                    _ui.update {
                        it.copy(
                            status = SessionStatus.INVOCATION_ACTIVE,
                            statusDetail = "$name activo · escuchando",
                            backgroundModeEnabled = true,
                            invocationActive = true,
                        )
                    }
                    InvocationForegroundService.update(name, active = true)
                }

                ConnectionPurpose.NORMAL -> {
                    if (manualInputMode) {
                        pttBuffering = false
                        flushBufferedPttAudio()
                        when {
                            pendingPttEnd -> {
                                pendingPttEnd = false
                                gemini.endAudioStream()
                                _ui.update { it.copy(status = SessionStatus.THINKING, statusDetail = "Procesando tu audio…") }
                            }
                            pushToTalkPressed -> {
                                startManualMic()
                                _ui.update { it.copy(status = SessionStatus.LISTENING, statusDetail = "Mantené apretado · escuchando") }
                            }
                            else -> {
                                mic.stop()
                                _ui.update { it.copy(status = SessionStatus.LISTENING, statusDetail = "Conectado · micrófono cerrado") }
                            }
                        }
                        sendPendingTypedTextIfPossible()
                    } else {
                        startMic()
                        _ui.update { it.copy(status = SessionStatus.LISTENING, statusDetail = "Escuchando") }
                    }
                }
            }
        }

        override fun onModelChanged(model: String, reason: String) {
            settings.setActiveGeminiModel(model)
            _ui.update { state ->
                state.copy(
                    activeGeminiModel = model,
                    status = SessionStatus.CONNECTING,
                    statusDetail = "Cambiando automáticamente a $model…",
                )
            }
            diag("Fallback temporal: modelo activo $model · preferido ${settings.geminiModel()} · $reason")
        }

        override fun onInputTranscript(fullText: String) {
            val normalized = normalizeCommand(fullText)

            if (_ui.value.backgroundModeEnabled) {
                if (connectionPurpose == ConnectionPurpose.BACKGROUND_ACTIVE && normalized.contains(EXIT_PHRASE)) {
                    discardCurrentUserMessage()
                    returnToWakeMode("Comando «get out» detectado")
                    return
                }

                val targetProfiles = findInvocationProfiles(normalized)
                if (targetProfiles.isNotEmpty()) {
                    discardCurrentUserMessage()
                    if (
                        connectionPurpose == ConnectionPurpose.BACKGROUND_ACTIVE &&
                        SystemClock.elapsedRealtime() < ignoreInvocationCommandsUntilMs
                    ) {
                        diag("Invocación residual ignorada al abrir la conversación")
                        return
                    }
                    val targetIds = targetProfiles.map { it.id }
                    val targetName = targetProfiles.joinToString(" + ") { it.name }
                    if (connectionPurpose == ConnectionPurpose.WAKE) {
                        pendingInvocationProfileIds = null
                        invocationConnectStartedAtMs = SystemClock.elapsedRealtime()
                        _ui.update { it.copy(statusDetail = "Invocando a $targetName…") }
                        diag("Invocación reconocida · conectando sin esperar turnComplete")
                        activateBackgroundCharacters(targetIds)
                    } else if (connectionPurpose == ConnectionPurpose.BACKGROUND_ACTIVE) {
                        pendingInvocationProfileIds = null
                        invocationConnectStartedAtMs = SystemClock.elapsedRealtime()
                        activateBackgroundCharacters(targetIds)
                    }
                    return
                }

                if (connectionPurpose == ConnectionPurpose.WAKE) return
            }

            if (turnCompletePending) {
                turnFinalizeJob?.cancel()
                turnFinalizeJob = null
                turnCompletePending = false
                finalizeAiMessage()
                resetGroupOutput()
                persistConversation()
            }

            if (isGroupMode()) {
                addressedGroupProfile(normalized)?.let { addressed ->
                    if (currentAiMessageId == null && addressed.id != groupLikelySpeakerId) {
                        groupLikelySpeakerId = addressed.id
                        if (fish != null && fishProfileId != addressed.id) cancelFish("Preparando voz de ${addressed.name}")
                        ensureFish(addressed.id)
                    }
                }
            }

            val startingNewTurn = currentUserMessageId == null
            if (startingNewTurn) {
                if (fish != null) cancelFish("Interrupción por voz")
                if (isGroupMode()) {
                    resetGroupOutput(keepLastSpeaker = true)
                    groupLikelySpeakerId = addressedGroupProfile(normalized)?.id
                        ?: groupLastSpeakerId
                        ?: activeBackgroundProfileIds.firstOrNull()
                    groupLikelySpeakerId?.let(::ensureFish)
                } else {
                    ensureFish()
                }
            }

            updateMessage(Speaker.USER, fullText, partial = true)
            _ui.update {
                if (it.backgroundModeEnabled) {
                    it.copy(
                        status = SessionStatus.INVOCATION_ACTIVE,
                        statusDetail = "${activeDisplayName()} te escucha…",
                    )
                } else {
                    it.copy(status = SessionStatus.LISTENING, statusDetail = "Te escucho…")
                }
            }
        }

        override fun onOutputTranscript(delta: String, fullText: String) {
            if (connectionPurpose == ConnectionPurpose.WAKE) return

            if (isGroupMode()) {
                handleGroupOutput(fullText)
            } else {
                ensureFish()
                fish?.sendText(delta)
                val c = _ui.value.config
                updateMessage(
                    Speaker.AI,
                    fullText,
                    partial = true,
                    characterProfileId = c.profileId,
                    characterName = c.profileName,
                )
            }

            if (turnCompletePending) scheduleTurnSettlement()
            _ui.update { it.copy(status = SessionStatus.SPEAKING, statusDetail = "Respondiendo") }
        }

        override fun onTurnComplete() {
            if (connectionPurpose == ConnectionPurpose.WAKE) {
                val targetIds = pendingInvocationProfileIds
                if (!targetIds.isNullOrEmpty()) {
                    pendingInvocationProfileIds = null
                    activateBackgroundCharacters(targetIds)
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
            resetGroupOutput()
            persistConversation()
            _ui.update {
                if (it.backgroundModeEnabled) {
                    it.copy(
                        status = SessionStatus.INVOCATION_ACTIVE,
                        statusDetail = "${activeDisplayName()} activo · escuchando",
                    )
                } else if (manualInputMode && !pushToTalkPressed) {
                    it.copy(status = SessionStatus.LISTENING, statusDetail = "Conectado · micrófono cerrado")
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
                pendingInvocationProfileIds = null
                activeBackgroundProfileIds = emptyList()
                resetGroupOutput()
                _ui.update {
                    it.copy(
                        status = SessionStatus.ERROR,
                        statusDetail = message,
                        backgroundModeEnabled = false,
                        invocationActive = false,
                        activeCharacterNames = emptyList(),
                    )
                }
            } else {
                mic.stop()
                pushToTalkPressed = false
                pttBuffering = false
                pendingPttEnd = false
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
                geminiModel = settings.geminiModel(),
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
        val config = profiles.loadProfile(profileId, settings.geminiKey(), settings.fishKey(), settings.geminiModel()) ?: return
        val chat = profiles.loadChat(profileId)
        ids.set((chat.maxOfOrNull { it.id } ?: 0L) + 1L)
        pendingVoiceBytes = null
        currentUserMessageId = null
        currentAiMessageId = null
        conversationProfileIds = listOf(profileId)
        activeBackgroundProfileIds = emptyList()
        settings.setActiveProfileId(profileId)
        resetManualInputState()
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
            activeCharacterNames = emptyList(),
            activeGeminiModel = settings.activeGeminiModel(),
        )
        diag("Perfil cargado: ${config.profileName} · ${chat.size} mensajes guardados · Gemini activo ${settings.activeGeminiModel()}")
    }

    fun setSettingsOpen(open: Boolean) = _ui.update { it.copy(settingsOpen = open) }

    fun updateConfig(transform: (AppConfig) -> AppConfig) {
        _ui.update { it.copy(config = transform(it.config)) }
    }

    fun selectGeminiModel(model: String) {
        val selected = normalizeGeminiModel(model)
        settings.setGeminiModel(selected)
        resetRuntimeForConnectionChange("Modelo Gemini cambiado")
        _ui.update { state ->
            state.copy(
                config = state.config.copy(geminiModel = selected),
                activeGeminiModel = selected,
                statusDetail = if (state.status == SessionStatus.DISCONNECTED) "Modelo preferido: $selected" else state.statusDetail,
            )
        }
        diag("Modelo global preferido y activo seleccionado: $selected")
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
            geminiModel = settings.geminiModel(),
        )
        profiles.saveProfile(config)
        settings.setActiveProfileId(id)
        loadProfileIntoUi(id, profiles.listProfiles(), keepSettingsOpen = true)
        diag("Nuevo perfil creado: $name")
    }

    fun selectProfile(profileId: String) {
        if (profileId == _ui.value.config.profileId && conversationProfileIds.size == 1) return
        if (desiredConnected) disconnect()
        loadProfileIntoUi(profileId, profiles.listProfiles(), keepSettingsOpen = true)
    }

    fun saveConfig() {
        val config = _ui.value.config
        if (config.profileName.isBlank()) {
            _ui.update { it.copy(status = SessionStatus.ERROR, statusDetail = "Poné un nombre al perfil") }
            return
        }

        val geminiKeyChanged = settings.saveGlobalConnection(
            config.geminiApiKey,
            config.fishApiKey,
            config.geminiModel,
        )
        if (geminiKeyChanged) {
            resetRuntimeForConnectionChange("API key de Gemini actualizada")
            diag("API Gemini nueva · sesión anterior descartada · vuelvo al modelo preferido ${settings.geminiModel()}")
        }
        profiles.saveProfile(config)
        pendingVoiceBytes?.let { bytes -> profiles.saveVoice(config.profileId, bytes) }
        pendingVoiceBytes = null
        settings.setActiveProfileId(config.profileId)

        _ui.update {
            it.copy(
                profiles = profiles.listProfiles(),
                hasVoiceSample = profiles.hasVoice(config.profileId),
                settingsOpen = false,
                activeGeminiModel = settings.activeGeminiModel(),
                status = if (geminiKeyChanged) SessionStatus.DISCONNECTED else it.status,
                statusDetail = if (geminiKeyChanged) {
                    "API Gemini actualizada · listo con ${settings.activeGeminiModel()}"
                } else it.statusDetail,
            )
        }
        diag("Perfil guardado: ${config.profileName}")
    }

    private fun resetRuntimeForConnectionChange(reason: String) {
        if (!desiredConnected && !_ui.value.backgroundModeEnabled) return

        turnFinalizeJob?.cancel()
        turnFinalizeJob = null
        turnCompletePending = false
        finalizeCurrentMessages()
        persistConversation()
        desiredConnected = false
        mic.stop()
        gemini.disconnect()
        cancelFish(reason)
        player.interrupt()
        InvocationForegroundService.stop(getApplication())
        connectionPurpose = ConnectionPurpose.NORMAL
        pendingInvocationProfileIds = null
        activeBackgroundProfileIds = emptyList()
        resetGroupOutput()
        resetManualInputState()
        _ui.update { state ->
            state.copy(
                status = SessionStatus.DISCONNECTED,
                statusDetail = reason,
                backgroundModeEnabled = false,
                invocationActive = false,
                activeCharacterNames = emptyList(),
            )
        }
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
        val requestedManualMode = manualConnectRequested
        manualConnectRequested = false
        validateForConnect()?.let { error ->
            _ui.update { it.copy(status = SessionStatus.ERROR, statusDetail = error, settingsOpen = true) }
            return
        }
        if (_ui.value.backgroundModeEnabled) stopBackgroundMode("Cambio a sesión normal")

        saveConfig()
        desiredConnected = true
        connectionPurpose = ConnectionPurpose.NORMAL
        manualInputMode = requestedManualMode
        if (!manualInputMode) {
            pushToTalkPressed = false
            pendingTypedText = null
            pendingPttEnd = false
            pttBuffering = false
            resetPttAudioBuffer()
        }
        activeBackgroundProfileIds = emptyList()
        conversationProfileIds = listOf(_ui.value.config.profileId)
        currentUserMessageId = null
        currentAiMessageId = null
        turnCompletePending = false
        turnFinalizeJob?.cancel()
        turnFinalizeJob = null
        resetGroupOutput()

        val c = _ui.value.config
        val activeModel = settings.activeGeminiModel()
        val history = historyForSingle(_ui.value.messages, c.profileId)
        _ui.update {
            it.copy(
                status = SessionStatus.CONNECTING,
                statusDetail = if (manualInputMode) "Conectando entrada manual…" else "Conectando…",
                backgroundModeEnabled = false,
                invocationActive = false,
                activeCharacterNames = emptyList(),
            )
        }
        gemini.connect(
            GeminiLiveClient.Config(
                apiKey = c.geminiApiKey,
                model = activeModel,
                personality = c.personality,
                history = history,
                fallbackModels = geminiFallbackChain(activeModel),
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
        val armError = when {
            _ui.value.config.geminiApiKey.isBlank() -> "Falta la API key de Gemini"
            _ui.value.profiles.isEmpty() -> "No hay perfiles para invocar"
            else -> null
        }
        armError?.let { error ->
            _ui.update { it.copy(status = SessionStatus.ERROR, statusDetail = error, settingsOpen = true) }
            return
        }

        if (desiredConnected) disconnectNormalSession("Cambiando a modo invocación")
        saveConfig()

        val c = _ui.value.config
        val activeModel = settings.activeGeminiModel()
        val context = getApplication<Application>()
        runCatching {
            InvocationForegroundService.start(context, "CharacterIA", active = false)
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
        resetManualInputState()
        activeBackgroundProfileIds = emptyList()
        pendingInvocationProfileIds = null
        ignoreInvocationCommandsUntilMs = 0L
        currentUserMessageId = null
        currentAiMessageId = null
        turnCompletePending = false
        turnFinalizeJob?.cancel()
        turnFinalizeJob = null
        resetGroupOutput()

        _ui.update {
            it.copy(
                status = SessionStatus.CONNECTING,
                statusDetail = "Armando modo invocación…",
                backgroundModeEnabled = true,
                invocationActive = false,
                activeCharacterNames = emptyList(),
            )
        }

        gemini.connect(
            GeminiLiveClient.Config(
                apiKey = c.geminiApiKey,
                model = activeModel,
                personality = WAKE_SYSTEM_PROMPT,
                history = emptyList(),
                fallbackModels = geminiFallbackChain(activeModel),
            )
        )
    }

    private fun activateBackgroundCharacters(requestedIds: List<String>) {
        if (!_ui.value.backgroundModeEnabled) return
        val targetIds = requestedIds.distinct().sorted().take(2)
        if (targetIds.isEmpty()) return

        val targetConfigs = targetIds.mapNotNull { id ->
            profiles.loadProfile(id, settings.geminiKey(), settings.fishKey(), settings.geminiModel())
        }
        if (targetConfigs.size != targetIds.size) {
            diag("No se pudieron cargar todos los perfiles invocados")
            return
        }

        val validationError = targetConfigs.firstNotNullOfOrNull { c ->
            when {
                c.profileName.isBlank() -> "Hay un perfil sin nombre"
                c.geminiApiKey.isBlank() -> "Falta la API key de Gemini"
                c.fishApiKey.isBlank() -> "Falta la API key de Fish Audio"
                !profiles.hasVoice(c.profileId) -> "${c.profileName} no tiene muestra de voz"
                c.voiceTranscript.isBlank() -> "${c.profileName} no tiene transcripción de voz"
                else -> null
            }
        }
        if (validationError != null) {
            _ui.update { it.copy(statusDetail = validationError) }
            diag(validationError)
            return
        }

        if (connectionPurpose == ConnectionPurpose.BACKGROUND_ACTIVE) {
            finalizeCurrentMessages()
            persistConversation()
        }

        turnFinalizeJob?.cancel()
        turnFinalizeJob = null
        turnCompletePending = false
        // Keep AudioRecord alive across invocation switches. Gemini drops PCM while setupComplete=false.
        gemini.disconnect()
        cancelFish("Cambio de personaje")
        player.interrupt()

        val first = targetConfigs.first()
        val isGroup = targetConfigs.size == 2
        val targetChat = if (isGroup) profiles.loadGroupChat(targetIds) else profiles.loadChat(first.profileId)
        ids.set((targetChat.maxOfOrNull { it.id } ?: 0L) + 1L)
        pendingVoiceBytes = null
        currentUserMessageId = null
        currentAiMessageId = null
        pendingInvocationProfileIds = null
        activeBackgroundProfileIds = targetIds
        conversationProfileIds = targetIds
        connectionPurpose = ConnectionPurpose.BACKGROUND_ACTIVE
        ignoreInvocationCommandsUntilMs = SystemClock.elapsedRealtime() + 1500L
        groupLastSpeakerId = if (isGroup) {
            targetChat.lastOrNull { it.speaker == Speaker.AI && it.characterProfileId in targetIds }?.characterProfileId
        } else null
        resetGroupOutput(keepLastSpeaker = true)
        settings.setActiveProfileId(first.profileId)

        val names = targetConfigs.map { it.profileName }
        val displayName = names.joinToString(" + ")
        _ui.update {
            it.copy(
                config = first,
                profiles = profiles.listProfiles(),
                hasVoiceSample = profiles.hasVoice(first.profileId),
                messages = targetChat,
                status = SessionStatus.CONNECTING,
                statusDetail = "Invocando a $displayName…",
                backgroundModeEnabled = true,
                invocationActive = true,
                activeCharacterNames = names,
                settingsOpen = false,
            )
        }
        InvocationForegroundService.update(displayName, active = true)

        val personality = if (isGroup) buildGroupPersonality(targetConfigs) else first.personality
        val history = if (isGroup) historyForGroup(targetChat) else historyForSingle(targetChat, first.profileId)
        val activeModel = settings.activeGeminiModel()
        gemini.connect(
            GeminiLiveClient.Config(
                apiKey = first.geminiApiKey,
                model = activeModel,
                personality = personality,
                history = history,
                fallbackModels = geminiFallbackChain(activeModel),
            )
        )
        diag("Invocación: $displayName · memoria compartida ${history.size} mensajes")
    }

    private fun returnToWakeMode(reason: String) {
        if (!_ui.value.backgroundModeEnabled) return

        turnFinalizeJob?.cancel()
        turnFinalizeJob = null
        turnCompletePending = false
        discardCurrentUserMessage()
        finalizeAiMessage()
        persistConversation()
        // Keep the same microphone capture alive while returning to the wake Gemini session.
        gemini.disconnect()
        cancelFish(reason)
        player.interrupt()

        connectionPurpose = ConnectionPurpose.WAKE
        activeBackgroundProfileIds = emptyList()
        pendingInvocationProfileIds = null
        currentUserMessageId = null
        currentAiMessageId = null
        resetGroupOutput()

        _ui.update {
            it.copy(
                status = SessionStatus.CONNECTING,
                statusDetail = "Cerrando conversación…",
                backgroundModeEnabled = true,
                invocationActive = false,
                activeCharacterNames = emptyList(),
            )
        }
        InvocationForegroundService.update("CharacterIA", active = false)

        val c = _ui.value.config
        val activeModel = settings.activeGeminiModel()
        gemini.connect(
            GeminiLiveClient.Config(
                apiKey = c.geminiApiKey,
                model = activeModel,
                personality = WAKE_SYSTEM_PROMPT,
                history = emptyList(),
                fallbackModels = geminiFallbackChain(activeModel),
            )
        )
        diag("$reason · vuelvo a esperar una invocación")
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
        activeBackgroundProfileIds = emptyList()
        pendingInvocationProfileIds = null
        resetGroupOutput()
        resetManualInputState()
        _ui.update {
            it.copy(
                status = SessionStatus.DISCONNECTED,
                statusDetail = "Modo invocación apagado",
                backgroundModeEnabled = false,
                invocationActive = false,
                activeCharacterNames = emptyList(),
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
        activeBackgroundProfileIds = emptyList()
        resetGroupOutput()
        resetManualInputState()
        _ui.update {
            it.copy(
                status = SessionStatus.DISCONNECTED,
                statusDetail = "Desconectado",
                backgroundModeEnabled = false,
                invocationActive = false,
                activeCharacterNames = emptyList(),
            )
        }
        diag(detail)
    }

    fun sendText(text: String) {
        val value = text.trim()
        if (value.isBlank()) return

        if (_ui.value.backgroundModeEnabled) {
            stopBackgroundMode("Cambio a entrada por teclado")
        }

        manualInputMode = true
        pushToTalkPressed = false
        pendingPttEnd = false
        pttBuffering = false
        resetPttAudioBuffer()
        mic.stop()

        if (!desiredConnected || _ui.value.status == SessionStatus.DISCONNECTED || _ui.value.status == SessionStatus.ERROR) {
            pendingTypedText = value
            manualConnectRequested = true
            connect()
            return
        }

        gemini.endAudioStream()
        pendingTypedText = value
        sendPendingTypedTextIfPossible()
    }

    fun startPushToTalk() {
        if (_ui.value.backgroundModeEnabled) {
            stopBackgroundMode("Cambio a pulsar para hablar")
        }

        if (validateForConnect() != null) {
            manualConnectRequested = true
            connect()
            return
        }

        finalizeCurrentMessages()
        persistConversation()
        if (fish != null) cancelFish("Interrupción por pulsar para hablar")
        player.interrupt()

        manualInputMode = true
        pushToTalkPressed = true
        pendingTypedText = null
        pendingPttEnd = false
        resetPttAudioBuffer()
        mic.stop()

        val needsConnection = !desiredConnected ||
            _ui.value.status == SessionStatus.DISCONNECTED ||
            _ui.value.status == SessionStatus.ERROR

        if (needsConnection) {
            pttBuffering = true
            manualConnectRequested = true
            connect()
            if (_ui.value.status == SessionStatus.ERROR) {
                pushToTalkPressed = false
                pttBuffering = false
                return
            }
        } else {
            pttBuffering = _ui.value.status == SessionStatus.CONNECTING ||
                _ui.value.status == SessionStatus.RECONNECTING
        }

        startManualMic()
        _ui.update {
            it.copy(
                status = if (pttBuffering) SessionStatus.CONNECTING else SessionStatus.LISTENING,
                statusDetail = if (pttBuffering) "Conectando · seguí apretando…" else "Mantené apretado · escuchando",
            )
        }
    }

    fun stopPushToTalk() {
        if (!pushToTalkPressed) return
        pushToTalkPressed = false
        mic.stop()

        if (pttBuffering) {
            pendingPttEnd = true
            _ui.update { it.copy(status = SessionStatus.CONNECTING, statusDetail = "Enviando tu audio…") }
        } else {
            gemini.endAudioStream()
            _ui.update { it.copy(status = SessionStatus.THINKING, statusDetail = "Procesando tu audio…") }
        }
    }

    private fun sendPendingTypedTextIfPossible() {
        val text = pendingTypedText ?: return
        if (_ui.value.status == SessionStatus.CONNECTING || _ui.value.status == SessionStatus.RECONNECTING) return
        if (sendTypedTextNow(text)) pendingTypedText = null
    }

    private fun sendTypedTextNow(text: String): Boolean {
        if (fish != null) cancelFish("Interrupción por texto")
        player.interrupt()
        finalizeCurrentMessages()
        persistConversation()

        val sent = gemini.sendText(text)
        if (!sent) return false

        updateMessage(Speaker.USER, text, partial = false)
        finalizeUserMessage()
        persistConversation()
        _ui.update { it.copy(status = SessionStatus.THINKING, statusDetail = "Pensando…") }
        diag("Mensaje de texto enviado")
        return true
    }

    private fun startMic() {
        if (!desiredConnected) return
        mic.start { pcm -> gemini.sendPcm16(pcm) }
            .onFailure {
                _ui.update { state -> state.copy(status = SessionStatus.ERROR, statusDetail = it.message ?: "Error de micrófono") }
            }
            .onSuccess { diag("Micrófono 16 kHz activo · bloques de 40 ms") }
    }

    private fun startManualMic() {
        mic.start { pcm ->
            if (pttBuffering) bufferPttAudio(pcm) else gemini.sendPcm16(pcm)
        }.onFailure {
            _ui.update { state -> state.copy(status = SessionStatus.ERROR, statusDetail = it.message ?: "Error de micrófono") }
        }.onSuccess {
            diag(if (pttBuffering) "Micrófono PTT activo · almacenando mientras conecta" else "Micrófono PTT activo")
        }
    }

    private fun bufferPttAudio(pcm: ByteArray) {
        synchronized(pttAudioLock) {
            val remaining = MAX_PTT_BUFFER_BYTES - pttAudioBuffer.size()
            if (remaining <= 0) return
            pttAudioBuffer.write(pcm, 0, minOf(remaining, pcm.size))
        }
    }

    private fun flushBufferedPttAudio() {
        val bytes = synchronized(pttAudioLock) {
            val data = pttAudioBuffer.toByteArray()
            pttAudioBuffer.reset()
            data
        }
        if (bytes.isEmpty()) return

        var offset = 0
        while (offset < bytes.size) {
            val end = minOf(offset + PTT_CHUNK_BYTES, bytes.size)
            gemini.sendPcm16(bytes.copyOfRange(offset, end))
            offset = end
        }
        diag("Audio PTT almacenado enviado · ${bytes.size} bytes")
    }

    private fun resetPttAudioBuffer() {
        synchronized(pttAudioLock) { pttAudioBuffer.reset() }
    }

    private fun resetManualInputState() {
        manualConnectRequested = false
        manualInputMode = false
        pushToTalkPressed = false
        pendingTypedText = null
        pendingPttEnd = false
        pttBuffering = false
        resetPttAudioBuffer()
    }

    private fun ensureFish(profileIdOverride: String? = null) {
        if (connectionPurpose == ConnectionPurpose.WAKE) return
        val profileId = profileIdOverride ?: _ui.value.config.profileId
        if (fish != null && fishProfileId == profileId) return
        if (fish != null && fishProfileId != profileId) cancelFish("Cambio de voz")

        val c = if (profileId == _ui.value.config.profileId) {
            _ui.value.config
        } else {
            profiles.loadProfile(profileId, settings.geminiKey(), settings.fishKey(), settings.geminiModel()) ?: return
        }
        val voice = if (profileId == _ui.value.config.profileId) {
            pendingVoiceBytes ?: profiles.voiceBytes(profileId)
        } else {
            profiles.voiceBytes(profileId)
        } ?: return

        lateinit var client: FishTtsClient
        client = FishTtsClient(object : FishTtsClient.Listener {
            override fun onAudio(bytes: ByteArray) {
                player.write(bytes)
            }

            override fun onReady() {
                diag("Fish listo · ${c.profileName} · TTS precargado")
            }

            override fun onFinished() {
                val wasCurrent = fish === client
                if (wasCurrent) {
                    fish = null
                    fishProfileId = null
                }
                if (wasCurrent && isGroupMode() && advanceGroupSpeechAfterFishFinished()) {
                    return
                }
                _ui.update { state ->
                    if (state.status == SessionStatus.SPEAKING) {
                        if (state.backgroundModeEnabled && state.invocationActive) {
                            state.copy(
                                status = SessionStatus.INVOCATION_ACTIVE,
                                statusDetail = "${activeDisplayName()} activo · escuchando",
                            )
                        } else if (manualInputMode && !pushToTalkPressed) {
                            state.copy(status = SessionStatus.LISTENING, statusDetail = "Conectado · micrófono cerrado")
                        } else {
                            state.copy(status = SessionStatus.LISTENING, statusDetail = "Escuchando")
                        }
                    } else state
                }
                diag("Fish terminó el turno")
            }

            override fun onError(message: String) {
                if (fish === client) {
                    fish = null
                    fishProfileId = null
                }
                diag(message)
                _ui.update { state -> state.copy(statusDetail = "$message · Gemini sigue conectado") }
            }

            override fun onDiagnostic(message: String) = diag(message)
        })
        fish = client
        fishProfileId = profileId
        client.start(
            apiKey = c.fishApiKey,
            referenceAudio = voice,
            referenceTranscript = c.voiceTranscript,
            speed = c.voiceSpeed,
        )
    }

    private fun handleGroupOutput(fullText: String) {
        if (!isGroupMode()) return

        val parsed = parseGroupSegments(fullText).ifEmpty {
            if (fullText.length < GROUP_PREFIX_FALLBACK_CHARS) return
            val fallback = groupLikelySpeakerId ?: groupLastSpeakerId ?: activeBackgroundProfileIds.firstOrNull()
                ?: return
            listOf(GroupSegment(fallback, fullText.trim()))
        }
        groupParsedSegments = parsed
        syncGroupMessages(parsed)
        groupLastSpeakerId = parsed.lastOrNull()?.speakerId ?: groupLastSpeakerId
        speakCurrentGroupSegment()

        val speaking = parsed.getOrNull(groupTtsSegmentIndex)
        val speakingName = speaking?.speakerId?.let { id ->
            _ui.value.profiles.firstOrNull { it.id == id }?.name
        }
        if (!speakingName.isNullOrBlank()) {
            _ui.update { it.copy(statusDetail = "$speakingName respondiendo") }
        }
    }

    private fun parseGroupSegments(fullText: String): List<GroupSegment> {
        data class Marker(val speakerId: String, val start: Int, val contentStart: Int)
        val markers = Regex("\\[\\[P([12])]]", RegexOption.IGNORE_CASE)
            .findAll(fullText)
            .mapNotNull { match ->
                val index = match.groupValues.getOrNull(1)?.toIntOrNull()?.minus(1) ?: return@mapNotNull null
                val profileId = activeBackgroundProfileIds.getOrNull(index) ?: return@mapNotNull null
                Marker(profileId, match.range.first, match.range.last + 1)
            }
            .toList()

        if (markers.isEmpty()) return emptyList()
        return markers.mapIndexedNotNull { index, marker ->
            val end = markers.getOrNull(index + 1)?.start ?: fullText.length
            val text = fullText.substring(marker.contentStart, end).trim()
            if (text.isBlank() && index < markers.lastIndex) null else GroupSegment(marker.speakerId, text)
        }
    }

    private fun syncGroupMessages(segments: List<GroupSegment>) {
        while (groupSegmentMessageIds.size < segments.size) {
            groupSegmentMessageIds += ids.getAndIncrement()
        }
        _ui.update { state ->
            val messages = state.messages.toMutableList()
            segments.forEachIndexed { index, segment ->
                if (segment.text.isBlank()) return@forEachIndexed
                val id = groupSegmentMessageIds[index]
                val profile = state.profiles.firstOrNull { it.id == segment.speakerId }
                val message = ChatMessage(
                    id = id,
                    speaker = Speaker.AI,
                    text = segment.text,
                    isPartial = true,
                    characterProfileId = segment.speakerId,
                    characterName = profile?.name.orEmpty(),
                )
                val existing = messages.indexOfFirst { it.id == id }
                if (existing >= 0) messages[existing] = message else messages += message
            }
            state.copy(messages = messages)
        }
    }

    private fun finalizeGroupMessages() {
        if (groupSegmentMessageIds.isEmpty()) return
        val idsToFinalize = groupSegmentMessageIds.toSet()
        _ui.update { state ->
            state.copy(messages = state.messages.map { message ->
                if (message.id in idsToFinalize) message.copy(isPartial = false) else message
            })
        }
    }

    private fun speakCurrentGroupSegment() {
        if (!isGroupMode()) return
        val segment = groupParsedSegments.getOrNull(groupTtsSegmentIndex) ?: return
        if (fishProfileId != segment.speakerId) {
            if (fish != null) cancelFish("Cambio natural de interlocutor")
            ensureFish(segment.speakerId)
        }
        val hasNext = groupTtsSegmentIndex + 1 < groupParsedSegments.size
        val safeText = if (!hasNext && !groupModelTurnComplete) {
            withoutIncompleteGroupMarkerTail(segment.text)
        } else {
            segment.text
        }
        val delta = incrementalDelta(groupTtsSentText, safeText)
        if (delta.isNotEmpty()) {
            fish?.sendText(delta)
            groupTtsSentText = safeText
        }

        val shouldCloseCurrent = hasNext || groupModelTurnComplete
        if (shouldCloseCurrent && !groupTtsFinishing) {
            groupTtsFinishing = true
            fish?.finish()
        }
    }

    private fun advanceGroupSpeechAfterFishFinished(): Boolean {
        if (!isGroupMode()) return false
        val hasNext = groupTtsSegmentIndex + 1 < groupParsedSegments.size
        if (hasNext) {
            groupTtsSegmentIndex += 1
            groupTtsSentText = ""
            groupTtsFinishing = false
            val next = groupParsedSegments[groupTtsSegmentIndex]
            val nextName = _ui.value.profiles.firstOrNull { it.id == next.speakerId }?.name ?: "Siguiente personaje"
            ensureFish(next.speakerId)
            speakCurrentGroupSegment()
            _ui.update { it.copy(status = SessionStatus.SPEAKING, statusDetail = "$nextName respondiendo") }
            diag("Conversación grupal · toma la palabra $nextName")
            return true
        }
        if (groupModelTurnComplete) {
            finalizeGroupMessages()
            resetGroupOutput(keepLastSpeaker = true)
        } else {
            groupTtsFinishing = false
        }
        return false
    }

    private fun scheduleTurnSettlement() {
        turnFinalizeJob?.cancel()
        turnFinalizeJob = viewModelScope.launch {
            delay(800)
            if (isGroupMode()) {
                groupModelTurnComplete = true
                finalizeGroupMessages()
                speakCurrentGroupSegment()
            } else {
                fish?.finish()
                finalizeAiMessage()
            }
            turnCompletePending = false
            turnFinalizeJob = null
            persistConversation()
            if (!isGroupMode()) resetGroupOutput(keepLastSpeaker = true)
            diag("Turno asentado · chat guardado · sigo escuchando")
        }
    }

    private fun cancelFish(reason: String) {
        fish?.cancel()
        fish = null
        fishProfileId = null
        player.interrupt()
        diag(reason)
    }

    private fun updateMessage(
        speaker: Speaker,
        text: String,
        partial: Boolean,
        characterProfileId: String = "",
        characterName: String = "",
    ) {
        if (text.isBlank()) return
        val currentId = if (speaker == Speaker.USER) currentUserMessageId else currentAiMessageId
        if (currentId == null) {
            val id = ids.getAndIncrement()
            if (speaker == Speaker.USER) currentUserMessageId = id else currentAiMessageId = id
            _ui.update { state ->
                state.copy(
                    messages = state.messages + ChatMessage(
                        id = id,
                        speaker = speaker,
                        text = text,
                        isPartial = partial,
                        characterProfileId = characterProfileId,
                        characterName = characterName,
                    )
                )
            }
        } else {
            _ui.update { state ->
                state.copy(messages = state.messages.map {
                    if (it.id == currentId) {
                        it.copy(
                            text = text,
                            isPartial = partial,
                            characterProfileId = characterProfileId.ifBlank { it.characterProfileId },
                            characterName = characterName.ifBlank { it.characterName },
                        )
                    } else it
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
        val idsForConversation = conversationProfileIds.distinct()
        if (idsForConversation.isEmpty()) return
        val stable = state.messages.map { it.copy(isPartial = false) }

        if (idsForConversation.size == 2) {
            profiles.saveGroupChat(idsForConversation, stable)
            gemini.updateHistory(historyForGroup(stable))
        } else {
            val profileId = idsForConversation.first()
            profiles.saveChat(profileId, stable)
            gemini.updateHistory(historyForSingle(stable, profileId))
        }
    }

    private fun historyForSingle(
        messages: List<ChatMessage>,
        profileId: String,
    ): List<GeminiLiveClient.HistoryTurn> {
        val stable = messages.filter { message ->
            !message.isPartial &&
                message.text.isNotBlank() &&
                (message.speaker == Speaker.USER || message.characterProfileId.isBlank() || message.characterProfileId == profileId)
        }
        return boundedHistory(stable) { message -> message.text }
    }

    private fun historyForGroup(messages: List<ChatMessage>): List<GeminiLiveClient.HistoryTurn> {
        val stable = messages.filter { !it.isPartial && it.text.isNotBlank() }
        return boundedHistory(stable) { message ->
            if (message.speaker == Speaker.AI && message.characterName.isNotBlank()) {
                "${message.characterName}: ${message.text}"
            } else message.text
        }
    }

    private fun boundedHistory(
        messages: List<ChatMessage>,
        textFor: (ChatMessage) -> String,
    ): List<GeminiLiveClient.HistoryTurn> {
        if (messages.isEmpty()) return emptyList()
        val selected = ArrayDeque<ChatMessage>()
        var chars = 0
        for (message in messages.asReversed()) {
            val text = textFor(message)
            if (selected.size >= 100) break
            if (chars + text.length > 50_000 && selected.isNotEmpty()) break
            selected.addFirst(message)
            chars += text.length
        }
        return selected.map { message ->
            GeminiLiveClient.HistoryTurn(
                role = if (message.speaker == Speaker.USER) "user" else "model",
                text = textFor(message),
            )
        }
    }

    private fun buildGroupPersonality(configs: List<AppConfig>): String {
        val first = configs[0]
        val second = configs[1]
        return """
Estás sosteniendo una conversación natural entre tres personas: el usuario, ${first.profileName} y ${second.profileName}.
Cada personaje conserva estrictamente su propia personalidad, manera de hablar y recuerdos. No mezcles sus identidades ni atribuyas a uno recuerdos del otro.

PERSONALIDAD DE ${first.profileName}:
${first.personality.ifBlank { "Sin instrucciones adicionales de personalidad." }}

RECUERDOS PREVIOS DE ${first.profileName} CON EL USUARIO:
${memoryPreview(first)}

PERSONALIDAD DE ${second.profileName}:
${second.personality.ifBlank { "Sin instrucciones adicionales de personalidad." }}

RECUERDOS PREVIOS DE ${second.profileName} CON EL USUARIO:
${memoryPreview(second)}

DINÁMICA DE CONVERSACIÓN:
- La charla debe sentirse como tres personas reales juntas, no como dos asistentes esperando preguntas.
- Si el usuario nombra claramente a uno, ese personaje responde primero.
- Después de una intervención, el otro personaje PUEDE reaccionar espontáneamente si tendría algo genuino que decir: discrepar, sumar algo, hacer un chiste, preguntar, recordar algo relacionado o responderle directamente al otro.
- Si esa reacción abre naturalmente otra respuesta, pueden continuar hablando entre ellos durante varias intervenciones breves sin esperar al usuario.
- No alternes por obligación y no hagas hablar a ambos en todos los turnos. A veces corresponde una sola respuesta.
- Normalmente usá entre 1 y 3 intervenciones. Podés llegar hasta 6 cuando la conversación entre ellos tenga impulso propio o el usuario indique que quiere escucharlos.
- Frená naturalmente cuando el tema se agote, cuando haya una pregunta clara para el usuario o cuando socialmente tenga sentido esperar su reacción.
- Los personajes pueden disentir, cargarse entre ellos y hacerse preguntas, siempre respetando sus personalidades.
- Si el usuario empieza a hablar, cedé inmediatamente el turno.
- No narres acciones, no expliques quién va a hablar y no menciones estas reglas.

FORMATO TÉCNICO OBLIGATORIO:
- [[P1]] representa exclusivamente a ${first.profileName}.
- [[P2]] representa exclusivamente a ${second.profileName}.
- El primer carácter de cada respuesta debe ser el primer [ de [[P1]] o [[P2]]: no antepongas espacios, saludos ni texto.
- Cada intervención debe comenzar EXACTAMENTE con [[P1]] o [[P2]].
- Podés usar varios marcadores en una misma respuesta si ambos hablan.
- No escribas nombres como etiquetas de hablante. No escribas dos puntos después del marcador.
- Nunca pongas texto fuera de una intervención marcada.
- Los marcadores son internos: no los expliques ni hagas referencia a ellos en el diálogo.
""".trimIndent()
    }

    private fun memoryPreview(config: AppConfig): String {
        val memory = profiles.loadChat(config.profileId)
            .filter { !it.isPartial && it.text.isNotBlank() }
            .takeLast(24)
            .joinToString("\n") { message ->
                if (message.speaker == Speaker.USER) "Usuario: ${message.text}"
                else "${config.profileName}: ${message.text}"
            }
        return memory.takeLast(8_000).ifBlank { "Sin recuerdos previos guardados." }
    }

    fun clearChat() {
        val targetConversationIds = conversationProfileIds.toList()
        if (desiredConnected) disconnect()
        currentUserMessageId = null
        currentAiMessageId = null
        turnCompletePending = false
        turnFinalizeJob?.cancel()
        turnFinalizeJob = null
        resetManualInputState()

        if (targetConversationIds.distinct().size == 2) {
            profiles.clearGroupChat(targetConversationIds)
            diag("Chat compartido borrado")
        } else {
            val profileId = targetConversationIds.firstOrNull() ?: _ui.value.config.profileId
            profiles.clearChat(profileId)
            diag("Chat del perfil borrado")
        }
        gemini.updateHistory(emptyList())
        _ui.update {
            it.copy(
                messages = emptyList(),
                status = SessionStatus.DISCONNECTED,
                statusDetail = "Chat borrado",
                backgroundModeEnabled = false,
                invocationActive = false,
                activeCharacterNames = emptyList(),
            )
        }
    }

    private fun findInvocationProfiles(normalizedText: String): List<CharacterProfileSummary> {
        val suffixIndex = normalizedText.indexOf(INVOCATION_SUFFIX)
        if (suffixIndex < 0) return emptyList()
        val beforeSuffix = normalizedText.substring(0, suffixIndex).trim()
        if (beforeSuffix.isBlank()) return emptyList()

        return _ui.value.profiles
            .mapNotNull { profile ->
                val normalizedName = normalizeCommand(profile.name)
                if (normalizedName.isBlank()) return@mapNotNull null
                val match = wordSequenceRegex(normalizedName).find(beforeSuffix) ?: return@mapNotNull null
                Triple(profile, match.range.first, normalizedName.length)
            }
            .sortedWith(compareBy<Triple<CharacterProfileSummary, Int, Int>> { it.second }.thenByDescending { it.third })
            .map { it.first }
            .distinctBy { it.id }
            .take(2)
    }

    private fun addressedGroupProfile(normalizedText: String): CharacterProfileSummary? {
        if (!isGroupMode()) return null
        return activeBackgroundProfileIds
            .mapNotNull { id -> _ui.value.profiles.firstOrNull { it.id == id } }
            .mapNotNull { profile ->
                val normalizedName = normalizeCommand(profile.name)
                val match = wordSequenceRegex(normalizedName).find(normalizedText) ?: return@mapNotNull null
                profile to match.range.first
            }
            .minByOrNull { it.second }
            ?.first
    }

    private fun withoutIncompleteGroupMarkerTail(text: String): String {
        if (text.isEmpty()) return text
        var holdback = 0
        for (marker in GROUP_SPEAKER_MARKERS) {
            val maxPrefix = minOf(marker.length - 1, text.length)
            for (length in maxPrefix downTo 1) {
                if (text.endsWith(marker.substring(0, length), ignoreCase = true)) {
                    holdback = maxOf(holdback, length)
                    break
                }
            }
        }
        return if (holdback > 0) text.dropLast(holdback) else text
    }

    private fun incrementalDelta(previous: String, current: String): String {
        if (previous.isEmpty()) return current
        if (current.startsWith(previous)) return current.substring(previous.length)
        if (previous.endsWith(current)) return ""
        val max = minOf(previous.length, current.length)
        for (n in max downTo 1) {
            if (previous.regionMatches(previous.length - n, current, 0, n)) {
                return current.substring(n)
            }
        }
        return current
    }

    private fun discardCurrentUserMessage() {
        val id = currentUserMessageId ?: return
        _ui.update { state ->
            state.copy(messages = state.messages.filterNot { it.id == id })
        }
        currentUserMessageId = null
    }

    private fun activeDisplayName(): String =
        _ui.value.activeCharacterNames.takeIf { it.isNotEmpty() }?.joinToString(" + ")
            ?: _ui.value.config.profileName.ifBlank { "CharacterIA" }

    private fun isGroupMode(): Boolean =
        connectionPurpose == ConnectionPurpose.BACKGROUND_ACTIVE && activeBackgroundProfileIds.size == 2

    private fun resetGroupOutput(keepLastSpeaker: Boolean = false) {
        groupParsedSegments = emptyList()
        groupSegmentMessageIds.clear()
        groupTtsSegmentIndex = 0
        groupTtsSentText = ""
        groupTtsFinishing = false
        groupModelTurnComplete = false
        groupLikelySpeakerId = null
        if (!keepLastSpeaker) groupLastSpeakerId = null
    }

    private fun wordSequenceRegex(normalizedName: String): Regex =
        Regex("(?:^|\\s)${Regex.escape(normalizedName)}(?=\\s|$)")

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
        resetManualInputState()
        InvocationForegroundService.stop(getApplication())
        player.release()
        super.onCleared()
    }

    companion object {
        private const val INVOCATION_SUFFIX = "are you here"
        private const val EXIT_PHRASE = "get out"
        private const val GROUP_PREFIX_FALLBACK_CHARS = 16
        private const val PTT_CHUNK_BYTES = 1_280
        private const val MAX_PTT_BUFFER_BYTES = 640_000
        private val GROUP_SPEAKER_MARKERS = listOf("[[P1]]", "[[P2]]")
        private const val WAKE_SYSTEM_PROMPT = """Sos un detector silencioso de comandos de voz. No converses, no respondas y no intentes ayudar. Tu única tarea es escuchar el audio para que la transcripción de entrada permita detectar frases con el formato «nombre del personaje, are you here?» o «nombre y nombre, are you here?», y el comando «get out». Aunque escuches preguntas o conversaciones, permanecé en silencio."""
    }
}
