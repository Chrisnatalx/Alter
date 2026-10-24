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

### 5. Tu configuración (opcional)
Copiá `.env.example` como `.env` y completá lo que necesites. Las variables están explicadas en [Configuración](#configuración). Lo más común es esto:
```
JARVIS_USER_NAME=Tu nombre
JARVIS_TIMEZONE=America/Argentina/Buenos_Aires
JARVIS_GOOGLE_ACCOUNT=tu-mail@ejemplo.com
```
`JARVIS_USER_NAME` es cómo te llama JARVIS y `JARVIS_TIMEZONE` define su fecha y hora (si la omitís usa la de tu sistema). `JARVIS_GOOGLE_ACCOUNT` sirve si tenés varias cuentas de Google en el navegador, para que Calendar y Gmail se abran en la correcta. El `.env` es tuyo y no se sube al repo.

### 6. Arrancar
Corré `jarvis`, permití el micrófono cuando el navegador lo pida y hablale.

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

## Configuración
Copiá `.env.example` como `.env` en la carpeta de JARVIS y completá lo que necesites (también las API keys que se sumen). `.env` no se sube al repo. Una variable definida en la terminal tiene prioridad sobre el archivo.

| Variable | Default | Para qué |
|---|---|---|
| `JARVIS_PORT` | `7777` | Puerto local |
| `JARVIS_MODEL` | modelo por defecto de tu cuenta | p. ej. `sonnet` o `haiku` para respuestas más rápidas |
| `JARVIS_USER_NAME` | vacío | Tu nombre, para que JARVIS te hable por él (queda solo en tu `.env`) |
| `JARVIS_TIMEZONE` | zona del sistema | Zona horaria IANA (p. ej. `America/Argentina/Buenos_Aires`) para la fecha y hora que ve JARVIS. Si no es válida, avisa en la consola y usa la del sistema |
| `JARVIS_GOOGLE_ACCOUNT` | vacío | Mail de la cuenta de Google con la que abrir Calendar, Gmail o Drive si tenés varias en el navegador (agrega `authuser=`) |
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
- El canal de eventos (`GET /api/events`) y todas las acciones POST (`/api/message`, `/api/interrupt`, `/api/confirm`, `/api/new`, `/api/tasks/stop`) exigen el mismo token y el mismo host local; solo un cliente está conectado al canal a la vez.
- Cada mensaje consume de tu cupo de Claude.
- El reconocimiento de voz del navegador procesa el audio en servidores de Google (Chrome) o Microsoft (Edge).
- La personalidad se define en `src/prompt.js`.

## Estructura del código
```
server.js            punto de entrada (reexporta src/server.js; lo usa bin/jarvis.js)
src/
  server.js          servidor HTTP: interfaz, canal de eventos (GET /api/events) y acciones POST
  config.js          configuración leída del entorno (.env)
  prompt.js          prompt de sistema y línea de fecha
  permissions.js     qué pide confirmación y la puerta de confirmaciones
  agent-options.js   opciones del Agent SDK compartidas
  session.js         la sesión viva con Claude: cola de entrada, eventos y confirmaciones
  events.js          canal de eventos (SSE) hacia la interfaz
  agents/            subagentes (agenda, correo, investigador) y su registro en index.js
  tools/             herramientas propias (navegador, YouTube); se registran en index.js
scripts/             e2e.sh: prueba de punta a punta (consume cupo)
test/                pruebas (npm test)
public/              interfaz web
```
