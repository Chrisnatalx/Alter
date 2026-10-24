const { test, after } = require('node:test');
const assert = require('node:assert');

// Puerto 0: al cargar el módulo el servidor escucha, y no queremos chocar con un JARVIS real.
process.env.JARVIS_PORT = '0';
const { server, isTrusted } = require('../src/server');
after(() => server.close());

const token = 'a'.repeat(48);
const allowedHosts = new Set(['localhost:7777', '127.0.0.1:7777']);
const req = (headers) => ({ headers });

test('isTrusted acepta host local con token correcto', () => {
  assert.strictEqual(isTrusted(req({ host: 'localhost:7777', 'x-jarvis-token': token }), { token, allowedHosts }), true);
  assert.strictEqual(isTrusted(req({ host: '127.0.0.1:7777', origin: 'http://localhost:7777', 'x-jarvis-token': token }), { token, allowedHosts }), true);
});

test('isTrusted rechaza host ajeno, origen ajeno y token malo', () => {
  assert.strictEqual(isTrusted(req({ host: 'evil.com', 'x-jarvis-token': token }), { token, allowedHosts }), false);
  assert.strictEqual(isTrusted(req({ host: 'localhost:7777', origin: 'http://evil.com', 'x-jarvis-token': token }), { token, allowedHosts }), false);
  assert.strictEqual(isTrusted(req({ host: 'localhost:7777', 'x-jarvis-token': 'b'.repeat(48) }), { token, allowedHosts }), false);
  assert.strictEqual(isTrusted(req({ host: 'localhost:7777', 'x-jarvis-token': 'abc' }), { token, allowedHosts }), false);
  assert.strictEqual(isTrusted(req({ host: 'localhost:7777' }), { token, allowedHosts }), false);
});
