# Respaldo persistente — Persona Studio en Railway

Este proyecto incluye sincronización opcional entre dispositivos para **perfiles, personalidades, voces de referencia, PNG, fondos, temáticas e historiales de debate**.

**Importante:** el servidor solo habilita esta función cuando encuentra un volumen realmente montado. Si no hay volumen, no escribe archivos en el disco temporal de Railway y la pestaña **Perfiles → Respaldo en la nube** muestra la advertencia. No confundas un deploy correcto con una copia de seguridad ya realizada.

## Activación en Railway

1. Abrí el proyecto de Railway que despliega **lisofer/characterIA**, rama **persona-studio-railway**.
2. Elegí el servicio web **Persona Studio** y agregale un **Volume** persistente.
3. Usá como **Mount Path**: `/data`. No hace falta crear `PERSISTENT_DATA_DIR` cuando usás ese punto de montaje.
4. Aplicá el cambio y esperá el nuevo despliegue. Un volumen de Railway es independiente del código y conserva los datos entre desplegues normales. No elimines el volumen: **borrar el volumen elimina los datos**.
5. En la app: **Perfiles → Respaldo en la nube**. Tiene que decir que la nube está lista.

Si ya usás un punto de montaje diferente, agregá la variable `PERSISTENT_DATA_DIR` con la ruta absoluta de ese volumen.

## Primera migración sin perder información

Los datos anteriores siguen en el almacenamiento **local del navegador**. Ningún deploy migrará automáticamente esos archivos para evitar sobrescribir los que están en otro dispositivo.

1. En el dispositivo que tenga la versión más completa, ingresá a **Perfiles**. Se recomienda pulsar primero **↓ Respaldo local** para descargar un archivo completo.
2. Pulsá **☁ Guardar este dispositivo** y confirmá. El sistema sube la metadata y luego los PNG, audios de referencia y fondos binarios al servidor.
3. Esperá el mensaje **✓ Guardado en la nube · versión N** antes de cambiar de dispositivo.
4. En el otro dispositivo, iniciá sesión, abrí **Perfiles** y, si tenía datos diferentes, descargá antes su respaldo local.
5. Pulsá **↓ Recuperar de la nube** y confirmá. Se reemplazará la biblioteca local de ese navegador con la copia elegida.

Una vez vinculado, se comprueban actualizaciones cada 12 segundos y se guardan los cambios cuando el debate no está hablando. Si ambos dispositivos cambiaron cosas al mismo tiempo, **se detiene la sincronización y se muestra un conflicto**, sin sobrescribir ninguno de los dos silenciosamente. La selección manual Guardar/Recuperar resuelve el conflicto.

**Salida LIVE:** la ventana secundaria 9:16 usa los archivos locales del mismo navegador y no sincroniza datos directamente.

## Respaldo adicional

**↓ Respaldo local** genera un archivo JSON con configuraciones y los binarios incluidos, para conservarlo fuera de Railway. **↑ Importar respaldo** permite recuperarlo sin conexión al volumen. No compartas esos archivos: pueden contener voces de referencia y conversaciones privadas.

## Seguridad y límites

- Todas las rutas `/api/cloud/...` requieren la sesión privada habitual y rechazan solicitudes de escritura de otros orígenes.
- Se usan hashes SHA-256 para los archivos, y las copias JSON se guardan mediante escritura temporal y renombrado atómico.
- Los cambios se protegen con un número de revisión: una copia hecha desde otro navegador no se reemplaza automáticamente cuando hay conflicto.
- Tamaño máximo por archivo: 20 MB. La copia de configuraciones/historiales tiene límites de tamaño para proteger el servidor.
- El volumen es persistente en los despliegues de Railway, **pero no equivale a una segunda copia independiente**. Conservá respaldos externos para protegerte ante borrado del volumen, problemas de cuenta o errores operativos.
- La clave de Gemini y de Fish sigue en Variables del servidor, **no se guarda en las copias de perfiles**.

## Pruebas

```bash
npm test
```

Incluye pruebas de archivos binarios, SHA-256, estados atómicos, control de versiones y validación de entradas.
