// JARVIS — servidor local.
// Sirve la interfaz (public/) y hace de puente entre el navegador y Claude a través del
// Claude Agent SDK, que usa el login de Claude Code (tu suscripción). JARVIS tiene acceso
// a tus conectores y plugins. Las acciones que envían o borran algo se frenan en `canUseTool`
// hasta que la persona lo confirma desde la interfaz (por voz o con un botón); el resto corre solo.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { nowLine } = require('./prompt');
const { describeTool, createPermissionGate } = require('./permissions');
const { createJarvisTools } = require('./tools');
const { buildAgentOptions } = require('./agent-options');

const PORT = config.port;

// Token por arranque: solo la página servida por este proceso lo conoce. Evita que otra
// web abierta en el navegador le hable a localhost y confirme acciones en tu nombre.
const TOKEN = crypto.randomBytes(24).toString('hex');
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

let sdkPromise = null;
const loadSdk = () => (sdkPromise ||= import('@anthropic-ai/claude-agent-sdk'));

// Puertas de permisos de los pedidos en curso: /api/confirm busca la confirmación en todas.
const liveGates = new Set();

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

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(config.publicDir, rel));
  if (!file.startsWith(config.publicDir)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    if (file.endsWith('index.html')) {
      data = Buffer.from(data.toString('utf8')
        .replace('__JARVIS_TOKEN__', TOKEN)
        .replace('__JARVIS_USER__', escapeHtml(config.userName)));
    }
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
function isTrusted(req, { token, allowedHosts }) {
  if (!allowedHosts.has(req.headers.host)) return false; // bloquea DNS rebinding
  const origin = req.headers.origin;
  if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return false;
  const given = String(req.headers['x-jarvis-token'] || '');
  return given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
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

  const gate = createPermissionGate({ emit: send, timeoutMs: config.confirmTimeoutMs });
  liveGates.add(gate);
  const abort = new AbortController();
  res.on('close', () => {
    closed = true;
    abort.abort(); // si el navegador corta (la persona interrumpe), cortamos a Claude
    gate.denyAll();
    liveGates.delete(gate);
  });

  const started = Date.now();
  let sessionId = payload.sessionId || null;
  let finished = false;
  try {
    const sdk = await loadSdk();
    const { query } = sdk;
    const options = buildAgentOptions({
      config,
      canUseTool: gate.canUseTool,
      mcpServers: { jarvis: createJarvisTools(sdk, { emit: send, googleAccount: config.googleAccount }) },
      abortController: abort,
    });
    if (sessionId && /^[0-9a-f-]{36}$/i.test(sessionId)) options.resume = sessionId;

    // La fecha va en el mensaje (no en el system prompt) para que esté al día en cada turno.
    const prompt = `[Fecha y hora actual: ${nowLine(config.timezone)}]\n${text}`;

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
  for (const gate of liveGates) {
    if (gate.confirm(payload.id, payload.allow === true)) { res.writeHead(204).end(); return; }
  }
  res.writeHead(404).end();
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && (req.url === '/api/chat' || req.url === '/api/confirm')) {
    if (!isTrusted(req, { token: TOKEN, allowedHosts: ALLOWED_HOSTS })) { res.writeHead(403).end(); return; }
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
  console.log(`\n  J.A.R.V.I.S. en línea → http://localhost:${PORT}\n  Claude: ${config.claudeBin || 'incluido en el SDK'}\n`);
});

module.exports = { server, PORT, isTrusted };
