# Guardado permanente para Mi primer CV

El servicio web gratuito de Render elimina los archivos locales con reinicios, pausas y despliegues. Esta rama integra almacenamiento externo en un **bucket privado de Supabase**, sin exponer ninguna credencial al navegador.

## Qué se guarda

- `settings.json`: voz Fish, ID, transcripción, modelo Gemini, personalidad, ajustes de encuadre, micrófono y labios.
- `assets/state-0.png` a `assets/state-7.png`: los ocho PNG animados.
- `assets/voice-sample.bin` y `assets/voice-sample-mime.txt`: muestra de voz y tipo de archivo.
- `sessions/*.json`: entrevistas y estadísticas.
- `cvs/*.pdf`: currículums generados.

El contenido se almacena en la carpeta `appdata/` del bucket, configurado como **privado**. Toda lectura y escritura pasa por el servidor autenticado.

## Activación en Render sin tarjeta

1. Crear una cuenta gratuita y proyecto en [Supabase](https://supabase.com/). Los proyectos gratuitos pueden suspenderse por inactividad, pero el contenido permanece en el almacenamiento externo mientras el proyecto exista.
2. En Supabase: **Project Settings → API Keys**. Obtener el `service_role` (secret, **no publicar ni usar en el navegador**), y la **Project URL**.
3. En Render → CVASISTENTE → Environment, agregar:
   - `SUPABASE_URL`: `https://TU-PROYECTO.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY`: valor secreto de `service_role`
   - `SUPABASE_BUCKET`: `mi-primer-cv-privado` (opcional)
4. Cambiar a la rama **`cv-storage-supabase`** para el servicio y desplegar. El backend crea el bucket privado si no existe y restaura su contenido en cada arranque.
5. Verificar en el panel `/admin` que aparezca **«Conectado a Supabase»**. Si no aparece, no se debe considerar asegurado el guardado.

No se requieren cambios en las variables de Gemini y Fish existentes.

## Precaución al migrar por primera vez

**No despliegues otra versión de Render Free sin tener una copia de tus PNG y audio actuales**. El primer despliegue no puede leer el disco efímero del proceso anterior. Guardá una copia de los originales y volvé a cargarlos una única vez cuando el panel indique «Conectado a Supabase». Después, los siguientes despliegues recuperan todo desde el bucket.

La configuración actual de Render y el almacenamiento efímero no son una copia de seguridad confiable. Con los datos conectados a Supabase, una falla de almacenamiento impide confirmar nuevas cargas, para no informar falsamente que quedaron guardadas.

## Privacidad

La API secret de Supabase solo existe en las variables privadas de Render. El bucket no es público. Los CV y sesiones pueden contener datos personales: para demostraciones usar datos ficticios o consentimiento válido, limitar el acceso administrativo y eliminar registros cuando ya no sean necesarios.

## Estado

Integración implementada y verificada por análisis de código; **sin prueba contra una instancia Supabase real** hasta que se configuren las credenciales. Esta rama está separada de `cv-asistente-accesible` para no provocar un despliegue prematuro que borre datos locales.
