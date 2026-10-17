# Mi primer CV — asistente accesible (prototipo)

Aplicación independiente alojada en la rama `cv-asistente-accesible` de `lisofer/characterIA` y ubicada en `/cv-asistente`. No modifica Persona Studio ni `main`.

## Railway (conectás tu propia cuenta)
1. Elegir repositorio `lisofer/characterIA`, **branch** `cv-asistente-accesible`.
2. Configurar **Root Directory**: `/cv-asistente`. El servicio usa `Dockerfile`.
3. Montar un **Volume** en `/data`.
4. Definir variables copiando `.env.example` y reemplazando contraseñas/secretos con valores fuertes. **Nunca subir claves al repositorio**.
5. Publicar dominio. Acceso alumnado: `/`; administrador: `/admin`. Ingresan con claves **diferentes**.
6. Entrar a `/admin`, configurar el personaje (8 PNG en orden), modelo, voz, personalidad, plantillas y texto de bienvenida; pulsar guardar.

## Voz y micrófono
- Fish Audio se llama desde el servidor usando `FISH_API_KEY`. Para voces clonadas se requiere un `reference_id` válido en Fish; el modelo de voz se configura desde el panel.
- Reconocimiento del micrófono: `SpeechRecognition / webkitSpeechRecognition` **del navegador**. Puede no estar disponible en todos los navegadores y el proveedor del navegador podría procesar voz en sus servidores. Siempre hay teclado como alternativa. Fish **sintetiza**, no transcribe, en esta versión.
- Los navegadores bloquean la reproducción automática hasta que el usuario interactúa; la bienvenida se muestra en texto y la voz se intenta reproducir, con reintento al primer toque.

## Datos y acceso
- `/data/settings.json`: configuración; `/data/assets`: 8 PNG; `/data/sessions`: entrevistas con CV estructurado, historial, tiempos y consumos; `/data/cvs`: PDF generados.
- Solo el panel administrador puede listar sesiones y descargar documentos ajenos. Cada estudiante accede únicamente a su sesión.
- Geminis jamás recibe la clave de la API; el PDF se crea con PDFKit en el servidor. Campos permitidos: nombre, localidad, teléfono, correo, perfil, educación, experiencia, habilidades, cursos e idiomas.
- La IA puede proponer terminar, pero el servidor exige que se haya mostrado la revisión y que exista confirmación expresa antes de generar el PDF.
- No se envían DNI, domicilio exacto, salud, edad ni fecha de nacimiento por defecto. Pedir consentimiento explícito antes de recopilar información personal. Para pruebas, usar identidades ficticias. El admin puede borrar una entrevista/PDF desde el panel.
- El panel registra el tiempo transcurrido de sesión, caracteres TTS y tokens cuando Gemini los devuelve; la duración de audio que registra el cliente es una **estimación**, no facturación de Fish.

## Estado
Primera versión funcional para pruebas pequeñas; no se probó todavía contra las claves reales Gemini/Fish ni en tu Railway. Para uso real con alumnos hacen falta pruebas de accesibilidad, protección de datos, límites de gasto y compatibilidad del navegador.
