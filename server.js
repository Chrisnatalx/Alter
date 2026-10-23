// JARVIS — servidor local.
// Sirve la interfaz (public/) y hace de puente entre el navegador y Claude a través del
// Claude Agent SDK, que usa el login de Claude Code (tu suscripción). JARVIS tiene acceso
// a tus conectores y plugins, pero CADA uso de una herramienta se frena en `canUseTool`
// hasta que la persona lo confirma desde la interfaz (por voz o con un botón).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.JARVIS_PORT || 7777);
const MODEL = process.env.JARVIS_MODEL || ''; // vacío = modelo por defecto de tu cuenta
const CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;     // sin respuesta en 2 minutos → se deniega
const PUBLIC_DIR = path.join(__dirname, 'public');
// Directorio vacío donde corre Claude: así no hereda CLAUDE.md ni archivos de otro proyecto.
const CORE_DIR = path.join(__dirname, '.core');
fs.mkdirSync(CORE_DIR, { recursive: true });

// Token por arranque: solo la página servida por este proceso lo conoce. Evita que otra
// web abierta en el navegador le hable a localhost y confirme acciones en tu nombre.
const TOKEN = crypto.randomBytes(24).toString('hex');
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

const SYSTEM_PROMPT = [
  'Sos JARVIS, un asistente de voz futurista que conversa con la persona usuaria en tiempo real.',
  'Todo lo que escribas se va a leer en voz alta con síntesis de voz.',
  'Respondé en español rioplatense, con calidez y un toque de ingenio elegante.',
  'Sé conciso: por defecto entre una y cuatro oraciones cortas, salvo que te pidan detalle.',
  'Nunca uses markdown, listas, viñetas, tablas, emojis, código ni URLs largas.',
  'Escribí los números y símbolos como se pronuncian cuando ayude a la lectura.',
  'Si algo no lo sabés con certeza, decilo y distinguí hechos de suposiciones.',
  'Tenés herramientas: los conectores y plugins de la persona (por ejemplo Gmail, Google Calendar, Google Drive, GitHub) y búsqueda web.',
  'Antes de usar una herramienta, decí en una sola oración corta qué vas a hacer y con qué datos.',
  'Cada uso de herramienta requiere que la persona lo confirme; la interfaz se lo pregunta sola, así que no pidas confirmación con texto.',
  'Si la persona rechaza una acción, no la reintentes: preguntale qué prefiere.',
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
//   confirm {id, app, action, detail} · done {sessionId, ms} · error {message}
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

  // Toda herramienta pasa por acá: preguntamos en la interfaz y esperamos la respuesta.
  const canUseTool = (toolName, input, opts) => new Promise((resolve) => {
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
    const { query } = await loadSdk();
    const options = {
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
