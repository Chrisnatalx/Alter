# JARVIS rendimiento de la respuesta por voz: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Medir por etapas cuánto tarda JARVIS desde que la persona deja de hablar hasta que empieza a contestar en voz alta, y probar por separado, con números, los cambios que podrían acortarlo.

**Architecture:** Primero se instrumenta (servidor: `src/timing.js`, enganchado en `Session`. Cliente: `public/timing.js` y unos pocos ganchos en `public/app.js`). Los tiempos van a la telemetría de la interfaz y a un registro JSONL local. Un guion por HTTP (`scripts/medir.js`) mide las etapas del servidor con la configuración que digan las variables de entorno. Después viene una medición base con **parada obligatoria** para la persona. Recién ahí se suman los cambios candidatos, cada uno detrás de su propia bandera, apagado por defecto y medido contra la base. Ningún default cambia sin el visto bueno de la persona.

**Tech Stack:** Node.js ≥ 20.12, CommonJS, `@anthropic-ai/claude-agent-sdk` 0.3.296, `node:test`. Frontend en JS plano (`public/`), con Web Speech API.

**Spec:** `docs/superpowers/specs/2026-10-25-jarvis-rendimiento-design.md`

## Global Constraints

- **Primero medir y después decidir.** Ningún cambio de configuración se fija por defecto sin mostrarle los números a la persona y sin su visto bueno (tareas 5 y 9).
- **Criterio de mejora:** un cambio se propone solo si baja en **al menos 300 ms** la mediana del tiempo hasta la primera frase hablada.
- **Presupuesto de cupo:** 4 pedidos × 3 corridas por configuración, con un máximo de 5 configuraciones (unos 60 turnos en total). Primero se compara cada sospecha contra la base, y se combinan solo las que mejoran solas.
- **Modelo:** en cada comparación se fija `JARVIS_MODEL` de forma explícita. Un cambio de modelo **siempre** lo decide la persona.
- **Conectores que JARVIS conserva:** Gmail, Google Calendar, Google Drive y GitHub, más el plugin de Discord. Ningún cambio puede sacar ninguno de estos.
- **Confirmaciones:** ningún cambio puede hacer que un envío o un borrado se salte la confirmación por voz. `permissionMode: 'default'` y `canUseTool` no cambian, y no se agrega ninguna regla `permissions`.
- **Lo que no puede romperse:** subagentes (`agenda`, `correo`, `investigador`), tareas en segundo plano e interrupción.
- **Fuera de alcance:** cambiar el motor de voz (TTS o STT), el lenguaje o la arquitectura.
- **Sin dependencias nuevas.** Identificadores en inglés y comentarios en español rioplatense, como el código actual. Ningún dato personal en el repo.
- **`logs/` va al `.gitignore`.** Ahí quedan el registro de tiempos y los resultados del guion, que incluyen el texto de respuestas con contenido real de mails y del calendario.
- **Ramas:** se trabaja en un worktree propio, en la rama `feat/rendimiento`, que sale de `feat/orquestador`. La medición base (tarea 5) se hace sin el trabajo de gestos y carrusel. El que termine segundo hace rebase sobre el primero.
- **`public/app.js` lo toca también el proyecto de gestos.** Los cambios ahí tienen que ser ganchos de pocas líneas, y la lógica va en `public/timing.js`.

## Hechos sobre el SDK (verificados en `sdk.d.ts` 0.3.296) e inferencias

Verificado:
- `settingSources: ['user']` carga `~/.claude/settings.json`: permisos, `model`, `enabledPlugins` y demás. Si se omite, se cargan todas las fuentes. Con `[]` no se carga ninguna (modo aislado).
- `settings` (objeto) es la capa «flag», la de mayor prioridad entre las que controla la persona (`user < project < local < flag < policy`).
- `Settings.allowedMcpServers: { serverName?, serverCommand?, serverUrl? }[]` «gobierna los servidores que agrega la persona (configuración user, project y local, `--mcp-config`, frontmatter de agentes, plugins, **conectores de claude.ai**)». La lista negra `deniedMcpServers` tiene prioridad. «Arrays merge across settings sources».
- `Settings.disableClaudeAiConnectors` apaga **todos** los conectores de claude.ai. No sirve, porque hay que conservar cuatro.
- `strictMcpConfig: true` deja solo los `mcpServers` pasados por opción e ignora los plugins y los conectores. `McpServerConfig` no incluye el tipo `claudeai-proxy`, así que no sirve.
- `Query.mcpServerStatus(): Promise<McpServerStatus[]>` (`name`, `status: 'connected'|'failed'|'needs-auth'|'pending'|'disabled'`, `source`, `tools`) y `Query.toggleMcpServer(name, enabled): Promise<void>`.
- `setMcpServers` no toca los servidores de settings ni de plugins: no sirve para filtrar.
- `skills?: string[] | 'all'`: si se omite, valen los defaults de la CLI. Una lista habilita solo esas skills.
- `system/init` trae `tools: string[]`, `mcp_servers: {name, status, source?}[]`, `model`, `skills`, `plugins`, `agents?`.
- Un `SDKUserMessage` con `parent_tool_use_id: null` trae los `tool_result` de las herramientas del orquestador.
- El `~/.claude/settings.json` de esta máquina no define `model`, `effortLevel` ni reglas `allow` de MCP. Sí activa `superpowers` (×2) y `discord@claude-plugins-official`. `remote-settings.json` no define allow o deny lists de MCP.

Inferido (lo comprueba la tarea 6, paso 1):
- Que `allowedMcpServers` en la capa flag se aplique también a los conectores de claude.ai. La documentación la llama «Enterprise allowlist», aunque dice que se combina entre fuentes.
- Que la allowlist **no** bloquee el servidor en proceso `jarvis`. Por las dudas, se lo incluye en la lista.
- Que `skills: []` deje la sesión sin skills, y que las skills ocupen contexto aunque JARVIS no tenga la herramienta `Skill`.
- Que los agentes que traen los plugins (por ejemplo los de superpowers) aparezcan en la descripción de la herramienta `Agent`. Se mira en `init.agents`.
- Los nombres exactos de los servidores (`claude.ai Gmail`, `claude.ai Google Calendar`, `claude.ai Google Drive`, `claude.ai GitHub`, `plugin:discord:discord`) siguen el patrón visto en esta cuenta. Se confirman con el registro de sesión de la tarea 2.

## Review Focus

1. **Turnos interrumpidos (ESC o hablar encima):** sus tiempos no pueden mezclarse en las medianas porque las bajarían. Se marcan `interrupted: true` y el resumen los excluye. Prueba en la tarea 1 (`summarizeTiming marca interrumpido`) y en la tarea 4 (`summarizeRuns excluye interrumpidos y timeouts`).
2. **Voz silenciada (MUTE) o sin `speechSynthesis`:** `onstart` nunca llega. El reporte del cliente tiene que salir igual al terminar el turno, con los campos de voz en `null`, sin quedar esperando. Prueba en la tarea 3 (`reporte sin voz sale con speechStart null`).
3. **Turnos de tarea y mensajes absorbidos:** un turno que arranca una tarea en segundo plano no debe medirse como si fuera de la persona. Si llegan dos mensajes y los responde un solo turno, el tiempo se cuenta desde el primero. Prueba en la tarea 2 (`timing: turno de tarea no se mide` y `timing: dos mensajes en un turno cuentan desde el primero`).
4. **Con el filtro, falta un conector conservado o el propio `jarvis`:** por un nombre distinto o un `needs-auth`, JARVIS perdería herramientas sin avisar. Se espera un aviso en la consola y la lista `faltan` en el registro de sesión. Prueba en la tarea 6 (`missingKeptServers detecta conservados ausentes o no conectados`).
5. **Arranque en frío:** el primer mensaje de una sesión incluye crear la sesión y cargar el SDK. Mezclado con los demás, distorsiona la comparación. Se marca `cold: true` y se reporta aparte. Prueba en la tarea 4 (`summarizeRuns separa el arranque en frío`).

---

## Fase A: instrumentación

### Task 1: Tiempos del servidor por turno (`src/timing.js`)

**Files:**
- Create: `src/timing.js`
- Test: `test/timing.test.js`

**Interfaces:**
- Produces:
  - `startTurnTiming(receivedAt: number) -> TurnTiming`. Es un objeto mutable: `{ receivedAt, initAt, firstTextAt, doneAt, interrupted, tools }`, con `tools` como `Map<toolUseId, { name, agent, startAt, endAt }>`.
  - `trackMessage(timing: TurnTiming, msg: SDKMessage, at: number) -> void`.
  - `summarizeTiming(timing: TurnTiming) -> { initMs, firstTextMs, doneMs, interrupted, tools: { name, agent, startMs, endMs }[] }`. Los ms son relativos a `receivedAt`, y valen `null` si la etapa no ocurrió.
  - `createTimingLog({ file, appendFile = fs.appendFile, mkdirSync = fs.mkdirSync }) -> { write(record: object): void }`.
  - `sanitizeVoiceRecord(payload: object) -> object | null`.

- [x] **Step 1: Escribir las pruebas que fallan** en `test/timing.test.js`:
  - `trackMessage marca init, primer texto y fin`: con `system/init` en 1100, un `text_delta` del orquestador en 1500, otro en 1600 y `result` `success` en 2000, todo con `receivedAt` en 1000, el resultado es `{ initMs: 100, firstTextMs: 500, doneMs: 1000, interrupted: false, tools: [] }`.
  - `un delta de subagente no cuenta como primer texto`: con `parent_tool_use_id: 'x'`, `firstTextMs` queda en `null`.
  - `herramientas: inicio por content_block_start, fin por tool_result`: con `content_block_start` `{ type:'tool_use', id:'tu1', name:'Agent' }` en 1200, un mensaje `assistant` con el bloque `tool_use` `{ id:'tu1', name:'Agent', input:{ subagent_type:'agenda' } }` y un `user` (`parent_tool_use_id: null`) con `{ type:'tool_result', tool_use_id:'tu1' }` en 1900, el resultado es `tools: [{ name:'Agent', agent:'agenda', startMs:200, endMs:900 }]`.
  - `summarizeTiming marca interrumpido`: con `result` `subtype: 'error_during_execution'`, el resultado es `interrupted: true` y `doneMs` es un número.
  - `createTimingLog escribe una línea JSON por registro`: con un `appendFile` falso, el texto es `JSON.stringify(record) + '\n'` y el directorio se crea con `{ recursive: true }`.
  - `createTimingLog con file vacío no escribe` y `createTimingLog no lanza si appendFile falla`: el callback recibe un error y solo se avisa una vez con `console.warn`.
  - `sanitizeVoiceRecord deja solo claves conocidas`: acepta `turn`, `speechEnd`, `final`, `post`, `firstQueued`, `speechStart`, `endToFinalMs`, `finalToPostMs`, `postToSpeechStartMs`, `speechEndToSpeechStartMs`, si son números finitos o `null`, y `listenMode`, si es un string de hasta 20 caracteres. Descarta cualquier otra clave. Con algo que no es un objeto, devuelve `null`.

- [x] **Step 2: Correr y ver que fallan.** `node --test test/timing.test.js`. Esperado: FAIL con `Cannot find module '../src/timing'`.

- [x] **Step 3: Implementar `src/timing.js`.** El encabezado y los comentarios van en español. `trackMessage` ignora todo `stream_event` con `parent_tool_use_id != null`. Un `tool_result` sin `tool_use_id` conocido se ignora. `createTimingLog` crea el directorio la primera vez que escribe.

- [x] **Step 4: Correr y ver que pasan.** `node --test test/timing.test.js`. Esperado: PASS.

- [x] **Step 5: Commit.** `git add src/timing.js test/timing.test.js && git commit -m "Tiempos por etapa del servidor"`

### Task 2: Tiempos en la sesión, en el canal de eventos y en el registro local

**Files:**
- Modify: `src/session.js` (constructor, `start`, `_consume`, `send`)
- Modify: `src/server.js` (`handleMessage`, `POST_ROUTES`, `deps`, `sessionFactory`)
- Modify: `src/config.js` (agregar `timingLog`)
- Modify: `.gitignore` (agregar `logs/`), `README.md`, `.env.example`
- Test: `test/session.test.js`, `test/server.test.js`

**Interfaces:**
- Consumes: todo lo de la tarea 1.
- Produces:
  - `config.timingLog: string`. Es `process.env.JARVIS_TIMING_LOG`, y si no está, `path.join(ROOT, 'logs', 'tiempos.jsonl')`. Con `'0'` queda en `''`, es decir, apagado.
  - `new Session({ config, emit, sdk, queryFn, timingLog, now = Date.now })`. Si falta `timingLog`, usa uno que no escribe.
  - `session.send(text, { receivedAt } = {})`.
  - El evento SSE `timing` se emite **antes** del `done` o `error` del mismo turno, con `{ turn: number, model, ...summarizeTiming() }`. Solo existe para turnos de la persona.
  - Registros JSONL:
    - `{ tipo: 'servidor', fecha: ISO, turn, model, flags: { mcpFilter, promptDirect }, ...summary }`.
    - Una vez por sesión, `{ tipo: 'sesion', fecha, model, tools: n, mcpTools: n, mcp: init.mcp_servers, skills: n, agents: init.agents ?? [] }`.
    - Por `POST /api/timing`, `{ tipo: 'voz', fecha, ...sanitizeVoiceRecord(payload) }`.
  - La ruta `POST /api/timing` responde 204, o 400 si el cuerpo no se puede sanear. Exige token, como el resto de la API.

- [x] **Step 1: Escribir las pruebas que fallan.**
  - En `test/session.test.js`, con `fakeQuery`, un `timingLog` espía y un `now` controlado:
    - `timing: el turno de la persona emite timing antes de done y lo registra`: con `send('hola', { receivedAt: 1000 })` y el guion `[init, delta('Hola'), success]`, los eventos son `['turn','init','delta','timing','done']`. Además, `timing.turn === 1`, `initMs` es un número y el espía recibe un registro `tipo: 'servidor'` y otro `tipo: 'sesion'`, este último una sola vez aunque haya dos turnos.
    - `timing: turno de tarea no se mide`: con `task_notification`, `init` y `success` sin `send`, no hay evento `timing` ni registro `servidor`.
    - `timing: dos mensajes en un turno cuentan desde el primero`: con `send('a', { receivedAt: 1000 })`, `send('b', { receivedAt: 1300 })`, `init` en 1500 y `success`, el resultado es `initMs === 500`.
  - En `test/server.test.js`:
    - `POST /api/message pasa receivedAt a send`: `fakeSession.send` guarda el segundo argumento, y `typeof opts.receivedAt === 'number'`.
    - `POST /api/timing guarda un registro saneado y da 204`: con `deps.timingLog` espía y el cuerpo `{ turn: 1, speechStart: 5, raro: 'x' }`, el registro tiene `tipo: 'voz'` y no tiene `raro`.
    - `POST /api/timing sin token da 403`.

- [x] **Step 2: Correr y ver que fallan.** `node --test test/session.test.js test/server.test.js`. Esperado: FAIL en las pruebas nuevas, y las viejas siguen en PASS.

- [x] **Step 3: Implementar.**
  - En `Session`, `send` guarda `receivedAt ?? now()` en `this.receivedAts`. En `_consume`, después de `mapMessage` de un `init` con `turnOrigin === 'user'`, se hace `this.timing = startTurnTiming(Math.min(...this.receivedAts))` y se vacía `receivedAts`, en el mismo lugar donde hoy se limpia `this.pushed`. Con origen `task`, `this.timing = null`.
  - Cada mensaje pasa por `trackMessage` con `now()`. Con un `result`, se emite y se registra `timing` antes de los eventos mapeados.
  - El registro `sesion` se escribe con el primer `init` y también se muestra en la consola, en una línea: `  [SESIÓN] modelo … · N herramientas (M de MCP) · servidores: …`.
  - En `server.js`, `handleMessage` toma `const receivedAt = Date.now()` como primera línea. `deps.timingLog = createTimingLog({ file: config.timingLog })` se le pasa a la `Session` en `sessionFactory`.
  - Las `flags` del registro salen de `config.mcpFilter` y `config.promptDirect`. Hasta las tareas 6 y 7 valen `undefined`, que es lo mismo que apagado.
  - README: sección «Tiempos de respuesta», con dónde está el registro y qué significa cada campo. También hay que sumar `JARVIS_TIMING_LOG` a la tabla de configuración y a `.env.example`, y `logs/` a `.gitignore`.

- [x] **Step 4: Correr todo.** `npm test`. Esperado: PASS completo.

- [x] **Step 5: Verificación real (1 turno de cupo).** Correr `jarvis`, escribir «hola» y mirar `logs/tiempos.jsonl`. Tiene que haber un registro `sesion` con la lista de `mcp` y su `source`, y un registro `servidor`. **Hay que anotar el `model` que informa `init` y los nombres exactos de los servidores, porque los usan las tareas 5 y 6.**
  - **Anotado (2026-10-25, puerto 7781, sin `JARVIS_MODEL`):** `init.model` = `claude-opus-5-5`. Sesión con 231 herramientas (228 de MCP), 64 skills y 32 servidores (`source`: `plugin`, `user`, `claudeai`, `sdk`). Los nombres conservados coinciden con el patrón: `claude.ai Gmail`, `claude.ai Google Calendar`, `claude.ai Google Drive` y `claude.ai GitHub` (los cuatro `connected`), `plugin:discord:discord` (**`failed`**) y `jarvis` (`connected`). `init.agents` trae, además de los tres propios, `claude`, `Explore`, `general-purpose`, `Plan`, `statusline-setup` y `superpowers:code-reviewer`.
  - Nota: el evento `timing` nuevo obligó a actualizar la prueba vieja `Session emite los eventos de la query`, que ahora espera `timing` entre `delta` y `done`.

- [x] **Step 6: Commit.** `git add src/session.js src/server.js src/config.js .gitignore README.md .env.example test/session.test.js test/server.test.js && git commit -m "Tiempos por turno en el canal de eventos y en logs/tiempos.jsonl"`

### Task 3: Tiempos de voz en la interfaz

**Files:**
- Create: `public/timing.js`
- Modify: `public/index.html` (agregar `<script src="timing.js"></script>` antes de `app.js`, y la fila `<dt>VOZ</dt><dd id="t-voice">— ms</dd>` después de LATENCIA)
- Modify: `public/app.js`, solo con ganchos: `startListening` (`onresult`, `onend`), el `onresult` y el `onend` de `startBargeIn`, `ask`, `speak`, `flushSentences` y `onEvent` (`timing`, `done`)
- Test: `test/voice-timing.test.js`

**Interfaces:**
- Consumes: el evento `timing` y `POST /api/timing` de la tarea 2.
- Produces:
  - `public/timing.js` funciona en los dos entornos: `module.exports` en Node y `window.JarvisTiming` en el navegador.
  - `buildVoiceReport(marks, server) -> report`. `marks` es `{ speechEnd, final, post, firstQueued, speechStart, listenMode }`, con valores de `performance.now()` o `null`. `server` es el payload de `timing`, o `null`. `report` es `{ turn, ...marks, endToFinalMs, finalToPostMs, postToSpeechStartMs, speechEndToSpeechStartMs, server }`. La diferencia es `null` si falta alguno de sus dos extremos. `listenMode` vale `'clasica'` por defecto.
  - `formatBreakdown(report) -> string`. Devuelve una línea para el `title` de `#t-voice`, por ejemplo: `habla→final 640 ms · init 900 · texto 1800 · voz 2300 · Agent(agenda) 200–3100`.
  - `isReportReady(turn) -> boolean`. Es verdadero si hay `server` y además `speechStart != null` o `firstQueued == null` con el turno terminado.

- [x] **Step 1: Escribir las pruebas que fallan** en `test/voice-timing.test.js` (con `require('../public/timing.js')`):
  - `buildVoiceReport calcula las diferencias`: con `{ speechEnd:100, final:700, post:710, firstQueued:2500, speechStart:2600 }`, el resultado es `endToFinalMs:600`, `finalToPostMs:10`, `postToSpeechStartMs:1890` y `speechEndToSpeechStartMs:2500`.
  - `texto escrito: sin marcas de voz de entrada`: con `speechEnd` y `final` en `null`, `endToFinalMs` es `null`, y `postToSpeechStartMs` se calcula igual.
  - `reporte sin voz sale con speechStart null`: `isReportReady({ server:{}, marks:{ firstQueued:null, speechStart:null }, ended:true }) === true`.
  - `formatBreakdown muestra herramientas con su subagente`.

- [x] **Step 2: Correr y ver que fallan.** `node --test test/voice-timing.test.js`. Esperado: FAIL con «Cannot find module».

- [x] **Step 3: Implementar `public/timing.js` y los ganchos en `app.js`.** Cada gancho tiene una o dos líneas:
  - En `onresult` (escucha normal y barge-in), `lastResultAt = performance.now()`. En `onend`, se llama a `ask(heard, { speechEnd: lastResultAt, final: performance.now() })`.
  - `ask(text, voice = {})` crea `turn.marks` y marca `post` justo antes de `post('/api/message')`. El turno creado en `onEvent('turn')` sin `ask` arranca con todas las marcas en `null`.
  - La firma pasa a ser `speak(text, standalone = false, onStart)`, y `u.onstart` llama a `onStart?.()`. En `flushSentences`, el primer `speak` del turno marca `firstQueued` y le pasa un `onStart` que marca `speechStart` una sola vez.
  - En `onEvent('timing')` se guarda `cur.server = data`. En `done` se marca `cur.ended = true`. Cada vez que cambia algo se llama a `reportIfReady(turn)`: si `isReportReady` da verdadero y el turno todavía no se reportó, se escribe `#t-voice` (el texto es `speechEndToSpeechStartMs`, o `postToSpeechStartMs` si el mensaje fue escrito, y el `title` es `formatBreakdown`) y se hace `post('/api/timing', report)` sin esperar la respuesta.
  - Hay que guardar la referencia al turno antes de que `done` ponga `cur = null`. Un turno interrumpido antes de hablar no se reporta.

- [x] **Step 4: Correr las pruebas.** `npm test`. Esperado: PASS.

- [ ] **Step 5: Verificación manual (unos 3 turnos de cupo).** En Chrome, con `?debug`, decir «hola» por voz. `VOZ` tiene que mostrar los ms, el `title` el desglose, y en `logs/tiempos.jsonl` tiene que aparecer un registro `voz` con el mismo `turn` que el `servidor`. Con MUTE, igual tiene que aparecer el registro, con `speechStart: null`. Con ESC a mitad de un turno, no tiene que quedar nada colgado ni errores en la consola.
  - **Pendiente para la persona:** el agente que implementó no tiene micrófono ni navegador; solo se verificó con `npm test` y `node --check`.
  - Desvíos chicos: `speak` devuelve `true` si la frase quedó en cola, y `firstQueued` se marca solo en ese caso (con MUTE no se marca, y el reporte sale al terminar el turno). El gancho de `flushSentences` es un ayudante `speakTimed` de pocas líneas en `app.js`. Un `timing` con `interrupted: true` no se guarda en el turno, así que ese turno no se reporta.

- [x] **Step 6: Commit.** `git add public/timing.js public/index.html public/app.js test/voice-timing.test.js && git commit -m "Tiempos de voz en la telemetría y en el registro local"`

## Fase B: guion de comparación

### Task 4: `scripts/medir.js`, un guion reproducible por HTTP

**Files:**
- Create: `scripts/medir-lib.js` (funciones puras), `scripts/medir.js` (el que corre)
- Modify: `README.md` (sección «Medir tiempos»)
- Test: `test/medir.test.js`

**Interfaces:**
- Consumes: los eventos `delta`, `timing`, `done`, `confirm`, `tasks` e `init`, la ruta `POST /api/confirm` y los registros `voz` de `logs/tiempos.jsonl`.
- Produces (en `medir-lib.js`):
  - `REQUESTS`: es exactamente `[{ id:'saludo', text:'Hola JARVIS, ¿cómo andás?' }, { id:'agenda', text:'¿Qué tengo hoy en el calendario?' }, { id:'correo', text:'Leé mi último mail.' }, { id:'web', text:'Buscá en la web el pronóstico del tiempo para mañana en Buenos Aires.' }]`.
  - `SENTENCE_RE`: es la misma regex que `flushSentences` en `public/app.js`.
  - `hasFirstSentence(text: string) -> boolean`.
  - `median(values: (number|null)[]) -> number | null`. Ignora los `null` y los `NaN`.
  - `createSseParser(onEvent: (event: string, data: object) => void) -> (chunk: string) => void`.
  - `checkEnv(env) -> string | null`. Devuelve un mensaje de error si falta `MEDIR_CONFIG` o `JARVIS_MODEL`.
  - Cada registro tiene esta forma: `{ request, run, cold, interrupted, timeout, denied, firstSentenceMs, httpFirstTextMs, server: { initMs, firstTextMs, doneMs, tools } | null, text }`.
  - `summarizeRuns(records) -> { byRequest: { [id]: { n, firstSentenceMs, firstTextMs, initMs, doneMs } }, all: {...}, cold: {...} }`. Los valores son medianas: `firstSentenceMs` sale del registro, y `firstTextMs`, `initMs` y `doneMs` salen de `server`. Se excluyen los registros con `interrupted` o `timeout`, y los `cold` se resumen aparte.
  - `compareResults(results: Result[]) -> string`. Arma una tabla de texto. El primer resultado es la base. Muestra la mediana de primera frase por pedido y la global, y la diferencia contra la base. Marca `✔ ≥300 ms` cuando la mejora global llega al umbral.
  - `summarizeVoice(records) -> string`. Toma los registros `voz` y agrupa por `listenMode` las medianas de `endToFinalMs`, `postToSpeechStartMs` y `speechEndToSpeechStartMs`, con su `n`.
- Uso:
  - `MEDIR_CONFIG=<etiqueta> JARVIS_MODEL=<id> [JARVIS_MCP_FILTER=1] [JARVIS_PROMPT_DIRECT=1] node scripts/medir.js`
  - `node scripts/medir.js --comparar logs/medicion-a.json logs/medicion-b.json …`
  - `node scripts/medir.js --voz logs/tiempos.jsonl`

- [x] **Step 1: Escribir las pruebas que fallan** en `test/medir.test.js`:
  - `median con pares, impares y nulls`: `median([3,1,2]) === 2`, `median([4,1,null,3,2]) === 2.5`, `median([]) === null`.
  - `SENTENCE_RE es la misma que usa flushSentences`: lee `public/app.js`, extrae la regex que está dentro de `flushSentences` y compara su `source` con `SENTENCE_RE.source`.
  - `hasFirstSentence`: `'Hola'` da `false`, `'Hola, ¿qué tal? '` da `true` y `'.'` da `false`.
  - `createSseParser junta trozos partidos`: dos chunks que cortan un `event: timing\ndata: {...}\n\n` en el medio producen un solo evento, y `: ping` se ignora.
  - `checkEnv exige MEDIR_CONFIG y JARVIS_MODEL`.
  - `summarizeRuns excluye interrumpidos y timeouts`.
  - `summarizeRuns separa el arranque en frío`: con un registro `cold: true` de 9000 ms y dos tibios de 1000 y 1200, el resultado es `byRequest.saludo.firstSentenceMs === 1100` y `cold.firstSentenceMs === 9000`.
  - `compareResults marca mejora de 300 ms o más`: una base de 2000 contra una variante de 1650 lleva la marca. Contra una de 1800 no la lleva.

- [x] **Step 2: Correr y ver que fallan.** `node --test test/medir.test.js`. Esperado: FAIL con «Cannot find module».

- [x] **Step 3: Implementar `medir-lib.js` y `medir.js`.** `medir.js` hace esto:
  1. Revisa `checkEnv` y avisa que el guion consume cupo y puede abrir pestañas, como `e2e.sh`.
  2. Levanta `node server.js` con `JARVIS_PORT=${MEDIR_PORT || 7789}` y el entorno que recibió, y saca el token de la página igual que `e2e.sh`.
  3. Abre `/api/events` con `fetch` en streaming.
  4. Hace `MEDIR_RUNS` corridas (3 por defecto) de los 4 pedidos, en orden y en **una sola sesión**. Solo el primer pedido es `cold`.
  5. Por pedido, toma `t0` al hacer el POST, `httpFirstTextMs` con el primer `delta` y `firstSentenceMs` cuando el texto acumulado cumple `hasFirstSentence`. Guarda el `timing` del servidor y el texto completo. El timeout es de 150 s.
  6. Antes del pedido siguiente espera hasta 180 s a que `tasks` quede vacío, y después 2 s más.
  7. Rechaza cada `confirm` con `allow:false` apenas llega. **Corta y sale con código 2** si en la salida del servidor aparece `[CONFIRMADO]` o `AUTOMÁTICO` con send, reply o forward, con el mismo `guard` que `e2e.sh`.
  8. Escribe `logs/medicion-<config>-<AAAAMMDD-HHMMSS>.json` con `{ config, env: { JARVIS_MODEL, JARVIS_MCP_FILTER, JARVIS_PROMPT_DIRECT }, model: <de init>, records, summary }` y muestra el resumen.
  9. Al salir mata el servidor, también si algo falló.
  - README: cómo se usa, cuánto cupo consume (12 turnos por configuración) y que los resultados tienen texto real de mails (por eso `logs/` no se sube).

- [x] **Step 4: Correr las pruebas.** `npm test`. Esperado: PASS.

- [x] **Step 5: Commit.** `git add scripts/medir-lib.js scripts/medir.js test/medir.test.js README.md && git commit -m "Guion de medición por HTTP con medianas y comparación"`

## Fase C: medición base (parada obligatoria)

### Task 5: Medir la base y reportarle a la persona

**Files:** ninguno del repo. Los resultados quedan en `logs/`, que no se sube.

- [ ] **Step 1: Fijar el modelo base.** Se usa el `model` que anotó la tarea 2 (paso 5), que es el modelo por defecto de la cuenta. Si `settings.json` define `effortLevel` o `alwaysThinkingEnabled`, también se anota. Hoy no define ninguno de los dos.
- [ ] **Step 2: Correr la base (12 turnos).** `MEDIR_CONFIG=base JARVIS_MODEL=<modelo de init> node scripts/medir.js`. Esperado: termina sin `TIMEOUT` ni código 2, y deja `logs/medicion-base-*.json`.
- [ ] **Step 3: Juntar la base de voz.** Se le pide a la persona que use JARVIS por voz de forma normal hasta tener al menos 8 registros `voz`, sin cambiar nada. Después se corre `node scripts/medir.js --voz logs/tiempos.jsonl`. Si en el registro ya hay suficientes de las tareas 2 y 3, alcanza con esos.
- [ ] **Step 4: Armar el reporte**, en el chat y no en un archivo:
  - la tabla de medianas por pedido (primera frase, primer texto, init y fin) y el arranque en frío;
  - el desglose de dónde se va el tiempo, contrastado con cada sospecha del spec:
    - (1) contexto: `tools` y `mcpTools` del registro `sesion`, más la lista de servidores y su `source`;
    - (2) modelo: cuál es;
    - (3) subagentes: la duración de `Agent(agenda)` y de `Agent(correo)` contra el total;
    - (4) voz: `endToFinalMs`;
    - (5) conectores: la duración de las herramientas `mcp__claude_ai_*`;
  - qué candidatos tienen sentido según los números y el cupo que gastaría cada uno.
- [ ] **Step 5: PARAR.** Mostrarle el reporte a la persona y esperar su visto bueno antes de seguir con la fase D. Si la persona quiere comparar otro modelo principal, se mide como una configuración más dentro del presupuesto, y la decisión es suya.

## Fase D: cambios candidatos (cada uno con su bandera, apagado por defecto y medido)

### Task 6: Cargar solo los servidores MCP que JARVIS conserva (`JARVIS_MCP_FILTER`)

**Files:**
- Create: `src/mcp-filter.js`
- Modify: `src/config.js` (`mcpFilter: process.env.JARVIS_MCP_FILTER === '1'`), `src/agent-options.js` (`settings`, `skills`), `src/session.js` (agrega `faltan` al registro `sesion` y avisa en la consola), `README.md`, `.env.example`
- Test: `test/mcp-filter.test.js`, `test/agents.test.js`

**Interfaces:**
- Produces:
  - `KEPT_MCP_SERVERS = ['claude.ai Gmail', 'claude.ai Google Calendar', 'claude.ai Google Drive', 'claude.ai GitHub', 'plugin:discord:discord']` y `OWN_MCP_SERVERS = ['jarvis']`.
  - `buildMcpFilterSettings() -> { allowedMcpServers: { serverName: string }[] }`, con los conservados más los propios.
  - `missingKeptServers(mcpServers: { name, status }[]) -> string[]`. Devuelve los conservados y propios que no aparecen o que tienen un `status` distinto de `'connected'`.
  - `buildAgentOptions` con `config.mcpFilter` suma `buildMcpFilterSettings()` a `settings` (sin tocar `disableAllHooks` ni `autoMemoryEnabled`) y pone `options.skills = []`.

- [ ] **Step 1: Spike (1 o 2 turnos).** Correr una vez con `JARVIS_MCP_FILTER=1` y un `settings.allowedMcpServers` armado a mano, escribir «hola» y mirar el registro `sesion`.
  - Hay que confirmar tres cosas: que solo quedan conectados los conservados y `jarvis`, que bajó `mcpTools` y qué pasa con `skills` y con `agents`.
  - **Regla de decisión:** si los otros conectores siguen `connected`, la allowlist de la capa flag no aplica, y se usa el plan B: en `Session.start`, `await q.mcpServerStatus()` y después `toggleMcpServer(name, false)` para cada servidor que no esté en las listas y no sea `source: 'sdk'`. La cola de entrada espera a que eso termine antes de entregarle el primer mensaje al SDK. El plan B se prueba con `fakeQuery` (`filtro por toggle apaga los no conservados antes del primer mensaje`).
  - Si `init.agents` trae agentes de plugins, se anota como hallazgo para el reporte. No se implementa nada sin medirlo.
  - Lo que se vio queda escrito en el mensaje del commit.
- [ ] **Step 2: Escribir las pruebas que fallan.**
  - `buildMcpFilterSettings incluye los cinco conservados y jarvis`.
  - `missingKeptServers detecta conservados ausentes o no conectados`: con `[{ name:'claude.ai Gmail', status:'connected' }, { name:'claude.ai Google Drive', status:'needs-auth' }, { name:'jarvis', status:'connected' }]`, el resultado incluye `'claude.ai Google Drive'`, `'claude.ai Google Calendar'`, `'claude.ai GitHub'` y `'plugin:discord:discord'`, y no incluye `'jarvis'`.
  - En `test/agents.test.js`:
    - `con el filtro las confirmaciones no cambian`: `permissionMode === 'default'`, `canUseTool` es el mismo, `settings.permissions === undefined`, `settings.disableAllHooks === true` y `settingSources` vale `['user']`.
    - `sin el filtro las opciones quedan como hoy`: no hay `allowedMcpServers` ni `skills`.
- [ ] **Step 3: Correr y ver que fallan.** `node --test test/mcp-filter.test.js test/agents.test.js`.
- [ ] **Step 4: Implementar.** Si falta un servidor conservado, la consola muestra `  [AVISO] Con el filtro de MCP faltan: …`. README y `.env.example`: `JARVIS_MCP_FILTER=1` es experimental y deja solo Gmail, Calendar, Drive, GitHub y Discord.
- [ ] **Step 5: Correr las pruebas.** `npm test`. Esperado: PASS.
- [ ] **Step 6: Medir (12 turnos).** `MEDIR_CONFIG=filtro JARVIS_MODEL=<el de la base> JARVIS_MCP_FILTER=1 node scripts/medir.js`, y después `node scripts/medir.js --comparar logs/medicion-base-*.json logs/medicion-filtro-*.json`.
  - Hay que comparar a mano los textos de las respuestas de los dos archivos.
  - También hay que correr `scripts/e2e.sh` con `JARVIS_MCP_FILTER=1`. Esperado: la confirmación del caso 2 se deniega y no aparece `BLOQUEADO`.
- [ ] **Step 7: Commit y nota.** `git commit -m "Filtro opcional de servidores MCP (JARVIS_MCP_FILTER)"`. La tabla y lo que se observó se guardan para el reporte de la tarea 9.

### Task 7: Las consultas rápidas van directo al conector (`JARVIS_PROMPT_DIRECT`)

**Files:**
- Modify: `src/prompt.js` (`buildSystemPrompt({ userName, directQuick })`), `src/agent-options.js` (pasa `directQuick: config.promptDirect`), `src/config.js` (`promptDirect: process.env.JARVIS_PROMPT_DIRECT === '1'`), `README.md`, `.env.example`
- Test: `test/prompt.test.js`

**Interfaces:**
- Produces: `buildSystemPrompt({ userName, directQuick = false }) -> string`. Con `directQuick`, la línea de delegación de hoy («Lo que lleva varios pasos… agenda para Calendar, correo para Gmail, investigador para la web.») se cambia por estas dos, textuales:
  - `'Las consultas puntuales de agenda o correo (qué tengo hoy, a qué hora es una reunión, cuál es mi último mail) las hacés vos directamente con el conector de Calendar o de Gmail, sin delegar.'`
  - `'Delegá con la herramienta Agent solo lo que lleva varios pasos o mucha lectura: agenda para Calendar, correo para Gmail, investigador para la web.'`

- [ ] **Step 1: Escribir las pruebas que fallan.**
  - `directQuick manda lo puntual al conector`: el prompt incluye `'sin delegar'` y sigue pasando `el prompt trae las reglas de delegación`.
  - `sin directQuick el prompt queda como hoy`: no incluye `'sin delegar'`.
  - `directQuick conserva la regla de confirmación`: incluye `'requiere que la persona lo confirme'`.
- [ ] **Step 2: Correr y ver que fallan.** `node --test test/prompt.test.js`.
- [ ] **Step 3: Implementar** y documentar la variable como experimental.
- [ ] **Step 4: Correr las pruebas.** `npm test`. Esperado: PASS.
- [ ] **Step 5: Medir (12 turnos).** `MEDIR_CONFIG=directo JARVIS_MODEL=<el de la base> JARVIS_PROMPT_DIRECT=1 node scripts/medir.js`, y después `--comparar` contra la base.
  - En el `timing` hay que confirmar que `agenda` y `correo` dejaron de pasar por `Agent`.
  - Hay que comparar los textos a mano, porque ahora el que lee es el modelo principal y no el subagente.
- [ ] **Step 6: Commit.** `git commit -m "Variante de prompt: consultas rápidas directo al conector (JARVIS_PROMPT_DIRECT)"`

### Task 8: Escucha continua con temporizador de silencio propio (`?escucha=continua`)

**Files:**
- Modify: `public/app.js`, solo `startListening` (más una constante y la lectura del modo cerca de `SR`). No se tocan la escucha de confirmación ni el barge-in.
- Modify: `README.md`

**Interfaces:**
- Consumes: `marks.listenMode` y `summarizeVoice` (tareas 3 y 4).
- Produces:
  - `listenMode`: el valor de `?escucha=` en la URL, que se guarda con `store.set('listenMode', …)`. Si no viene, se lee `store.get('listenMode', 'clasica')`. Los valores posibles son `'clasica'` y `'continua'`.
  - `SILENCE_MS = 800`, que es un valor inicial y se ajusta con los números.

- [ ] **Step 1: Implementar.**
  - En `'continua'`: `rec.continuous = true`, y cada `onresult` reinicia un `setTimeout(SILENCE_MS)` que llama a `rec.stop()`. El `onend` actual sigue igual: si `heard` tiene algo, llama a `ask`.
  - El temporizador se limpia en `onend` y en `dropRec`.
  - `ask` recibe `listenMode` en las marcas.
  - En `'clasica'` el código hace exactamente lo mismo que hoy.
- [ ] **Step 2: Pruebas automáticas.** `npm test` tiene que seguir en PASS. La API de voz no se puede probar con `node:test`.
- [ ] **Step 3: Verificación manual con `?debug`.** Con `?escucha=continua`, hay que probar cuatro cosas:
  - una frase corta y otra con una pausa en el medio: no se tiene que cortar antes de tiempo;
  - el barge-in («basta» mientras JARVIS habla);
  - ESC;
  - una confirmación por voz, «sí» o «no».
  Después, volver con `?escucha=clasica`.
- [ ] **Step 4: Medir con uso real.** Se le pide a la persona al menos 8 turnos por voz en cada modo y se corre `node scripts/medir.js --voz logs/tiempos.jsonl`. Lo que se compara es `speechEndToSpeechStartMs`, y el umbral es el mismo: 300 ms. Hay que anotar si aparecen frases cortadas.
- [ ] **Step 5: Commit.** `git commit -m "Escucha continua opcional con temporizador de silencio (?escucha=continua)"`

### Task 9: Combinación, reporte final y adopción (parada obligatoria)

**Files:** `src/config.js`, `README.md` y `.env.example`, pero solo si la persona aprueba algún cambio de default.

- [ ] **Step 1: Combinar, solo si las tareas 6 y 7 mejoraron cada una ≥300 ms por su lado (12 turnos).** `MEDIR_CONFIG=combinado JARVIS_MODEL=<el de la base> JARVIS_MCP_FILTER=1 JARVIS_PROMPT_DIRECT=1 node scripts/medir.js`, y después `--comparar` con los cuatro archivos. Con esto la cuenta llega a 48 turnos de guion, y quedan 12 para un modelo alternativo si la persona lo pidió en la tarea 5.
- [ ] **Step 2: Reporte final para la persona.** Incluye:
  - la tabla de `--comparar` y la de `--voz`;
  - por cada candidato: si llegó al umbral, qué se vio en los textos y cualquier riesgo (por ejemplo, conectores `needs-auth` o agentes de plugins);
  - la propuesta concreta de qué pasar a default.
- [ ] **Step 3: PARAR y esperar la decisión.**
- [ ] **Step 4: Aplicar solo lo aprobado.**
  - Por cada bandera aprobada, el default pasa a encendido y `'0'` la apaga: `JARVIS_MCP_FILTER !== '0'` o `JARVIS_PROMPT_DIRECT !== '0'`. En el caso de la escucha, `store.get('listenMode', 'continua')`.
  - Hay que actualizar las pruebas que fijan el default, el README (la tabla de configuración y «Tiempos de respuesta») y `.env.example`.
- [ ] **Step 5: Verificación final.** `npm test` en PASS. `scripts/e2e.sh`: las confirmaciones se deniegan, no aparece `BLOQUEADO`, la tarea en segundo plano avisa y el caso 3 responde. A mano: interrupción con ESC y por voz.
- [ ] **Step 6: Commit.** `git commit -m "Adopta los cambios de rendimiento aprobados"`
