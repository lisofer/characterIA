# NEXO CV — asistente accesible de currículums

Versión inicial funcional de una aplicación nueva, sin utilizar el código anterior ni Fish Audio.

## Qué trae

- Portal único con contraseñas separadas para alumnos y administrador.
- Identificación persistente por cookie segura y perfil único por navegador; vuelve al CV que había dejado.
- El botón violeta **reinicia y borra definitivamente** los datos, registros y PDF de ese perfil, previa confirmación.
- Interfaz de cuatro controles de colores: colgar/iniciar llamada, micrófono pulsar/terminar, teclado y reiniciar.
- Gemini `gemini-3.8-live`, con respaldo `gemini-3.1-flash-live-preview` si falla la conexión por cuota o indisponibilidad. La voz seleccionada no cambia al pasar al respaldo.
- Subtítulos de una sola línea: medición del ancho real, salto solo por palabras completas y ajuste para palabras particularmente largas.
- Ocho fotogramas PNG para ojos abiertos/cerrados × boca reposo/A/O/E. Admite imágenes transparentes, siempre con `object-fit: contain` por defecto, además de controles de escala y posición.
- Animación labial a partir del audio PCM reproducido, adelanto/retardo (-250 a +250 ms), suavizado, sensibilidad, amplitud y parpadeo.
- Administrador: subir/reemplazar las ocho imágenes, previsualizar móvil/escritorio, seleccionar voces, escucharlas, modificar el prompt único y la personalidad.
- Base de datos SQLite en un volumen Railway (`/data`) para conservar datos, eventos, imágenes y PDF entre reinicios y despliegues.
- Herramientas Gemini para consultar, agregar/corregir campos y generar el CV PDF tras confirmación.

## Requisitos

Node.js 22.13+ y clave `GEMINI_API_KEY` de Google AI Studio, con acceso y cuota al modelo Live.

### Ejecutar en tu computadora

```bash
cp .env.example .env
# Editar .env con las contraseñas y GEMINI_API_KEY; para local configurar DATA_DIR=./local-data
npm install
# Exportar las variables: npm start no carga automáticamente .env en todos los entornos
node --env-file=.env server.js
```

Abrí `http://localhost:3000`. Para que el micrófono funcione de forma segura en un dominio público se necesita HTTPS; Railway lo ofrece.

### Railway

1. Crear **un repositorio nuevo**, separado del anterior, y subir los archivos de este proyecto.
2. Conectar el repositorio a **un servicio Node** de Railway de la cuenta elegida (`brayanmomosok@gmail.com`).
3. Configurar las variables `GEMINI_API_KEY`, `ADMIN_PASSWORD`, `STUDENT_PASSWORD`, `NODE_ENV=production` y `DATA_DIR=/data`. Elegir contraseñas largas y distintas.
4. En el servicio, adjuntar un **volumen persistente montado en `/data`**. Se necesita *antes de la primera prueba real*.
5. Configurar respaldos de volumen y dominio HTTPS. Arrancar con **una sola réplica** mientras se usa SQLite.
6. Subir los ocho archivos PNG desde el panel de administración; los PNG **no vienen incluidos** porque las imágenes originales no estaban adjuntas en esta conversación.
7. Probar con la API Key real: micrófono, audio saliente, transcripción, cambio de modelo y una generación de PDF. Comprobar cuota y precios antes de un uso público.

### Orden exacto de imágenes

| Índice | Ojos | Boca |
|---|---|---|
| 1 | abiertos | reposo |
| 2 | cerrados | reposo |
| 3 | abiertos | A |
| 4 | cerrados | A |
| 5 | abiertos | O |
| 6 | cerrados | O |
| 7 | abiertos | E |
| 8 | cerrados | E |

Las imágenes se guardan en `/data/frames/0.png` a `/data/frames/7.png`. Se recomienda mantener la referencia original de 1080×1620 px, encuadre idéntico y fondo transparente.

## Persistencia y seguridad

SQLite guarda perfiles, cambios, historial conversacional resumido, sesiones y documentos. La cookie de sesión contiene un token aleatorio (no el nombre ni un ID público). No se usa IP ni fingerprinting.

La contraseña de alumnos compartida **no es una identidad individual**. Cada navegador recibe un perfil distinto. Si dos personas comparten navegador, deben usar el botón de reinicio para borrar el perfil de la persona anterior. Si se borran cookies/datos de navegación se pierde el acceso al perfil previo, aunque los registros siguen en el volumen hasta una eliminación explícita. Para usuarios reales conviene incorporar recuperación de perfiles y administración de retención de datos más adelante.

El botón reiniciar **elimina los datos del perfil activo**, incluso sus PDFs, previa confirmación. Las copias de seguridad de Railway pueden mantener una copia temporal hasta que venza su retención.

La app guarda información personal en el servidor y envía audio y contexto a Gemini; antes de usarla con alumnos reales, revisar consentimiento, permisos, normativa de protección de datos y políticas de retención.

## Límite de pruebas realizadas en esta entrega

Se verificaron sintaxis JavaScript, pruebas de persistencia SQLite, y maquetación en navegador de escritorio/móvil. **No se ejecutó una prueba extremo a extremo con Gemini ni se instaló/desplegó en Railway**, porque en este entorno faltó acceso al registro de paquetes npm y no se proporcionó una API Key utilizable para llamadas reales. El respaldo se implementó con los nombres de modelos oficiales, pero su funcionamiento efectivo depende de la disponibilidad y cuota de la cuenta Google.

## API principal

- `POST /api/login` y `GET /api/me`: acceso y continuidad.
- `POST /api/reset`: eliminación definitiva del perfil actual, `{ "confirm": true }`.
- `/api/live`: WebSocket de conversación segura (autenticación por cookie).
- `GET /api/cv/:doc`: descargar un PDF propio.
- `GET/PUT /api/admin/config`: configuración persistente.
- `POST /api/admin/frames/:index`: subir PNG (`multipart/form-data`, campo `image`).
- `POST /api/admin/voice-sample`: reproducir una muestra de voz.

## Pruebas

```bash
npm test
```
