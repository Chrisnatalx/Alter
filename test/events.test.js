const test = require('node:test');
const assert = require('node:assert/strict');
const { createEventHub } = require('../src/events');

function fakeRes() {
  const res = { chunks: [], ended: false, head: null, closeCb: null };
  res.writeHead = (code, headers) => { res.head = { code, headers }; };
  res.write = (s) => { res.chunks.push(s); return true; };
  res.end = () => { res.ended = true; };
  res.on = (ev, cb) => { if (ev === 'close') res.closeCb = cb; };
  res.text = () => res.chunks.join('');
  return res;
}

test('attach escribe los headers SSE', () => {
  const hub = createEventHub();
  const res = fakeRes();
  hub.attach(res);
  assert.equal(res.head.code, 200);
  assert.match(res.head.headers['Content-Type'], /text\/event-stream/);
  res.closeCb();
});

test('hub replaces previous client', () => {
  const hub = createEventHub();
  const a = fakeRes();
  const b = fakeRes();
  hub.attach(a);
  hub.attach(b);
  assert.match(a.text(), /event: replaced/);
  assert.equal(a.ended, true);
  hub.emit('delta', { text: 'hola' });
  assert.doesNotMatch(a.text(), /delta/);
  assert.match(b.text(), /event: delta\ndata: {"text":"hola"}\n\n/);
  // el cierre tardío del cliente reemplazado no deja al hub sin cliente
  a.closeCb();
  assert.equal(hub.hasClient(), true);
  b.closeCb();
});

test('emit sin clientes no lanza', () => {
  const hub = createEventHub();
  assert.doesNotThrow(() => hub.emit('delta', { text: 'x' }));
  assert.equal(hub.hasClient(), false);
});

test('el cierre del cliente actual deja hasClient en false', () => {
  const hub = createEventHub();
  const res = fakeRes();
  hub.attach(res);
  assert.equal(hub.hasClient(), true);
  res.closeCb();
  assert.equal(hub.hasClient(), false);
});

test('manda ping periódico y lo detiene al cerrar', async () => {
  const hub = createEventHub({ pingMs: 10 });
  const res = fakeRes();
  hub.attach(res);
  await new Promise((r) => setTimeout(r, 35));
  assert.match(res.text(), /: ping\n\n/);
  res.closeCb();
  const n = res.chunks.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(res.chunks.length, n);
});
