# Persona Studio 3 — Gemini + Fish Audio

Aplicación web para un personaje con personalidad configurable, respuestas de Gemini, voz Fish Audio y ocho PNG faciales. Preparada para funcionar desde Chrome en Android después de publicarse con HTTPS.

## Desplegar en Railway desde el teléfono

1. En Railway, creá un proyecto o servicio nuevo y seleccioná **Deploy from GitHub repo**.
2. Elegí el repositorio **`lisofer/characterIA`**.
3. **Muy importante:** en el servicio, abrí **Settings → Source** y seleccioná la rama **`persona-studio-railway`** como rama de despliegue. **No uses `main`**: contiene una aplicación distinta.
4. Railway detecta el `package.json` en la raíz y ejecuta `npm start`. Usá Node.js 20 o posterior.
5. En **Settings → Networking**, generá un dominio público (`*.up.railway.app`); debe empezar con `https://` para que Android permita pedir acceso al micrófono.
6. Entrá a la URL HTTPS desde **Chrome en Android**. En **Cerebro**, pegá tu propia API key de Gemini; en **Voz**, tu API key de Fish Audio.
7. Podés configurar Voice ID o cargar muestra de 10–30 segundos con su transcripción literal; cargá tus ocho PNG y probá la voz con **Probar Fish**.
8. Tocá **Activar micrófono** una vez. Después mantené apretado el botón de hablar y soltá para enviar.

**No hace falta poner API keys en variables de Railway.** Esta versión las solicita dentro de la app en cada sesión y no las guarda en el repositorio ni en el servidor. Si no configurás Fish, podés seleccionar voz del navegador.

## Diseño técnico

- `index.html`: interfaz adaptable, perfiles separados, Gemini, PNG, reproducción de voz.
- `server.js`: servidor HTTP y puente a la API de Fish (MessagePack) con `GET /api/health` y `POST /api/fish/tts`.
- `package.json`: script `npm start` sin dependencias externas.
- `tests.test.js`: seis pruebas simuladas del puente Fish (ejecutar `npm test`).

La animación de boca se calcula a partir del **texto** de Gemini, no de los ruidos del micrófono. La correspondencia fonética es aproximada; Fish entrega el audio y la app estima su temporización.

## Privacidad y seguridad

No insertes API keys en código, commits ni capturas. Los secretos se introducen en los campos de la aplicación y duran solamente la sesión de la pestaña. Fish recibe el texto, y si elegiste clonación instantánea también el audio de muestra y su transcripción. Usá voces para las que tengas autorización.

El servidor no incluye cuentas de usuario ni autenticación: el dominio que genere Railway podrá ser visitado por otras personas. Cada usuario tendrá que introducir su propia clave para usar Fish/Gemini. Para un servicio privado, hay que agregar control de acceso y límites de uso antes de distribuirlo.

## Alcance

Un personaje por conversación. La función de dos personajes simultáneos está pendiente. La app está preparada, pero la generación real con tu cuenta de Fish/Gemini y el permiso del micrófono en tu Android requieren comprobación después del despliegue.