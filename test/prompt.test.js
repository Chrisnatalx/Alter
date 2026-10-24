const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSystemPrompt, nowLine } = require('../src/prompt');

test('sin nombre, el prompt no tiene datos personales', () => {
  const p = buildSystemPrompt({ userName: '' });
  assert.ok(!p.includes('Nata'));
  assert.ok(!p.includes('se llama'));
});

test('con nombre, lo agrega', () => {
  assert.ok(buildSystemPrompt({ userName: 'Ana' }).includes('La persona se llama Ana.'));
});

test('el prompt menciona las herramientas propias', () => {
  const p = buildSystemPrompt({ userName: '' });
  assert.ok(p.includes('abrir_en_navegador'));
  assert.ok(p.includes('poner_en_youtube'));
});

test('nowLine deriva la ciudad de la zona horaria', () => {
  assert.ok(nowLine('America/Argentina/Buenos_Aires').endsWith(', Buenos Aires'));
});

test('el prompt trae las reglas de delegación', () => {
  const p = buildSystemPrompt({});
  assert.ok(p.includes('investigador'));
  assert.ok(p.includes('segundo plano'));
  assert.ok(p.includes('herramienta Agent'));
});
