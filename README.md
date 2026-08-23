# CharacterIA Sing

Rama experimental de CharacterIA basada en `feature/android-v02`. Conserva los tres modos de entrada de la versión actual:

- **Teclado**: escribir sin dejar el micrófono escuchando.
- **Conversación**: botón central para charla fluida con escucha continua.
- **Pulsar para hablar**: botón derecho para grabar/enviar audio sin escuchar el ambiente fuera de la pulsación.

También conserva perfiles múltiples y conversaciones con hasta dos personajes seleccionados.

## Objetivo de esta rama

Probar canto espontáneo dentro de una conversación usando Fish Audio sin reemplazar la referencia zero-shot actual por un `reference_id` fijo.

CharacterIA Sing mantiene el perfil normal de Fish para habla y detecta automáticamente señales de canto antes de abrir el WebSocket de TTS. Puede reconocer:

- marcas como `[SING]`, `<SING>` o `[[SING]]`;
- símbolos musicales como `♪` o `🎵`;
- expresiones como `te canto`, `una copla`, `una payada`, `una canción`;
- respuestas con estructura de verso de varias líneas cortas.

Cuando detecta canto usa un perfil más estable:

```text
temperature = 0.25
top_p = 0.45
repetition_penalty = 1.08
chunk_length = 120
latency = normal
condition_on_previous_chunks = true
```

Para habla normal conserva:

```text
temperature = 0.7
top_p = 0.7
repetition_penalty = 1.2
chunk_length = 100
latency = low
condition_on_previous_chunks = true
```

El modo canto además hace flushes más cortos para intentar mantener mayor coherencia entre frases.

> Importante: esto busca estabilizar la melodía inventada por Fish; todavía no impone notas, MIDI ni una curva F0 externa. Fish puede seguir desafinando o cambiar de centro tonal, pero debería reducirse parte de la variabilidad.

## Flujo

```text
Micrófono / teclado / PTT
        ↓
Gemini Live
        ↓
Transcripción incremental
        ↓
Detector habla / canto
        ↓
Fish Audio zero-shot
   ↙                ↘
Habla normal      Perfil Sing
        ↓
PCM 44.1 kHz
        ↓
AudioTrack
```

## Configuración

1. Abrí **Configuración**.
2. Pegá tu API key de Gemini.
3. Pegá tu API key de Fish Audio.
4. Cargá una muestra de voz.
5. Escribí la transcripción exacta de esa muestra.
6. Ajustá la personalidad del personaje.
7. Guardá y conectá.

La voz sigue enviándose como referencia zero-shot. Esta rama no crea ni fija modelos de voz en Fish.

## Build

- Android Gradle Plugin **8.13.2**
- Gradle **8.13**
- Kotlin / Compose Compiler **2.3.21**
- Compose BOM **2026.06.00**
- `compileSdk = 36`
- `targetSdk = 36`
- JDK 17

GitHub Actions compila automáticamente un APK debug en cada push a ramas `feature/**` y publica un prerelease versionado.
