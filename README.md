# GENESIS v00

Rama experimental completamente nueva dentro de `characterIA`.

**Objetivo:** una población de humanos digitales extremadamente livianos, persistentes y autónomos. El mundo corre localmente; Gemini aparece sólo cuando hace falta lenguaje o una bifurcación cognitiva compleja.

## Principios

- Sin guion, quests ni eventos narrativos programados.
- Español para conversar con los habitantes.
- No hay matrimonio, monogamia, heterosexualidad, clases sociales ni instituciones codificadas como reglas culturales. Los vínculos pueden surgir entre cualquier par de personas.
- La reproducción biológica está separada de la atracción/afecto social.
- Cada humano guarda un estado compacto: cuerpo, rasgos, necesidades, relaciones significativas, recuerdos e ideas.
- La memoria es subjetiva y limitada.
- Nacimiento, envejecimiento, enfermedad y muerte existen en el kernel.
- El clima usa una dinámica caótica simple; los desastres son consecuencias del estado físico, no eventos escritos por Gemini.
- Los habitantes pueden transmitir ideas entre sí.
- Gemini no escribe la trama: ocasionalmente actúa como la cognición privada de una persona y puede proponer una intención o una idea nueva.

## Tiempo

El mundo guarda el último timestamp real del teléfono. Al volver a abrir la app calcula el tiempo real transcurrido y lo multiplica por la escala elegida.

Controles iniciales: `PAUSA`, `1×`, `10×`, `100×`, `1000×`, `+1 día`, `+30 días`, `+1 año`.

El catch-up usa pasos cada vez más gruesos para poder saltar meses/años sin simular cada frame.

## IA

En la app tocá **API** y pegá tu Gemini API key. Se usa `gemini-2.5-flash-lite` mediante REST directo, sin SDK pesado.

- Conversar con una persona: llamada a Gemini.
- Pensamiento autónomo: como máximo aproximadamente una llamada cada 90 s reales **y** cada 12 h simuladas.
- Movimiento, fisiología, vínculos, reproducción, enfermedad, clima y tiempo: locales, sin API.

La key se guarda localmente en preferencias de la app en esta v00.

## Peso

El proyecto evita Compose, AndroidX, motores de juego y SDKs de IA. Usa `android.app.Activity`, `Canvas`, archivos binarios y `HttpURLConnection` para mantener el APK y el runtime lo más chicos posible.

## Estado de v00

Primera prueba de concepto: 40 humanos, barrio pixel 2D, tiempo persistente, relaciones sin restricción de sexo, reproducción biológica, enfermedad, muerte, recuerdos compactos, ideas transmisibles y chat por texto.

La meta inmediata no es que parezca un juego terminado. Es dejarlo correr, adelantar años y comprobar si al volver existen vidas verdaderamente diferentes.
