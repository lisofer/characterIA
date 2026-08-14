# CharacterIA

App Android nativa para conversar por voz con un personaje de IA usando:

- **Gemini Live** como cerebro conversacional y VAD.
- **Fish Audio** (`s2.1-pro-free`) para responder con una voz clonada a partir de una muestra local.
- **AudioRecord / AudioTrack** para entrada y reproducción PCM en tiempo real.
- **Jetpack Compose** para la interfaz.

## Flujo

```text
Micrófono (PCM 16 kHz)
        ↓
Gemini Live WebSocket
        ↓
Transcripción de salida incremental
        ↓
Fish Audio WebSocket TTS
        ↓
PCM 44.1 kHz
        ↓
AudioTrack
```

La conexión de Gemini permanece abierta entre turnos. La app habilita `sessionResumption` y `contextWindowCompression` para poder recuperar conexiones renovadas por el servidor y sostener conversaciones largas.

## Configuración en el teléfono

1. Abrí **Configuración**.
2. Pegá tu API key de Gemini.
3. Pegá tu API key de Fish Audio.
4. Cargá una muestra de voz de 10–30 segundos.
5. Escribí la transcripción exacta de esa muestra.
6. Ajustá la personalidad si querés.
7. Guardá y tocá **Conectar**.
8. Permití el micrófono.

Las API keys se cifran localmente mediante **Android Keystore**. La muestra de voz se copia al almacenamiento privado de la app y no se incluye en backups.

> Esta versión es una app personal/prototipo. Para distribuirla a terceros conviene reemplazar la API key directa de Gemini por tokens efímeros emitidos por un backend propio.

## Conversación continua

Gemini recibe PCM mono, 16 bits, 16 kHz en bloques de ~100 ms. Se usa VAD automático para detectar el final del turno. Mientras Fish reproduce la respuesta, el micrófono permanece activo y Android intenta cancelar el eco mediante `VOICE_COMMUNICATION` + `AcousticEchoCanceler`, permitiendo interrumpir la respuesta hablando.

Fish se abre por WebSocket por cada respuesta. La muestra y su transcripción se envían como referencia zero-shot y el texto de Gemini se entrega incrementalmente. El audio vuelve como PCM y se reproduce a medida que llega.

## Build

El proyecto usa:

- Android Gradle Plugin **9.3.0**
- Gradle **9.5.0**
- Kotlin / Compose Compiler **2.3.21**
- Compose BOM **2026.06.00**
- `compileSdk = 36`
- `targetSdk = 36`
- JDK 17

El repositorio incluye un workflow de GitHub Actions que compila automáticamente el APK debug y lo publica como artifact `CharacterIA-debug`.

Si abrís el proyecto localmente, usá una versión reciente de Android Studio con SDK 36 instalado y Gradle 9.5.0.

## Estado v0.1

Incluido:

- conversación de audio continua;
- Gemini 3.1 Flash Live y fallback 2.5;
- transcripción de usuario/IA en pantalla;
- Fish Audio streaming con `s2.1-pro-free`;
- clonación zero-shot con muestra local;
- interrupción de audio;
- reconexión Gemini con session resumption;
- compresión de contexto;
- configuración editable de personalidad;
- almacenamiento cifrado de API keys;
- diagnóstico dentro de la app.

Próximos pasos útiles:

- memoria autobiográfica persistente;
- convertir la muestra de Fish en `reference_id` persistente para reducir latencia;
- botón **“yo no diría eso”** para corregir personalidad;
- perfiles de personalidad versionados;
- modo manos libres con foreground service;
- tokens efímeros de Gemini para una distribución pública segura.
