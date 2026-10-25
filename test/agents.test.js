const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAgents } = require('../src/agents');
const { needsConfirm } = require('../src/permissions');
const { buildAgentOptions } = require('../src/agent-options');

const config = { coreDir: '.', userName: '' };

test('ningún subagente tiene herramientas de enviar o borrar', () => {
  const agents = buildAgents(config, {});
  assert.deepEqual(Object.keys(agents).sort(), ['agenda', 'correo', 'investigador']);
  for (const [name, a] of Object.entries(agents)) {
    assert.ok(a.tools.length > 0, name);
    for (const t of a.tools) assert.equal(needsConfirm(t, {}), false, `${name}: ${t}`);
  }
});

test('el investigador corre en segundo plano', () => {
  assert.equal(buildAgents(config, {}).investigador.background, true);
});

test('el modelo de cada subagente se puede pisar por entorno', () => {
  assert.equal(buildAgents(config, {}).agenda.model, 'haiku');
  assert.equal(buildAgents(config, { JARVIS_AGENT_AGENDA_MODEL: 'sonnet' }).agenda.model, 'sonnet');
});

test('los subagentes no cargan CLAUDE.md', () => {
  for (const a of Object.values(buildAgents(config, {}))) assert.equal(a.omitClaudeMd, true);
});

test('con el filtro las confirmaciones no cambian', () => {
  const canUseTool = () => {};
  const o = buildAgentOptions({ config: { ...config, mcpFilter: true }, canUseTool, mcpServers: {} });
  assert.equal(o.permissionMode, 'default');
  assert.equal(o.canUseTool, canUseTool);
  assert.equal(o.settings.permissions, undefined);
  assert.equal(o.settings.disableAllHooks, true);
  assert.equal(o.settings.autoMemoryEnabled, false);
  assert.deepEqual(o.settingSources, ['user']);
  assert.ok(o.settings.allowedMcpServers.some((s) => s.serverUrl === 'https://gmailmcp.googleapis.com/*'));
});

test('sin el filtro las opciones quedan como hoy', () => {
  const o = buildAgentOptions({ config: { ...config, mcpFilter: false }, canUseTool: () => {}, mcpServers: {} });
  assert.equal(o.settings.allowedMcpServers, undefined);
});

test('buildAgentOptions habilita la herramienta Agent y define los subagentes', () => {
  const o = buildAgentOptions({ config, canUseTool: () => {}, mcpServers: {} });
  assert.ok(o.tools.includes('Agent'));
  assert.deepEqual(Object.keys(o.agents).sort(), ['agenda', 'correo', 'investigador']);
});
