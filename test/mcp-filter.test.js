const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { KEPT_CONNECTOR_URLS, KEPT_MCP_SERVERS, pluginServerCommands, buildMcpFilterSettings, missingKeptServers } = require('../src/mcp-filter');

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
