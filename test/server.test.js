const { test, after } = require('node:test');
const assert = require('node:assert');

// Puerto 0: al cargar el módulo el servidor escucha, y no queremos chocar con un ALTER real.
process.env.ALTER_PORT = '0';
process.env.ALTER_USER_NAME = 'A$&B$$<x>'; // la config es inmutable: se fija antes de cargarla
const { server, isTrusted } = require('../src/server');
after(() => server.close());

const token = 'a'.repeat(48);
const allowedHosts = new Set(['localhost:7777', '127.0.0.1:7777']);
const req = (headers) => ({ headers });

test('isTrusted acepta host local con token correcto', () => {
  assert.strictEqual(isTrusted(req({ host: 'localhost:7777', 'x-alter-token': token }), { token, allowedHosts }), true);
  assert.strictEqual(isTrusted(req({ host: '127.0.0.1:7777', origin: 'http://localhost:7777', 'x-alter-token': token }), { token, allowedHosts }), true);
});

test('isTrusted rechaza host ajeno, origen ajeno y token malo', () => {
  assert.strictEqual(isTrusted(req({ host: 'evil.com', 'x-alter-token': token }), { token, allowedHosts }), false);
  assert.strictEqual(isTrusted(req({ host: 'localhost:7777', origin: 'http://evil.com', 'x-alter-token': token }), { token, allowedHosts }), false);
  assert.strictEqual(isTrusted(req({ host: 'localhost:7777', 'x-alter-token': 'b'.repeat(48) }), { token, allowedHosts }), false);
  assert.strictEqual(isTrusted(req({ host: 'localhost:7777', 'x-alter-token': 'abc' }), { token, allowedHosts }), false);
  assert.strictEqual(isTrusted(req({ host: 'localhost:7777' }), { token, allowedHosts }), false);
});

// ---- Rutas de la sesión viva (handleRequest con req/res falsos) ----
const { EventEmitter } = require('node:events');
const { handleRequest, serveStatic } = require('../src/server');

function fakeReq(method, url, body, headers = {}) {
  const r = new EventEmitter();
  r.method = method; r.url = url;
  r.headers = { host: 'localhost:7777', 'x-alter-token': token, ...headers };
  r.destroy = () => {};
  process.nextTick(() => { if (body !== undefined) r.emit('data', JSON.stringify(body)); r.emit('end'); });
  return r;
}
function fakeRes() {
  const res = { status: null, body: '', done: null };
  res.finished = new Promise((r) => { res.done = r; });
  res.writeHead = (s, h) => { res.status = s; res.headers = h || {}; return res; };
  res.write = (c) => { res.body += c; return true; };
  res.end = (c) => { if (c) res.body += c; res.done(); return res; };
  res.on = () => res;
  return res;
}
function fakeSession(over = {}) {
  const calls = { send: [], close: 0, interrupt: 0, stop: [], confirm: [] };
  return {
    calls, closed: false, sessionId: 'sid-1', model: 'haiku', tasks: [{ id: 't1' }],
    send: (t, o) => calls.send.push([t, o?.view]), // send(text, { view, receivedAt })
    close() { calls.close++; },
    interrupt: async () => { calls.interrupt++; },
    stopTask: async (id) => { calls.stop.push(id); },
    runningTasks: () => 2,
    confirm: (id, allow) => { calls.confirm.push([id, allow]); return id === 'ok'; },
    ...over,
  };
}
function mkDeps(session) {
  const events = [];
  const created = [];
  const hub = {
    attach: (res) => { res.writeHead(200); res.done(); }, // el SSE real no termina: acá sí para poder esperar
    emit: (e, d) => events.push([e, d]),
    hasClient: () => true,
  };
  return { hub, token, allowedHosts, events, created, sessionFactory: async (resumeId) => { created.push(resumeId); return session; } };
}
async function call(deps, method, url, body, headers) {
  const res = fakeRes();
  handleRequest(fakeReq(method, url, body, headers), res, deps);
  await res.finished;
  return res;
}

test('POST sin token da 403', async () => {
  const res = await call(mkDeps(fakeSession()), 'POST', '/api/new', {}, { 'x-alter-token': '' });
  assert.equal(res.status, 403);
});

test('GET /api/events sin token da 403', async () => {
  const res = await call(mkDeps(fakeSession()), 'GET', '/api/events', undefined, { 'x-alter-token': '' });
  assert.equal(res.status, 403);
});

test('POST /api/message con texto vacío da 400', async () => {
  const deps = mkDeps(fakeSession());
  const res = await call(deps, 'POST', '/api/message', { text: '  ' });
  assert.equal(res.status, 400);
  assert.equal(deps.created.length, 0);
});

test('POST /api/message crea la sesión una vez, la reutiliza y responde 202', async () => {
  const s = fakeSession();
  const deps = mkDeps(s);
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  const a = await call(deps, 'POST', '/api/message', { text: 'hola', sessionId: uuid });
  const b = await call(deps, 'POST', '/api/message', { text: 'otra' });
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  assert.deepEqual(s.calls.send, [['hola', undefined], ['otra', undefined]]);
  assert.deepEqual(deps.created, [uuid]);
});

test('una sesión cerrada se reemplaza en el siguiente mensaje', async () => {
  const dead = fakeSession({ closed: true });
  const fresh = fakeSession();
  const deps = mkDeps(dead);
  await call(deps, 'POST', '/api/message', { text: 'uno' });
  deps.sessionFactory = async () => fresh;
  await call(deps, 'POST', '/api/message', { text: 'dos' });
  assert.deepEqual(fresh.calls.send, [['dos', undefined]]);
});

test('POST /api/warm arranca la sesión que hay que retomar sin mandarle nada', async () => {
  const s = fakeSession();
  const deps = mkDeps(s);
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  const res = await call(deps, 'POST', '/api/warm', { sessionId: uuid });
  assert.equal(res.status, 202);
  assert.deepEqual(deps.created, [uuid]);
  assert.deepEqual(s.calls.send, []);
  // El mensaje que llega después usa esa misma sesión, y otro warm con la sesión viva no crea otra
  await call(deps, 'POST', '/api/warm', {});
  await call(deps, 'POST', '/api/message', { text: 'hola' });
  assert.deepEqual(deps.created, [uuid]);
  assert.deepEqual(s.calls.send, [['hola', undefined]]);
});

test('POST /api/warm responde aunque crear la sesión falle', async () => {
  const deps = mkDeps(fakeSession());
  deps.sessionFactory = async () => { throw new Error('sin claude'); };
  const res = await call(deps, 'POST', '/api/warm', {});
  assert.equal(res.status, 202);
});

test('POST /api/message pasa la vista que mira la persona', async () => {
  const s = fakeSession();
  const deps = mkDeps(s);
  await call(deps, 'POST', '/api/message', { text: 'hola', view: { face: 'weather' } });
  assert.deepEqual(s.calls.send, [['hola', { face: 'weather' }]]);
});

test('POST /api/new con tareas corriendo da 409 y {running}', async () => {
  const s = fakeSession();
  const deps = mkDeps(s);
  await call(deps, 'POST', '/api/message', { text: 'hola' });
  const res = await call(deps, 'POST', '/api/new', {});
  assert.equal(res.status, 409);
  assert.equal(res.body, '{"running":2}');
  assert.equal(s.calls.close, 0);
});

test('POST /api/new con force cierra, emite reset y da 204', async () => {
  const s = fakeSession();
  const deps = mkDeps(s);
  await call(deps, 'POST', '/api/message', { text: 'hola' });
  const res = await call(deps, 'POST', '/api/new', { force: true });
  assert.equal(res.status, 204);
  assert.equal(s.calls.close, 1);
  assert.deepEqual(deps.events.at(-1), ['reset', {}]);
  // sin sesión, /api/new también da 204
  assert.equal((await call(deps, 'POST', '/api/new', {})).status, 204);
});

test('POST /api/confirm: 204 si existe, 404 si no y 404 sin sesión', async () => {
  const s = fakeSession();
  const deps = mkDeps(s);
  assert.equal((await call(deps, 'POST', '/api/confirm', { id: 'ok', allow: true })).status, 404);
  await call(deps, 'POST', '/api/message', { text: 'hola' });
  assert.equal((await call(deps, 'POST', '/api/confirm', { id: 'ok', allow: true })).status, 204);
  assert.equal((await call(deps, 'POST', '/api/confirm', { id: 'nope', allow: true })).status, 404);
  assert.deepEqual(s.calls.confirm[0], ['ok', true]);
});

test('POST /api/interrupt y /api/tasks/stop dan 204', async () => {
  const s = fakeSession();
  const deps = mkDeps(s);
  await call(deps, 'POST', '/api/message', { text: 'hola' });
  assert.equal((await call(deps, 'POST', '/api/interrupt', {})).status, 204);
  assert.equal((await call(deps, 'POST', '/api/tasks/stop', { taskId: 't1' })).status, 204);
  assert.equal(s.calls.interrupt, 1);
  assert.deepEqual(s.calls.stop, ['t1']);
  assert.equal((await call(deps, 'POST', '/api/tasks/stop', {})).status, 400);
});

test('GET /api/events emite init y tasks si hay sesión', async () => {
  const s = fakeSession();
  const deps = mkDeps(s);
  await call(deps, 'POST', '/api/message', { text: 'hola' });
  deps.events.length = 0;
  await call(deps, 'GET', '/api/events');
  assert.deepEqual(deps.events, [['init', { sessionId: 'sid-1', model: 'haiku' }], ['tasks', { tasks: [{ id: 't1' }] }]]);
});

test('/api/chat ya no existe', async () => {
  const res = await call(mkDeps(fakeSession()), 'POST', '/api/chat', { text: 'hola' });
  assert.notEqual(res.status, 200);
  assert.notEqual(res.status, 202);
});

test('serveStatic: el nombre con $& queda literal (escapado) en la página', async () => {
  const res = fakeRes();
  serveStatic({ url: '/' }, res, token);
  await res.finished;
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('content="A$&amp;B$$&lt;x&gt;"'), res.body.slice(0, 400));
  assert.ok(res.body.includes(token));
});

test('un cuerpo JSON que no es objeto (null, número, lista) da 400, no 500', async () => {
  for (const body of [null, 5, [1]]) {
    const deps = mkDeps(fakeSession());
    const res = await call(deps, 'POST', '/api/message', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(deps.created.length, 0);
  }
  assert.equal((await call(mkDeps(fakeSession()), 'POST', '/api/confirm', null)).status, 400);
});

test('serveStatic: una ruta mal codificada (/%) da 400 y no tira el servidor', async () => {
  const res = fakeRes();
  serveStatic({ url: '/%' }, res, token);
  await res.finished;
  assert.equal(res.status, 400);
  const viaRoute = await call(mkDeps(fakeSession()), 'GET', '/%E0%A4%A');
  assert.equal(viaRoute.status, 400);
});

// ---- MediaPipe y el modelo, servidos desde el servidor local ----
const os = require('node:os');
const fsx = require('node:fs');
const pathx = require('node:path');
const { serveVendor } = require('../src/server');
async function vendor(url, roots) {
  const res = fakeRes();
  const handled = serveVendor({ url }, res, roots);
  if (handled) await res.finished;
  return { handled, res };
}

test('serveStatic index lleva CSP connect-src self', async () => {
  const res = fakeRes();
  serveStatic({ url: '/' }, res, token);
  await res.finished;
  assert.equal(res.headers['Content-Security-Policy'], "connect-src 'self'");
});

test('serveVendor sirve el bundle como JS y el wasm como application/wasm', async () => {
  const a = await vendor('/vendor/mediapipe/vision_bundle.mjs');
  assert.equal(a.handled, true);
  assert.equal(a.res.status, 200);
  assert.equal(a.res.headers['Content-Type'], 'text/javascript; charset=utf-8');
  assert.equal(a.res.headers['Cache-Control'], 'public, max-age=86400');
  const b = await vendor('/vendor/mediapipe/wasm/vision_wasm_internal.wasm');
  assert.equal(b.res.status, 200);
  assert.equal(b.res.headers['Content-Type'], 'application/wasm');
});

test('missing model gives 404', async () => {
  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'alter-vendor-'));
  const { res } = await vendor('/vendor/models/hand_landmarker.task', { '/vendor/models/': dir });
  assert.equal(res.status, 404);
});

test('serveVendor bloquea salir de la raíz', async () => {
  let checked = 0;
  for (const url of ['/vendor/mediapipe/../../package.json', '/vendor/mediapipe/%2e%2e/%2e%2e/package.json', '/vendor/mediapipe/..%5c..%5cpackage.json', '/vendor/models/..%2f..%2fpackage.json']) {
    const { handled, res } = await vendor(url);
    if (!handled) continue; // la URL normalizada ya no es de /vendor/: la atiende serveStatic, dentro de public/
    checked++;
    assert.ok(res.status === 403 || res.status === 404, `${url} → ${res.status}`);
  }
  assert.ok(checked >= 2); // las barras codificadas sí llegan a serveVendor
});

test('serveVendor ignora otras rutas', async () => {
  assert.equal((await vendor('/app.js')).handled, false);
});

test('GET /vendor con un host ajeno da 403', async () => {
  const res = await call(mkDeps(fakeSession()), 'GET', '/vendor/mediapipe/vision_bundle.mjs', undefined, { host: 'evil.com' });
  assert.equal(res.status, 403);
});

test('HEAD /vendor dice si está el modelo sin mandar el archivo', async () => {
  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'alter-vendor-'));
  const miss = fakeRes();
  serveVendor({ url: '/vendor/models/hand_landmarker.task', method: 'HEAD' }, miss, { '/vendor/models/': dir });
  await miss.finished;
  assert.equal(miss.status, 404);
  fsx.writeFileSync(pathx.join(dir, 'hand_landmarker.task'), 'x'.repeat(10));
  const hit = fakeRes();
  serveVendor({ url: '/vendor/models/hand_landmarker.task', method: 'HEAD' }, hit, { '/vendor/models/': dir });
  await hit.finished;
  assert.equal(hit.status, 200);
  assert.equal(hit.headers['Content-Length'], 10);
  assert.equal(hit.body, '');
  // Y por handleRequest: HEAD no da 405
  assert.equal((await call(mkDeps(fakeSession()), 'HEAD', '/vendor/mediapipe/vision_bundle.mjs')).status, 200);
});

test('GET /vendor por handleRequest sirve el bundle', async () => {
  const res = await call(mkDeps(fakeSession()), 'GET', '/vendor/mediapipe/vision_bundle.mjs');
  assert.equal(res.status, 200);
});

// ---- Feeds (Calendar, Mail y Clima de las vistas) ----
function fakeFeeds() {
  const calls = [];
  const snap = { google: { data: null, updatedAt: null, error: null, refreshing: false }, weather: { data: { current: { temp: 15 } }, updatedAt: 1, error: null, refreshing: false } };
  return {
    calls, snap,
    snapshot: () => snap,
    refresh: (kind, opts) => { calls.push(['refresh', kind, opts]); return Promise.resolve(); },
    refreshAll: (opts) => { calls.push(['refreshAll', opts]); return Promise.resolve(); },
  };
}
const withFeeds = (feeds) => ({ ...mkDeps(fakeSession()), feeds });

test('GET /api/feeds sin token da 403', async () => {
  const res = await call(withFeeds(fakeFeeds()), 'GET', '/api/feeds', undefined, { 'x-alter-token': '' });
  assert.equal(res.status, 403);
});

test('GET /api/feeds devuelve el snapshot', async () => {
  const feeds = fakeFeeds();
  const res = await call(withFeeds(feeds), 'GET', '/api/feeds');
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(res.body), feeds.snap);
});

test('GET /api/feeds sin feeds da 404', async () => {
  assert.equal((await call(mkDeps(fakeSession()), 'GET', '/api/feeds')).status, 404);
});

test('POST /api/feeds/refresh pide el refresco sin esperarlo', async () => {
  const feeds = fakeFeeds();
  const deps = withFeeds(feeds);
  assert.equal((await call(deps, 'POST', '/api/feeds/refresh', { kind: 'google' })).status, 202);
  assert.deepEqual(feeds.calls.at(-1), ['refresh', 'google', { ifOlderMs: undefined }]);
  assert.equal((await call(deps, 'POST', '/api/feeds/refresh', { ifOlderMs: 300000 })).status, 202);
  assert.deepEqual(feeds.calls.at(-1), ['refreshAll', { ifOlderMs: 300000 }]);
  assert.equal((await call(deps, 'POST', '/api/feeds/refresh', { kind: 'x' })).status, 400);
  assert.equal(feeds.calls.length, 2);
});

test('GET /api/events pide refresco si los datos tienen más de un minuto', async () => {
  const feeds = fakeFeeds();
  await call(withFeeds(feeds), 'GET', '/api/events');
  assert.deepEqual(feeds.calls, [['refreshAll', { ifOlderMs: 60000 }]]);
});

test('GET /api/events sin feeds sigue andando', async () => {
  assert.equal((await call(mkDeps(fakeSession()), 'GET', '/api/events')).status, 200);
});

test('GET /api/events reenvía las confirmaciones pendientes', async () => {
  const pending = { id: 'c1', app: 'Gmail', action: 'send message', title: '', detail: '' };
  const deps = mkDeps(fakeSession({ pendingConfirms: () => [pending] }));
  await call(deps, 'POST', '/api/message', { text: 'hola' });
  deps.events.length = 0;
  await call(deps, 'GET', '/api/events');
  assert.deepEqual(deps.events.at(-1), ['confirm', pending]);
});

test('POST /api/message pasa receivedAt a send', async () => {
  const opts = [];
  const s = fakeSession({ send: (t, o) => opts.push(o) });
  await call(mkDeps(s), 'POST', '/api/message', { text: 'hola' });
  assert.equal(typeof opts[0]?.receivedAt, 'number');
});

test('POST /api/timing guarda un registro saneado y da 204', async () => {
  const records = [];
  const deps = mkDeps(fakeSession());
  deps.timingLog = { write: (r) => records.push(r) };
  const res = await call(deps, 'POST', '/api/timing', { turn: 1, speechStart: 5, raro: 'x' });
  assert.equal(res.status, 204);
  assert.equal(records.length, 1);
  assert.equal(records[0].tipo, 'voz');
  assert.equal(records[0].turn, 1);
  assert.equal(records[0].speechStart, 5);
  assert.equal('raro' in records[0], false);
});

test('POST /api/timing sin token da 403', async () => {
  const records = [];
  const deps = mkDeps(fakeSession());
  deps.timingLog = { write: (r) => records.push(r) };
  const res = await call(deps, 'POST', '/api/timing', { turn: 1 }, { 'x-alter-token': '' });
  assert.equal(res.status, 403);
  assert.equal(records.length, 0);
});
