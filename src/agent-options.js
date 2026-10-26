// Opciones del Claude Agent SDK para ALTER. Un solo lugar, para que el chat y las tareas
// en segundo plano arranquen a Claude con la misma configuración.

const { buildSystemPrompt } = require('./prompt');
const { buildAgents } = require('./agents');
const { buildMcpFilterSettings } = require('./mcp-filter');

function buildAgentOptions({ config, canUseTool, mcpServers, abortController }) {
  const options = {
    mcpServers,
    cwd: config.coreDir,
    includePartialMessages: true,
    systemPrompt: buildSystemPrompt({ userName: config.userName, preamble: config.promptPreamble !== false }),
    settingSources: ['user'],            // tus plugins y conectores…
    settings: { disableAllHooks: true, autoMemoryEnabled: false }, // …sin hooks ni memoria de archivos
    tools: ['WebSearch', 'WebFetch', 'Agent'], // de las herramientas internas, solo web y delegar: nada de terminal ni archivos
    agents: buildAgents(config),         // subagentes: agenda, correo e investigador
    permissionMode: 'default',           // todo lo que no esté preaprobado pasa por canUseTool
    canUseTool,
    perTaskStopAffordance: true,         // interrupt() corta solo el turno actual; las tareas en segundo plano siguen
  };
  // Solo los conectores que ALTER conserva (src/mcp-filter.js); permisos y confirmaciones no cambian
  if (config.mcpFilter) options.settings = { ...options.settings, ...buildMcpFilterSettings({ home: config.claudeHome }) };
  if (abortController) options.abortController = abortController;
  if (config.claudeBin) options.pathToClaudeCodeExecutable = config.claudeBin;
  if (config.model) options.model = config.model;
  return options;
}

module.exports = { buildAgentOptions };
