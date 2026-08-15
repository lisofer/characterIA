from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly 1 match, found {count}")
    return text.replace(old, new, 1)


vm_path = Path("app/src/main/java/com/lisofer/characteria/CharacterViewModel.kt")
vm = vm_path.read_text()

vm = replace_once(
    vm,
    '''    private var wakeDetected = false\n    private var wakeTranscript = ""\n    private var pendingInvocationText: String? = null\n''',
    '''    private var wakeDetected = false\n    private var wakeTranscript = ""\n    private var pendingInvocationProfileId: String? = null\n''',
    "invocation fields",
)

vm = vm.replace('statusDetail = "Esperando «yo te invoco»"', 'statusDetail = "Esperando «[personaje], are you here?»"')
vm = replace_once(
    vm,
    '                    InvocationForegroundService.update(name, active = false)\n',
    '                    InvocationForegroundService.update("CharacterIA", active = false)\n',
    "armed notification",
)

vm = replace_once(
    vm,
    '''\n                    pendingInvocationText?.takeIf { it.isNotBlank() }?.let { text ->\n                        pendingInvocationText = null\n                        ensureFish()\n                        updateMessage(Speaker.USER, text, partial = false)\n                        finalizeUserMessage()\n                        persistConversation()\n                        if (gemini.sendTextTurn(text)) {\n                            diag("Frase de invocación entregada al personaje")\n                        } else {\n                            diag("No se pudo entregar la frase de invocación")\n                        }\n                    }\n''',
    '\n',
    "remove invocation phrase from chat",
)

old_bg_block = '''            if (_ui.value.backgroundModeEnabled) {\n                if (normalized.contains(RETIRE_PHRASE)) {\n                    if (connectionPurpose == ConnectionPurpose.BACKGROUND_ACTIVE) {\n                        updateMessage(Speaker.USER, fullText, partial = false)\n                        finalizeUserMessage()\n                        persistConversation()\n                    }\n                    stopBackgroundMode("Comando «podés retirarte» detectado")\n                    return\n                }\n\n                if (connectionPurpose == ConnectionPurpose.WAKE) {\n                    wakeTranscript = fullText\n                    if (normalized.contains(WAKE_PHRASE)) {\n                        wakeDetected = true\n                        _ui.update { it.copy(statusDetail = "Invocación detectada…") }\n                    }\n                    return\n                }\n            }\n'''
new_bg_block = '''            if (_ui.value.backgroundModeEnabled) {\n                if (connectionPurpose == ConnectionPurpose.BACKGROUND_ACTIVE && normalized.contains(EXIT_PHRASE)) {\n                    discardCurrentUserMessage()\n                    returnToWakeMode("Comando «get out» detectado")\n                    return\n                }\n\n                val targetProfile = findInvocationProfile(normalized)\n                if (targetProfile != null) {\n                    discardCurrentUserMessage()\n                    if (connectionPurpose == ConnectionPurpose.WAKE) {\n                        wakeTranscript = fullText\n                        wakeDetected = true\n                        pendingInvocationProfileId = targetProfile.id\n                        _ui.update { it.copy(statusDetail = "Invocando a ${targetProfile.name}…") }\n                    } else if (connectionPurpose == ConnectionPurpose.BACKGROUND_ACTIVE) {\n                        wakeDetected = false\n                        wakeTranscript = ""\n                        pendingInvocationProfileId = null\n                        activateBackgroundCharacter(targetProfile.id)\n                    }\n                    return\n                }\n\n                if (connectionPurpose == ConnectionPurpose.WAKE) {\n                    wakeTranscript = fullText\n                    return\n                }\n            }\n'''
vm = replace_once(vm, old_bg_block, new_bg_block, "background command router")

old_turn = '''            if (connectionPurpose == ConnectionPurpose.WAKE) {\n                if (wakeDetected) {\n                    val transcript = wakeTranscript\n                    wakeDetected = false\n                    wakeTranscript = ""\n                    activateBackgroundCharacter(transcript)\n                } else {\n                    wakeTranscript = ""\n                }\n                return\n            }\n'''
new_turn = '''            if (connectionPurpose == ConnectionPurpose.WAKE) {\n                val profileId = pendingInvocationProfileId\n                if (wakeDetected && profileId != null) {\n                    wakeDetected = false\n                    wakeTranscript = ""\n                    pendingInvocationProfileId = null\n                    activateBackgroundCharacter(profileId)\n                } else {\n                    wakeTranscript = ""\n                }\n                return\n            }\n'''
vm = replace_once(vm, old_turn, new_turn, "wake turn completion")

vm = vm.replace('                pendingInvocationText = null\n', '                pendingInvocationProfileId = null\n')
vm = vm.replace('        pendingInvocationText = null\n', '        pendingInvocationProfileId = null\n')

old_arm_validation = '''        validateForConnect()?.let { error ->\n            _ui.update { it.copy(status = SessionStatus.ERROR, statusDetail = error, settingsOpen = true) }\n            return\n        }\n\n        if (desiredConnected) disconnectNormalSession("Cambiando a modo invocación")\n'''
new_arm_validation = '''        val armError = when {\n            _ui.value.config.geminiApiKey.isBlank() -> "Falta la API key de Gemini"\n            _ui.value.profiles.isEmpty() -> "No hay perfiles para invocar"\n            else -> null\n        }\n        armError?.let { error ->\n            _ui.update { it.copy(status = SessionStatus.ERROR, statusDetail = error, settingsOpen = true) }\n            return\n        }\n\n        if (desiredConnected) disconnectNormalSession("Cambiando a modo invocación")\n'''
# The same validation snippet also exists in connect(); replace the occurrence immediately after startBackgroundMode only.
marker = '    private fun startBackgroundMode() {\n'
pos = vm.index(marker)
head, tail = vm[:pos], vm[pos:]
tail = replace_once(tail, old_arm_validation, new_arm_validation, "background arm validation")
vm = head + tail

old_activate = '''    private fun activateBackgroundCharacter(triggerText: String) {\n        if (!_ui.value.backgroundModeEnabled || connectionPurpose != ConnectionPurpose.WAKE) return\n\n        val c = _ui.value.config\n        val history = historyForGemini(_ui.value.messages)\n        mic.stop()\n        gemini.disconnect()\n        connectionPurpose = ConnectionPurpose.BACKGROUND_ACTIVE\n        pendingInvocationText = triggerText\n        wakeDetected = false\n        wakeTranscript = ""\n\n        _ui.update {\n            it.copy(\n                status = SessionStatus.CONNECTING,\n                statusDetail = "Invocando a ${c.profileName.ifBlank { "CharacterIA" }}…",\n                invocationActive = true,\n            )\n        }\n        InvocationForegroundService.update(c.profileName.ifBlank { "CharacterIA" }, active = true)\n\n        gemini.connect(\n            GeminiLiveClient.Config(\n                apiKey = c.geminiApiKey,\n                model = c.geminiModel,\n                personality = c.personality,\n                history = history,\n            )\n        )\n        diag("Invocación confirmada · memoria cargada (${history.size} mensajes)")\n    }\n'''
new_activate = '''    private fun activateBackgroundCharacter(profileId: String) {\n        if (!_ui.value.backgroundModeEnabled) return\n\n        val targetConfig = profiles.loadProfile(profileId, settings.geminiKey(), settings.fishKey()) ?: run {\n            diag("No se encontró el perfil invocado: $profileId")\n            return\n        }\n        val targetHasVoice = profiles.hasVoice(profileId)\n        val validationError = when {\n            targetConfig.profileName.isBlank() -> "El perfil no tiene nombre"\n            targetConfig.geminiApiKey.isBlank() -> "Falta la API key de Gemini"\n            targetConfig.fishApiKey.isBlank() -> "Falta la API key de Fish Audio"\n            !targetHasVoice -> "${targetConfig.profileName} no tiene muestra de voz"\n            targetConfig.voiceTranscript.isBlank() -> "${targetConfig.profileName} no tiene transcripción de voz"\n            else -> null\n        }\n        if (validationError != null) {\n            _ui.update { it.copy(statusDetail = validationError) }\n            diag(validationError)\n            return\n        }\n\n        val previousName = _ui.value.config.profileName\n        turnFinalizeJob?.cancel()\n        turnFinalizeJob = null\n        turnCompletePending = false\n        if (connectionPurpose == ConnectionPurpose.BACKGROUND_ACTIVE) {\n            finalizeCurrentMessages()\n            persistConversation()\n        }\n        mic.stop()\n        gemini.disconnect()\n        cancelFish("Cambio de personaje")\n        player.interrupt()\n\n        val targetChat = profiles.loadChat(profileId)\n        ids.set((targetChat.maxOfOrNull { it.id } ?: 0L) + 1L)\n        pendingVoiceBytes = null\n        currentUserMessageId = null\n        currentAiMessageId = null\n        settings.setActiveProfileId(profileId)\n        connectionPurpose = ConnectionPurpose.BACKGROUND_ACTIVE\n        wakeDetected = false\n        wakeTranscript = ""\n        pendingInvocationProfileId = null\n\n        _ui.update {\n            it.copy(\n                config = targetConfig,\n                profiles = profiles.listProfiles(),\n                hasVoiceSample = targetHasVoice,\n                messages = targetChat,\n                status = SessionStatus.CONNECTING,\n                statusDetail = "Invocando a ${targetConfig.profileName}…",\n                backgroundModeEnabled = true,\n                invocationActive = true,\n                settingsOpen = false,\n            )\n        }\n        InvocationForegroundService.update(targetConfig.profileName, active = true)\n\n        val history = historyForGemini(targetChat)\n        gemini.connect(\n            GeminiLiveClient.Config(\n                apiKey = targetConfig.geminiApiKey,\n                model = targetConfig.geminiModel,\n                personality = targetConfig.personality,\n                history = history,\n            )\n        )\n        if (previousName.isNotBlank() && previousName != targetConfig.profileName) {\n            diag("Cambio de personaje: $previousName → ${targetConfig.profileName}")\n        } else {\n            diag("Invocación: ${targetConfig.profileName}")\n        }\n        diag("Memoria cargada · ${history.size} mensajes")\n    }\n\n    private fun returnToWakeMode(reason: String) {\n        if (!_ui.value.backgroundModeEnabled) return\n\n        turnFinalizeJob?.cancel()\n        turnFinalizeJob = null\n        turnCompletePending = false\n        discardCurrentUserMessage()\n        finalizeAiMessage()\n        persistConversation()\n        mic.stop()\n        gemini.disconnect()\n        cancelFish(reason)\n        player.interrupt()\n\n        connectionPurpose = ConnectionPurpose.WAKE\n        wakeDetected = false\n        wakeTranscript = ""\n        pendingInvocationProfileId = null\n        currentUserMessageId = null\n        currentAiMessageId = null\n\n        _ui.update {\n            it.copy(\n                status = SessionStatus.CONNECTING,\n                statusDetail = "Cerrando conversación…",\n                backgroundModeEnabled = true,\n                invocationActive = false,\n            )\n        }\n        InvocationForegroundService.update("CharacterIA", active = false)\n\n        val c = _ui.value.config\n        gemini.connect(\n            GeminiLiveClient.Config(\n                apiKey = c.geminiApiKey,\n                model = c.geminiModel,\n                personality = WAKE_SYSTEM_PROMPT,\n                history = emptyList(),\n            )\n        )\n        diag("$reason · vuelvo a esperar una invocación")\n    }\n'''
vm = replace_once(vm, old_activate, new_activate, "activate/switch character")

# Insert helpers before normalizeCommand.
old_normalize = '''    private fun normalizeCommand(text: String): String {\n'''
new_helpers = '''    private fun findInvocationProfile(normalizedText: String): CharacterProfileSummary? {\n        return _ui.value.profiles\n            .asSequence()\n            .map { profile -> profile to normalizeCommand(profile.name) }\n            .filter { (_, normalizedName) -> normalizedName.isNotBlank() }\n            .sortedByDescending { (_, normalizedName) -> normalizedName.length }\n            .firstOrNull { (_, normalizedName) ->\n                normalizedText.contains("$normalizedName $INVOCATION_SUFFIX")\n            }\n            ?.first\n    }\n\n    private fun discardCurrentUserMessage() {\n        val id = currentUserMessageId ?: return\n        _ui.update { state ->\n            state.copy(messages = state.messages.filterNot { it.id == id })\n        }\n        currentUserMessageId = null\n    }\n\n    private fun normalizeCommand(text: String): String {\n'''
vm = replace_once(vm, old_normalize, new_helpers, "command helpers")

old_companion = '''    companion object {\n        private const val WAKE_PHRASE = "yo te invoco"\n        private const val RETIRE_PHRASE = "podes retirarte"\n        private const val WAKE_SYSTEM_PROMPT = """Sos un detector silencioso de una frase de activación. No converses, no respondas y no intentes ayudar. Tu única tarea es escuchar el audio para que la transcripción de entrada permita detectar la frase «yo te invoco». Aunque escuches preguntas o conversaciones, permanecé en silencio."""\n    }\n'''
new_companion = '''    companion object {\n        private const val INVOCATION_SUFFIX = "are you here"\n        private const val EXIT_PHRASE = "get out"\n        private const val WAKE_SYSTEM_PROMPT = """Sos un detector silencioso de comandos de voz. No converses, no respondas y no intentes ayudar. Tu única tarea es escuchar el audio para que la transcripción de entrada permita detectar frases con el formato «nombre del personaje, are you here?» y el comando «get out». Aunque escuches preguntas o conversaciones, permanecé en silencio."""\n    }\n'''
vm = replace_once(vm, old_companion, new_companion, "command constants")

vm_path.write_text(vm)

# UI labels.
ui_path = Path("app/src/main/java/com/lisofer/characteria/MainActivity.kt")
ui = ui_path.read_text()
ui = replace_once(
    ui,
    '                SessionStatus.INVOCATION_ARMED -> "Segundo plano · decí «yo te invoco»"\n                SessionStatus.INVOCATION_ACTIVE -> "Segundo plano · decí «podés retirarte»"\n',
    '                SessionStatus.INVOCATION_ARMED -> "Segundo plano · «[personaje], are you here?»"\n                SessionStatus.INVOCATION_ACTIVE -> "Cambiar: «[personaje], are you here?» · salir: «get out»"\n',
    "invocation UI hints",
)
ui_path.write_text(ui)

# Foreground notification copy.
service_path = Path("app/src/main/java/com/lisofer/characteria/InvocationForegroundService.kt")
service = service_path.read_text()
service = replace_once(
    service,
    '            if (active) "Decí «podés retirarte» para apagarlo."\n            else "Esperando «yo te invoco»."\n',
    '            if (active) "Cambiar: «nombre, are you here?» · cerrar: «get out»."\n            else "Esperando «nombre del personaje, are you here?»."\n',
    "foreground notification hints",
)
service_path.write_text(service)

print("Named invocation patch applied successfully")
