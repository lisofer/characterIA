# CharacterIA

CharacterIA es una app Android experimental para conversar por voz o texto con personajes configurables, usando Gemini Live para la conversación y Fish Audio para la voz clonada.

## Android v02

La rama `feature/android-v02` parte de `feature/android-v01` y mantiene tres modos de entrada separados:

- **Teclado:** escribe sin dejar el micrófono abierto.
- **Conversación continua:** el botón central mantiene el micrófono activo para una charla fluida.
- **Pulsar para hablar:** el botón derecho abre el micrófono solamente mientras se mantiene presionado.

También permite invocar dos personajes de dos maneras:

- por voz, como antes: `personaje1 + personaje2, are you here?`;
- desde **Configuración > Perfiles**, seleccionando dos perfiles y tocando **Invocar**.

La conversación grupal conserva el historial compartido de esa pareja de personajes.

## Rendimiento

`android-v02` incluye reproducción PCM de Fish Audio en un hilo dedicado, menor buffering de salida, modo de baja latencia de Fish y menos animaciones de scroll durante el streaming de Gemini.

## Compilación

El workflow de GitHub Actions genera automáticamente una APK debug para las ramas `feature/**`.
