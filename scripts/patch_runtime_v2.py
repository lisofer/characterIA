from pathlib import Path

vm_path = Path('app/src/main/java/com/lisofer/characteria/CharacterViewModel.kt')
s = vm_path.read_text()

# Gemini model fallback callback.
anchor = '        override fun onInputTranscript(fullText: String) {\n'
if 'override fun onModelChanged(model: String, reason: String)' not in s:
    insert = '''        override fun onModelChanged(model: String, reason: String) {
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
    if anchor not in s:
        raise SystemExit('listener anchor not found')
    s = s.replace(anchor, insert + anchor, 1)

# All profile loads receive the global model.
s = s.replace(
    'profiles.loadProfile(profileId, settings.geminiKey(), settings.fishKey())',
    'profiles.loadProfile(profileId, settings.geminiKey(), settings.fishKey(), settings.geminiModel())'
)
s = s.replace(
    'profiles.loadProfile(id, settings.geminiKey(), settings.fishKey())',
    'profiles.loadProfile(id, settings.geminiKey(), settings.fishKey(), settings.geminiModel())'
)

# New profiles inherit the global model.
s = s.replace(
    '''                geminiApiKey = settings.geminiKey(),
                fishApiKey = settings.fishKey(),
            )''',
    '''                geminiApiKey = settings.geminiKey(),
                fishApiKey = settings.fishKey(),
                geminiModel = settings.geminiModel(),
            )'''
)
s = s.replace(
    '''            geminiApiKey = settings.geminiKey(),
            fishApiKey = settings.fishKey(),
        )''',
    '''            geminiApiKey = settings.geminiKey(),
            fishApiKey = settings.fishKey(),
            geminiModel = settings.geminiModel(),
        )'''
)

# Model selector persists globally immediately.
anchor = '    fun newProfile() {\n'
if 'fun selectGeminiModel(model: String)' not in s:
    insert = '''    fun selectGeminiModel(model: String) {
        val selected = normalizeGeminiModel(model)
        settings.setGeminiModel(selected)
        _ui.update { state -> state.copy(config = state.config.copy(geminiModel = selected)) }
        diag("Modelo global seleccionado: $selected")
    }

'''
    if anchor not in s:
        raise SystemExit('newProfile anchor not found')
    s = s.replace(anchor, insert + anchor, 1)

s = s.replace(
    'settings.saveGlobalKeys(config.geminiApiKey, config.fishApiKey)',
    'settings.saveGlobalConnection(config.geminiApiKey, config.fishApiKey, config.geminiModel)'
)

# A+B and B+A are exactly the same pair identity.
s = s.replace(
    'val targetIds = requestedIds.distinct().take(2)',
    'val targetIds = requestedIds.distinct().sorted().take(2)'
)

# All real conversations get Search + fallback. Wake detection gets fallback but no Search.
normal_old = '''                personality = c.personality,
                history = history,
            )'''
normal_new = '''                personality = c.personality,
                history = history,
                fallbackModels = geminiFallbackChain(c.geminiModel),
                enableGoogleSearch = true,
            )'''
if normal_old in s:
    s = s.replace(normal_old, normal_new, 1)

wake_old = '''                personality = WAKE_SYSTEM_PROMPT,
                history = emptyList(),
            )'''
wake_new = '''                personality = WAKE_SYSTEM_PROMPT,
                history = emptyList(),
                fallbackModels = geminiFallbackChain(c.geminiModel),
                enableGoogleSearch = false,
            )'''
s = s.replace(wake_old, wake_new)

group_old = '''                personality = personality,
                history = history,
            )'''
group_new = '''                personality = personality,
                history = history,
                fallbackModels = geminiFallbackChain(first.geminiModel),
                enableGoogleSearch = true,
            )'''
if group_old in s:
    s = s.replace(group_old, group_new, 1)

# Robust group markers, independent of line breaks and names in normal speech.
start = s.index('    private fun parseGroupSegments(fullText: String): List<GroupSegment> {')
end = s.index('    private fun syncGroupMessages(segments: List<GroupSegment>) {', start)
parser = r'''    private fun parseGroupSegments(fullText: String): List<GroupSegment> {
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

'''
s = s[:start] + parser + s[end:]

# Keep a tiny tail buffered so a partial [[P2]] can never be spoken by P1.
old = '''        val delta = incrementalDelta(groupTtsSentText, segment.text)
        if (delta.isNotEmpty()) {
            fish?.sendText(delta)
            groupTtsSentText = segment.text
        }

        val hasNext = groupTtsSegmentIndex + 1 < groupParsedSegments.size
'''
new = '''        val hasNext = groupTtsSegmentIndex + 1 < groupParsedSegments.size
        val safeText = if (!hasNext && !groupModelTurnComplete) {
            segment.text.dropLast(minOf(GROUP_MARKER_HOLDBACK_CHARS, segment.text.length))
        } else {
            segment.text
        }
        val delta = incrementalDelta(groupTtsSentText, safeText)
        if (delta.isNotEmpty()) {
            fish?.sendText(delta)
            groupTtsSentText = safeText
        }

'''
if old not in s:
    raise SystemExit('group tts block not found')
s = s.replace(old, new, 1)

# Group prompt uses opaque routing markers instead of human names.
start = s.index('    private fun buildGroupPersonality(configs: List<AppConfig>): String {')
end = s.index('    private fun memoryPreview(config: AppConfig): String {', start)
personality = r'''    private fun buildGroupPersonality(configs: List<AppConfig>): String {
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
- Cada intervención debe comenzar EXACTAMENTE con [[P1]] o [[P2]].
- Podés usar varios marcadores en una misma respuesta si ambos hablan.
- No escribas nombres como etiquetas de hablante. No escribas dos puntos después del marcador.
- Nunca pongas texto fuera de una intervención marcada.
- Los marcadores son internos: no los expliques ni hagas referencia a ellos en el diálogo.
""".trimIndent()
    }

'''
s = s[:start] + personality + s[end:]

if 'private const val GROUP_MARKER_HOLDBACK_CHARS' not in s:
    s = s.replace(
        '        private const val GROUP_PREFIX_FALLBACK_CHARS = 48\n',
        '        private const val GROUP_PREFIX_FALLBACK_CHARS = 48\n        private const val GROUP_MARKER_HOLDBACK_CHARS = 8\n'
    )

vm_path.write_text(s)

# UI: global model selector.
ui_path = Path('app/src/main/java/com/lisofer/characteria/MainActivity.kt')
u = ui_path.read_text()
u = u.replace(
    '            onConfig = vm::updateConfig,\n            onPickVoice',
    '            onConfig = vm::updateConfig,\n            onModelSelected = vm::selectGeminiModel,\n            onPickVoice'
)
u = u.replace(
    '    onConfig: ((AppConfig) -> AppConfig) -> Unit,\n    onPickVoice',
    '    onConfig: ((AppConfig) -> AppConfig) -> Unit,\n    onModelSelected: (String) -> Unit,\n    onPickVoice'
)
u = u.replace(
    '"Las API keys son compartidas por todos los perfiles y quedan cifradas con Android Keystore."',
    '"Las API keys y el modelo de Gemini son globales: todos los personajes usan siempre la misma conexión. Las claves quedan cifradas con Android Keystore."'
)
old_menu = '''                        listOf(
                            "gemini-3.1-flash-live-preview",
                            "gemini-2.5-flash-native-audio-preview-12-2025",
                        ).forEach { model ->
                            DropdownMenuItem(
                                text = { Text(model) },
                                onClick = {
                                    onConfig { it.copy(geminiModel = model) }
                                    modelMenu = false
                                }
                            )
                        }
'''
new_menu = '''                        GEMINI_LIVE_MODELS.forEach { model ->
                            DropdownMenuItem(
                                text = { Text(model.label) },
                                onClick = {
                                    onModelSelected(model.id)
                                    modelMenu = false
                                }
                            )
                        }
'''
if old_menu not in u:
    raise SystemExit('model menu block not found')
u = u.replace(old_menu, new_menu, 1)
selector_end = '''                }
            }
            item {
                Column {
                    Text("Muestra de voz", fontWeight = FontWeight.Bold)
'''
selector_new = '''                }
                Text(
                    "Si el modelo agota cuota, CharacterIA baja automáticamente al siguiente modelo Live gratuito disponible.",
                    color = Muted,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
            item {
                Column {
                    Text("Muestra de voz", fontWeight = FontWeight.Bold)
'''
if selector_end not in u:
    raise SystemExit('selector footer not found')
u = u.replace(selector_end, selector_new, 1)
ui_path.write_text(u)
