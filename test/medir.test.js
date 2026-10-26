const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  REQUESTS, SENTENCE_RE, hasFirstSentence, median, createSseParser, checkEnv, summarizeRuns, compareResults, summarizeVoice, planRuns, textBeforeTool,
} = require('../scripts/medir-lib');

test('REQUESTS son los cuatro pedidos fijos', () => {
  assert.deepEqual(REQUESTS.map((r) => r.id), ['saludo', 'agenda', 'correo', 'web']);
});

test('planRuns: sesión nueva por corrida y el primer pedido de cada una es en frío', () => {
  const plan = planRuns(2, REQUESTS);
  assert.equal(plan.length, 8);
  assert.deepEqual(plan.map((p) => p.newSession), [false, false, false, false, true, false, false, false]); // la primera ya arranca sin sesión
  assert.deepEqual(plan.map((p) => p.cold), [true, false, false, false, true, false, false, false]);
  assert.deepEqual(plan.map((p) => p.run), [1, 1, 1, 1, 2, 2, 2, 2]);
  assert.equal(plan[4].request, REQUESTS[0]);
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

// Corta como flushSentences: cada coincidencia de más de un carácter es una frase para la voz
function split(source, text) {
  const re = new RegExp(source, 'g');
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].trim().length > 1) out.push(m[0].trim());
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

test('flushSentences no pierde el texto antes de ¿ o ¡', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const source = app.slice(app.indexOf('function flushSentences')).match(/const re = \/(.+)\/g;/)[1];
  for (const src of [source, SENTENCE_RE.source]) {
    assert.deepEqual(split(src, 'Hola, ¿qué tal? Todo bien.'), ['Hola, ¿qué tal?', 'Todo bien.']);
    assert.deepEqual(split(src, '¡Listo! Ya está.'), ['¡Listo!', 'Ya está.']);
    assert.deepEqual(split(src, 'Uno. Dos… ¿Tres?\n'), ['Uno.', 'Dos…', '¿Tres?']);
  }
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

test('checkEnv exige MEDIR_CONFIG y ALTER_MODEL', () => {
  assert.match(checkEnv({}), /MEDIR_CONFIG/);
  assert.match(checkEnv({ MEDIR_CONFIG: 'base' }), /ALTER_MODEL/);
  assert.match(checkEnv({ MEDIR_CONFIG: '../x', ALTER_MODEL: 'm' }), /MEDIR_CONFIG/); // va en el nombre de archivo
  assert.equal(checkEnv({ MEDIR_CONFIG: 'base', ALTER_MODEL: 'claude-opus-5-5' }), null);
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
  assert.match(lines[0], /frío/); // el arranque en frío también se compara, en su columna
});

test('textBeforeTool: ¿llegó texto antes de la primera herramienta?', () => {
  assert.equal(textBeforeTool(rec({ server: { firstTextMs: 900, tools: [{ name: 'X', startMs: 1200 }] } })), true);
  assert.equal(textBeforeTool(rec({ server: { firstTextMs: 3000, tools: [{ name: 'X', startMs: 1200 }] } })), false);
  assert.equal(textBeforeTool(rec({ server: { firstTextMs: 900, tools: [] } })), null); // sin herramientas no aplica
  assert.equal(textBeforeTool(rec({ server: null })), null);
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
