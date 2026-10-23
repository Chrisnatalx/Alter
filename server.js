// JARVIS — servidor local.
// Sirve la interfaz (public/) y hace de puente entre el navegador y Claude Code
// en modo headless (`claude -p`), que autentica con la suscripción del usuario.
// No usa dependencias externas: solo módulos nativos de Node.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.JARVIS_PORT || 7777);
const MODEL = process.env.JARVIS_MODEL || ''; // vacío = modelo por defecto de tu cuenta
const PUBLIC_DIR = path.join(__dirname, 'public');
// Directorio vacío donde corre Claude: así no hereda CLAUDE.md ni settings de otro proyecto.
const CORE_DIR = path.join(__dirname, '.core');
fs.mkdirSync(CORE_DIR, { recursive: true });

const SYSTEM_PROMPT = [
  'Sos JARVIS, un asistente de voz futurista que conversa con la persona usuaria en tiempo real.',
  'Todo lo que escribas se va a leer en voz alta con síntesis de voz.',
  'Respondé en español rioplatense, con calidez y un toque de ingenio elegante.',
  'Sé conciso: por defecto entre una y cuatro oraciones cortas, salvo que te pidan detalle.',
  'Nunca uses markdown, listas, viñetas, tablas, emojis, código ni URLs largas.',
  'Escribí los números y símbolos como se pronuncian cuando ayude a la lectura.',
  'Si algo no lo sabés con certeza, decilo y distinguí hechos de suposiciones.',
  'No tenés herramientas ni acceso a internet en esta interfaz.',
].join(' ');

// Ubica el ejecutable real de Claude Code. En Windows evitamos claude.cmd
// (Node no permite lanzar .cmd sin shell) y vamos directo al .exe.
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  if (process.platform === 'win32' && process.env.APPDATA) {
    const exe = path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return 'claude';
}
const CLAUDE_BIN = resolveClaudeBin();

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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
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

// POST /api/chat  { text, sessionId? }  →  Server-Sent Events:
//   init {sessionId, model} · delta {text} · done {sessionId, ms} · error {message}
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
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--setting-sources', 'project', // ignora settings/plugins/hooks de usuario → más rápido y aislado
    '--strict-mcp-config',          // sin servidores MCP
    '--tools', '',                  // sin herramientas: solo conversación
    '--system-prompt', SYSTEM_PROMPT, // reemplaza el prompt de Claude Code: acá no hay herramientas ni memoria de archivos
  ];
  if (MODEL) args.push('--model', MODEL);
  if (payload.sessionId && /^[0-9a-f-]{36}$/i.test(payload.sessionId)) args.push('--resume', payload.sessionId);

  const started = Date.now();
  const child = spawn(CLAUDE_BIN, args, { cwd: CORE_DIR, windowsHide: true });
  child.stdin.end(text); // el prompt va por stdin para evitar problemas de escape

  let sessionId = payload.sessionId || null;
  let buffer = '';
  let stderr = '';
  let finished = false;

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }

      if (msg.type === 'system' && msg.subtype === 'init') {
        sessionId = msg.session_id;
        send('init', { sessionId, model: msg.model });
      } else if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
        send('delta', { text: msg.event.delta.text });
      } else if (msg.type === 'result') {
        finished = true;
        if (msg.is_error) send('error', { message: msg.result || 'Error de Claude' });
        else send('done', { sessionId: msg.session_id || sessionId, ms: Date.now() - started });
      }
    }
  });
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  child.on('error', (err) => {
    send('error', { message: `No pude iniciar Claude Code (${CLAUDE_BIN}): ${err.message}` });
    res.end();
  });
  child.on('close', (code) => {
    if (!finished) send('error', { message: stderr.trim() || `Claude terminó con código ${code}` });
    res.end();
  });
  // Si el navegador corta (p. ej. la persona interrumpe), matamos el proceso.
  res.on('close', () => { if (child.exitCode === null) child.kill(); });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/chat') return handleChat(req, res);
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405).end();
});

// Solo escucha en localhost: la interfaz usa tu cuenta, no la expongas a la red.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  J.A.R.V.I.S. en línea → http://localhost:${PORT}\n  Claude: ${CLAUDE_BIN}\n`);
});

module.exports = { server, PORT };
