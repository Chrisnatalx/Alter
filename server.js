// JARVIS — servidor local.
// Sirve la interfaz (public/) y hace de puente entre el navegador y Claude a través del
// Claude Agent SDK, que usa el login de Claude Code (tu suscripción). JARVIS tiene acceso
// a tus conectores y plugins. Las acciones que envían o borran algo se frenan en `canUseTool`
// hasta que la persona lo confirma desde la interfaz (por voz o con un botón); el resto corre solo.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { z } = require('zod');
require('./env');

const PORT = Number(process.env.JARVIS_PORT || 7777);
const MODEL = process.env.JARVIS_MODEL || ''; // vacío = modelo por defecto de tu cuenta
const CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;     // sin respuesta en 2 minutos → se deniega
// Cuenta de Google con la que abrir Calendar, Gmail, Drive… si hay varias en el navegador.
const GOOGLE_ACCOUNT = process.env.JARVIS_GOOGLE_ACCOUNT || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
// Directorio vacío donde corre Claude: así no hereda CLAUDE.md ni archivos de otro proyecto.
const CORE_DIR = path.join(__dirname, '.core');
fs.mkdirSync(CORE_DIR, { recursive: true });

// Token por arranque: solo la página servida por este proceso lo conoce. Evita que otra
// web abierta en el navegador le hable a localhost y confirme acciones en tu nombre.
const TOKEN = crypto.randomBytes(24).toString('hex');
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

const SYSTEM_PROMPT = [
  'Sos JARVIS, un asistente de voz futurista que conversa con la persona usuaria en tiempo real. Se llama Nata.',
  'Todo lo que escribas se va a leer en voz alta con síntesis de voz.',
  'Respondé en español rioplatense, con calidez y un toque de ingenio elegante.',
  'Sé conciso: por defecto entre una y cuatro oraciones cortas, salvo que te pidan detalle.',
  'Nunca uses markdown, listas, viñetas, tablas, emojis, código ni URLs largas.',
  'Escribí los números y símbolos como se pronuncian cuando ayude a la lectura.',
  'Si algo no lo sabés con certeza, decilo y distinguí hechos de suposiciones.',
  'Tenés herramientas: los conectores y plugins de la persona (por ejemplo Gmail, Google Calendar, Google Drive, GitHub) y búsqueda web.',
  'Para leer, buscar o consultar no hace falta permiso: hacelo directamente.',
  'Enviar algo (mails, respuestas, invitaciones, mensajes, compartir) o borrar algo requiere que la persona lo confirme; la interfaz se lo pregunta sola, así que no pidas confirmación con texto. Antes de hacerlo, decí en una oración corta qué vas a enviar o borrar.',
  'Si la persona rechaza una acción, no la reintentes: preguntale qué prefiere.',
  'Podés abrir páginas en el navegador de la persona con la herramienta abrir_en_navegador, sin pedir permiso.',
  'Usala cuando ver algo ayude más que escucharlo, o cuando te pidan mostrar o abrir algo.',
  'Si te preguntan por sus reuniones o su agenda de una semana, además de resumirlas en voz abrí Google Calendar en la vista semanal de esa semana: https://calendar.google.com/calendar/r/week/AAAA/M/D con cualquier día de esa semana. Para un solo día usá /r/day/AAAA/M/D.',
  'Cuando abras algo, decilo en pocas palabras, sin leer la dirección.',
  'Si te piden poner música o un video de YouTube, usá poner_en_youtube y respondé muy corto.',
  'Al resumir resultados, contá solo lo importante, como lo diría una persona en voz alta.',
].join(' ');

// Ubica el ejecutable de Claude Code instalado (el mismo que usás en la terminal).
// Si no se encuentra, el SDK usa el que trae incluido.
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  if (process.platform === 'win32' && process.env.APPDATA) {
    const exe = path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}
const CLAUDE_BIN = resolveClaudeBin();

let sdkPromise = null;
const loadSdk = () => (sdkPromise ||= import('@anthropic-ai/claude-agent-sdk'));

// ------------------------------------------------------------------
//  Confirmaciones pendientes: id → { resolve, timer }
// ------------------------------------------------------------------
const pending = new Map();

// "mcp__claude_ai_Google_Calendar__create_event" → { app: "Google Calendar", action: "create event" }
function describeTool(toolName, mcpServer) {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (m) {
    const app = (mcpServer?.name || m[1])
      .replace(/^claude\.ai\s+/i, '').replace(/^claude_ai_/i, '').replace(/^plugin:[^:]+:/, '')
      .replace(/_/g, ' ').trim();
    return { app, action: m[2].replace(/_/g, ' ') };
  }
  const builtin = { WebSearch: 'búsqueda web', WebFetch: 'lectura de una página web' };
  return { app: builtin[toolName] || toolName, action: '' };
}

// Solo piden confirmación las acciones que envían algo a otras personas o borran algo.
// Todo lo demás (leer, buscar, consultar, crear borradores) se autoriza solo.
const SENDS = /(^|_)(send|reply|forward|share|invite|publish|push|merge)(_|$)|^(add|create)_.*comment/i;
const DELETES = /(^|_)(delete|trash|remove|revoke|destroy)(_|$)/i;
function needsConfirm(toolName, input) {
  const action = /^mcp__.+?__(.+)$/.exec(toolName)?.[1];
  if (!action) return false; // herramientas internas: solo web (búsqueda y lectura)
  if (SENDS.test(action) || DELETES.test(action)) return true;
  // Crear o mover un evento con invitados les manda la invitación por mail
  if (/event/i.test(action) && Array.isArray(input?.attendees) && input.attendees.length) return true;
  return false;
}

// Resume el input de la herramienta para mostrarlo en pantalla (no se lee en voz alta).
function summarizeInput(input) {
  try {
    return Object.entries(input || {}).slice(0, 8).map(([k, v]) => {
      let s = typeof v === 'string' ? v : JSON.stringify(v);
      if (s.length > 160) s = s.slice(0, 157) + '…';
      return `${k}: ${s}`;
    }).join('\n');
  } catch { return ''; }
}

// ------------------------------------------------------------------
//  Herramientas propias de JARVIS
// ------------------------------------------------------------------

// Abre una URL en el navegador por defecto. Lo hace el servidor y no la página porque el
// navegador bloquea las ventanas que no salen de un clic (acá la orden llega por voz).
// Solo http/https: nada de file:, programas ni protocolos raros.
function openInBrowser(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Solo se pueden abrir direcciones http o https.');
  if (GOOGLE_ACCOUNT && /(^|\.)google\.com$/i.test(url.hostname) && !url.searchParams.has('authuser')) {
    url.searchParams.set('authuser', GOOGLE_ACCOUNT);
  }
  const href = url.toString();
  // rundll32 no pasa por cmd, así que los & de la URL no se interpretan como comandos
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', href]]
    : process.platform === 'darwin' ? ['open', [href]] : ['xdg-open', [href]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  return href;
}

// Busca en YouTube y devuelve el primer video (sin publicidades ni shorts, que usan otro formato).
// Lee la página de resultados porque no requiere API key; si YouTube la cambia, devuelve null.
async function findYoutubeVideo(search) {
  const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(search)}`, {
    headers: { 'Accept-Language': 'es-AR,es;q=0.9', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const html = await res.text();
  const m = /"videoRenderer":\{"videoId":"([\w-]{11})".*?"title":\{"runs":\[\{"text":"(.*?)"\}/.exec(html);
  if (!m) return null;
  let title = m[2];
  try { title = JSON.parse(`"${title}"`); } catch {} // decodifica escapes como &
  return { id: m[1], title };
}

// Servidor MCP en proceso; se arma por pedido para poder avisarle a la interfaz qué se abrió.
function jarvisTools(sdk, send) {
  return sdk.createSdkMcpServer({
    name: 'jarvis',
    version: '1.0.0',
    tools: [
      sdk.tool(
        'abrir_en_navegador',
        'Abre una página web en una pestaña nueva del navegador de la persona, para mostrarle algo visualmente (su calendario, un mail, un documento, un repo, una búsqueda).',
        { url: z.string().describe('Dirección completa, con https://') },
        async ({ url }) => {
          try {
            const href = openInBrowser(url);
            console.log(`  [ABIERTO] ${href}`);
            send('open', { url: href });
            return { content: [{ type: 'text', text: `Abierto en el navegador: ${href}` }] };
          } catch (err) {
            return { content: [{ type: 'text', text: `No pude abrirlo: ${err.message}` }], isError: true };
          }
        },
      ),
      sdk.tool(
        'poner_en_youtube',
        'Reproduce música o un video de YouTube: busca y abre el primer resultado en el navegador. Al usarla, la interfaz apaga el micrófono para que la música no se tome como voz.',
        { busqueda: z.string().describe('Qué buscar, por ejemplo "Queen Bohemian Rhapsody" o "lofi para concentrarse"') },
        async ({ busqueda }) => {
          try {
            const video = await findYoutubeVideo(busqueda);
            // Si no se pudo leer el resultado, al menos abrir la búsqueda para elegir a mano
            const href = openInBrowser(video
              ? `https://www.youtube.com/watch?v=${video.id}`
              : `https://www.youtube.com/results?search_query=${encodeURIComponent(busqueda)}`);
            console.log(`  [YOUTUBE] ${href}`);
            send('open', { url: href });
            send('music', { title: video?.title || '' });
            return { content: [{ type: 'text', text: video
              ? `Reproduciendo «${video.title}» en el navegador. El micrófono quedó apagado: avisale que toque ESPACIO para volver a hablarte.`
              : 'No pude identificar el video; abrí la búsqueda de YouTube para que elija. El micrófono quedó apagado: avisale que toque ESPACIO para volver a hablarte.' }] };
          } catch (err) {
            return { content: [{ type: 'text', text: `No pude abrir YouTube: ${err.message}` }], isError: true };
          }
        },
      ),
    ],
  });
}

// ------------------------------------------------------------------
//  HTTP
// ------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    if (file.endsWith('index.html')) data = Buffer.from(data.toString('utf8').replace('__JARVIS_TOKEN__', TOKEN));
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Solo aceptamos llamadas a la API desde la propia página de JARVIS.
function isTrusted(req) {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return false; // bloquea DNS rebinding
  const origin = req.headers.origin;
  if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return false;
  const given = String(req.headers['x-jarvis-token'] || '');
  return given.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN));
}

function nowLine() {
  return new Date().toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// POST /api/chat  { text, sessionId? }  →  Server-Sent Events:
//   init {sessionId, model} · delta {text} · tool {app, action}
//   confirm {id, app, action, detail} · open {url} · music {title} · done {sessionId, ms} · error {message}
async function handleChat(req, res) {
  let payload;
  try { payload = await readJson(req); } catch { res.writeHead(400).end(); return; }
  const text = String(payload.text || '').trim();
  if (!text) { res.writeHead(400).end(); return; }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  let closed = false;
  const send = (event, data) => { if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

  const abort = new AbortController();
  const myConfirms = new Set();
  res.on('close', () => {
    closed = true;
    abort.abort(); // si el navegador corta (la persona interrumpe), cortamos a Claude
    for (const id of myConfirms) pending.get(id)?.resolve(false);
  });

  // Toda herramienta pasa por acá: si envía o borra algo, preguntamos en la interfaz y esperamos.
  const canUseTool = (toolName, input, opts) => new Promise((resolve) => {
    if (!needsConfirm(toolName, input)) {
      console.log(`  [AUTOMÁTICO] ${toolName}`);
      resolve({ behavior: 'allow', updatedInput: input });
      return;
    }
    const id = crypto.randomUUID();
    const { app, action } = describeTool(toolName, opts.mcpServer);
    const finish = (allowed) => {
      if (!pending.has(id)) return;
      clearTimeout(pending.get(id).timer);
      pending.delete(id); myConfirms.delete(id);
      console.log(`  [${allowed ? 'CONFIRMADO' : 'RECHAZADO'}] ${toolName}`);
      resolve(allowed
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'La persona no autorizó esta acción.' });
    };
    const timer = setTimeout(() => finish(false), CONFIRM_TIMEOUT_MS);
    pending.set(id, { resolve: finish, timer });
    myConfirms.add(id);
    opts.signal?.addEventListener('abort', () => finish(false));
    send('confirm', { id, app, action, title: opts.title || '', detail: summarizeInput(input) });
  });

  const started = Date.now();
  let sessionId = payload.sessionId || null;
  let finished = false;
  try {
    const sdk = await loadSdk();
    const { query } = sdk;
    const options = {
      mcpServers: { jarvis: jarvisTools(sdk, send) },
      cwd: CORE_DIR,
      abortController: abort,
      includePartialMessages: true,
      systemPrompt: SYSTEM_PROMPT,
      settingSources: ['user'],            // tus plugins y conectores…
      settings: { disableAllHooks: true, autoMemoryEnabled: false }, // …sin hooks ni memoria de archivos
      tools: ['WebSearch', 'WebFetch'],    // de las herramientas internas, solo web: nada de terminal ni archivos
      permissionMode: 'default',           // todo lo que no esté preaprobado pasa por canUseTool
      canUseTool,
    };
    if (CLAUDE_BIN) options.pathToClaudeCodeExecutable = CLAUDE_BIN;
    if (MODEL) options.model = MODEL;
    if (sessionId && /^[0-9a-f-]{36}$/i.test(sessionId)) options.resume = sessionId;

    // La fecha va en el mensaje (no en el system prompt) para que esté al día en cada turno.
    const prompt = `[Fecha y hora actual: ${nowLine()}, Buenos Aires]\n${text}`;

    for await (const msg of query({ prompt, options })) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        sessionId = msg.session_id;
        send('init', { sessionId, model: msg.model });
      } else if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
        send('delta', { text: msg.event.delta.text });
      } else if (msg.type === 'stream_event' && msg.event?.type === 'content_block_start' && msg.event.content_block?.type === 'tool_use') {
        send('tool', describeTool(msg.event.content_block.name));
      } else if (msg.type === 'result') {
        finished = true;
        if (msg.is_error || msg.subtype !== 'success') send('error', { message: msg.result || msg.errors?.join(' ') || 'Error de Claude' });
        else send('done', { sessionId: msg.session_id || sessionId, ms: Date.now() - started });
      }
    }
  } catch (err) {
    if (!closed) send('error', { message: err.message || String(err) });
    finished = true;
  }
  if (!finished) send('error', { message: 'La sesión terminó sin respuesta.' });
  res.end();
}

// POST /api/confirm  { id, allow }
async function handleConfirm(req, res) {
  let payload;
  try { payload = await readJson(req); } catch { res.writeHead(400).end(); return; }
  const p = pending.get(String(payload.id || ''));
  if (!p) { res.writeHead(404).end(); return; }
  p.resolve(payload.allow === true);
  res.writeHead(204).end();
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && (req.url === '/api/chat' || req.url === '/api/confirm')) {
    if (!isTrusted(req)) { res.writeHead(403).end(); return; }
    return req.url === '/api/chat' ? handleChat(req, res) : handleConfirm(req, res);
  }
  if (req.method === 'GET') {
    if (!ALLOWED_HOSTS.has(req.headers.host)) { res.writeHead(403).end(); return; }
    return serveStatic(req, res);
  }
  res.writeHead(405).end();
});

// Solo escucha en localhost: la interfaz usa tu cuenta, no la expongas a la red.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  J.A.R.V.I.S. en línea → http://localhost:${PORT}\n  Claude: ${CLAUDE_BIN || 'incluido en el SDK'}\n`);
});

module.exports = { server, PORT };
