from pathlib import Path

path = Path('app/src/main/java/com/lisofer/characteria/CharacterViewModel.kt')
s = path.read_text()

old = '''        turnFinalizeJob?.cancel()
        turnFinalizeJob = null
        turnCompletePending = false
        mic.stop()
        gemini.disconnect()
        cancelFish("Cambio de personaje")
        player.interrupt()
'''
new = '''        turnFinalizeJob?.cancel()
        turnFinalizeJob = null
        turnCompletePending = false
        // Keep AudioRecord alive across invocation switches. Gemini drops PCM while setupComplete=false.
        gemini.disconnect()
        cancelFish("Cambio de personaje")
        player.interrupt()
'''
if old not in s:
    raise SystemExit('activate mic-stop block not found')
s = s.replace(old, new, 1)

old = '''        discardCurrentUserMessage()
        finalizeAiMessage()
        persistConversation()
        mic.stop()
        gemini.disconnect()
        cancelFish(reason)
        player.interrupt()

        connectionPurpose = ConnectionPurpose.WAKE
'''
new = '''        discardCurrentUserMessage()
        finalizeAiMessage()
        persistConversation()
        // Keep the same microphone capture alive while returning to the wake Gemini session.
        gemini.disconnect()
        cancelFish(reason)
        player.interrupt()

        connectionPurpose = ConnectionPurpose.WAKE
'''
if old not in s:
    raise SystemExit('return-to-wake mic-stop block not found')
s = s.replace(old, new, 1)

path.write_text(s)
