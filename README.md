# J.A.R.V.I.S.

Interfaz de voz futurista para conversar con Claude usando **tu suscripción**. No usa API key: el servidor local usa el [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk), que autentica con tu login de Claude Code.

JARVIS tiene acceso a tus **conectores y plugins** (Gmail, Google Calendar, Drive, GitHub, etc.) y a búsqueda web. Lee y busca sin preguntar; **solo te pide confirmación antes de enviar o borrar algo**, por voz («sí» / «no») o con un botón.

## Puesta en marcha, paso a paso
JARVIS usa **tu** cuenta de Claude y **tus** conectores: cada persona lo configura con lo suyo, y en el repo no queda ningún dato personal.

### 1. Instalar lo necesario
- **Node 20.12 o superior** ([nodejs.org](https://nodejs.org)). Comprobalo con `node -v`.
- **Chrome o Edge**. El reconocimiento de voz no funciona en Firefox.
- **Claude Code**: `npm install -g @anthropic-ai/claude-code`
- Una **suscripción de Claude** (Pro o Max). JARVIS consume de tu cupo.

### 2. Iniciar sesión en Claude Code
Abrí una terminal, corré `claude` y hacé login con tu cuenta de claude.ai. Alcanza con hacerlo una vez; JARVIS reutiliza esa sesión.

### 3. Conectar tus apps (Gmail, Calendar, Drive…)
JARVIS usa los conectores de tu cuenta de claude.ai. En [claude.ai](https://claude.ai) andá a **Configuración → Conectores** y conectá los que quieras usar, por ejemplo Gmail, Google Calendar, Google Drive o GitHub. Si no conectás nada, igual funciona con búsqueda web, abrir páginas y YouTube.

Para comprobar qué ve tu cuenta, corré `claude` y escribí `/mcp`: los conectores de claude.ai aparecen ahí.

### 4. Descargar e instalar JARVIS
```
git clone https://github.com/Chrisnatalx/JARVIS.git
cd JARVIS
npm install
npm link
```
`npm link` registra el comando global `jarvis`. Si después movés la carpeta, volvé a correr `npm link` adentro.

`npm install` también baja el modelo de manos de MediaPipe (~7,8 MB) a `vendor/` y comprueba su huella. Si no había red, avisa y sigue: los gestos quedan apagados hasta que corras `npm run modelo`.

### 5. Tu configuración (opcional)
Copiá `.env.example` como `.env` y completá lo que necesites. Las variables están explicadas en [Configuración](#configuración). Lo más común es esto:
```
JARVIS_USER_NAME=Tu nombre
JARVIS_TIMEZONE=America/Argentina/Buenos_Aires
JARVIS_GOOGLE_ACCOUNT=tu-mail@ejemplo.com
```
`JARVIS_USER_NAME` es cómo te llama JARVIS y `JARVIS_TIMEZONE` define su fecha y hora (si la omitís usa la de tu sistema). `JARVIS_GOOGLE_ACCOUNT` sirve si tenés varias cuentas de Google en el navegador, para que Calendar y Gmail se abran en la correcta. El `.env` es tuyo y no se sube al repo.

### 6. Arrancar
Corré `jarvis`, permití el micrófono y la cámara cuando el navegador lo pida y hablale. La cámara es para los [gestos con la mano](#gestos-con-la-mano); si no la querés, negá el permiso o tocá **C**.

## Uso
En cualquier terminal:

```
jarvis
```

Levanta el servidor y abre la interfaz. Si ya estaba corriendo, solo abre la ventana. Dejá la terminal abierta; Ctrl+C lo apaga. (Alternativa en Windows: doble clic en `iniciar-jarvis.bat`.)

- **Hablá directamente**: JARVIS detecta cuándo empezás y terminás de hablar (tras una pausa corta envía la frase), responde y vuelve a escuchar.
- **ESPACIO** o botón **MICRÓFONO**: prende/apaga la escucha.
- **ESC**, o tocar el núcleo mientras habla: interrumpe la respuesta y vuelve a escucharte.
- **Interrumpir hablando**: mientras JARVIS habla sigue escuchando. Ignora las palabras que él mismo está diciendo (el micrófono también capta los parlantes) y corta cuando oye 3 palabras nuevas o una orden como «basta», «callate», «esperá» o «Jarvis». Con auriculares funciona mejor.
- **NUEVA**: empieza una conversación sin contexto previo. Si hay tareas en segundo plano, te avisa cuántas se cancelarían y espera tu «sí» o «no».
- **Una sola ventana**: la página escucha a JARVIS por un canal de eventos permanente (`/api/events`) y le manda lo que decís por POST. Hay una única sesión viva con Claude, y solo una ventana activa a la vez: si abrís otra, la primera avisa «JARVIS está abierto en otra ventana» y se queda quieta (recargala con F5 para volver a usarla).
- **Si algo termina por su cuenta** (una tarea en segundo plano), JARVIS te lo dice cuando no estés hablando con él.
- Voz, velocidad y tono se ajustan en el panel izquierdo. En Edge aparecen voces "Natural" más realistas.

## Acciones y confirmación
Leer, buscar y consultar (tu calendario, tus mails, la web…) corre solo. Piden confirmación las acciones que **envían** algo a otras personas o **publican** algo: mandar, responder o reenviar un mail; compartir; invitar; publicar, push o merge; comentar; responder a una invitación de Calendar (le llega un mail al organizador); las herramientas de GitHub que escriben (crear o editar issues, pull requests, archivos, reseñas, comentarios y repositorios, hacer fork); y los eventos de Calendar con invitados (`attendees`, `attendeeEmails`, `addedAttendees` o `addedAttendeeEmails` con algo adentro). **Todo `update_event` de Calendar pide confirmación**, porque por defecto avisa por mail a todos los invitados, salvo que venga con `notificationLevel: NONE`. También piden confirmación las acciones que **borran** algo (borrar, mandar a la papelera, quitar, revocar). Crear un evento sin invitados no pide nada. La regla está en `needsConfirm`, en `src/permissions.js`.

**No pongas reglas `allow` para herramientas que envían o borran en la configuración de Claude Code** (`~/.claude/settings.json`, por ejemplo `mcp__claude_ai_Gmail` o `mcp__claude_ai_Gmail__send_message`). JARVIS carga tus permisos de usuario y una regla `allow` aprueba la herramienta sin pasar por la confirmación por voz: se saltaría. El SDK no ofrece (en la versión instalada) una forma pública de leer las reglas vigentes al arrancar, así que JARVIS no puede avisarte: revisalo vos.

Cuando hace falta confirmar:
1. Te dice en una oración qué va a enviar o borrar.
2. Aparece el panel **AUTORIZACIÓN REQUERIDA** con el detalle exacto de la acción.
3. Te pregunta «¿Me autorizás a usar …?» y escucha tu respuesta: «sí», «dale», «confirmo» / «no», «cancelá». Si la frase trae un sí y un no a la vez, vuelve a preguntar. En el registro queda qué entendió («Escuché: …»).
4. Si no respondés en 2 minutos, o interrumpís, la acción se rechaza y el panel se cierra solo («Autorización vencida» en el registro). Si recargás la página con una confirmación pendiente, el panel reaparece.

Los subagentes nunca pueden confirmar: si uno intenta enviar o borrar algo, se le deniega y en el registro queda «Un subagente intentó … y se lo impedí».

## Abrir cosas en el navegador
JARVIS puede abrir páginas en una pestaña nueva de tu navegador por defecto (herramienta propia `abrir_en_navegador`, en `src/tools/`), sin pedir confirmación porque no envía ni borra nada. Por ejemplo, si le preguntás por tus reuniones de la semana, te las resume y abre Google Calendar en la vista semanal. También sirve para «mostrame el repo», «abrime ese mail», etc. Solo abre direcciones `http`/`https`, y cada una queda anotada en el registro («Abrí: …»).

**Música**: «poné X en YouTube» busca y abre el primer video (herramienta `poner_en_youtube`; lee la página de resultados, sin API key; si no logra identificar el video, abre la búsqueda). Al hacerlo **se apaga el micrófono**, para que la música no se tome como si le hablaras: tocá **ESPACIO** para volver a hablarle. JARVIS no controla la pestaña después de abrirla (pausar o cambiar de tema se hace a mano).

De las herramientas internas de Claude Code solo están habilitadas las de web (sin terminal ni archivos). Los hooks y la memoria de archivos de Claude Code están desactivados en JARVIS.

## Gestos con la mano
Con la cámara prendida, JARVIS sigue tu mano en el navegador con MediaPipe (`HandLandmarker`). **El video no se muestra en pantalla y no sale de tu máquina**: MediaPipe, sus archivos `.wasm` y el modelo se sirven desde el propio servidor local, sin CDN. MediaPipe trae un cliente de estadísticas que intenta mandar datos de uso a Google (`odml.pa.googleapis.com`): la página se sirve con la política `connect-src 'self'`, que lo bloquea (en la consola del navegador vas a ver el aviso del bloqueo).

| Gesto | Qué hace |
|---|---|
| **Pellizco** (pulgar e índice estirados, el resto de los dedos recogidos), abrir y cerrar los dedos | Agranda o achica el núcleo, como el zoom del celular |
| **Juntar** pulgar e índice del todo y mover la mano | Agarra el núcleo y lo arrastra |
| **Soltar** (abrir la mano o sacarla del cuadro) | El núcleo vuelve solo a su lugar y a su tamaño |
| Mano **de derecha a izquierda**, rápido | Gira el carrusel a la vista siguiente: Núcleo → Calendar → Mail → Núcleo |
| Mano **de izquierda a derecha**, rápido | Vuelve una vista atrás |
| Mano **hacia arriba**, rápido | Muestra el Clima |
| Mano **hacia abajo**, rápido (desde el Clima) | Vuelve a la vista de antes |

Las direcciones son las tuyas: si movés la mano hacia tu izquierda, la pantalla gira hacia tu izquierda. **Gesticular mientras hablás no cuenta**: solo dispara un movimiento brusco y largo (más de un tercio del cuadro en menos de 300 ms, casi sin desvío), con la mano estable en el cuadro y fuera de un pellizco, y después de un giro hay casi un segundo de espera. El pellizco solo actúa sobre el Núcleo.

- **C** o el botón **CÁMARA**: prende/apaga la cámara (se apaga la luz). La preferencia se guarda en el navegador.
- **Flechas del teclado** (← → ↑ ↓): lo mismo que los giros, sin cámara.
- Abajo a la izquierda se ve el estado: `MANO DETECTADA`, `SIN MANO`, `CÁMARA APAGADA` o `GESTOS NO DISPONIBLES: …` con el motivo (sin permiso de cámara, falta el modelo, etc.). La voz y el teclado andan igual.
- **Faltan los gestos** («corré npm run modelo»): `npm run modelo` vuelve a bajar el modelo.
- Con `?debug` en la dirección, la consola muestra cada 5 s cuánto tarda la detección, y la `x` de tu palma: al mover la mano hacia tu izquierda tiene que bajar. Si sube, tu webcam ya viene espejada (avisá: hay que sacar el `unmirror` en `public/hands.js`).
- Con poca luz el seguimiento empeora: el indicador ayuda a ver qué pasa. La detección corre a 15 cuadros por segundo para no frenar el núcleo de partículas.

## Vistas
El carrusel tiene tres caras en un anillo (**Núcleo**, **Calendar** y **Mail**) y el **Clima** arriba, fuera del anillo. Los puntitos de abajo marcan en qué cara estás. Con una vista abierta el núcleo queda chiquito en la esquina, cambia de color como el grande (escuchando, pensando, hablando) y tocarlo hace lo mismo de siempre.

- **Calendar**: la semana entera, de lunes a domingo, con los eventos de todos tus calendarios visibles. Los de día completo van arriba y los que rechazaste no aparecen. Un evento que cruza la medianoche, o que empezó antes del lunes, aparece en cada día que toca (con «…»). Hoy queda marcado según la zona horaria de JARVIS (`JARVIS_TIMEZONE`).
- **Mail**: los últimos 8 hilos de la bandeja de entrada, numerados, con los no leídos marcados.
- **Clima**: Buenos Aires ahora (temperatura, sensación, viento y humedad) y los próximos días, desde [Open-Meteo](https://open-meteo.com) (gratis, sin API key, lo pide el servidor).
- Cada cara dice cuándo se actualizó, o el error si no hay datos.

**Se le puede hablar desde cualquier vista**, y JARVIS sabe cuál estás mirando: en Mail, «¿de qué trata el segundo?» o «respondé el segundo» se refieren al segundo hilo de la lista que ves (va con su id, así no se confunde aunque llegue un mail nuevo). Antes de responder, archivar o borrar un hilo de la vista, JARVIS lo lee y comprueba que el asunto sea el que ves; si no coincide, te pregunta. Mientras Mail está abierta la lista no cambia sola; se actualiza al volver a entrar, o enseguida si JARVIS respondió, archivó o borró algo. Las confirmaciones de envío y borrado son las de siempre.

**Girar es instantáneo y no gasta un turno**: los datos ya están guardados en el servidor. Calendar y Gmail se traen con una consulta aparte de la conversación (`src/feeds/google.js`): modelo `haiku`, sin el prompt de JARVIS, **solo tres herramientas de lectura** (`list_calendars`, `list_events` y `search_threads`) y respuesta en JSON validado. Es de solo lectura a prueba de fallas: solo se conectan los servidores de Gmail y Calendar (`allowedMcpServers` por URL, así tampoco arrancan tus plugins ni tus otros MCP), las demás herramientas quedan fuera del contexto, un `canUseTool` propio deniega cualquier otra aunque tu `~/.claude/settings.json` la permita, y si la consulta llega a ver una sola herramienta de más, no corre. **Consume cupo de tu cuenta**: medido, unos US$0,005 a US$0,008 por refresco a precio de lista, y unos 20 a 25 segundos en segundo plano. Corre solo mientras haya una ventana de JARVIS abierta: al abrirla (si los datos tienen más de un minuto), cada 10 minutos, al volver a la pestaña (si tienen más de 5) y después de que JARVIS escriba de verdad algo en Gmail o Calendar (una confirmación rechazada no cuenta). Si un refresco falla, los de rutina esperan 2 minutos antes de reintentar. El modelo se cambia con `JARVIS_FEED_MODEL`.

## Configuración
Copiá `.env.example` como `.env` en la carpeta de JARVIS y completá lo que necesites (también las API keys que se sumen). `.env` no se sube al repo. Una variable definida en la terminal tiene prioridad sobre el archivo.

| Variable | Default | Para qué |
|---|---|---|
| `JARVIS_PORT` | `7777` | Puerto local |
| `JARVIS_MODEL` | modelo por defecto de tu cuenta | p. ej. `sonnet` o `haiku` para respuestas más rápidas |
| `JARVIS_USER_NAME` | vacío | Tu nombre, para que JARVIS te hable por él (queda solo en tu `.env`) |
| `JARVIS_TIMEZONE` | zona del sistema | Zona horaria IANA (p. ej. `America/Argentina/Buenos_Aires`) para la fecha y hora que ve JARVIS. Si no es válida, avisa en la consola y usa la del sistema |
| `JARVIS_GOOGLE_ACCOUNT` | vacío | Mail de la cuenta de Google con la que abrir Calendar, Gmail o Drive si tenés varias en el navegador (agrega `authuser=`) |
| `JARVIS_FEED_MODEL` | `haiku` | Modelo de la consulta de lectura que trae Calendar y Gmail para las [vistas](#vistas) |
| `JARVIS_AGENT_<NOMBRE>_MODEL` | `haiku` (agenda), `sonnet` (correo, investigador) | Modelo de cada subagente: `AGENDA`, `CORREO` o `INVESTIGADOR` (ver [Subagentes](#subagentes-y-tareas-en-segundo-plano)) |
| `CLAUDE_BIN` | autodetectado | Ruta al ejecutable de Claude Code (si no, usa el que trae el SDK) |

## Subagentes y tareas en segundo plano
JARVIS puede delegar trabajo en subagentes (definidos en `src/agents/`). Los tres son de solo lectura o de preparación: **no envían ni borran nada**. Lo que envía o borra lo hace JARVIS mismo, y pide tu confirmación.

| Subagente | Qué hace | Modelo por defecto | Variable para cambiarlo |
|---|---|---|---|
| `agenda` | Consulta Google Calendar: reuniones de un día o una semana, huecos libres, propuestas de horario. Solo lee. | `haiku` | `JARVIS_AGENT_AGENDA_MODEL` |
| `correo` | Busca y lee Gmail, resume hilos y deja borradores. No envía. | `sonnet` | `JARVIS_AGENT_CORREO_MODEL` |
| `investigador` | Búsquedas y lecturas web largas. **Corre en segundo plano**. | `sonnet` | `JARVIS_AGENT_INVESTIGADOR_MODEL` |

Para cambiar el modelo de uno, poné la variable en tu `.env` (por ejemplo `JARVIS_AGENT_AGENDA_MODEL=sonnet`) y reiniciá JARVIS.

- **Tareas en segundo plano**: mientras el investigador trabaja podés seguir hablando. Las tareas en curso aparecen en el panel, donde se pueden cancelar. Cuando una termina, JARVIS te lo cuenta apenas no estés hablando con él.
- **Reiniciar el servidor (o NUEVA con confirmación) cancela las tareas en curso**: no sobreviven a un reinicio.
- **Agregar un subagente**: creá un archivo en `src/agents/` que exporte `name`, `description`, `prompt`, `tools` (solo las herramientas que necesita), `model` y `maxTurns` (y `background: true` si debe correr en segundo plano), y registralo en la lista de `src/agents/index.js`. Su modelo se podrá cambiar con `JARVIS_AGENT_<NOMBRE>_MODEL`. Un subagente no debería tener herramientas que envíen o borren.
- **Agregar una herramienta propia**: definila en un archivo de `src/tools/` (con `sdk.tool(...)`) y registrala en `src/tools/index.js`.
- **Prueba de punta a punta**: `scripts/e2e.sh` levanta el servidor en el puerto 7788 y manda mensajes de prueba (con argumentos, manda esos mensajes). **Consume cupo de tu cuenta y puede abrir pestañas**; rechaza toda confirmación, pero usa tus conectores reales, así que revisá los mensajes antes de correrlo.

## Seguridad y privacidad
- El servidor solo escucha en `127.0.0.1` y exige un token que se genera en cada arranque y solo conoce la página de JARVIS: otra web abierta en tu navegador no puede mandarle órdenes ni confirmar acciones. Si reiniciás el servidor, recargá la página (F5). La página se reconecta sola si el canal de eventos se corta, salvo que el token ya no valga (ahí pide F5).
- El canal de eventos (`GET /api/events`), los datos de las vistas (`GET /api/feeds` y `POST /api/feeds/refresh`) y todas las acciones POST (`/api/message`, `/api/interrupt`, `/api/confirm`, `/api/new`, `/api/tasks/stop`) exigen el mismo token y el mismo host local; solo un cliente está conectado al canal a la vez.
- Cada mensaje consume de tu cupo de Claude, y también el refresco de Calendar y Gmail de las vistas (ver [Vistas](#vistas)).
- La cámara se procesa en el navegador: el video no se muestra ni sale de tu máquina. La página solo puede conectarse a su propio servidor (`connect-src 'self'`), lo que bloquea la telemetría de MediaPipe.
- Los asuntos y remitentes de los mails que viajan con tu mensaje (vista de Mail) se aplanan, se recortan y van marcados como datos, no como instrucciones.
- El reconocimiento de voz del navegador procesa el audio en servidores de Google (Chrome) o Microsoft (Edge).
- La personalidad se define en `src/prompt.js`.

## Estructura del código
```
server.js            punto de entrada (reexporta src/server.js; lo usa bin/jarvis.js)
src/
  server.js          servidor HTTP: interfaz, canal de eventos (GET /api/events) y acciones POST
  config.js          configuración leída del entorno (.env)
  prompt.js          prompt de sistema, línea de fecha y línea de la vista en pantalla
  permissions.js     qué pide confirmación y la puerta de confirmaciones
  agent-options.js   opciones del Agent SDK compartidas
  session.js         la sesión viva con Claude: cola de entrada, eventos y confirmaciones
  events.js          canal de eventos (SSE) hacia la interfaz
  agents/            subagentes (agenda, correo, investigador) y su registro en index.js
  tools/             herramientas propias (navegador, YouTube); se registran en index.js
  feeds/             datos de las vistas: weather.js (Open-Meteo), google.js (Calendar y Gmail,
                     query de solo lectura) y cache.js (caché y refresco en segundo plano)
scripts/             e2e.sh: prueba de punta a punta (consume cupo); descargar-modelo.js (npm run modelo)
test/                pruebas (npm test)
public/              interfaz web
  app.js             lógica del cliente: voz, conversación, núcleo, cámara y carrusel
  gestures.js        rastreador de gestos (puro, con tests): giros, pellizco, agarre
  nav.js             navegación del carrusel y datos de la vista (puro, con tests)
  hands.js           cámara y MediaPipe HandLandmarker en el navegador
  faces.js           caras del carrusel: Calendar, Mail y Clima
vendor/              el modelo de manos (lo baja npm install; no se sube al repo)
```
