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
- **NUEVA**: empieza una conversación sin contexto previo.
- Voz, velocidad y tono se ajustan en el panel izquierdo. En Edge aparecen voces "Natural" más realistas.

## Acciones y confirmación
Leer, buscar y consultar (tu calendario, tus mails, la web…) corre solo. Piden confirmación las acciones que **envían** algo a otras personas (mandar, responder o reenviar un mail, compartir, invitar, publicar, push o merge, comentar, y crear o mover eventos con invitados) o que **borran** algo (borrar, mandar a la papelera, quitar, revocar). La regla está en `needsConfirm`, en `src/permissions.js`.

Cuando hace falta confirmar:
1. Te dice en una oración qué va a enviar o borrar.
2. Aparece el panel **AUTORIZACIÓN REQUERIDA** con el detalle exacto de la acción.
3. Te pregunta «¿Me autorizás a usar …?» y escucha tu respuesta: «sí», «dale», «confirmo» / «no», «cancelá». Si la frase trae un sí y un no a la vez, vuelve a preguntar. En el registro queda qué entendió («Escuché: …»).
4. Si no respondés en 2 minutos, o interrumpís, la acción se rechaza.

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
| `JARVIS_TIMEZONE` | zona del sistema | Zona horaria IANA (p. ej. `America/Argentina/Buenos_Aires`) para la fecha y hora que ve JARVIS |
| `JARVIS_GOOGLE_ACCOUNT` | vacío | Mail de la cuenta de Google con la que abrir Calendar, Gmail o Drive si tenés varias en el navegador (agrega `authuser=`) |
| `CLAUDE_BIN` | autodetectado | Ruta al ejecutable de Claude Code (si no, usa el que trae el SDK) |

## Seguridad y privacidad
- El servidor solo escucha en `127.0.0.1` y exige un token que se genera en cada arranque y solo conoce la página de JARVIS: otra web abierta en tu navegador no puede mandarle órdenes ni confirmar acciones. Si reiniciás el servidor, recargá la página (F5).
- Cada mensaje consume de tu cupo de Claude.
- El reconocimiento de voz del navegador procesa el audio en servidores de Google (Chrome) o Microsoft (Edge).
- La personalidad se define en `src/prompt.js`.

## Estructura del código
```
server.js            punto de entrada (reexporta src/server.js; lo usa bin/jarvis.js)
src/
  server.js          servidor HTTP: interfaz, /api/chat (SSE) y /api/confirm
  config.js          configuración leída del entorno (.env)
  prompt.js          prompt de sistema y línea de fecha
  permissions.js     qué pide confirmación y la puerta de confirmaciones
  agent-options.js   opciones del Agent SDK compartidas
  tools/             herramientas propias (navegador, YouTube)
test/                pruebas (npm test)
public/              interfaz web
```
