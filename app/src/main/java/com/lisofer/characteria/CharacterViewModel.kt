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
    private var fishProfileId: String? = null
    private var turnFinalizeJob: Job? = null
    private var turnCompletePending = false
    private var desiredConnected = false
    private var connectionPurpose = ConnectionPurpose.NORMAL

    private var pendingInvocationProfileIds: List<String>? = null
    private var activeBackgroundProfileIds: List<String> = emptyList()
    private var conversationProfileIds: List<String> = emptyList()

    private var groupLastSpeakerId: String? = null
    private var groupLikelySpeakerId: String? = null
    private var groupOutputSpeakerId: String? = null
    private var groupOutputSpokenText = ""

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
                    startMic()
                    _ui.update { it.copy(status = SessionStatus.LISTENING, statusDetail = "Escuchando") }
                }
            }
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
                    val targetIds = targetProfiles.map { it.id }
                    val targetName = targetProfiles.joinToString(" + ") { it.name }
                    if (connectionPurpose == ConnectionPurpose.WAKE) {
                        pendingInvocationProfileIds = targetIds
                        _ui.update { it.copy(statusDetail = "Invocando a $targetName…") }
                    } else if (connectionPurpose == ConnectionPurpose.BACKGROUND_ACTIVE) {
                        pendingInvocationProfileIds = null
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
                    groupOutputSpeakerId = null
                    groupOutputSpokenText = ""
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
        conversationProfileIds = listOf(profileId)
        activeBackgroundProfileIds = emptyList()
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
            activeCharacterNames = emptyList(),
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
        activeBackgroundProfileIds = emptyList()
        conversationProfileIds = listOf(_ui.value.config.profileId)
        currentUserMessageId = null
        currentAiMessageId = null
        turnCompletePending = false
        turnFinalizeJob?.cancel()
        turnFinalizeJob = null
        resetGroupOutput()

        val c = _ui.value.config
        val history = historyForSingle(_ui.value.messages, c.profileId)
        _ui.update {
            it.copy(
                status = SessionStatus.CONNECTING,
                statusDetail = "Conectando…",
                backgroundModeEnabled = false,
                invocationActive = false,
                activeCharacterNames = emptyList(),
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
        activeBackgroundProfileIds = emptyList()
        pendingInvocationProfileIds = null
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
                model = c.geminiModel,
                personality = WAKE_SYSTEM_PROMPT,
                history = emptyList(),
            )
        )
    }

    private fun activateBackgroundCharacters(requestedIds: List<String>) {
        if (!_ui.value.backgroundModeEnabled) return
        val targetIds = requestedIds.distinct().take(2)
        if (targetIds.isEmpty()) return

        val targetConfigs = targetIds.mapNotNull { id ->
            profiles.loadProfile(id, settings.geminiKey(), settings.fishKey())
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
        mic.stop()
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
        gemini.connect(
            GeminiLiveClient.Config(
                apiKey = first.geminiApiKey,
                model = first.geminiModel,
                personality = personality,
                history = history,
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
        mic.stop()
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
        gemini.connect(
            GeminiLiveClient.Config(
                apiKey = c.geminiApiKey,
                model = c.geminiModel,
                personality = WAKE_SYSTEM_PROMPT,
                history = emptyList(),
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

    private fun startMic() {
        if (!desiredConnected) return
        mic.start { pcm -> gemini.sendPcm16(pcm) }
            .onFailure {
                _ui.update { state -> state.copy(status = SessionStatus.ERROR, statusDetail = it.message ?: "Error de micrófono") }
            }
            .onSuccess { diag("Micrófono 16 kHz activo · bloques de 40 ms") }
    }

    private fun ensureFish(profileIdOverride: String? = null) {
        if (connectionPurpose == ConnectionPurpose.WAKE) return
        val profileId = profileIdOverride ?: _ui.value.config.profileId
        if (fish != null && fishProfileId == profileId) return
        if (fish != null && fishProfileId != profileId) cancelFish("Cambio de voz")

        val c = if (profileId == _ui.value.config.profileId) {
            _ui.value.config
        } else {
            profiles.loadProfile(profileId, settings.geminiKey(), settings.fishKey()) ?: return
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
                if (fish === client) {
                    fish = null
                    fishProfileId = null
                }
                _ui.update { state ->
                    if (state.status == SessionStatus.SPEAKING) {
                        if (state.backgroundModeEnabled && state.invocationActive) {
                            state.copy(
                                status = SessionStatus.INVOCATION_ACTIVE,
                                statusDetail = "${activeDisplayName()} activo · escuchando",
                            )
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

        if (groupOutputSpeakerId == null) {
            val parsed = parseGroupSpeaker(fullText)
            groupOutputSpeakerId = parsed?.first
                ?: if (fullText.length >= GROUP_PREFIX_FALLBACK_CHARS) {
                    groupLikelySpeakerId ?: groupLastSpeakerId ?: activeBackgroundProfileIds.firstOrNull()
                } else null
            if (groupOutputSpeakerId == null) return

            if (fishProfileId != groupOutputSpeakerId) {
                cancelFish("Gemini eligió otra voz")
                ensureFish(groupOutputSpeakerId)
            }
        }

        val speakerId = groupOutputSpeakerId ?: return
        val speakerConfig = profiles.loadProfile(speakerId, settings.geminiKey(), settings.fishKey()) ?: return
        val spokenFull = stripGroupSpeakerPrefix(fullText, speakerConfig.profileName).trimStart()
        val spokenDelta = incrementalDelta(groupOutputSpokenText, spokenFull)
        groupOutputSpokenText = spokenFull
        groupLastSpeakerId = speakerId

        if (spokenDelta.isNotEmpty()) {
            ensureFish(speakerId)
            fish?.sendText(spokenDelta)
        }
        if (spokenFull.isNotBlank()) {
            updateMessage(
                Speaker.AI,
                spokenFull,
                partial = true,
                characterProfileId = speakerId,
                characterName = speakerConfig.profileName,
            )
            _ui.update { it.copy(statusDetail = "${speakerConfig.profileName} respondiendo") }
        }
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
            resetGroupOutput(keepLastSpeaker = true)
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
Estás sosteniendo una conversación grupal entre el usuario y exactamente dos personajes: ${first.profileName} y ${second.profileName}.
Cada personaje debe conservar estrictamente su propia personalidad, manera de hablar y recuerdos. No mezcles sus identidades ni atribuyas a uno recuerdos del otro.

PERSONALIDAD DE ${first.profileName}:
${first.personality.ifBlank { "Sin instrucciones adicionales de personalidad." }}

RECUERDOS PREVIOS DE ${first.profileName} CON EL USUARIO:
${memoryPreview(first)}

PERSONALIDAD DE ${second.profileName}:
${second.personality.ifBlank { "Sin instrucciones adicionales de personalidad." }}

RECUERDOS PREVIOS DE ${second.profileName} CON EL USUARIO:
${memoryPreview(second)}

REGLAS DE CONVERSACIÓN:
- En cada turno habla UN SOLO personaje. Nunca generes dos intervenciones en la misma respuesta.
- Si el usuario nombra claramente a uno, responde ese personaje.
- Si el usuario responde directamente a quien acaba de hablar, normalmente continúa ese personaje.
- Si no nombra a nadie, elegí naturalmente quién tiene más sentido que responda por el hilo, alternando solo cuando resulte natural.
- Si pregunta "ustedes", "los dos" o algo dirigido a ambos, elegí a uno para tomar primero la palabra; el otro podrá responder en un turno posterior.
- Los personajes pueden discrepar. No hagas que coincidan artificialmente.
- No narres quién va a hablar, no describas acciones y no expliques estas reglas.

REGLA TÉCNICA OBLIGATORIA:
Toda respuesta debe comenzar exactamente con uno de estos dos prefijos, seguido inmediatamente por lo que dice ese personaje:
${first.profileName}:
${second.profileName}:
Usá solamente uno de esos prefijos por respuesta.
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

    private fun parseGroupSpeaker(fullText: String): Pair<String, Int>? {
        for (profileId in activeBackgroundProfileIds) {
            val profile = _ui.value.profiles.firstOrNull { it.id == profileId } ?: continue
            val regex = Regex("^\\s*${Regex.escape(profile.name)}\\s*:\\s*", RegexOption.IGNORE_CASE)
            val match = regex.find(fullText) ?: continue
            return profileId to (match.range.last + 1)
        }
        return null
    }

    private fun stripGroupSpeakerPrefix(fullText: String, profileName: String): String {
        val regex = Regex("^\\s*${Regex.escape(profileName)}\\s*:\\s*", RegexOption.IGNORE_CASE)
        return regex.replaceFirst(fullText, "")
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
        groupOutputSpeakerId = null
        groupOutputSpokenText = ""
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
        InvocationForegroundService.stop(getApplication())
        player.release()
        super.onCleared()
    }

    companion object {
        private const val INVOCATION_SUFFIX = "are you here"
        private const val EXIT_PHRASE = "get out"
        private const val GROUP_PREFIX_FALLBACK_CHARS = 48
        private const val WAKE_SYSTEM_PROMPT = """Sos un detector silencioso de comandos de voz. No converses, no respondas y no intentes ayudar. Tu única tarea es escuchar el audio para que la transcripción de entrada permita detectar frases con el formato «nombre del personaje, are you here?» o «nombre y nombre, are you here?», y el comando «get out». Aunque escuches preguntas o conversaciones, permanecé en silencio."""
    }
}
