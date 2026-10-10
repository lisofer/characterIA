# Persona Studio · almacenamiento compartido automático

Los archivos grandes y los datos privados se guardan en el volumen permanente de Railway. **GitHub almacena solamente el código fuente**: usar GitHub para guardar voces e imágenes de usuarios no es apropiado (el repositorio tiene límites de archivo, los commits no son una base de datos y expondría material privado a colaboradores).

## Requisito del servidor (una única vez)

En el proyecto Railway que publica `lisofer/characterIA`, rama `persona-studio-railway`, debe existir un volumen persistente montado en **`/data`** (o en la ruta indicada por `PERSISTENT_DATA_DIR`). **Un deploy NO es almacenamiento persistente.** El backend se niega a guardar en el disco temporal.

El estado y los recursos quedan en `/data/persona-studio-cloud-v1/`, conservándose entre despliegues normales. No elimines ni desvincules el volumen sin crear antes un respaldo.

## Sincronización (automática, no hay botón de guardar)

1. Abrí la aplicación en el celular con tu token habitual. Entrá a **Perfiles → Sincronización automática** y esperá el estado **✓ Sincronizado en la nube · versión N**.
2. Abrí la **misma URL de Railway** en la computadora, iniciá sesión y esperá unos segundos. La app descargará automáticamente la versión del celular; los personajes, voces y fondos se cargan sin importar ni exportar nada.
3. Cada edición en perfiles, temáticas, configuraciones, PNG, audios o fondos inicia una sincronización al cabo de aproximadamente 1,5 segundos; con la app abierta también se consulta el servidor cada 8 segundos.
4. La ventana secundaria LIVE 9:16 no modifica los datos; sigue recibiendo la emisión de la ventana principal mediante BroadcastChannel.

Si la computadora y el celular tenían datos distintos antes de sincronizar, el software intenta conservar ambos. Los perfiles y las temáticas con el mismo ID pero diferente contenido se duplican cuando hay conflicto verdadero, en vez de sobrescribir silenciosamente los existentes. Cambios normales al mismo personaje se actualizan sin crear copias.

Los cambios entrantes se difieren mientras un debate está reproduciéndose. Las salidas de audio no se interrumpen para refrescar los avatares. Si se está transmitiendo sin pausas, puede tardar en verse un cambio llegado de otro dispositivo.

## Verificar de verdad

- El estado en Perfiles debe decir **✓ Sincronizado** y una **versión numérica**. **No basta con tocar o ver los controles**.
- La computadora y el celular deben entrar a la **misma URL y al mismo entorno Railway**; dos despliegues de Railway distintos no comparten automáticamente un volumen.
- Sin volumen, aparece una advertencia clara y se conservan los datos locales. Para problemas de red se muestra un mensaje de error y se intenta de nuevo.
- `GET /api/cloud/status` requiere sesión y devuelve `available:true` si existe el volumen montado.
- `GET /api/cloud/state` requiere sesión y devuelve número de revisión, marca de tiempo y manifiesto de datos.

## Seguridad y copias

- Los endpoints necesitan la cookie privada y controles CSRF; el código no envía las claves secretas de Fish o Gemini.
- Los binarios de PNG, fondos y voces van separados del JSON y se verifican con SHA-256. Cada subida usa control de revisión atómico.
- **Un volumen permanente no es un backup externo**. Para una segunda copia independiente, en **Perfiles → Respaldo de seguridad (opcional)** usá **Descargar copia local**.
- Los archivos ya existentes en el navegador no se borran por actualizar el código. No borres datos de Chrome ni el volumen hasta verificar la sincronización en ambos dispositivos.

## Pruebas de regresión

```bash
npm test
```

Incluye pruebas del almacenamiento permanente y de la fusión de perfiles e imágenes entre dispositivos.
