# JARVIS orquestador: diseño

Fecha: 2026-10-24 · Estado: aprobado

## Intención

JARVIS es un asistente de voz local sobre el Claude Agent SDK. Usa la suscripción de cada persona y sus conectores de claude.ai, sin API key. Hoy es un solo agente con unas pocas herramientas. La idea es convertirlo en un **orquestador**: un agente principal que conversa por voz y que:

- tiene muchas herramientas propias (abrir páginas, poner música y las que se sumen);
- delega tareas a **subagentes especializados** con sus propias herramientas y su propio contexto, para que el contexto de JARVIS no se llene con el trabajo intermedio;
- usa modelos más baratos y rápidos (`haiku`, `sonnet`) en los subagentes de tareas sencillas;
- puede mandar tareas largas **en segundo plano** («investigá X y avisame»), seguir conversando y avisar por voz cuando terminan.

Además, el repo se comparte: cualquier persona tiene que poder clonarlo y configurarlo con su cuenta siguiendo el README.

## Estado actual (hechos verificados en el código)

- `server.js` (unas 360 líneas) concentra el HTTP, el system prompt, la regla de permisos (`needsConfirm` / `canUseTool`), las herramientas propias (`abrir_en_navegador`, `poner_en_youtube`) y la integración con el SDK.
- Cada mensaje es un `POST /api/chat` que lanza un `query()` nuevo con `prompt` de texto (modo de un solo turno) y `resume: sessionId`, y responde por SSE (`init`, `delta`, `tool`, `open`, `music`, `confirm`, `done`, `error`). Cuando la respuesta termina, la ejecución también.
- En ese modo el SDK **mata las tareas en segundo plano** al entregar el resultado. Lo dice la documentación de `perTaskStopAffordance` en `sdk.d.ts`: «on a one-shot run (the string `prompt` form…) hold-back tasks are still killed when the held result is released». Por eso hoy no hay tareas en segundo plano posibles.
- Interrumpir (barge-in, ESC) corta la conexión HTTP, y el servidor aborta el `query()` entero con `AbortController`.
- La confirmación de envíos y borrados pasa por `canUseTool` y se responde con `POST /api/confirm`. La interfaz la pregunta por voz o con un botón.
- `public/app.js` (unas 740 líneas) maneja voz, estados (`idle`, `listening`, `thinking`, `speaking`, `confirming`), barge-in, confirmación y el registro. Guarda `sessionId` en `localStorage`. El botón NUEVA lo borra.
- No hay tests ni paso de build. Usa CommonJS, Node 20.12 o superior, y las dependencias `@anthropic-ai/claude-agent-sdk` 0.3.296 y `zod` 4.6.7.

## Lo que ofrece el SDK (verificado en `sdk.d.ts` 0.3.296)

- `options.agents: Record<string, AgentDefinition>`. Cada definición tiene `description`, `prompt`, `tools` / `disallowedTools`, `model` (alias `haiku`, `sonnet`, `opus` o `inherit`), `maxTurns`, `effort`, `background` (correr como tarea en segundo plano) y `omitClaudeMd`.
- Modo de entrada continua: `prompt` como `AsyncIterable<SDKUserMessage>`. `Query` expone `interrupt()`, `setModel()` y `streamInput()`.
- Mensajes de sistema `task_started`, `task_notification` (con `status: completed | failed | stopped` y `summary`) y `background_tasks_changed` (el conjunto completo de tareas vivas).
- `perTaskStopAffordance`: si quien consume el SDK lo declara, un `interrupt()` en una sesión de entrada continua **no mata** las tareas en segundo plano, y cada tarea se frena por separado con la solicitud de control `stop_task`. Sin esa declaración, interrumpir mata todas las tareas.
- Las opciones de `canUseTool` incluyen `agentID` («If running within the context of a sub-agent»). Eso indica que la confirmación también se aplica dentro de los subagentes. **Es una inferencia y hay que comprobarla en la práctica** (ver Riesgos).

## Objetivos

1. Separar el servidor en módulos con una responsabilidad cada uno, de modo que sumar una herramienta o un subagente sea agregar un archivo.
2. Una **sesión viva** por conversación, en modo de entrada continua, en lugar de un `query()` por mensaje.
3. JARVIS como orquestador con subagentes definidos con `options.agents`, cada uno con herramientas acotadas y el modelo adecuado.
4. Tareas en segundo plano: se lanzan, JARVIS sigue disponible, avisa por voz al terminar, se ven en la interfaz y se pueden cancelar.
5. La confirmación por voz de envíos y borrados sigue funcionando igual, **también para las acciones de los subagentes**. La interfaz indica qué agente pide permiso.
6. README actualizado en cada etapa, con el paso a paso para cuentas nuevas.

## No objetivos

- Cambiar de lenguaje (Go o Python) o pasar a TypeScript. Ver Decisiones.
- Controlar pestañas ya abiertas (pausar YouTube, cambiar de tema).
- Varias personas usando el mismo servidor a la vez. Es local y para una sola persona.
- Exponer JARVIS a la red o usar la API con API key.
- Memoria persistente entre conversaciones (más allá de `resume`).

## Anti-objetivos (fallaría aunque funcione)

- Que un subagente envíe o borre algo **sin** pasar por la confirmación por voz.
- Que las consultas simples («qué tengo hoy», «poné música») se vuelvan notablemente más lentas que hoy por delegarlas sin necesidad.
- Perder el barge-in, la escucha continua o la interrupción con ESC.
- Que un aviso de tarea terminada interrumpa a la persona mientras habla o mientras JARVIS está diciendo otra cosa.
- Datos personales o secretos en el repo.

## Decisiones tomadas

### Por la persona usuaria
- Arquitectura de orquestador con subagentes, modelos más baratos para tareas simples y tareas en segundo plano.
- La estructura de carpetas propuesta (`src/` con `tools/` y `agents/`).
- Al poner música se apaga el micrófono, y ESPACIO lo vuelve a prender (ya implementado).
- La configuración va en `.env` (ya implementado).
- Implementar las tres etapas completas.
- **Resultado de las tareas en segundo plano:** el resultado entra en la conversación del orquestador, y JARVIS lo procesa y lo cuenta en sus palabras, para que después se le pueda preguntar sobre eso. Si en ese momento la persona está hablando, JARVIS está hablando o hay una confirmación abierta, ese turno se guarda (en el servidor o en la interfaz) y se dice al volver a `idle`. Si la persona empieza un turno mientras tanto, el suyo tiene prioridad.
- **Los subagentes solo leen y preparan:** no tienen herramientas de envío ni de borrado (se quitan con `disallowedTools` usando los mismos patrones de `needsConfirm`). Por ejemplo, el de correo deja borradores, y enviar lo hace JARVIS, siempre con confirmación. `canUseTool` igual se mantiene para los subagentes como segunda barrera, y la prueba de la etapa 3 verifica que un subagente **no pueda** enviar.

### Mi criterio (para revisar)
- **Stack:** seguir con Node.js y CommonJS, sin TypeScript ni build. Motivo: hay SDK oficial, la interfaz es JS sí o sí y la latencia la pone el modelo, no el lenguaje.
- **Estructura:**
  ```
  server.js            se reduce a arrancar src/server (mantiene `require('./server.js')` de bin/jarvis.js)
  src/
    server.js          HTTP, estáticos, token, rutas
    events.js          canal de eventos servidor → interfaz
    session.js         sesión viva: cola de entrada, query(), reparto de mensajes, interrupt, nueva
    prompt.js          system prompt del orquestador
    permissions.js     needsConfirm, describeTool, summarizeInput, canUseTool + confirmaciones pendientes
    tools/index.js     arma el servidor MCP en proceso con todas las herramientas
    tools/browser.js   abrir_en_navegador (+ openInBrowser)
    tools/youtube.js   poner_en_youtube (+ findYoutubeVideo)
    agents/index.js    junta las definiciones para options.agents
    agents/<nombre>.js un subagente por archivo
  ```
- **Transporte:** como la sesión puede emitir eventos sin que la persona haya hablado (una tarea que termina), se reemplaza el SSE por pedido con un **canal de eventos permanente**: `GET /api/events` con streaming vía `fetch`, usando el mismo header `x-jarvis-token` (`EventSource` no permite headers). Las acciones van por `POST`: `/api/message {text}`, `/api/interrupt`, `/api/confirm {id, allow}`, `/api/new` y `/api/tasks/stop {taskId}`. Se mantiene la validación de host, origen y token en todas las rutas.
- **Una sesión activa por proceso.** Al conectarse, la interfaz manda el `sessionId` guardado y el servidor la retoma con `resume` si no hay una viva. NUEVA cierra la sesión y abre otra.
- **Interrupción:** `query.interrupt()` en lugar de abortar todo, declarando `perTaskStopAffordance` para que las tareas en segundo plano sobrevivan. La persona las cancela de a una (botón en la interfaz, o pidiéndoselo a JARVIS si existe la vía).
- **Avisos de tareas terminadas:** si la persona está hablando, JARVIS está hablando o hay una confirmación abierta, el aviso se encola en la interfaz y se dice al volver a `idle`. En el registro aparece siempre en el momento.
- **Primeros subagentes** (modelo entre paréntesis):
  - `agenda` (`haiku`): Google Calendar. Lectura y armado de eventos.
  - `correo` (`sonnet`): Gmail. Buscar, resumir y redactar borradores. Enviar sigue pidiendo confirmación.
  - `investigador` (`sonnet`, `background: true`): búsqueda y lectura web, para investigaciones largas.
- **Qué delega JARVIS:** lo rápido lo hace directo (abrir algo, música, una consulta puntual). Delega lo que lleva varios pasos o mucha lectura. Esta regla va en el prompt del orquestador. JARVIS conserva acceso directo a los conectores para las consultas puntuales.
- **Modelo del orquestador:** sigue siendo `JARVIS_MODEL` (vacío = el de la cuenta). Los modelos de los subagentes se definen en cada archivo, con override opcional por `.env` (`JARVIS_AGENT_<NOMBRE>_MODEL`).
- **Herramienta `Agent`:** hay que sumarla a `tools` (hoy solo están `WebSearch` y `WebFetch`). Sin ella, el orquestador no puede delegar.
- **Varias ventanas:** `jarvis` abre una ventana nueva aunque el servidor ya esté corriendo. Los eventos van solo a la **última ventana conectada**. Las anteriores muestran «JARVIS está abierto en otra ventana» y no hablan ni escuchan. Así se evitan voces duplicadas y confirmaciones dobles.
- **NUEVA con tareas en curso:** JARVIS avisa cuántas tareas hay y pide confirmación, porque se cancelan. Si se reinicia el servidor, las tareas en curso se pierden (el SDK no las conserva entre procesos). Esto queda documentado en el README.
- **Datos personales fuera del código:** el nombre de la persona («Se llama Nata») y la zona horaria (Buenos Aires, en `nowLine()`) pasan a `.env` (`JARVIS_USER_NAME`, `JARVIS_TIMEZONE`, con defaults neutros). Se hace en la etapa 1 y se agrega al paso a paso del README.
- **Tests:** `node:test`, que viene con Node y no suma dependencias, para la lógica pura: reglas de permisos, armado y validación de URLs, parser de YouTube con HTML guardado como fixture, y cola de entrada de la sesión. Además, un script de prueba de punta a punta contra el servidor real. Ese script consume cupo de Claude y abre pestañas, así que no corre solo.

## Etapas (cada una deja JARVIS funcionando)

1. **Reestructurar sin cambiar el comportamiento.** Separar en `src/` según la estructura y agregar los tests unitarios. Mismas rutas y mismos eventos que hoy. Se verifica repitiendo las pruebas manuales: calendario semanal, YouTube y una acción con confirmación.
2. **Sesión viva y canal de eventos.** Entrada continua, `GET /api/events` y las nuevas rutas `POST`. La interfaz se adapta (envío, interrupción, NUEVA, reconexión si se reinicia el servidor). Tiene que conservar barge-in, ESC, confirmación por voz y retomar la conversación.
3. **Subagentes y tareas en segundo plano.** Definiciones en `agents/`, regla de delegación en el prompt, panel de tareas en la interfaz (en curso / terminadas / cancelar), avisos por voz encolados y confirmación que muestra qué agente pide permiso.

Al cerrar cada etapa: README actualizado, commit y push.

## Riesgos y cosas a comprobar primero

- **Subagentes sin envío** (anti-objetivo número 1): antes de cerrar la etapa 3 hay que comprobar con una prueba real que un subagente no tiene herramientas de envío ni de borrado, y que si llegara a intentarlo, `canUseTool` lo frena.
- **El aviso al terminar una tarea:** no está verificado si, en entrada continua, una `task_notification` dispara sola un turno nuevo del orquestador (como pasa en Claude Code) o si hay que inyectar un mensaje. Conviene un spike al principio de la etapa 2.
- **`perTaskStopAffordance`:** resuelto. Es un campo de `Options` (`sdk.d.ts`, línea 1812) y se pasa directo a `query()`. Las tareas se cancelan con `Query.stopTask(taskId)` (línea 3238). Queda comprobar en la práctica que un `interrupt()` realmente no las mata.
- **Latencia:** medir el tiempo hasta el primer token antes y después de cada etapa en las mismas consultas simples. No debería empeorar de forma notable.
- **Cupo:** los subagentes consumen el mismo cupo de la suscripción. Usar `haiku` o `sonnet` reduce costo y tiempo, pero no lo elimina.

## Lo que queda a criterio de quien implementa

- Nombres internos, forma exacta de los mensajes del canal de eventos y diseño visual del panel de tareas (siguiendo el estilo actual de la interfaz).
- El texto exacto de los prompts de los subagentes.
- Cómo reconectar el canal de eventos y cómo resincronizar las tareas al recargar la página (ver `background_tasks_changed`).
