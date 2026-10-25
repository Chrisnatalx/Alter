const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { KEPT_CONNECTOR_URLS, KEPT_MCP_SERVERS, pluginServerCommands, buildMcpFilterSettings, keptConnectorsSettled, missingKeptServers } = require('../src/mcp-filter');

// Archivos falsos de ~/.claude/plugins: el registro de instalados y el .mcp.json del plugin
const HOME = path.join('C:', 'Users', 'ana');
const INSTALL = 'C:\\Users\\ana\\.claude\\plugins\\cache\\claude-plugins-official\\discord\\0.0.4';
function fakeFs(over = {}) {
  const files = {
    [path.join(HOME, '.claude', 'plugins', 'installed_plugins.json')]: JSON.stringify({ version: 2, plugins: { 'discord@claude-plugins-official': [{ scope: 'user', installPath: INSTALL }] } }),
    [path.join(INSTALL, '.mcp.json')]: JSON.stringify({ mcpServers: { discord: { command: 'bun', args: ['run', '--cwd', '${CLAUDE_PLUGIN_ROOT}', '--shell=bun', '--silent', 'start'] } } }),
    ...over,
  };
  return (file) => { if (!(file in files)) throw new Error('ENOENT ' + file); return files[file]; };
}

test('los conectores conservados van por URL (por nombre la allowlist los descarta)', () => {
  assert.deepEqual(KEPT_CONNECTOR_URLS, [
    'https://gmailmcp.googleapis.com/*',
    'https://calendarmcp.googleapis.com/*',
    'https://drivemcp.googleapis.com/*',
    'https://api.githubcopilot.com/*',
  ]);
});

test('pluginServerCommands arma el comando exacto del plugin de Discord con su carpeta instalada', () => {
  assert.deepEqual(pluginServerCommands({ home: HOME, readFile: fakeFs() }), [
    ['bun', 'run', '--cwd', 'C:/Users/ana/.claude/plugins/cache/claude-plugins-official/discord/0.0.4', '--shell=bun', '--silent', 'start'],
  ]);
});

test('pluginServerCommands sin el plugin instalado devuelve una lista vacía y no lanza', () => {
  assert.deepEqual(pluginServerCommands({ home: HOME, readFile: () => { throw new Error('ENOENT'); } }), []);
  const sinDiscord = fakeFs({ [path.join(HOME, '.claude', 'plugins', 'installed_plugins.json')]: JSON.stringify({ plugins: {} }) });
  assert.deepEqual(pluginServerCommands({ home: HOME, readFile: sinDiscord }), []);
});

test('buildMcpFilterSettings: URLs de los cuatro conectores y el comando de Discord', () => {
  const s = buildMcpFilterSettings({ home: HOME, readFile: fakeFs() });
  assert.deepEqual(s.allowedMcpServers.filter((e) => e.serverUrl).map((e) => e.serverUrl), KEPT_CONNECTOR_URLS);
  assert.equal(s.allowedMcpServers.filter((e) => e.serverCommand).length, 1);
  assert.ok(s.allowedMcpServers.every((e) => !e.serverName)); // jarvis es del SDK: pasa sin estar en la lista
});

test('pluginServerCommands prefiere el marketplace oficial y la instalación más nueva', () => {
  const OLD = 'C:\\p\\discord\\0.0.3';
  const NEW = 'C:\\p\\discord\\0.0.4';
  const OTHER = 'C:\\p\\otro\\discord';
  const mcp = JSON.stringify({ mcpServers: { discord: { command: 'bun', args: ['--cwd', '${CLAUDE_PLUGIN_ROOT}'] } } });
  const readFile = fakeFs({
    [path.join(HOME, '.claude', 'plugins', 'installed_plugins.json')]: JSON.stringify({ plugins: {
      'discord@otro-marketplace': [{ scope: 'user', installPath: OTHER, lastUpdated: '2026-10-24T00:00:00Z' }],
      'discord@claude-plugins-official': [
        { scope: 'user', installPath: OLD, version: '0.0.3', lastUpdated: '2026-10-01T00:00:00Z' },
        { scope: 'user', installPath: NEW, version: '0.0.4', lastUpdated: '2026-10-22T00:00:00Z' },
      ],
    } }),
    [path.join(OLD, '.mcp.json')]: mcp, [path.join(NEW, '.mcp.json')]: mcp, [path.join(OTHER, '.mcp.json')]: mcp,
  });
  assert.deepEqual(pluginServerCommands({ home: HOME, readFile }), [['bun', '--cwd', 'C:/p/discord/0.0.4']]);
});

test('keptConnectorsSettled: deja de esperar cuando nada está pendiente aunque falte un conservado', () => {
  const st = (over) => [
    { name: 'claude.ai Gmail', status: 'connected', source: 'claudeai' },
    { name: 'claude.ai Google Calendar', status: 'connected', source: 'claudeai' },
    { name: 'claude.ai Google Drive', status: 'connected', source: 'claudeai' },
    { name: 'jarvis', status: 'connected', source: 'sdk' },
    ...over,
  ];
  assert.equal(keptConnectorsSettled(st([])), true); // falta GitHub pero nada espera: no se aguanta el tope
  assert.equal(keptConnectorsSettled(st([{ name: 'claude.ai GitHub', status: 'pending', source: 'claudeai' }])), false);
  assert.equal(keptConnectorsSettled(st([{ name: 'plugin:discord:discord', status: 'pending', source: 'plugin' }])), false);
  // antes de que llegue la lista de claude.ai no se da por terminado (si no, el primer turno sale sin sus herramientas)
  assert.equal(keptConnectorsSettled([{ name: 'jarvis', status: 'connected', source: 'sdk' }]), false);
  assert.equal(keptConnectorsSettled([]), false);
});

test('missingKeptServers detecta conservados ausentes o no conectados', () => {
  const missing = missingKeptServers([
    { name: 'claude.ai Gmail', status: 'connected' },
    { name: 'claude.ai Google Drive', status: 'needs-auth' },
    { name: 'jarvis', status: 'connected' },
  ]);
  for (const n of ['claude.ai Google Drive', 'claude.ai Google Calendar', 'claude.ai GitHub', 'plugin:discord:discord']) assert.ok(missing.includes(n), n);
  assert.ok(!missing.includes('jarvis'));
  assert.ok(!missing.includes('claude.ai Gmail'));
  assert.equal(missingKeptServers(undefined).length, KEPT_MCP_SERVERS.length + 1);
});
