from pathlib import Path

vm_path = Path('app/src/main/java/com/lisofer/characteria/CharacterViewModel.kt')
s = vm_path.read_text()

old = '''        override fun onModelChanged(model: String, reason: String) {
            settings.setGeminiModel(model)
            _ui.update { state ->
                state.copy(
                    config = state.config.copy(geminiModel = model),
                    status = SessionStatus.CONNECTING,
                    statusDetail = "Cambiando automáticamente a $model…",
                )
            }
            diag("Modelo global cambiado automáticamente a $model · $reason")
        }
'''
new = '''        override fun onModelChanged(model: String, reason: String) {
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
'''
if old not in s:
    raise SystemExit('onModelChanged block not found')
s = s.replace(old, new, 1)

# UI load exposes preferred separately from active fallback model.
old = '''            activeCharacterNames = emptyList(),
        )
        diag("Perfil cargado: ${config.profileName} · ${chat.size} mensajes guardados")
'''
new = '''            activeCharacterNames = emptyList(),
            activeGeminiModel = settings.activeGeminiModel(),
        )
        diag("Perfil cargado: ${config.profileName} · ${chat.size} mensajes guardados · Gemini activo ${settings.activeGeminiModel()}")
'''
if old not in s:
    raise SystemExit('loadProfile state block not found')
s = s.replace(old, new, 1)

old = '''    fun selectGeminiModel(model: String) {
        val selected = normalizeGeminiModel(model)
        settings.setGeminiModel(selected)
        _ui.update { state -> state.copy(config = state.config.copy(geminiModel = selected)) }
        diag("Modelo global seleccionado: $selected")
    }
'''
new = '''    fun selectGeminiModel(model: String) {
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
'''
if old not in s:
    raise SystemExit('selectGeminiModel block not found')
s = s.replace(old, new, 1)

old = '''        settings.saveGlobalConnection(config.geminiApiKey, config.fishApiKey, config.geminiModel)
        profiles.saveProfile(config)
'''
new = '''        val geminiKeyChanged = settings.saveGlobalConnection(
            config.geminiApiKey,
            config.fishApiKey,
            config.geminiModel,
        )
        if (geminiKeyChanged) {
            resetRuntimeForConnectionChange("API key de Gemini actualizada")
            diag("API Gemini nueva · sesión anterior descartada · vuelvo al modelo preferido ${settings.geminiModel()}")
        }
        profiles.saveProfile(config)
'''
if old not in s:
    raise SystemExit('saveGlobalConnection block not found')
s = s.replace(old, new, 1)

old = '''                hasVoiceSample = profiles.hasVoice(config.profileId),
                settingsOpen = false,
            )
'''
new = '''                hasVoiceSample = profiles.hasVoice(config.profileId),
                settingsOpen = false,
                activeGeminiModel = settings.activeGeminiModel(),
                status = if (geminiKeyChanged) SessionStatus.DISCONNECTED else it.status,
                statusDetail = if (geminiKeyChanged) {
                    "API Gemini actualizada · listo con ${settings.activeGeminiModel()}"
                } else it.statusDetail,
            )
'''
if old not in s:
    raise SystemExit('saveConfig ui block not found')
s = s.replace(old, new, 1)

# Runtime reset helper. It is intentionally a full reset so no socket/session handle from the old API key survives.
anchor = '''    fun importVoiceSample(uri: Uri) {
'''
helper = '''    private fun resetRuntimeForConnectionChange(reason: String) {
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

'''
if helper.strip() not in s:
    if anchor not in s:
        raise SystemExit('importVoiceSample anchor not found')
    s = s.replace(anchor, helper + anchor, 1)

# Every new Gemini session starts at the active model for this API key, not the preferred selector value.
# Normal connection.
old = '''        val c = _ui.value.config
        val history = historyForSingle(_ui.value.messages, c.profileId)
'''
new = '''        val c = _ui.value.config
        val activeModel = settings.activeGeminiModel()
        val history = historyForSingle(_ui.value.messages, c.profileId)
'''
if old not in s:
    raise SystemExit('normal active model anchor not found')
s = s.replace(old, new, 1)
s = s.replace(
    '''                model = c.geminiModel,
                personality = c.personality,
                history = history,
                fallbackModels = geminiFallbackChain(c.geminiModel),
''',
    '''                model = activeModel,
                personality = c.personality,
                history = history,
                fallbackModels = geminiFallbackChain(activeModel),
''',
    1,
)

# Wake start: add active model after config.
old = '''        val c = _ui.value.config
        val context = getApplication<Application>()
'''
new = '''        val c = _ui.value.config
        val activeModel = settings.activeGeminiModel()
        val context = getApplication<Application>()
'''
if old not in s:
    raise SystemExit('wake start model anchor not found')
s = s.replace(old, new, 1)
s = s.replace(
    '''                model = c.geminiModel,
                personality = WAKE_SYSTEM_PROMPT,
                history = emptyList(),
                fallbackModels = geminiFallbackChain(c.geminiModel),
''',
    '''                model = activeModel,
                personality = WAKE_SYSTEM_PROMPT,
                history = emptyList(),
                fallbackModels = geminiFallbackChain(activeModel),
''',
    1,
)

# Group/character activation uses global preferred in configs, but global active model to connect.
old = '''        val personality = if (isGroup) buildGroupPersonality(targetConfigs) else first.personality
        val history = if (isGroup) historyForGroup(targetChat) else historyForSingle(targetChat, first.profileId)
        gemini.connect(
'''
new = '''        val personality = if (isGroup) buildGroupPersonality(targetConfigs) else first.personality
        val history = if (isGroup) historyForGroup(targetChat) else historyForSingle(targetChat, first.profileId)
        val activeModel = settings.activeGeminiModel()
        gemini.connect(
'''
if old not in s:
    raise SystemExit('group active model anchor not found')
s = s.replace(old, new, 1)
s = s.replace(
    '''                model = first.geminiModel,
                personality = personality,
                history = history,
                fallbackModels = geminiFallbackChain(first.geminiModel),
''',
    '''                model = activeModel,
                personality = personality,
                history = history,
                fallbackModels = geminiFallbackChain(activeModel),
''',
    1,
)

# Return to wake uses whatever active model belongs to the current key.
old = '''        val c = _ui.value.config
        gemini.connect(
            GeminiLiveClient.Config(
                apiKey = c.geminiApiKey,
                model = c.geminiModel,
                personality = WAKE_SYSTEM_PROMPT,
                history = emptyList(),
                fallbackModels = geminiFallbackChain(c.geminiModel),
'''
new = '''        val c = _ui.value.config
        val activeModel = settings.activeGeminiModel()
        gemini.connect(
            GeminiLiveClient.Config(
                apiKey = c.geminiApiKey,
                model = activeModel,
                personality = WAKE_SYSTEM_PROMPT,
                history = emptyList(),
                fallbackModels = geminiFallbackChain(activeModel),
'''
if old not in s:
    raise SystemExit('return wake model block not found')
s = s.replace(old, new, 1)

vm_path.write_text(s)

# UI: show preferred vs active clearly without adding complexity.
ui_path = Path('app/src/main/java/com/lisofer/characteria/MainActivity.kt')
u = ui_path.read_text()

u = u.replace(
    '''                else -> state.config.geminiModel
''',
    '''                else -> state.activeGeminiModel
''',
    1,
)

u = u.replace(
    '''                        Text("Modelo: ${c.geminiModel}")
''',
    '''                        Text("Modelo preferido: ${c.geminiModel}")
''',
    1,
)

old = '''                Text(
                    "Si el modelo agota cuota, CharacterIA baja automáticamente al siguiente modelo Live gratuito disponible.",
                    color = Muted,
                    style = MaterialTheme.typography.labelSmall,
                )
'''
new = '''                Text(
                    if (state.activeGeminiModel != c.geminiModel) {
                        "Activo ahora: ${state.activeGeminiModel} por fallback. Si cambiás la API de Gemini, vuelve automáticamente al modelo preferido."
                    } else {
                        "Activo ahora: ${state.activeGeminiModel}. Si agota cuota, CharacterIA baja temporalmente al siguiente modelo Live disponible."
                    },
                    color = Muted,
                    style = MaterialTheme.typography.labelSmall,
                )
'''
if old not in u:
    raise SystemExit('model helper text not found')
u = u.replace(old, new, 1)

ui_path.write_text(u)
