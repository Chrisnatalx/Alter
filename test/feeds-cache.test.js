const test = require('node:test');
const assert = require('node:assert/strict');
const { createFeedCache, createFeedWatcher, READ_ACTIONS } = require('../src/feeds/cache');

// Reloj y timers falsos: el intervalo se dispara a mano con tick()
function mk({ loaders, hasClient = () => true } = {}) {
  let t = 1_000_000;
  const events = [];
  const intervals = [];
  const cache = createFeedCache({
    loaders,
    intervalMs: 600000,
    hasClient,
    emit: (e, d) => events.push([e, d]),
    now: () => t,
    timers: { setInterval: (fn, ms) => { const h = { fn, ms, unref() {} }; intervals.push(h); return h; }, clearInterval: (h) => { h.cleared = true; } },
  });
  return { cache, events, intervals, advance: (ms) => { t += ms; }, now: () => t };
}

test('refresh stores data and emits feeds', async () => {
  const { cache, events, now } = mk({ loaders: { weather: async () => ({ temp: 15 }) } });
  await cache.refresh('weather');
  const snap = cache.snapshot();
  assert.deepEqual(snap.weather.data, { temp: 15 });
  assert.equal(snap.weather.updatedAt, now());
  assert.equal(snap.weather.error, null);
  assert.equal(snap.weather.refreshing, false);
  assert.deepEqual(events.at(-1), ['feeds', snap]);
});

test('concurrent refresh is single-flight', async () => {
  let calls = 0;
  const { cache } = mk({ loaders: { google: async () => { calls++; return 1; } } });
  const a = cache.refresh('google');
  const b = cache.refresh('google');
  assert.equal(a, b);
  assert.equal(cache.snapshot().google.refreshing, true);
  await a;
  assert.equal(calls, 1);
});

test('ifOlderMs skips fresh data', async () => {
  let calls = 0;
  const { cache, advance } = mk({ loaders: { google: async () => ++calls } });
  await cache.refresh('google');
  advance(60e3);
  await cache.refresh('google', { ifOlderMs: 5 * 60e3 });
  assert.equal(calls, 1);
  advance(5 * 60e3);
  await cache.refresh('google', { ifOlderMs: 5 * 60e3 });
  assert.equal(calls, 2);
});

test('failed refresh keeps previous data and records error', async () => {
  let fail = false;
  const { cache, advance } = mk({ loaders: { google: async () => { if (fail) throw new Error('sin conectores'); return 'viejo'; } } });
  await cache.refresh('google');
  fail = true;
  await cache.refresh('google'); // no rechaza
  const g = cache.snapshot().google;
  assert.equal(g.data, 'viejo');
  assert.equal(g.error, 'sin conectores');
  assert.equal(g.refreshing, false);
  fail = false;
  advance(121e3); // pasada la espera después del error
  await cache.refresh('google');
  assert.equal(cache.snapshot().google.error, null); // un refresco bueno limpia el error
});

test('un tipo desconocido no hace nada', async () => {
  const { cache, events } = mk({ loaders: {} });
  await cache.refresh('x');
  assert.equal(events.length, 0);
});

test('interval only refreshes with a client', async () => {
  let client = false;
  const calls = [];
  const { cache, intervals } = mk({ loaders: { google: async () => calls.push('g'), weather: async () => calls.push('w') }, hasClient: () => client });
  cache.start();
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 600000);
  intervals[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, []);
  client = true;
  intervals[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.sort(), ['g', 'w']);
  cache.stop();
  assert.equal(intervals[0].cleared, true);
});

test('reason viaja en el evento feeds', async () => {
  const { cache, events } = mk({ loaders: { google: async () => 1 } });
  await cache.refresh('google', { reason: 'write' });
  assert.equal(events.at(-1)[1].reason, 'write');
  await cache.refresh('google');
  assert.equal(events.at(-1)[1].reason, undefined);
});

test('un refresco por escritura durante otro en curso se vuelve a pedir al terminar', async () => {
  let calls = 0;
  let release;
  const { cache, events } = mk({ loaders: { google: () => { calls++; return calls === 1 ? new Promise((r) => { release = r; }) : Promise.resolve(calls); } } });
  const first = cache.refresh('google');
  const second = cache.refresh('google', { reason: 'write' });
  await new Promise((r) => setImmediate(r)); // el loader arranca en un microtask
  release(1);
  await first; await second;
  assert.equal(calls, 2); // los datos del primero podían ser de antes de la escritura
  assert.equal(events.at(-1)[1].reason, 'write');
  assert.equal(cache.snapshot().google.data, 2);
});

test('watcher fires once after a write that actually ran', () => {
  let n = 0;
  const w = createFeedWatcher(() => n++);
  w('tool', { app: 'Gmail', action: 'send message' });
  w('tool_result', { app: 'Gmail', action: 'send message', ok: true });
  w('delta', { text: 'listo' });
  w('done', {});
  w('done', {});
  assert.equal(n, 1);
  w('tool_result', { app: 'Gmail', action: 'search threads', ok: true });
  w('done', {});
  assert.equal(n, 1);
  w('tool_result', { app: 'búsqueda web', action: '', ok: true });
  w('done', {});
  assert.equal(n, 1);
  w('tool_result', { app: 'Google Calendar', action: 'create event', ok: true });
  w('error', { message: 'x' });
  assert.equal(n, 2);
});

test('watcher no dispara si la escritura se denegó o no corrió', () => {
  let n = 0;
  const w = createFeedWatcher(() => n++);
  w('tool', { app: 'Gmail', action: 'send message' }); // empezó…
  w('confirm', { id: 'c1', app: 'Gmail', action: 'send message' });
  w('confirm_closed', { id: 'c1', allowed: false });
  w('tool_result', { app: 'Gmail', action: 'send message', ok: false }); // …y se denegó
  w('done', {});
  w('tool', { app: 'Gmail', action: 'trash thread' }); // sin resultado (turno cortado)
  w('done', { interrupted: true });
  assert.equal(n, 0);
});

test('watcher no dispara sin navegador conectado', () => {
  let n = 0;
  let client = false;
  const w = createFeedWatcher(() => n++, { hasClient: () => client });
  w('tool_result', { app: 'Gmail', action: 'send message', ok: true });
  w('done', {});
  assert.equal(n, 0);
  client = true;
  w('tool_result', { app: 'Gmail', action: 'send message', ok: true });
  w('done', {});
  assert.equal(n, 1);
});

test('después de un error, los refrescos de rutina esperan 2 minutos; los de escritura no', async () => {
  let calls = 0;
  let fail = true;
  const { cache, advance } = mk({ loaders: { google: async () => { calls++; if (fail) throw new Error('caído'); return 'ok'; } } });
  await cache.refresh('google');
  assert.equal(calls, 1);
  assert.equal(typeof cache.snapshot().google.lastErrorAt, 'number');
  advance(60e3);
  await cache.refresh('google');                       // al conectar, foco o intervalo: espera
  await cache.refresh('google', { ifOlderMs: 60000 });
  await cache.refreshAll();
  assert.equal(calls, 1);
  await cache.refresh('google', { reason: 'write' });  // una escritura de ALTER: va igual
  assert.equal(calls, 2);
  advance(121e3);
  fail = false;
  await cache.refresh('google');
  assert.equal(calls, 3);
  assert.equal(cache.snapshot().google.error, null);
});

test('READ_ACTIONS tiene las lecturas con espacios, como describeTool', () => {
  assert.ok(READ_ACTIONS.has('search threads'));
  assert.ok(READ_ACTIONS.has('list events'));
  assert.ok(!READ_ACTIONS.has('send message'));
});
