from pathlib import Path

path = Path("app/src/main/java/com/lisofer/characteria/MainActivity.kt")
text = path.read_text()

old = '                            state.config.profileName.ifBlank { "Sin perfil" },\n'
new = '                            (state.activeCharacterNames.takeIf { it.size > 1 }?.joinToString(" + ") ?: state.config.profileName.ifBlank { "Sin perfil" }),\n'
if old not in text:
    raise SystemExit("top profile label pattern not found")
text = text.replace(old, new, 1)

old = '                    if (isUser) "VOS" else aiName.ifBlank { "CHARACTER" }.uppercase(),\n'
new = '                    if (isUser) "VOS" else message.characterName.ifBlank { aiName.ifBlank { "CHARACTER" } }.uppercase(),\n'
if old not in text:
    raise SystemExit("message speaker label pattern not found")
text = text.replace(old, new, 1)

path.write_text(text)
