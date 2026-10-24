# J.A.R.V.I.S.

Interfaz de voz futurista para conversar con Claude usando **tu suscripción**. No usa API key: el servidor local usa el [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk), que autentica con tu login de Claude Code.

JARVIS tiene acceso a tus **conectores y plugins** (Gmail, Google Calendar, Drive, GitHub, etc.) y a búsqueda web. Lee y busca sin preguntar; **solo te pide confirmación antes de enviar o borrar algo**, por voz («sí» / «no») o con un botón.

## Requisitos
- Node 18 o superior
- Claude Code instalado y con sesión iniciada (corré `claude` una vez y hacé login)
- Chrome o Edge (el reconocimiento de voz no funciona en Firefox)

## Instalación (en cualquier PC)
```
git clone https://github.com/Chrisnatalx/JARVIS.git
cd JARVIS
npm install
npm link
```

`npm link` registra el comando global `jarvis`. Si después movés la carpeta, volvé a correr `npm link` adentro.

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
Leer, buscar y consultar (tu calendario, tus mails, la web…) corre solo. Piden confirmación las acciones que **envían** algo a otras personas (mandar, responder o reenviar un mail, compartir, invitar, publicar, push o merge, comentar, y crear o mover eventos con invitados) o que **borran** algo (borrar, mandar a la papelera, quitar, revocar). La regla está en `needsConfirm` dentro de `server.js`.

Cuando hace falta confirmar:
1. Te dice en una oración qué va a enviar o borrar.
2. Aparece el panel **AUTORIZACIÓN REQUERIDA** con el detalle exacto de la acción.
3. Te pregunta «¿Me autorizás a usar …?» y escucha tu respuesta: «sí», «dale», «confirmo» / «no», «cancelá». Si la frase trae un sí y un no a la vez, vuelve a preguntar. En el registro queda qué entendió («Escuché: …»).
4. Si no respondés en 2 minutos, o interrumpís, la acción se rechaza.

## Abrir cosas en el navegador
JARVIS puede abrir páginas en una pestaña nueva de tu navegador por defecto (herramienta propia `abrir_en_navegador`, en `server.js`), sin pedir confirmación porque no envía ni borra nada. Por ejemplo, si le preguntás por tus reuniones de la semana, te las resume y abre Google Calendar en la vista semanal. También sirve para «mostrame el repo», «abrime ese mail», etc. Solo abre direcciones `http`/`https`, y cada una queda anotada en el registro («Abrí: …»).

**Música**: «poné X en YouTube» busca y abre el primer video (herramienta `poner_en_youtube`; lee la página de resultados, sin API key; si no logra identificar el video, abre la búsqueda). Al hacerlo **se apaga el micrófono**, para que la música no se tome como si le hablaras: tocá **ESPACIO** para volver a hablarle. JARVIS no controla la pestaña después de abrirla (pausar o cambiar de tema se hace a mano).

De las herramientas internas de Claude Code solo están habilitadas las de web (sin terminal ni archivos). Los hooks y la memoria de archivos de Claude Code están desactivados en JARVIS.

## Configuración
Copiá `.env.example` como `.env` en la carpeta de JARVIS y completá lo que necesites (también las API keys que se sumen). `.env` no se sube al repo. Una variable definida en la terminal tiene prioridad sobre el archivo.

| Variable | Default | Para qué |
|---|---|---|
| `JARVIS_PORT` | `7777` | Puerto local |
| `JARVIS_MODEL` | modelo por defecto de tu cuenta | p. ej. `sonnet` o `haiku` para respuestas más rápidas |
| `JARVIS_GOOGLE_ACCOUNT` | vacío | Mail de la cuenta de Google con la que abrir Calendar, Gmail o Drive si tenés varias en el navegador (agrega `authuser=`) |
| `CLAUDE_BIN` | autodetectado | Ruta al ejecutable de Claude Code (si no, usa el que trae el SDK) |

## Seguridad y privacidad
- El servidor solo escucha en `127.0.0.1` y exige un token que se genera en cada arranque y solo conoce la página de JARVIS: otra web abierta en tu navegador no puede mandarle órdenes ni confirmar acciones. Si reiniciás el servidor, recargá la página (F5).
- Cada mensaje consume de tu cupo de Claude.
- El reconocimiento de voz del navegador procesa el audio en servidores de Google (Chrome) o Microsoft (Edge).
- La personalidad se define en `SYSTEM_PROMPT` dentro de `server.js`.
