# Persona Studio 3.1 — Gemini + Fish Audio (acceso privado)

Aplicación web de **un personaje** con ocho imágenes PNG, personalidad de Gemini, voz de Fish Audio S2.1 y perfiles locales. Funciona desde Chrome en Android mediante HTTPS. No modifica la rama `main` de CharacterIA.

## Despliegue en Railway desde el celular

1. En Railway, creá un **proyecto nuevo**, elegí **Deploy from GitHub Repo** y el repositorio `lisofer/characterIA`.
2. **Seleccioná la rama `persona-studio-railway`** en Settings → Source. NO uses `main`: contiene la app Android original.
3. En **Variables**, agregá estos cuatro valores (nunca los pongas en GitHub):

| Variable | Valor |
|---|---|
| `APP_ACCESS_TOKEN` | Tu contraseña/token PRIVADO para abrir Persona Studio, **mínimo 24 caracteres** aleatorios. |
| `SESSION_SECRET` | Otro secreto **distinto**, aleatorio, de **mínimo 32 caracteres**; firma las cookies de sesión. |
| `GEMINI_API_KEY` | Tu API key real de Gemini. |
| `FISH_API_KEY` | Tu API key real de Fish Audio. |

4. Railway ejecuta `npm start` con Node 20+. En **Settings → Networking**, generá el dominio público HTTPS.
5. Abrí la URL desde Chrome Android. La primera pantalla te pide **APP_ACCESS_TOKEN**; si es correcto, abre Persona Studio. La sesión dura hasta 7 días o hasta que cierres sesión.
6. Dentro, cargá las ocho imágenes, configurá personalidad, voz (Voice ID o muestra + transcripción exacta), probá Fish y mantené el botón de hablar pulsado para grabar. Soltalo para enviar.

Para generar `APP_ACCESS_TOKEN` y `SESSION_SECRET` podés usar un gestor de contraseñas (generador aleatorio); **no repitas** un mismo valor. Si cambiás cualquiera de los dos se invalidarán las sesiones anteriores.

## Qué protegen estas medidas

- La página principal y los endpoints Gemini/Fish requieren autenticación (cookie de sesión firmada `HttpOnly`, `SameSite=Strict`, `Secure` sobre HTTPS).
- Login con comparación de tiempo constante, límite de intentos y protección básica frente a solicitudes de otros sitios.
- Las llamadas a Gemini y Fish las realiza **server.js** con claves de entorno. Las keys **nunca** se incorporan al HTML, a peticiones del navegador ni al repositorio.
- Límite de solicitudes autenticadas contra abuso. La web sólo devuelve si la clave fue configurada, nunca su contenido.
- `GET /healthz` es público y solo devuelve `{ok:true}` para comprobaciones de disponibilidad.

### Límites de privacidad

- El historial, la personalidad y el texto de la muestra se guardan en el **almacenamiento local del navegador** y las imágenes/audio en IndexedDB, **sin cifrado adicional**. Esto no equivale a una base de datos privada o un almacenamiento cifrado: cualquier persona con acceso físico y técnico al mismo perfil de Chrome podría llegar a leerlos. El botón «Cerrar sesión» protege el acceso a la web, pero no borra los datos locales del dispositivo.
- Gemini recibe la conversación y las grabaciones de voz para transcribir; Fish recibe texto y opcionalmente la muestra de voz con transcripción. Las API keys siguen protegidas.
- No compartas el token ni la URL de configuración de Railway. Si sospechás filtración, cambiá `APP_ACCESS_TOKEN` y `SESSION_SECRET` en Variables de Railway.
- Modo de un solo usuario. No hay administración de varios usuarios ni almacenamiento compartido entre dispositivos. No se sincronizan automáticamente los perfiles entre celular y computadora.

## Archivos y pruebas

- `index.html`: interfaz móvil, PNG, perfiles y reproducción.
- `server.js`: login/sesiones, proxies Gemini y Fish, límites de acceso.
- `package.json`: inicio sin dependencias externas (`npm start`).
- `tests.test.js`: pruebas con proveedores simulados (`npm test`).

**No publiques archivos `.env` ni claves reales**. La clonación de voz debe hacerse únicamente con muestras para las cuales tenés autorización. Las pruebas simuladas no sustituyen el ensayo con Gemini, Fish y tu teléfono reales.