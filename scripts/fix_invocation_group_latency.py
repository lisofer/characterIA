from pathlib import Path

path = Path('app/src/main/java/com/lisofer/characteria/CharacterViewModel.kt')
s = path.read_text()

# 1) Invocation: once the full command is already visible in input transcription,
# start the character connection immediately instead of waiting for Gemini turnComplete/VAD.
old = '''                    if (connectionPurpose == ConnectionPurpose.WAKE) {
                        pendingInvocationProfileIds = targetIds
                        _ui.update { it.copy(statusDetail = "Invocando a $targetName…") }
                    } else if (connectionPurpose == ConnectionPurpose.BACKGROUND_ACTIVE) {
                        pendingInvocationProfileIds = null
                        activateBackgroundCharacters(targetIds)
                    }
'''
new = '''                    if (connectionPurpose == ConnectionPurpose.WAKE) {
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
'''
if old not in s:
    raise SystemExit('invocation block not found')
s = s.replace(old, new, 1)

# Add invocation timing state.
old = '''    private var ignoreInvocationCommandsUntilMs: Long = 0L

    private data class GroupSegment(val speakerId: String, val text: String)
'''
new = '''    private var ignoreInvocationCommandsUntilMs: Long = 0L
    private var invocationConnectStartedAtMs: Long = 0L

    private data class GroupSegment(val speakerId: String, val text: String)
'''
if old not in s:
    raise SystemExit('invocation timing anchor not found')
s = s.replace(old, new, 1)

# Log real invocation connection time when active Gemini becomes ready.
old = '''                ConnectionPurpose.BACKGROUND_ACTIVE -> {
                    startMic()
                    val name = activeDisplayName()
                    _ui.update {
'''
new = '''                ConnectionPurpose.BACKGROUND_ACTIVE -> {
                    startMic()
                    val name = activeDisplayName()
                    val startedAt = invocationConnectStartedAtMs
                    if (startedAt > 0L) {
                        diag("Invocación lista en ${SystemClock.elapsedRealtime() - startedAt} ms · $name")
                        invocationConnectStartedAtMs = 0L
                    }
                    _ui.update {
'''
if old not in s:
    raise SystemExit('background ready anchor not found')
s = s.replace(old, new, 1)

# 2) Group TTS: do NOT hold back eight ordinary characters on every streaming update.
# Hold back only a suffix that can actually be the beginning of an unfinished speaker marker.
old = '''        val hasNext = groupTtsSegmentIndex + 1 < groupParsedSegments.size
        val safeText = if (!hasNext && !groupModelTurnComplete) {
            segment.text.dropLast(minOf(GROUP_MARKER_HOLDBACK_CHARS, segment.text.length))
        } else {
            segment.text
        }
'''
new = '''        val hasNext = groupTtsSegmentIndex + 1 < groupParsedSegments.size
        val safeText = if (!hasNext && !groupModelTurnComplete) {
            withoutIncompleteGroupMarkerTail(segment.text)
        } else {
            segment.text
        }
'''
if old not in s:
    raise SystemExit('group holdback block not found')
s = s.replace(old, new, 1)

# Add precise marker-tail protection helper before incrementalDelta.
anchor = '''    private fun incrementalDelta(previous: String, current: String): String {
'''
helper = '''    private fun withoutIncompleteGroupMarkerTail(text: String): String {
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

'''
if anchor not in s:
    raise SystemExit('incremental delta anchor not found')
s = s.replace(anchor, helper + anchor, 1)

# Strengthen marker format so the parser can route the first voice immediately.
old = '''- [[P1]] representa exclusivamente a ${first.profileName}.
- [[P2]] representa exclusivamente a ${second.profileName}.
- Cada intervención debe comenzar EXACTAMENTE con [[P1]] o [[P2]].
'''
new = '''- [[P1]] representa exclusivamente a ${first.profileName}.
- [[P2]] representa exclusivamente a ${second.profileName}.
- El primer carácter de cada respuesta debe ser el primer [ de [[P1]] o [[P2]]: no antepongas espacios, saludos ni texto.
- Cada intervención debe comenzar EXACTAMENTE con [[P1]] o [[P2]].
'''
if old not in s:
    raise SystemExit('group prompt marker block not found')
s = s.replace(old, new, 1)

# Faster fallback only when Gemini violates the 6-character marker protocol.
s = s.replace('private const val GROUP_PREFIX_FALLBACK_CHARS = 48', 'private const val GROUP_PREFIX_FALLBACK_CHARS = 16')
s = s.replace('        private const val GROUP_MARKER_HOLDBACK_CHARS = 8\n', '        private val GROUP_SPEAKER_MARKERS = listOf("[[P1]]", "[[P2]]")\n')

path.write_text(s)
