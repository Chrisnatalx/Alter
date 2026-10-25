// Filtro de servidores MCP (JARVIS_MCP_FILTER): JARVIS carga solo los conectores que la persona eligió
// conservar (Gmail, Google Calendar, Google Drive, GitHub y el plugin de Discord) más su servidor propio, en
// vez de todos los de la cuenta. Así cada turno lleva muchas menos herramientas.
//
// Cómo funciona `settings.allowedMcpServers` (probado con mcpServerStatus() el 2026-10-25, sin mandar mensajes):
// - Por nombre («claude.ai Gmail») descarta igual los conectores de claude.ai: hay que ir por `serverUrl`.
// - Si hay alguna entrada `serverUrl`, todo servidor remoto se compara por URL (los http de la persona que no
//   están en la lista quedan afuera); si hay alguna `serverCommand`, todo servidor stdio se compara por su
//   comando exacto, sin comodines ni ${VAR}. Por eso el comando de Discord se arma con su carpeta instalada.
// - El servidor propio `jarvis` (tipo sdk) pasa siempre, sin estar en la lista.
// Solo se lee configuración (~/.claude/plugins): nada se escribe.

const fs = require('fs');
const os = require('os');
const path = require('path');

const KEPT_CONNECTOR_URLS = [
  'https://gmailmcp.googleapis.com/*',
  'https://calendarmcp.googleapis.com/*',
  'https://drivemcp.googleapis.com/*',
  'https://api.githubcopilot.com/*',
];
// Plugins con servidor MCP que se conservan: { plugin, server }
const KEPT_PLUGIN_SERVERS = [{ plugin: 'discord', server: 'discord' }];
const OFFICIAL_MARKETPLACE = 'claude-plugins-official';
// Nombres que informa init.mcp_servers, para avisar si falta alguno
const KEPT_MCP_SERVERS = ['claude.ai Gmail', 'claude.ai Google Calendar', 'claude.ai Google Drive', 'claude.ai GitHub', 'plugin:discord:discord'];
const OWN_MCP_SERVERS = ['jarvis'];

// La instalación de un plugin: primero la del marketplace oficial; entre sus instalaciones, las globales
// (scope user) antes que las de un proyecto, y de esas la actualizada más recientemente.
function pickInstall(installed, plugin) {
  const keys = Object.keys(installed).filter((k) => k.startsWith(plugin + '@'));
  const key = keys.find((k) => k === `${plugin}@${OFFICIAL_MARKETPLACE}`) || keys[0];
  const list = (key && Array.isArray(installed[key]) ? installed[key] : []).filter((i) => i?.installPath);
  const when = (i) => Date.parse(i.lastUpdated || i.installedAt || '') || 0;
  return list.sort((a, b) => (b.scope === 'user') - (a.scope === 'user') || when(b) - when(a))[0];
}

// Comando exacto de cada plugin conservado, como lo arma la CLI: el de su .mcp.json con la carpeta instalada
// (en barras normales). Si algo no está, ese plugin no se incluye: nunca lanza.
function pluginServerCommands({ home, readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  home ||= os.homedir();
  const commands = [];
  let installed;
  try { installed = JSON.parse(readFile(path.join(home, '.claude', 'plugins', 'installed_plugins.json'))).plugins || {}; } catch { return commands; }
  for (const { plugin, server } of KEPT_PLUGIN_SERVERS) {
    try {
      const installPath = pickInstall(installed, plugin)?.installPath;
      if (!installPath) continue;
      const def = JSON.parse(readFile(path.join(installPath, '.mcp.json'))).mcpServers?.[server];
      if (!def?.command) continue;
      const root = installPath.replace(/\\/g, '/');
      commands.push([def.command, ...(def.args || [])].map((a) => String(a).replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, root)));
    } catch { /* ese plugin no se conserva */ }
  }
  return commands;
}

// Capa «flag» de settings con la allowlist: URLs de los conectores y comandos de los plugins
function buildMcpFilterSettings(opts) {
  return {
    allowedMcpServers: [
      ...KEPT_CONNECTOR_URLS.map((serverUrl) => ({ serverUrl })),
      ...pluginServerCommands(opts).map((serverCommand) => ({ serverCommand })),
    ],
  };
}

// ¿Ya terminaron de conectar (bien o mal) los conectores de claude.ai conservados? Con el filtro, el init llega
// antes que ellos, y un primer turno sin sus herramientas termina delegando en un subagente (probado: 27 s).
// Listo cuando ya llegó la lista de claude.ai y nada quedó `pending`. Si falta un conservado no se espera el
// tope entero: el aviso de `faltan` lo informa.
function keptConnectorsSettled(mcpStatus) {
  const list = mcpStatus || [];
  return list.some((s) => s.source === 'claudeai') && !list.some((s) => s.status === 'pending');
}

// Conservados o propios que no aparecen o no quedaron conectados (p. ej. un needs-auth o una URL que cambió)
function missingKeptServers(mcpServers) {
  const connected = new Set((mcpServers || []).filter((s) => s.status === 'connected').map((s) => s.name));
  return [...KEPT_MCP_SERVERS, ...OWN_MCP_SERVERS].filter((n) => !connected.has(n));
}

module.exports = { KEPT_CONNECTOR_URLS, KEPT_MCP_SERVERS, OWN_MCP_SERVERS, pluginServerCommands, buildMcpFilterSettings, keptConnectorsSettled, missingKeptServers };
