const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  REQUESTS, SENTENCE_RE, hasFirstSentence, median, createSseParser, checkEnv, summarizeRuns, compareResults, summarizeVoice,
} = require('../scripts/medir-lib');

test('REQUESTS son los cuatro pedidos fijos', () => {
  assert.deepEqual(REQUESTS.map((r) => r.id), ['saludo', 'agenda', 'correo', 'web']);
});

test('median con pares, impares y nulls', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, null, 3, 2]), 2.5);
  assert.equal(median([NaN, 5]), 5);
  assert.equal(median([]), null);
  assert.equal(median([null]), null);
});

test('SENTENCE_RE es la misma que usa flushSentences', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const body = app.slice(app.indexOf('function flushSentences'));
  const m = body.match(/const re = \/(.+)\/g;/);
  assert.ok(m, 'no encontré la regex en flushSentences');
  assert.equal(m[1], SENTENCE_RE.source);
});

test('hasFirstSentence', () => {
  assert.equal(hasFirstSentence('Hola'), false);
  assert.equal(hasFirstSentence('Hola, ¿qué tal? '), true);
  assert.equal(hasFirstSentence('.'), false);
  assert.equal(hasFirstSentence('Listo.'), true);
  assert.equal(hasFirstSentence('Listo.'), true); // la regex global no arrastra lastIndex entre llamadas
});

test('createSseParser junta trozos partidos', () => {
  const got = [];
  const feed = createSseParser((e, d) => got.push([e, d]));
  feed(': ping\n\nevent: timing\ndata: {"tu');
  feed('rn":1}\n\nevent: done\r\ndata: {}\r\n\r\n');
  assert.deepEqual(got, [['timing', { turn: 1 }], ['done', {}]]);
});

test('checkEnv exige MEDIR_CONFIG y JARVIS_MODEL', () => {
  assert.match(checkEnv({}), /MEDIR_CONFIG/);
  assert.match(checkEnv({ MEDIR_CONFIG: 'base' }), /JARVIS_MODEL/);
  assert.match(checkEnv({ MEDIR_CONFIG: '../x', JARVIS_MODEL: 'm' }), /MEDIR_CONFIG/); // va en el nombre de archivo
  assert.equal(checkEnv({ MEDIR_CONFIG: 'base', JARVIS_MODEL: 'claude-opus-5-5' }), null);
});

const rec = (over) => ({ request: 'saludo', run: 1, cold: false, interrupted: false, timeout: false, denied: false, firstSentenceMs: 1000, httpFirstTextMs: 900, server: { initMs: 100, firstTextMs: 800, doneMs: 1500, tools: [] }, text: '', ...over });

test('summarizeRuns excluye interrumpidos y timeouts', () => {
  const s = summarizeRuns([rec({ firstSentenceMs: 1000 }), rec({ firstSentenceMs: 50, interrupted: true }), rec({ firstSentenceMs: 60, timeout: true })]);
  assert.equal(s.byRequest.saludo.n, 1);
  assert.equal(s.byRequest.saludo.firstSentenceMs, 1000);
  assert.equal(s.byRequest.saludo.initMs, 100);
  assert.equal(s.all.firstSentenceMs, 1000);
});

test('summarizeRuns separa el arranque en frío', () => {
  const s = summarizeRuns([rec({ cold: true, firstSentenceMs: 9000 }), rec({ firstSentenceMs: 1000 }), rec({ firstSentenceMs: 1200 })]);
  assert.equal(s.byRequest.saludo.firstSentenceMs, 1100);
  assert.equal(s.cold.firstSentenceMs, 9000);
  assert.equal(s.cold.n, 1);
});

const result = (config, ms) => ({ config, summary: summarizeRuns([rec({ firstSentenceMs: ms })]) });

test('compareResults marca mejora de 300 ms o más', () => {
  const lines = compareResults([result('base', 2000), result('rapida', 1650), result('casi', 1800)]).split('\n');
  assert.match(lines.find((l) => l.startsWith('rapida')), /✔ ≥300 ms/);
  assert.doesNotMatch(lines.find((l) => l.startsWith('casi')), /✔/);
  assert.doesNotMatch(lines.find((l) => l.startsWith('base')), /✔/);
});

test('summarizeVoice agrupa por modo de escucha', () => {
  const out = summarizeVoice([
    { tipo: 'voz', listenMode: 'clasica', endToFinalMs: 600, postToSpeechStartMs: 2000, speechEndToSpeechStartMs: 2600 },
    { tipo: 'voz', listenMode: 'clasica', endToFinalMs: 800, postToSpeechStartMs: 2200, speechEndToSpeechStartMs: 3000 },
    { tipo: 'voz', listenMode: 'continua', endToFinalMs: 300, postToSpeechStartMs: 2000, speechEndToSpeechStartMs: 2300 },
    { tipo: 'servidor', initMs: 5 },
  ]);
  assert.match(out, /clasica.*n=2.*700.*2100.*2800/);
  assert.match(out, /continua.*n=1.*300/);
});
