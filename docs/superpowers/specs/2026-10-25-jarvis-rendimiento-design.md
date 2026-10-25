# JARVIS: rendimiento de la respuesta por voz: diseño

Fecha: 2026-10-25 · Estado: borrador

## Intención

La persona dice que «cada vez que le hablo a JARVIS tarda bastante en dar un resultado». La meta es acortar el tiempo entre que termina de hablar y que JARVIS empieza a contestar en voz alta. Como la causa no se conoce, **primero se mide** y después se arreglan las causas que los números muestren.

## Estado actual (verificado en el código)

- **Una sesión viva** del Agent SDK por conversación, con entrada continua (`src/session.js`). No se lanza un proceso por mensaje.
- **Opciones** (`src/agent-options.js`):
  - `settingSources: ['user']` carga todos los plugins y conectores de la cuenta, no solo los que usa JARVIS.
  - Las herramientas internas son `WebSearch`, `WebFetch` y `Agent`.
  - Hay tres subagentes: `agenda` (haiku), `correo` (sonnet) e `investigador` (sonnet, en segundo plano).
  - El modelo principal es el de la cuenta, salvo que se defina `JARVIS_MODEL`.
- **Voz de entrada**: `SpeechRecognition` con `continuous = false`. Chrome cierra la frase cuando detecta silencio, y esa espera también suma.
- **Voz de salida**: se lee frase por frase mientras llega el texto (`flushSentences` en `public/app.js`).
- **Medición existente**: la interfaz ya mide la latencia hasta el primer token (`t-latency`) y el servidor manda `ms` en `done`.

## Sospechas, no confirmadas

1. Cargar todos los plugins y conectores de la cuenta agranda la lista de herramientas y el contexto de cada turno.
2. El modelo por defecto puede ser grande o tener razonamiento extendido, lo que retrasa el primer token.
3. Delegar en un subagente encadena dos modelos.
4. La espera de silencio del reconocedor de voz.
5. Las llamadas a los conectores de claude.ai (la red hasta el proxy de MCP).

## Objetivos

1. **Instrumentación por etapas** de cada turno, desde la voz hasta la primera palabra hablada:
   1. Fin del habla (último resultado del reconocedor).
   2. `POST /api/message` recibido en el servidor.
   3. `init` del SDK.
   4. Primer `stream_event` de texto.
   5. Cada herramienta: inicio y fin, con su nombre.
   6. Primera frase entregada a `speechSynthesis` y su `onstart`.
2. Esos tiempos se ven en la interfaz (en la telemetría que ya existe) y quedan en un registro local que se puede comparar entre corridas.
3. **Un guion de comparación reproducible**: un set fijo de pedidos típicos (saludo simple, «qué tengo hoy», «leé mi último mail», una búsqueda web) que se corre con distintas configuraciones y da una tabla de tiempos.
4. **Probar cada sospecha por separado** con ese guion y quedarse solo con los cambios que mejoran con números.
5. Las mejoras que se adopten no pueden romper nada de lo que hay: confirmaciones, subagentes, tareas en segundo plano, interrupción.
6. README: cómo ver los tiempos y las variables nuevas, si se suma alguna.

## No objetivos

- Cambiar el motor de voz (TTS o STT en la nube, Whisper, etc.) en esta etapa. Si las mediciones muestran que la voz es el cuello de botella, se propone como un proyecto aparte.
- Cambiar de lenguaje o de arquitectura.

## Anti-objetivos

- «Optimizaciones» sin una medición antes y otra después.
- Que JARVIS pierda alguno de los conectores que la persona eligió conservar (ver Decisiones) por acelerar.
- Que baje la calidad de las respuestas sin que la persona lo decida.

## Decisiones tomadas por la persona

- **Conectores que JARVIS conserva**: Gmail, Google Calendar, Google Drive y GitHub, más el plugin de **Discord** por ahora. El resto de los conectores y plugins de la cuenta (Estima, Tactiq, Notion, Atlassian, engram, etc.) se pueden dejar afuera si las mediciones muestran que acelera.

## Decisiones tomadas por Claude (revisables)

- **Primero medir y después decidir**: los cambios de configuración (filtrar conectores, cambiar el modelo, usar menos subagentes) se presentan a la persona con los números antes de dejarlos fijos.
- **Candidato principal a probar**: cargar solo los servidores MCP que JARVIS usa. Las opciones son un `settingSources` más acotado, la lista de servidores permitidos o `toggleMcpServer`. El mecanismo exacto hay que verificarlo en `sdk.d.ts`.
- La instrumentación se apaga con una variable de entorno o queda siempre encendida si no cuesta nada medible.
- **Aislar cada variable**: `settingSources` también carga reglas de permisos, el modelo por defecto y las skills. En cada comparación se fija el modelo de forma explícita y se verifica que las reglas de confirmación sigan iguales, para que una mejora de velocidad no venga de un cambio de calidad escondido. Ningún cambio puede hacer que un envío o un borrado se salte la confirmación por voz.
- **Alcance del guion**: el guion repetible (estilo `scripts/e2e.sh`, por HTTP) mide las etapas 2 a 5 del servidor. Las etapas de voz (1 y 6) se miden con la instrumentación durante el uso real y se registran igual.
- **Voz de entrada**: está permitido ajustar la configuración del reconocedor actual, por ejemplo `continuous = true` con un temporizador de silencio propio, o usar `onspeechend`. Cambiar de motor sigue fuera de alcance. Para medir la espera, se registra el último resultado provisional (el momento aproximado en que la persona dejó de hablar) y el resultado final.
- **Presupuesto de cupo**: 4 pedidos × 3 corridas por configuración, con un máximo de 5 configuraciones (unos 60 turnos en total). Primero se compara cada sospecha contra la base. Se combinan solo las que mejoran solas.
- **Qué cuenta como mejora**: se propone un cambio si baja la mediana del tiempo hasta la primera frase hablada en al menos 300 ms. El guion guarda el texto de cada respuesta para comparar la calidad a mano. Un cambio de modelo siempre lo decide la persona, con los números a la vista.
- **Subagentes**: siguen existiendo. Se puede probar que lo rápido (por ejemplo «qué tengo hoy») vaya directo al conector en lugar de delegarse, ajustando el prompt.
- **Ramas**: cada trabajo va en su propio worktree, con una rama que sale de `feat/orquestador`. La medición base se hace sobre `feat/orquestador` sin el trabajo de gestos. El que termine segundo hace rebase sobre el primero.

## Lo que queda a criterio de quien implementa

- El formato del registro de tiempos.
- Cómo se corre el guion: script en `scripts/` o test manual guiado.

## Riesgos

- Que los tiempos varíen mucho por la red o por la carga de la API. Se mitiga corriendo cada pedido varias veces y mirando la mediana.
- El guion gasta cupo de la suscripción: hay que mantenerlo chico.
- Puede chocar con el trabajo de gestos y carrusel (diseño paralelo) en `src/agent-options.js` y `public/app.js`.
