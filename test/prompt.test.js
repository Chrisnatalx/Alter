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

const PREAMBLE = 'Antes de llamar a cualquier herramienta, decí primero una frase muy corta y variada, de dos a cinco palabras (por ejemplo «Ya me fijo.» o «Dame un segundo.»), sin direcciones web, y recién después usá la herramienta.';

test('preamble agrega la frase corta antes de las herramientas', () => {
  const p = buildSystemPrompt({ userName: '', preamble: true });
  assert.ok(p.includes(PREAMBLE));
  assert.ok(p.includes('requiere que la persona lo confirme')); // la regla de confirmación sigue
  assert.ok(p.includes('herramienta Agent'));
});

test('sin preamble el prompt queda como hoy', () => {
  assert.ok(!buildSystemPrompt({ userName: '' }).includes('Antes de llamar a cualquier herramienta'));
  assert.equal(buildSystemPrompt({ userName: '', preamble: false }), buildSystemPrompt({ userName: '' }));
});

test('buildAgentOptions pasa JARVIS_PROMPT_PREAMBLE al prompt', () => {
  const { buildAgentOptions } = require('../src/agent-options');
  const on = buildAgentOptions({ config: { coreDir: '.', userName: '', promptPreamble: true }, canUseTool: () => {}, mcpServers: {} });
  const off = buildAgentOptions({ config: { coreDir: '.', userName: '' }, canUseTool: () => {}, mcpServers: {} });
  assert.ok(on.systemPrompt.includes(PREAMBLE));
  assert.ok(!off.systemPrompt.includes(PREAMBLE));
  assert.equal(on.permissionMode, 'default');
});

test('el prompt trae las reglas de delegación', () => {
  const p = buildSystemPrompt({});
  assert.ok(p.includes('investigador'));
  assert.ok(p.includes('segundo plano'));
  assert.ok(p.includes('herramienta Agent'));
});
