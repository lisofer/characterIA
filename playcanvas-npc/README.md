# PlayCanvas NPC con voz + Gemini + memoria en Railway

Backend **independiente** para incorporar personajes hablantes en un juego 3D de PlayCanvas.

Esta carpeta vive en una **rama separada** de characterIA para no alterar la app Android existente. No requiere ZIPs de ChatGPT.

## Qué hay implementado
- Audio de micrófono del navegador -> Railway -> Gemini Live; la respuesta sale con voz natural de Gemini.
- Un NPC de ejemplo, **Dante**, con personalidad editable desde el panel web.
- Memoria por NPC y por jugador en el archivo /data/npc-data.json; resúmenes automáticos al cerrar una conversación (con modelo Flash-Lite).
- Botón **Restablecer NPC** desde PlayCanvas y panel privado; la personalidad nunca se borra al resetear.
- La clave GEMINI_API_KEY queda **solo en Railway**, jamás dentro del script de PlayCanvas.
- Preparado para incorporar Fish Audio **en una versión siguiente**; no está implementado todavía.

## 1. Deploy de GitHub en Railway
1. Crear un servicio de GitHub conectado a **lisofer/characterIA**.
2. Elegir la rama **feature/playcanvas-npc-live** para este servicio.
3. En Settings > Root Directory, escribir **/playcanvas-npc**. La raíz de la app NO es el README Android.
4. Railway detectará Node por package.json. Comando de inicio opcional: **npm start**.
5. Agregar un **Volume** al servicio y montarlo en **/data** (mount path absoluto).
6. Variables de entorno del servicio:

   GEMINI_API_KEY=pegar-la-clave-real-aqui
   ADMIN_TOKEN=un-token-largo-aleatorio
   APP_ORIGINS=https://launch.playcanvas.com,https://playcanv.as,https://TU-SERVICIO.up.railway.app
   GEMINI_LIVE_MODEL=gemini-3.8-live
   GEMINI_MEMORY_MODEL=gemini-3.5-flash-lite
   DATA_FILE=/data/npc-data.json

   No definir PORT manualmente; Railway lo suministra.

7. En Networking, generar un dominio HTTPS y reemplazar **TU-SERVICIO** por el dominio real en APP_ORIGINS, conservando los orígenes exactos. Redeploy para aplicar la variable.
8. Abrir https://TU-SERVICIO.up.railway.app/api/health y comprobar ok:true.
9. Abrir https://TU-SERVICIO.up.railway.app/admin.html y pegar ADMIN_TOKEN para editar la personalidad.

En Windows se puede generar un token seguro mediante:
    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

**No pongas claves en GitHub, PlayCanvas, capturas ni mensajes de chat.**

## 2. Vincular el NPC dentro del juego PlayCanvas
1. Abrí tu proyecto en el Editor de PlayCanvas.
2. Desde GitHub, obtené el script **playcanvas/npcGeminiVoice.js** de esta misma carpeta.
   Como ya tenés Codex + MCP, pedile a Codex que cree el script dentro de Assets sin pasar archivos por ChatGPT.
3. Creá una entidad que represente al NPC, por ejemplo una cápsula 3D llamada **Dante**.
4. En esa entidad agregá el componente **Script** con **npcGeminiVoice**.
5. Inspector:
   - Backend URL: https://TU-SERVICIO.up.railway.app
   - NPC ID: dante
   - Player Camera: entidad cámara FPS
   - Interaction Distance: 4
6. Lanzá el juego en HTTPS; permití el micrófono.
7. Acercate al NPC y pulsá **E** o **Hablar**. Para borrar sus recuerdos pulsá **Restablecer NPC**.

Si Codex detecta que tu proyecto usa **ESM Scripts** en vez de scripts clásicos, deberá adaptar la envoltura pc.createScript a ESM antes de importar; la lógica de comunicación es reutilizable.

## Sincronización automática de nombre, personalidad y voz

**Railway es la fuente única de configuración.** El npcId de PlayCanvas (dante por compatibilidad con recuerdos existentes) es solamente una clave técnica: no define el nombre visible.

- Al cargar el juego, el script consulta GET /api/public/npcs, que devuelve el nombre y la voz, sin exponer el prompt privado.
- Cada 5 segundos vuelve a consultar el nombre y actualiza los textos y el nombre de la entidad 3D durante la ejecución.
- Al conversar, Railway lee el perfil vigente y construye systemInstruction usando el nombre y prompt más recientes. El nombre configurado prevalece sobre nombres antiguos escritos dentro del prompt.
- Al guardar el perfil en /admin.html, el servidor avisa a las sesiones activas con profile_updated y las cierra con código 4001. El script PlayCanvas abre una nueva conexión automáticamente con el nuevo perfil, SIN borrar la memoria.
- Si no está conversando, la siguiente conexión ya usa la configuración actualizada.
- Después de instalar UNA VEZ el npcGeminiVoice.js actualizado, no hace falta volver a Codex cada vez que cambies la personalidad o el nombre.

**Prueba:** En Railway cambiá Nombre a Nira y su prompt a una mujer IA del mundo digital. Guardá. El nombre debe cambiar en el juego sin modificar el script. Iniciá conversación y preguntá cómo se llama. Cambiá después un rasgo de personalidad durante la charla: la conexión debe renovarse conservando la memoria. El botón Restablecer NPC sigue siendo la única acción que borra recuerdos.
## 3. Panel administrativo
URL: /admin.html

- Modificar el nombre, la voz nativa de Gemini y el prompt de personalidad.
- Ver memoria de un jugador introduciendo su ID.
- Resetear la memoria individual sin alterar el prompt.
- Resetear TODAS las memorias de un NPC.
- El token no se guarda en localStorage; se ingresa en cada visita.

El ID de jugador del script web se genera una vez y se guarda en localStorage del navegador del juego. El ID del panel debe coincidir si querés inspeccionar su memoria; para probar, podés verlo en DevTools > Application > Local Storage > umbral_player_id.

## 4. Memoria y velocidad
- Gemini Live recibe **una única vez**, al abrir conexión, el prompt y un resumen corto más hasta 8 turnos recientes.
- No se consulta la base de datos en cada bloque de audio.
- El resumen se actualiza por separado, **al terminar** una conversación, usando gemini-3.5-flash-lite.
- Se guardan solo hasta 16 turnos recientes y un resumen de 1200 caracteres; no es una transcripción infinita ni un aprendizaje de pesos del modelo.
- El botón Reset elimina esos recuerdos y cierra la sesión, evitando la restauración de resúmenes anteriores.

## 5. Límites del prototipo
- Se diseñó para una primera prueba con pocos jugadores. El acceso anónimo tiene rate limits y origen restringido, pero **no sustituye autenticación fuerte**. Antes de hacer público un multijugador, incorporar autenticación real y cuotas por cuenta.
- El micrófono usa ScriptProcessorNode, que es compatible con navegadores actuales pero está obsoleto; para producción sustituir por AudioWorklet.
- El WebSocket transmite audio PCM16 de 16 kHz hacia Gemini; recibe PCM16 de 24 kHz. Puede haber latencia por el servidor intermedio.
- Al cerrar la sesión de Live, se pierde el audio no transcrito; el sistema guarda transcripciones y resumen, no grabaciones. Esto protege almacenamiento y reduce costo.
- Live API puede desconectar conexiones periódicamente; este prototipo vuelve a abrir sesión manualmente. En producción añadir reconexión con sessionResumption y pruebas de interrupciones.
- Fish Audio no está activo. Cuando se implemente, se debe separar la generación del texto y la síntesis para poder pasar a Fish y volver a Gemini TTS en caso de fallo.
- No se pudo verificar la llamada real a Gemini ni el renderizado de PlayCanvas sin configurar la API y el proyecto.

## API
GET /api/health
GET /api/public/npcs
POST /api/session (navegador: npcId, playerId)
WSS /live?token=... (mensajes audio, text, reset)
GET /api/admin/npcs (Bearer ADMIN_TOKEN)
PUT /api/admin/npcs/:id
GET /api/admin/memory/:npcId/:playerId
POST /api/admin/reset/:npcId/:playerId
POST /api/admin/reset-all/:npcId

## Tests
    npm install
    npm test

GitHub Actions ejecuta pruebas automáticas de persistencia y reseteo en cada push a esta rama.
