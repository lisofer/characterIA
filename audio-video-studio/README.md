# Persona Studio — Audio & Video

Una aplicación separada y **mobile-first** para generar MP3 con Fish Audio y MP4 vertical con 8 imágenes PNG por conjunto.

## Funciones

- Acceso privado mediante APP_PASSWORD, sesión en cookie HttpOnly firmada por SESSION_SECRET (90 días).
- Personajes con voz de Fish mediante **reference_id** o **archivo de audio + transcripción exacta**.
- Varios conjuntos (subcarpetas) de **8 PNG** por personaje; subirlos numerados `00.png`…`07.png`.
- Biblioteca global de fondos de imagen, reutilizables entre personajes.
- Guiones escritos manualmente o asistidos opcionalmente por Gemini.
- Generación MP3 guardada con el texto exacto, el personaje, conjunto y fondo. MP4 a demanda.
- MP4 vertical de 720×1280, H.264/AAC, optimizado para teléfono; analiza volumen/pausas reales del audio para escoger PNG de boca.
- Historial y archivos persistentes en SQLite y el directorio de datos. Exportación MP4 en segundo plano dentro del servicio.

## Railway

1. En GitHub, seleccionar rama `audio-video-studio-mobile` del repositorio `lisofer/characterIA`.
2. Crear **un servicio nuevo**, para no cambiar el proyecto de TikTok Live. Configurar **Root Directory**: `/audio-video-studio` y usar el Dockerfile dentro de esa carpeta.
3. Variables de Railway: `APP_PASSWORD`, `SESSION_SECRET`, `FISH_API_KEY`, `GEMINI_API_KEY`, `DATA_DIR=/data`. Opcionales: `FISH_MODEL=s2.1-pro`, `GEMINI_MODEL=gemini-2.5-flash`.
4. Agregar un **Volume** a este servicio con **Mount path** `/data`. El volumen no se comparte automáticamente con el proyecto de TikTok y no debe montarse sobre código fuente.
5. Exponer un dominio HTTPS público (el acceso a la aplicación está protegido con clave).

No se guarda ninguna clave en GitHub ni en el navegador. APP_PASSWORD y SESSION_SECRET deben mantenerse sin cambios entre despliegues para no perder la sesión del teléfono.

**Advertencia sobre fondos y transparencia:** MP4 H.264 no permite transparencia alfa convencional. «Sin fondo» utiliza un lienzo oscuro sólido; para videos transparentes de verdad sería necesario un formato alternativo como WebM con alfa.

**Orden de PNG:** `00.png` es boca cerrada/reposo; `01.png` a `07.png` corresponden a posiciones de boca o expresiones habladas de diferente apertura. Es importante conservar la misma posición y escala del personaje entre todos los archivos. El sistema estima movimiento a partir de la energía acústica; no implementa fonemas exactos.

**Muestras de voz:** subir audios propios o para los que tengas autorización. La transcripción debe corresponder exactamente a la muestra.

**Procesamiento:** las tareas viven dentro de un único proceso del servicio; al reiniciar Railway una tarea en curso se marca interrumpida, pero los trabajos que ya terminaron persisten y se pueden descargar. Para cargas concurrentes grandes, se podría pasar a una cola persistente.

## Desarrollo local

```bash
cd audio-video-studio
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
export APP_PASSWORD='clave-de-prueba'
export SESSION_SECRET='secreto-largo-de-prueba'
export FISH_API_KEY='tu_api_key'
export GEMINI_API_KEY='tu_api_key'
export DATA_DIR=./data
uvicorn main:app --reload --port 3000
```

Tener ffmpeg instalado localmente. Abrir http://localhost:3000.

### Organización persistente

```text
/data
  studio.sqlite3
  assets/
    characters/<id>/reference*.mp3
    characters/<id>/outfits/<set-id>/00.png .. 07.png
    backgrounds/<id>.png
  outputs/<generation-id>.mp3
  outputs/<generation-id>.mp4
  tmp/ (archivos temporales de render)
```

Importante: si se destruye el volumen Railway, se pierden los datos; habilitar los backups que ofrece Railway.
