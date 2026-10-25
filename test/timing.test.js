const test = require('node:test');
const assert = require('node:assert/strict');
const { startTurnTiming, trackMessage, summarizeTiming, createTimingLog, sanitizeVoiceRecord } = require('../src/timing');

const init = { type: 'system', subtype: 'init', session_id: 'sid-1', model: 'haiku' };
const delta = (text, parent = null) => ({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const success = { type: 'result', subtype: 'success', session_id: 'sid-1', result: 'ok' };

test('trackMessage marca init, primer texto y fin', () => {
  const t = startTurnTiming(1000);
  trackMessage(t, init, 1100);
  trackMessage(t, delta('Hola'), 1500);
  trackMessage(t, delta(' qué tal'), 1600);
  trackMessage(t, success, 2000);
  assert.deepEqual(summarizeTiming(t), { initMs: 100, firstTextMs: 500, doneMs: 1000, interrupted: false, tools: [] });
});

test('un delta de subagente no cuenta como primer texto', () => {
  const t = startTurnTiming(1000);
  trackMessage(t, delta('x', 'x'), 1200);
  assert.equal(summarizeTiming(t).firstTextMs, null);
});

test('herramientas: inicio por content_block_start, fin por tool_result', () => {
  const t = startTurnTiming(1000);
  trackMessage(t, { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu1', name: 'Agent' } } }, 1200);
  trackMessage(t, { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'agenda' } }] } }, 1300);
  trackMessage(t, { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tu1' }] } }, 1900);
  // un tool_result de una herramienta desconocida se ignora
  trackMessage(t, { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'otro' }] } }, 1950);
  assert.deepEqual(summarizeTiming(t).tools, [{ name: 'Agent', agent: 'agenda', startMs: 200, endMs: 900 }]);
});

test('summarizeTiming marca interrumpido', () => {
  const t = startTurnTiming(1000);
  trackMessage(t, init, 1100);
  trackMessage(t, { type: 'result', subtype: 'error_during_execution', session_id: 'sid-1' }, 1400);
  const s = summarizeTiming(t);
  assert.equal(s.interrupted, true);
  assert.equal(typeof s.doneMs, 'number');
});

test('createTimingLog escribe una línea JSON por registro', () => {
  const writes = [];
  const dirs = [];
  const log = createTimingLog({
    file: '/tmp/x/logs/tiempos.jsonl',
    appendFile: (file, text, cb) => { writes.push([file, text]); cb(null); },
    mkdirSync: (dir, opts) => dirs.push([dir, opts]),
  });
  const record = { tipo: 'servidor', turn: 1 };
  log.write(record);
  log.write({ tipo: 'voz' });
  assert.equal(writes[0][1], JSON.stringify(record) + '\n');
  assert.equal(writes.length, 2);
  assert.equal(dirs.length, 1); // el directorio se crea solo la primera vez
  assert.deepEqual(dirs[0][1], { recursive: true });
});

test('createTimingLog con file vacío no escribe', () => {
  let called = 0;
  const log = createTimingLog({ file: '', appendFile: () => { called++; }, mkdirSync: () => { called++; } });
  log.write({ tipo: 'servidor' });
  assert.equal(called, 0);
});

test('createTimingLog no lanza si appendFile falla', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const log = createTimingLog({ file: 'x/t.jsonl', appendFile: (f, s, cb) => cb(new Error('disco lleno')), mkdirSync: () => {} });
  log.write({ a: 1 });
  log.write({ a: 2 });
  assert.equal(warn.mock.callCount(), 1); // se avisa una sola vez
});

test('sanitizeVoiceRecord deja solo claves conocidas', () => {
  const out = sanitizeVoiceRecord({
    turn: 3, speechEnd: 1.5, final: null, post: 2, firstQueued: 3, speechStart: 4,
    endToFinalMs: 10, finalToPostMs: 1, postToSpeechStartMs: 2, speechEndToSpeechStartMs: 3,
    listenMode: 'clasica', raro: 'x', server: { initMs: 1 }, turnStr: '1',
  });
  assert.deepEqual(out, {
    turn: 3, speechEnd: 1.5, final: null, post: 2, firstQueued: 3, speechStart: 4,
    endToFinalMs: 10, finalToPostMs: 1, postToSpeechStartMs: 2, speechEndToSpeechStartMs: 3,
    listenMode: 'clasica',
  });
  // números no finitos, tipos raros y modos demasiado largos se descartan
  assert.deepEqual(sanitizeVoiceRecord({ turn: Infinity, post: '5', listenMode: 'x'.repeat(21) }), {});
  assert.equal(sanitizeVoiceRecord(null), null);
  assert.equal(sanitizeVoiceRecord('hola'), null);
  assert.equal(sanitizeVoiceRecord([1]), null);
});
