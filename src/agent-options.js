// Opciones del Claude Agent SDK para JARVIS. Un solo lugar, para que el chat y las tareas
// en segundo plano arranquen a Claude con la misma configuración.

const { buildSystemPrompt } = require('./prompt');

function buildAgentOptions({ config, canUseTool, mcpServers, abortController }) {
  const options = {
    mcpServers,
    cwd: config.coreDir,
    includePartialMessages: true,
    systemPrompt: buildSystemPrompt({ userName: config.userName }),
    settingSources: ['user'],            // tus plugins y conectores…
    settings: { disableAllHooks: true, autoMemoryEnabled: false }, // …sin hooks ni memoria de archivos
    tools: ['WebSearch', 'WebFetch'],    // de las herramientas internas, solo web: nada de terminal ni archivos
    permissionMode: 'default',           // todo lo que no esté preaprobado pasa por canUseTool
    canUseTool,
    perTaskStopAffordance: true,         // interrupt() corta solo el turno actual; las tareas en segundo plano siguen
  };
  if (abortController) options.abortController = abortController;
  if (config.claudeBin) options.pathToClaudeCodeExecutable = config.claudeBin;
  if (config.model) options.model = config.model;
  return options;
}

module.exports = { buildAgentOptions };
