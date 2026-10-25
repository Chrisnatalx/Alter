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

const PREAMBLE_START = 'Antes de llamar a cualquier herramienta, decí primero una frase muy corta';

test('el preámbulo viene por defecto y pide frases cortas y variadas', () => {
  const p = buildSystemPrompt({ userName: '' });
  assert.ok(p.includes(PREAMBLE_START));
  assert.ok(p.includes('de dos a cinco palabras'));
  assert.ok(p.includes('no repitas la misma dos veces seguidas'));
  assert.ok(p.includes('«Ya me fijo.»'));
  assert.ok(p.includes('requiere que la persona lo confirme')); // la regla de confirmación sigue
  assert.ok(p.includes('herramienta Agent'));
});

test('con preamble false el prompt no lo trae', () => {
  const p = buildSystemPrompt({ userName: '', preamble: false });
  assert.ok(!p.includes(PREAMBLE_START));
  assert.ok(p.includes('requiere que la persona lo confirme'));
});

test('buildAgentOptions: preámbulo salvo que la config lo apague', () => {
  const { buildAgentOptions } = require('../src/agent-options');
  const opts = (over) => buildAgentOptions({ config: { coreDir: '.', userName: '', ...over }, canUseTool: () => {}, mcpServers: {} });
  assert.ok(opts({}).systemPrompt.includes(PREAMBLE_START));
  assert.ok(opts({ promptPreamble: true }).systemPrompt.includes(PREAMBLE_START));
  assert.ok(!opts({ promptPreamble: false }).systemPrompt.includes(PREAMBLE_START));
  assert.equal(opts({}).permissionMode, 'default');
});

test('el prompt trae las reglas de delegación', () => {
  const p = buildSystemPrompt({});
  assert.ok(p.includes('investigador'));
  assert.ok(p.includes('segundo plano'));
  assert.ok(p.includes('herramienta Agent'));
});
