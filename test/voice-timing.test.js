const test = require('node:test');
const assert = require('node:assert/strict');
const { buildVoiceReport, formatBreakdown, isReportReady, emptyMarks } = require('../public/timing.js');

test('buildVoiceReport calcula las diferencias', () => {
  const r = buildVoiceReport({ speechEnd: 100, final: 700, post: 710, firstQueued: 2500, speechStart: 2600 }, { turn: 4, initMs: 1 });
  assert.equal(r.endToFinalMs, 600);
  assert.equal(r.finalToPostMs, 10);
  assert.equal(r.postToSpeechStartMs, 1890);
  assert.equal(r.speechEndToSpeechStartMs, 2500);
  assert.equal(r.turn, 4); // el número de turno lo da el servidor
  assert.equal(r.listenMode, 'clasica');
  assert.deepEqual(r.server, { turn: 4, initMs: 1 });
});

test('texto escrito: sin marcas de voz de entrada', () => {
  const r = buildVoiceReport({ ...emptyMarks(), post: 10, firstQueued: 900, speechStart: 1000 }, null);
  assert.equal(r.endToFinalMs, null);
  assert.equal(r.speechEndToSpeechStartMs, null);
  assert.equal(r.postToSpeechStartMs, 990);
  assert.equal(r.turn, null);
  assert.equal(r.server, null);
});

test('reporte sin voz sale con speechStart null', () => {
  assert.equal(isReportReady({ server: {}, marks: { firstQueued: null, speechStart: null }, ended: true }), true);
  // sin terminar el turno, o con una frase en cola que todavía no sonó, se espera
  assert.equal(isReportReady({ server: {}, marks: { firstQueued: null, speechStart: null }, ended: false }), false);
  assert.equal(isReportReady({ server: {}, marks: { firstQueued: 5, speechStart: null }, ended: true }), false);
  assert.equal(isReportReady({ server: {}, marks: { firstQueued: 5, speechStart: 9 }, ended: false }), true);
  assert.equal(isReportReady({ server: null, marks: { firstQueued: 5, speechStart: 9 }, ended: true }), false);
});

test('formatBreakdown muestra herramientas con su subagente', () => {
  const report = {
    endToFinalMs: 640, postToSpeechStartMs: 2300,
    server: { initMs: 900, firstTextMs: 1800, tools: [{ name: 'Agent', agent: 'agenda', startMs: 200, endMs: 3100 }, { name: 'WebSearch', agent: null, startMs: 50, endMs: null }] },
  };
  assert.equal(formatBreakdown(report), 'habla→final 640 ms · init 900 · texto 1800 · voz 2300 · Agent(agenda) 200–3100 · WebSearch 50–…');
  assert.equal(formatBreakdown({ endToFinalMs: null, postToSpeechStartMs: null, server: null }), '');
});
