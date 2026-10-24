const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOpenUrl, openInBrowser } = require('../src/tools/browser');
const { parseYoutubeResults, findYoutubeVideo } = require('../src/tools/youtube');

test('buildOpenUrl rechaza protocolos que no son http/https', () => {
  assert.throws(() => buildOpenUrl('file:///C:/x', ''), { message: 'Solo se pueden abrir direcciones http o https.' });
});

test('buildOpenUrl agrega authuser en google.com', () => {
  assert.equal(
    buildOpenUrl('https://calendar.google.com/calendar/r/week/2026/10/26', 'a@b.c'),
    'https://calendar.google.com/calendar/r/week/2026/10/26?authuser=a%40b.c',
  );
});

test('buildOpenUrl respeta un authuser existente', () => {
  assert.equal(buildOpenUrl('https://mail.google.com/?authuser=0', 'a@b.c'), 'https://mail.google.com/?authuser=0');
});

test('buildOpenUrl no toca otros dominios', () => {
  assert.equal(buildOpenUrl('https://github.com/x', 'a@b.c'), 'https://github.com/x');
});

test('openInBrowser usa rundll32 en win32', { skip: process.platform !== 'win32' }, () => {
  const calls = [];
  const spawnFn = (...a) => { calls.push(a); return { unref() {} }; };
  openInBrowser('https://x.com/', spawnFn);
  assert.equal(calls[0][0], 'rundll32');
  assert.deepEqual(calls[0][1], ['url.dll,FileProtocolHandler', 'https://x.com/']);
});

const FIXTURE = '{"adSlotRenderer":{"x":1}},{"videoRenderer":{"videoId":"fJ9rUzIMcZQ","thumbnail":{},"title":{"runs":[{"text":"Queen \u2013 Bohemian Rhapsody"}]}}';

test('parseYoutubeResults extrae id y título decodificado', () => {
  assert.deepEqual(parseYoutubeResults(FIXTURE), { id: 'fJ9rUzIMcZQ', title: 'Queen – Bohemian Rhapsody' });
});

test('parseYoutubeResults devuelve null sin resultados', () => {
  assert.equal(parseYoutubeResults('<html></html>'), null);
});

test('findYoutubeVideo devuelve null si la respuesta no es ok', async () => {
  assert.equal(await findYoutubeVideo('x', async () => ({ ok: false })), null);
});

test('openInBrowser: si el programa falta, el error se registra y no se propaga', () => {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.unref = () => {};
  openInBrowser('https://x.com/', () => child);
  const orig = console.error; console.error = () => {};
  try { assert.doesNotThrow(() => child.emit('error', new Error('ENOENT'))); } finally { console.error = orig; }
});
