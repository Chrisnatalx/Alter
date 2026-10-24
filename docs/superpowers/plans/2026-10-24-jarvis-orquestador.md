# JARVIS orquestador: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convertir JARVIS en un orquestador con sesión viva, subagentes que solo leen y preparan, y tareas en segundo plano que avisan por voz.

**Architecture:** El servidor se separa en módulos (`src/`). Una sola sesión del Agent SDK en modo de entrada continua (`prompt` como `AsyncIterable`) recibe los mensajes por `POST` y emite eventos por un canal permanente (`GET /api/events`). Los subagentes se definen con `options.agents`, con listas cerradas de herramientas de solo lectura. `canUseTool` deniega cualquier envío o borrado que venga de un subagente.

**Tech Stack:** Node.js ≥ 20.12, CommonJS, `@anthropic-ai/claude-agent-sdk` 0.3.296, `zod` 4.6.7, `node:test`. El frontend es JS plano en `public/`.

**Spec:** `docs/superpowers/specs/2026-10-24-jarvis-orquestador-design.md`

## Global Constraints

- Node.js y CommonJS. Sin TypeScript, sin build y sin dependencias nuevas, salvo que una tarea lo indique.
- El servidor escucha solo en `127.0.0.1`. Todas las rutas `/api/*` exigen host permitido, origen permitido y el header `x-jarvis-token`, igual que hoy (`isTrusted`).
- Ningún dato personal en el repo: el nombre de la persona y la zona horaria salen de `.env` (`JARVIS_USER_NAME`, `JARVIS_TIMEZONE`).
- Los subagentes **no** pueden enviar ni borrar. Si un subagente pide una herramienta que `needsConfirm` marca, `canUseTool` la deniega sin preguntar.
- Toda respuesta hablada sigue las reglas actuales del system prompt (español rioplatense, sin markdown ni URLs).
- Comentarios en español con la densidad y el tono del código actual.
- Al cerrar cada etapa (tareas 4, 8 y 11): README actualizado, `npm test` en verde, commit y push a `main`.

## Hechos verificados con un spike (2026-10-24, SDK 0.3.296, modelo `haiku`)

- En entrada continua se emite un `result` por turno, y cada turno empieza con `system/init`.
- Un subagente con `background: true` emite `task_started`. El turno principal termina enseguida. Al terminar la tarea llegan `task_notification` (`status`, `summary`), `background_tasks_changed` y un **turno nuevo del orquestador que arranca solo** (`system/init` → texto → `result`) y cuenta el resultado.
- `canUseTool` se llama para las herramientas de los subagentes, con `opts.agentID` definido.
- Con `perTaskStopAffordance: true`, `q.interrupt()` corta solo el turno en curso (`result` con `subtype: 'error_during_execution'`) y la tarea en segundo plano sigue y avisa al terminar.
- Un mensaje que llega mientras hay un turno en curso puede responderse en ese mismo turno.

## Review Focus

1. **Llega un turno de una tarea mientras la persona habla o JARVIS está hablando:** no debe cortarla. Se dice cuando la interfaz vuelve a `idle`. Lo prueba la tarea 8 (`queueTaskTurn`) y la verificación manual de la tarea 11.
2. **Se reinicia el servidor con la página abierta:** la interfaz reconecta el canal de eventos sola. Si el token cambió, muestra «recargá con F5», como hoy. Lo prueba la verificación manual de la tarea 8.
3. **Se abre una segunda ventana:** la primera deja de hablar y de escuchar y muestra el aviso. Lo prueba la tarea 6 (`hub replaces previous client`).
4. **Se interrumpe con una confirmación abierta:** la confirmación se deniega y el turno se corta. Lo prueban la tarea 5 (`interrupt denies pending confirms`) y la tarea 1 (`denyAll`).
5. **Un subagente intenta enviar un mail:** se deniega sin preguntar. Lo prueban la tarea 1 (`subagent send is denied without asking`) y la verificación real de la tarea 11.

---

## Etapa 1: reestructurar sin cambiar el comportamiento

### Task 1: Permisos en `src/permissions.js` + infraestructura de tests

**Files:**
- Create: `src/permissions.js`, `test/permissions.test.js`
- Modify: `package.json` (script `"test": "node --test"`)

**Interfaces:**
- Produces:
  - `describeTool(toolName: string, mcpServer?: {name?: string}) -> {app: string, action: string}`. Se mueve de `server.js` sin cambios.
  - `needsConfirm(toolName: string, input: object) -> boolean`. Se mueve sin cambios, junto con las regex `SENDS` y `DELETES`.
  - `summarizeInput(input: object) -> string`. Se mueve sin cambios.
  - `createPermissionGate({ emit: (event: string, data: object) => void, timeoutMs: number }) -> { canUseTool, confirm(id: string, allow: boolean) -> boolean, denyAll() -> void, pendingCount() -> number }`
    - `canUseTool(toolName, input, opts)` devuelve una Promise con un resultado del SDK.
    - Sin `needsConfirm`: `{behavior:'allow', updatedInput: input}`.
    - Con `needsConfirm` y `opts.agentID`: `{behavior:'deny', message:'Los subagentes no pueden enviar ni borrar: pedíselo a JARVIS.'}`, sin emitir nada.
    - Con `needsConfirm` sin `agentID`: emite `confirm {id, app, action, title, detail}` y espera a `confirm(id, allow)`, al timeout o a `opts.signal` abortado.
    - `confirm()` devuelve `false` si el id no existe.

- [ ] **Step 1: Write the failing tests** en `test/permissions.test.js`:
  - `needsConfirm`:
    - `true` para `mcp__claude_ai_Gmail__send_message`, `mcp__claude_ai_Gmail__trash_thread`, `mcp__claude_ai_GitHub__merge_pull_request` y `mcp__claude_ai_Google_Calendar__create_event` con `{attendees:['a@b.c']}`.
    - `false` para `mcp__claude_ai_Gmail__create_draft`, `mcp__claude_ai_Google_Calendar__list_events`, `WebSearch` y `mcp__jarvis__abrir_en_navegador`.
  - `describeTool('mcp__claude_ai_Google_Calendar__create_event')` es igual a `{app:'Google Calendar', action:'create event'}`.
  - `subagent send is denied without asking`: `canUseTool('mcp__claude_ai_Gmail__send_message', {}, {agentID:'x', signal})` resuelve `behavior:'deny'`, `emit` no se llamó y `pendingCount() === 0`.
  - `confirm resolves allow`: sin `agentID`, `emit` recibe `'confirm'` con un `id`, y `confirm(id, true)` hace que la Promise resuelva `behavior:'allow'`.
  - `denyAll`: dos confirmaciones pendientes. `denyAll()` las resuelve a las dos con `behavior:'deny'` y deja `pendingCount() === 0`.
  - `timeout denies`: con `timeoutMs: 20`, resuelve `deny`.

- [ ] **Step 2: Run** `npm test`. Expected: FAIL (`Cannot find module '../src/permissions'`).
- [ ] **Step 3: Implement `src/permissions.js`** moviendo el código de `server.js` (líneas de `describeTool`, `needsConfirm`, `summarizeInput`, el `Map` `pending` y el cuerpo de `canUseTool`) a la fábrica `createPermissionGate`. Agregar la rama de `opts.agentID`. Mantener los `console.log` `[AUTOMÁTICO]`, `[CONFIRMADO]` y `[RECHAZADO]` y sumar `[DENEGADO A SUBAGENTE]`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Permisos en src/permissions.js con tests"`

### Task 2: Herramientas en `src/tools/`

**Files:**
- Create: `src/tools/browser.js`, `src/tools/youtube.js`, `src/tools/index.js`, `test/tools.test.js`

**Interfaces:**
- Consumes: `config.googleAccount` (Task 3; hasta entonces se pasa por parámetro).
- Produces:
  - `buildOpenUrl(rawUrl: string, googleAccount: string) -> string`. Valida http/https (si no, lanza `Error('Solo se pueden abrir direcciones http o https.')`) y agrega `authuser` en `*.google.com` si falta.
  - `openInBrowser(href: string, spawnFn = child_process.spawn) -> void`. Usa `rundll32 url.dll,FileProtocolHandler` en win32, `open` en darwin y `xdg-open` en el resto.
  - `parseYoutubeResults(html: string) -> {id: string, title: string} | null`. Usa la regex actual sobre `"videoRenderer"` y decodifica los escapes del título.
  - `findYoutubeVideo(search: string, fetchFn = fetch) -> Promise<{id, title} | null>`
  - `createJarvisTools(sdk, { emit, googleAccount }) -> McpSdkServerConfigWithInstance`. Es el servidor `jarvis` con `abrir_en_navegador` y `poner_en_youtube`, con el mismo texto, los mismos eventos (`open {url}`, `music {title}`) y los mismos mensajes de resultado que hoy en `server.js`.

- [ ] **Step 1: Write the failing tests** en `test/tools.test.js`:
  - `buildOpenUrl('file:///C:/x', '')` lanza el error.
  - `buildOpenUrl('https://calendar.google.com/calendar/r/week/2026/10/26', 'a@b.c')` es igual a `'https://calendar.google.com/calendar/r/week/2026/10/26?authuser=a%40b.c'`.
  - Con `?authuser=0` ya presente, no se cambia.
  - `buildOpenUrl('https://github.com/x', 'a@b.c')` no agrega `authuser`.
  - `openInBrowser` con `spawnFn` falso en win32: se llama con `'rundll32'` y `['url.dll,FileProtocolHandler', href]`. Saltear el test si `process.platform !== 'win32'`.
  - `parseYoutubeResults(FIXTURE)` es igual a `{id:'fJ9rUzIMcZQ', title:'Queen – Bohemian Rhapsody'}`. `FIXTURE` es un string con un bloque `"adSlotRenderer":{...}` seguido de `"videoRenderer":{"videoId":"fJ9rUzIMcZQ","thumbnail":{},"title":{"runs":[{"text":"Queen \u2013 Bohemian Rhapsody"}]}}`.
  - `parseYoutubeResults('<html></html>') === null`.
  - `findYoutubeVideo` con `fetchFn` que devuelve `{ok:false}` resuelve `null`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL (módulos inexistentes).
- [ ] **Step 3: Implement** los tres archivos, moviendo el código de `server.js`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Herramientas propias en src/tools con tests"`

### Task 3: Configuración y prompt (`src/config.js`, `src/prompt.js`) + datos personales fuera del código

**Files:**
- Create: `src/config.js`, `src/prompt.js`, `test/prompt.test.js`
- Modify: `.env.example` (sumar `JARVIS_USER_NAME` y `JARVIS_TIMEZONE`), `public/index.html` (meta `jarvis-user`), `public/app.js:686` (`GREETING`)

**Interfaces:**
- Produces:
  - `src/config.js` exporta un objeto congelado con:
    - `port` (`JARVIS_PORT`, 7777)
    - `model` (`JARVIS_MODEL`, '')
    - `googleAccount` (`JARVIS_GOOGLE_ACCOUNT`, '')
    - `userName` (`JARVIS_USER_NAME`, '')
    - `timezone` (`JARVIS_TIMEZONE`; si falta, `Intl.DateTimeFormat().resolvedOptions().timeZone`)
    - `claudeBin` (lógica actual de `resolveClaudeBin`)
    - `confirmTimeoutMs` (120000)
    - `coreDir` (`<repo>/.core`, creado con `mkdirSync`)
    - `publicDir`

    Al empezar hace `require('../env')`.
  - `buildSystemPrompt({ userName }) -> string`. Es el `SYSTEM_PROMPT` actual, sin la frase «Se llama Nata.». Si hay `userName`, agrega `La persona se llama ${userName}.`
  - `nowLine(timezone: string) -> string`. Es el formato actual de `nowLine()`, pero con `timezone` y la ciudad derivada de la zona (`America/Argentina/Buenos_Aires` → `Buenos Aires`: último segmento, con `_` → espacio).
  - La página recibe el nombre en `<meta name="jarvis-user" content="__JARVIS_USER__">`, que el servidor reemplaza escapando HTML (`& < > "`). En `app.js`, `GREETING` pasa a ser `` `Hola${USER ? ' ' + USER : ''}, ¿cómo estás?` ``.

- [ ] **Step 1: Write the failing tests** en `test/prompt.test.js`:
  - `buildSystemPrompt({userName:''})` no contiene `'Nata'` ni `'se llama'`.
  - `buildSystemPrompt({userName:'Ana'})` contiene `'La persona se llama Ana.'`.
  - El prompt contiene `'abrir_en_navegador'` y `'poner_en_youtube'`.
  - `nowLine('America/Argentina/Buenos_Aires')` termina en `', Buenos Aires'`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `config.js` y `prompt.js`, más los cambios en `index.html`, `app.js` y `.env.example`. El prompt pasa a ser `[Fecha y hora actual: ${nowLine(tz)}]`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Configuración y prompt sin datos personales"`

### Task 4: Servidor HTTP en `src/server.js` y cierre de la etapa 1

**Files:**
- Create: `src/server.js`, `src/agent-options.js`
- Modify: `server.js` (queda como `module.exports = require('./src/server');`), `README.md`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `src/server.js` exporta `{ server, PORT }`, igual que hoy, porque `bin/jarvis.js` lo usa.
  - `isTrusted(req, { token, allowedHosts }) -> boolean`, exportada para test.
  - `src/agent-options.js`: `buildAgentOptions({ config, canUseTool, mcpServers, abortController? }) -> Options`. Tiene las mismas opciones que hoy: `cwd: config.coreDir`, `systemPrompt`, `settingSources:['user']`, `settings:{disableAllHooks:true, autoMemoryEnabled:false}`, `tools:['WebSearch','WebFetch']`, `permissionMode:'default'`, `includePartialMessages:true`, más `model` y `pathToClaudeCodeExecutable` si están. La reutilizan las tareas 5 y 9.
  - Las rutas y los eventos SSE de `/api/chat` y `/api/confirm` quedan **idénticos** a los actuales.
- [ ] **Step 1: Write the failing tests** en `test/server.test.js`. `isTrusted`:
  - acepta host `localhost:7777` con token correcto;
  - rechaza un host ajeno, `origin: http://evil.com` y un token incorrecto o de distinto largo.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/server.js` moviendo el HTTP actual (`serveStatic` con los dos reemplazos de meta, `readJson`, `handleChat` usando `buildAgentOptions` y `createPermissionGate` por pedido, `handleConfirm`).
- [ ] **Step 4: Run** `npm test`. Expected: PASS. Además, `node --check` de todos los archivos.
- [ ] **Step 5: Verificación manual de punta a punta.** Levantar con `JARVIS_PORT=7788 node server.js`, sacar el token con `curl -s localhost:7788/ | grep -o '[0-9a-f]\{48\}'` y probar con `curl -N` sobre `/api/chat`:
  - «¿Qué reuniones tengo esta semana?» → eventos `tool` (Google Calendar), `open` con `calendar.google.com/calendar/r/week/…` y `done`;
  - «Poneme Bohemian Rhapsody de Queen» → `open` con `watch?v=` y `music`.

  Después cortar el servidor. Avisar que abre pestañas y consume cupo.
- [ ] **Step 6: README.** Sumar `JARVIS_USER_NAME` y `JARVIS_TIMEZONE` a la tabla y al paso 5 del paso a paso. Reemplazar las menciones a `SYSTEM_PROMPT` / `needsConfirm` «dentro de `server.js`» por `src/prompt.js` / `src/permissions.js`. Agregar una sección corta «Estructura del código» con el árbol de `src/`.
- [ ] **Step 7: Commit y push** `git commit -m "Etapa 1: servidor separado en src/ sin cambios de comportamiento" && git push origin main`

## Etapa 2: sesión viva y canal de eventos

### Task 5: Sesión viva en `src/session.js`

**Files:**
- Create: `src/session.js`, `test/session.test.js`

**Interfaces:**
- Consumes:
  - `buildAgentOptions` (Task 4). Se agrega `perTaskStopAffordance: true` y se quita `abortController`.
  - `createPermissionGate` (Task 1).
- Produces:
  - `createInputQueue() -> { push(text: string): void, close(): void, iterable: AsyncIterable<SDKUserMessage> }`. Cada mensaje tiene la forma `{type:'user', message:{role:'user', content: text}, parent_tool_use_id:null, session_id:''}`.
  - `mapMessage(msg, state) -> Array<[event, data]>`. Es una función pura, y `state` es un objeto mutable que la sesión mantiene.
    - `system/init` → `['turn', {origin}]` y `['init', {sessionId, model}]`. La regla de `origin`:
      - si `state.userSince` → `'user'`;
      - si no, si `state.taskSince` → `'task'`;
      - si no → `'user'`.

      Después pone las dos banderas en `false`.
    - `stream_event` con `text_delta`, solo si `msg.parent_tool_use_id == null` → `['delta', {text}]`.
    - `stream_event` con `content_block_start` y `tool_use` del orquestador → `['tool', describeTool(name)]`.
    - `system/task_started` → `['task', {id: task_id, status:'running', description, agent: subagent_type}]`.
    - `system/task_notification` → pone `state.taskSince = true` y emite `['task', {id, status, summary}]`.
    - `system/background_tasks_changed` → `['tasks', {tasks: msg.tasks.map(t => ({id: t.task_id, description: t.description, agent: t.subagent_type}))}]`. Es la lista completa de tareas vivas (`SDKBackgroundTasksChangedMessage.tasks`, verificado) y se guarda en `state.tasks`; `runningTasks()` devuelve su largo. La interfaz la usa para resincronizar el panel al reconectar.
    - `result`:
      - `subtype === 'success'` → `['done', {sessionId, ms}]`;
      - `error_during_execution` después de un `interrupt()` → `['done', {sessionId, interrupted:true}]`;
      - cualquier otro error → `['error', {message}]`.
  - `class Session`, con `constructor({ config, emit, queryFn = sdk.query, sdk })`:
    - `start({ resumeId?: string }) -> void`. Llama a `queryFn` una vez con `prompt: queue.iterable` y consume los mensajes con `mapMessage` → `emit`.
    - `send(text: string) -> void`. Pone `state.userSince = true` y hace push con el prefijo de fecha.
    - `interrupt() -> Promise<void>`. Llama a `gate.denyAll()` y después a `q.interrupt()`.
    - `stopTask(taskId: string) -> Promise<void>`
    - `runningTasks() -> number`
    - `close() -> void`. Cierra la cola y llama a `q.close()` si existe.
    - `confirm(id, allow) -> boolean`. Delega en el gate.
    - getter `sessionId`.
- [ ] **Step 1: Write the failing tests** en `test/session.test.js`. Usar un `queryFn` falso: un generador async que emite una secuencia guardada y expone `interrupt`, `stopTask` y `close` como espías.
  - `createInputQueue` entrega en orden los mensajes enviados antes y después de empezar a iterar.
  - `mapMessage` sobre la secuencia del spike (init → delta → result success) da `turn{origin:'user'}`, `init`, `delta`, `done`.
  - `task turn origin`: con `task_notification` y después `init`, sin `send` en el medio, da `turn{origin:'task'}`.
  - Un delta con `parent_tool_use_id:'abc'` no emite nada (es texto de un subagente).
  - `interrupt denies pending confirms`: con un `canUseTool` pendiente en el gate, `session.interrupt()` lo resuelve `deny` y llama a `q.interrupt` una vez.
  - `send` antes de que arranque la query no se pierde.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement `src/session.js`.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Sesión viva del SDK con tests"`

### Task 6: Canal de eventos en `src/events.js`

**Files:**
- Create: `src/events.js`, `test/events.test.js`

**Interfaces:**
- Produces: `createEventHub() -> { attach(res: http.ServerResponse) -> void, emit(event: string, data: object) -> void, hasClient() -> boolean }`
  - `attach` escribe los headers SSE.
  - Si ya había un cliente, le manda `replaced {}` y le hace `end()`. Solo el último recibe eventos.
  - Al cerrarse `res`, si era el actual, queda sin cliente.
  - `emit` sin cliente descarta el evento y no lanza.
  - Cada 25 s manda un comentario `: ping\n\n` para que el proxy y el navegador no corten. El timer se limpia al cerrar.
- [ ] **Step 1: Write the failing tests** con objetos `res` falsos (`write`, `end`, `writeHead`, `on('close')`):
  - `hub replaces previous client`: dos `attach`. El primero recibió `event: replaced` y `end()`, y `emit('delta', …)` solo llega al segundo.
  - `emit` sin clientes no lanza.
  - Un cierre del cliente actual deja `hasClient() === false`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement `src/events.js`.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Canal de eventos con un solo cliente activo"`

### Task 7: Rutas nuevas en `src/server.js`

**Files:**
- Modify: `src/server.js`, `test/server.test.js`

**Interfaces:**
- Consumes: `Session` (Task 5), `createEventHub` (Task 6).
- Produces (todas pasan por `isTrusted`):
  - `GET /api/events` → `hub.attach(res)`. Si hay sesión, emite enseguida `init {sessionId}` y `tasks {tasks}` con el estado actual (así se resincroniza al recargar la página).
  - `POST /api/message {text, sessionId?}`:
    - si no hay sesión, crea `new Session({ emit: hub.emit, … })` y la arranca con `start({resumeId: sessionId})`, validando el formato UUID como hoy;
    - después llama a `session.send(text)`;
    - responde `202`, o `400` si el texto está vacío.
  - `POST /api/interrupt` → `204`.
  - `POST /api/confirm {id, allow}` → `204`, o `404` si el id no existe.
  - `POST /api/new {force?}`:
    - si `session.runningTasks() > 0` y no viene `force`, responde `409 {running: n}`;
    - si no, `session.close()`, deja la sesión en `null`, emite `reset {}` y responde `204`.
  - `POST /api/tasks/stop {taskId}` → `204`.
  - `/api/chat` se elimina.
  - Los `GET` estáticos siguen igual.
  - Las herramientas se crean una vez por sesión con `createJarvisTools(sdk, {emit: hub.emit, googleAccount})`.
- [ ] **Step 1: Write the failing tests.** Exportar `handleRequest(req, res, deps)` con `deps = {hub, sessionFactory, token, allowedHosts}` y probar con `req`/`res` falsos:
  - `POST /api/new` con una sesión falsa que tiene `runningTasks()=2` → `409` y body `{"running":2}`;
  - con `force:true` → `204` y `close()` llamado;
  - `POST /api/message` con `{text:''}` → `400`;
  - sin token → `403`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** las rutas.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Rutas de la sesión viva"`

### Task 8: Interfaz sobre el canal de eventos y cierre de la etapa 2

**Files:**
- Modify: `public/app.js`, `public/index.html` (overlay «abierto en otra ventana»), `public/style.css`, `README.md`

**Interfaces:**
- Consumes: las rutas de la Task 7 y los eventos `turn`, `init`, `delta`, `tool`, `open`, `music`, `confirm`, `task`, `tasks`, `done`, `error`, `replaced` y `reset`.
- Produces (en `app.js`):
  - `connectEvents()`: hace `fetch('/api/events', {headers: {'X-Jarvis-Token': TOKEN}})` y lee el stream con el mismo parser que hoy.
    - Si se corta, reintenta con espera creciente (1 s, 2 s, 4 s, hasta 10 s).
    - Con `403` muestra «El servidor se reinició: recargá la página con F5.» y deja de reintentar.
  - `ask(text)` conserva su comportamiento visible (estado `thinking`, registro, subtítulos), pero hace `POST /api/message` y deja de leer el stream. Los `delta` llegan por `connectEvents` y se pintan en el turno actual.
  - `interrupt()`: hace `POST /api/interrupt` y corta la voz local. Ya no hay `AbortController`.
  - **Turnos de tareas:** con `turn {origin:'task'}`, el texto de ese turno se acumula en `taskBuffer` en lugar de hablarse. Con `done`, se llama a `queueTaskTurn(text)`.
  - `queueTaskTurn(text)`:
    - si `app.state === 'idle'` (o `listening` sin nada oído en `heard`), detiene la escucha, lo registra y lo habla como cualquier respuesta;
    - si no, lo encola y lo dice la próxima vez que `setState('idle')` se ejecute.
  - `replaced`: muestra el overlay «JARVIS está abierto en otra ventana», corta la voz y el micrófono y no reconecta.
  - NUEVA: hace `POST /api/new`.
    - Con `409 {running}`, JARVIS dice «Hay {n} tareas en curso y se van a cancelar. ¿Confirmás?» y usa el mismo panel y la misma escucha de sí/no que las confirmaciones (`showConfirm` con un id local `'reset'`, sin ir al servidor). Con «sí» manda `POST /api/new {force:true}`.
    - Con `reset`, limpia como hoy.
- [ ] **Step 1: Implement** los cambios en `app.js`, `index.html` y `style.css`. Sin tests automáticos de UI.
- [ ] **Step 2: Run** `npm test` y `node --check public/app.js`. Expected: PASS.
- [ ] **Step 3: Verificación manual** con `jarvis` en Chrome. Anotar el resultado de cada punto:
  - una pregunta por voz se responde y se lee;
  - barge-in: hablar encima corta y responde lo nuevo;
  - ESC corta;
  - confirmación por voz: «mandale un mail de prueba a mi propia casilla» → panel → «no» → no se envía;
  - reiniciar el servidor con la página abierta → reconecta o pide F5;
  - abrir una segunda ventana con `jarvis` → la primera muestra el aviso;
  - NUEVA → reinicia;
  - la latencia al primer token en «¿qué hora es?» es comparable a la de antes (anotar los ms de TELEMETRÍA).
- [ ] **Step 4: README.** Actualizar «Uso» y «Seguridad» (canal de eventos, una ventana activa) y sacar la mención a `/api/chat`.
- [ ] **Step 5: Commit y push** `git commit -m "Etapa 2: sesión viva y canal de eventos" && git push origin main`

## Etapa 3: subagentes y tareas en segundo plano

### Task 9: Subagentes en `src/agents/`

**Files:**
- Create: `src/agents/index.js`, `src/agents/agenda.js`, `src/agents/correo.js`, `src/agents/investigador.js`, `test/agents.test.js`
- Modify: `src/agent-options.js` (`tools` suma `'Agent'`; se agrega `agents: buildAgents(config)`), `.env.example`

**Interfaces:**
- Consumes: `needsConfirm` (Task 1), `config` (Task 3).
- Produces:
  - Cada archivo de agente exporta `{ name, description, prompt, tools: string[], model, background?: boolean, maxTurns }`.
    - `tools` es una **lista cerrada** de nombres completos de solo lectura o preparación:
      - `agenda` (`haiku`): `mcp__claude_ai_Google_Calendar__{list_calendars,list_events,get_event,search_events,suggest_time}`.
      - `correo` (`sonnet`): `mcp__claude_ai_Gmail__{search_threads,get_thread,get_message,list_labels,list_drafts,get_draft,create_draft,update_draft}`.
      - `investigador` (`sonnet`, `background: true`): `WebSearch`, `WebFetch`.
    - Los prompts piden respuestas breves y aptas para leer en voz alta, y dicen que el agente no envía nada: deja borradores y avisa.
  - `buildAgents(config, env = process.env) -> Record<string, AgentDefinition>`. Aplica el override `JARVIS_AGENT_<NOMBRE>_MODEL` (con el nombre en mayúsculas) y agrega `omitClaudeMd: true`.
  - Supuesto, a confirmar en la Task 11: los nombres `mcp__claude_ai_Gmail__*` y `mcp__claude_ai_Google_Calendar__*` son iguales en cualquier cuenta, porque vienen del nombre del conector en claude.ai.
- [ ] **Step 1: Write the failing tests** en `test/agents.test.js`:
  - `no agent has a send or delete tool`: para cada agente y cada herramienta, `needsConfirm(tool, {}) === false`;
  - `investigador.background === true`;
  - `buildAgents(config, {JARVIS_AGENT_AGENDA_MODEL:'sonnet'}).agenda.model === 'sonnet'`;
  - sin override, `agenda.model === 'haiku'`;
  - `buildAgentOptions(...).tools` incluye `'Agent'`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** los agentes, `buildAgents` y el cambio en `agent-options.js`. Agregar a `.env.example` las tres variables `JARVIS_AGENT_*_MODEL`, comentadas.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Subagentes agenda, correo e investigador"`

### Task 10: Regla de delegación y panel de tareas

**Files:**
- Modify: `src/prompt.js`, `test/prompt.test.js`, `public/app.js`, `public/index.html`, `public/style.css`

**Interfaces:**
- Consumes: eventos `task` y `tasks` (Task 5), `POST /api/tasks/stop` (Task 7).
- Produces:
  - `buildSystemPrompt` agrega estas reglas:
    - Lo rápido (abrir algo, música, una consulta puntual a un conector) lo hace JARVIS directamente.
    - Lo que lleva varios pasos o mucha lectura lo delega con la herramienta Agent al subagente que corresponda.
    - Las investigaciones largas van al `investigador`, que corre en segundo plano: JARVIS dice en una oración que la lanzó y sigue disponible.
    - Los subagentes no envían: si hace falta enviar, JARVIS lo hace él mismo con confirmación.
    - Al recibir el resultado de una tarea, lo cuenta en pocas oraciones y sin markdown.
  - Panel «TAREAS» en la interfaz: debajo de TELEMETRÍA, con el mismo estilo de `.panel-title`. Una fila por tarea con descripción, estado (EN CURSO / LISTA / FALLÓ / CANCELADA) y un botón «CANCELAR» mientras está en curso, que hace `POST /api/tasks/stop`. Cada cambio queda también en el registro.
- [ ] **Step 1: Write the failing test.** `buildSystemPrompt({})` contiene `'investigador'` y `'segundo plano'`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** el prompt y el panel.
- [ ] **Step 4: Run** `npm test` y `node --check public/app.js`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Delegación en el prompt y panel de tareas"`

### Task 11: Verificación real y cierre de la etapa 3

**Files:**
- Modify: `README.md`
- Create: `scripts/e2e.sh`. Es el script de punta a punta: levanta el servidor en `7788`, abre `GET /api/events` en segundo plano, manda los mensajes por `POST` e imprime los eventos. Avisa al empezar que consume cupo y abre pestañas.

- [ ] **Step 1:** Correr `scripts/e2e.sh` con estos casos y anotar los eventos:
  1. «Investigá quién ganó el último mundial» → `task running`, `done` del turno, y más tarde `task completed`, `turn {origin:'task'}`, `delta` y `done`.
  2. «Pedile al agente de correo que le mande un mail a test@example.com diciendo hola». Expected: ningún evento `confirm` que venga de un subagente. En el log del servidor no aparece `send_message` permitido. Si el orquestador decide enviarlo él, aparece `confirm` y se responde `allow:false` por `POST /api/confirm`.
  3. «¿Qué tengo mañana en el calendario?» → la respuesta es directa o vía `agenda`. Anotar el tiempo hasta el primer `delta` comparado con la etapa 1.
- [ ] **Step 2:** Prueba manual por voz en Chrome:
  - lanzar una investigación y, mientras corre, hacer otra pregunta y hablar encima de la respuesta: el aviso de la tarea no interrumpe y se dice después;
  - cancelar una tarea desde el panel;
  - NUEVA con una tarea en curso pide confirmación.
- [ ] **Step 3: README.** Agregar:
  - una sección «Subagentes y tareas en segundo plano»: qué hace cada uno, qué modelo usa, cómo cambiarlo por `.env` y que **no envían ni borran**;
  - cómo agregar un subagente o una herramienta (un archivo en `src/agents/` o `src/tools/` más su registro en `index.js`);
  - que reiniciar el servidor cancela las tareas en curso.
- [ ] **Step 4: Commit y push** `git commit -m "Etapa 3: subagentes y tareas en segundo plano" && git push origin main`
