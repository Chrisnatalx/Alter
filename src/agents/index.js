// Subagentes de ALTER en el formato `agents` del Agent SDK. Los tres son de solo lectura o
// preparación (borradores): lo que envía o borra lo hace ALTER con confirmación.

const AGENTS = [require('./agenda'), require('./correo'), require('./investigador')];

// El modelo de cada uno se puede pisar con ALTER_AGENT_<NOMBRE>_MODEL (ej. ALTER_AGENT_AGENDA_MODEL=sonnet).
function buildAgents(config, env = process.env) {
  const out = {};
  for (const { name, description, prompt, tools, model, background, maxTurns } of AGENTS) {
    const def = {
      description, prompt, tools,
      model: env[`ALTER_AGENT_${name.toUpperCase()}_MODEL`] || model,
      maxTurns,
      omitClaudeMd: true, // sin CLAUDE.md: solo el prompt del agente
    };
    if (background) def.background = true;
    out[name] = def;
  }
  return out;
}

module.exports = { buildAgents };
