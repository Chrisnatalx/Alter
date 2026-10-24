// JARVIS — servidor local.
// Sirve la interfaz (public/) y hace de puente entre el navegador y Claude a través del
// Claude Agent SDK, que usa el login de Claude Code (tu suscripción). Hay una sola sesión viva
// (src/session.js) y un canal de eventos permanente hacia la interfaz (src/events.js): la página
// escucha en GET /api/events y manda mensajes y confirmaciones por POST. Las acciones que envían
// o borran algo esperan a que la persona confirme (por voz o con un botón); el resto corre solo.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { createEventHub } = require('./events');
const { Session } = require('./session');

const PORT = config.port;

// Token por arranque: solo la página servida por este proceso lo conoce. Evita que otra
// web abierta en el navegador le hable a localhost y confirme acciones en tu nombre.
const TOKEN = crypto.randomBytes(24).toString('hex');
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

let sdkPromise = null;
const loadSdk = () => (sdkPromise ||= import('@anthropic-ai/claude-agent-sdk'));

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

function serveStatic(req, res, token = TOKEN) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(config.publicDir, rel));
  if (!file.startsWith(config.publicDir)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    if (file.endsWith('index.html')) {
      data = Buffer.from(data.toString('utf8')
        .replace('__JARVIS_TOKEN__', () => token) // con función: `$&` y similares no se interpretan
        .replace('__JARVIS_USER__', () => escapeHtml(config.userName)));
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

// Estado de la sesión por `deps` (en producción hay un solo deps, o sea una sola sesión viva).
const states = new WeakMap();
const stateOf = (deps) => { if (!states.has(deps)) states.set(deps, { session: null, creating: null }); return states.get(deps); };

// La sesión actual, o null si no hay o ya murió (el próximo mensaje crea una nueva).
const liveSession = (st) => (st.session && !st.session.closed ? st.session : null);

// Crea la sesión una sola vez aunque lleguen dos mensajes a la vez.
async function ensureSession(st, deps, resumeId) {
  const live = liveSession(st);
  if (live) return live;
  st.creating ||= deps.sessionFactory(resumeId).finally(() => { st.creating = null; });
  st.session = await st.creating;
  return st.session;
}

const noContent = (res) => res.writeHead(204).end();

// GET /api/events → canal SSE permanente. Al conectar se manda el estado actual para que
// recargar la página no pierda la sesión ni las tareas en curso.
function handleEvents(req, res, deps) {
  deps.hub.attach(res);
  const session = liveSession(stateOf(deps));
  if (session) {
    deps.hub.emit('init', { sessionId: session.sessionId, ...(session.model ? { model: session.model } : {}) });
    deps.hub.emit('tasks', { tasks: session.tasks });
  }
}

// POST /api/message { text, sessionId? } → 202. La respuesta llega por el canal de eventos.
async function handleMessage(req, res, deps) {
  const payload = await readJson(req);
  const text = String(payload.text || '').trim();
  if (!text) { res.writeHead(400).end(); return; }
  const session = await ensureSession(stateOf(deps), deps, payload.sessionId);
  session.send(text);
  res.writeHead(202).end();
}

// POST /api/new { force? } → cierra la sesión; con tareas en segundo plano pide confirmar con force.
async function handleNew(req, res, deps) {
  const payload = await readJson(req);
  const st = stateOf(deps);
  const session = liveSession(st);
  if (session) {
    const running = session.runningTasks();
    if (running > 0 && payload.force !== true) {
      res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ running }));
      return;
    }
    session.close();
  }
  st.session = null;
  deps.hub.emit('reset', {});
  noContent(res);
}

// Rutas POST de la API: (req, res, deps) → promesa. Todas exigen isTrusted antes de llegar acá.
const POST_ROUTES = {
  '/api/message': handleMessage,
  '/api/new': handleNew,
  '/api/interrupt': async (req, res, deps) => {
    await readJson(req);
    await liveSession(stateOf(deps))?.interrupt();
    noContent(res);
  },
  '/api/confirm': async (req, res, deps) => {
    const payload = await readJson(req);
    const ok = liveSession(stateOf(deps))?.confirm(payload.id, payload.allow === true);
    if (ok) noContent(res); else res.writeHead(404).end();
  },
  '/api/tasks/stop': async (req, res, deps) => {
    const payload = await readJson(req);
    if (!payload.taskId) { res.writeHead(400).end(); return; }
    await liveSession(stateOf(deps))?.stopTask(String(payload.taskId));
    noContent(res);
  },
};

function handleRequest(req, res, deps) {
  const { pathname } = new URL(req.url, 'http://x');
  const trust = { token: deps.token, allowedHosts: deps.allowedHosts };
  if (pathname.startsWith('/api/')) {
    if (!isTrusted(req, trust)) { res.writeHead(403).end(); return; }
    if (req.method === 'GET' && pathname === '/api/events') return handleEvents(req, res, deps);
    const route = req.method === 'POST' && POST_ROUTES[pathname];
    if (!route) { res.writeHead(404).end(); return; }
    route(req, res, deps).catch((err) => {
      // JSON roto → 400; cualquier otra falla (p. ej. no se pudo arrancar la sesión) → 500
      if (res.headersSent) { res.end(); return; }
      res.writeHead(err instanceof SyntaxError ? 400 : 500).end();
      if (!(err instanceof SyntaxError)) console.error('  [ERROR]', err.message || err);
    });
    return;
  }
  if (req.method === 'GET') {
    if (!deps.allowedHosts.has(req.headers.host)) { res.writeHead(403).end(); return; }
    return serveStatic(req, res, deps.token);
  }
  res.writeHead(405).end();
}

const hub = createEventHub();
const deps = {
  hub,
  token: TOKEN,
  allowedHosts: ALLOWED_HOSTS,
  // Carga el SDK (ESM) una vez, crea la sesión con sus herramientas y la arranca.
  async sessionFactory(resumeId) {
    const sdk = await loadSdk();
    const session = new Session({ config, emit: hub.emit, sdk });
    session.start({ resumeId });
    return session;
  },
};

const server = http.createServer((req, res) => handleRequest(req, res, deps));

// Solo escucha en localhost: la interfaz usa tu cuenta, no la expongas a la red.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`
  J.A.R.V.I.S. en línea → http://localhost:${PORT}
  Claude: ${config.claudeBin || 'incluido en el SDK'}
`);
});

module.exports = { server, PORT, isTrusted, handleRequest, serveStatic };
