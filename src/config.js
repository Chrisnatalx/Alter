// Configuración de JARVIS, leída del entorno (.env). Los datos personales (nombre, zona
// horaria, cuenta de Google) viven solo en .env, nunca en el código.

require('../env');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Ubica el ejecutable de Claude Code instalado (el mismo que usás en la terminal).
// Si no se encuentra, el SDK usa el que trae incluido.
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  if (process.platform === 'win32' && process.env.APPDATA) {
    const exe = path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}

// Directorio vacío donde corre Claude: así no hereda CLAUDE.md ni archivos de otro proyecto.
const coreDir = path.join(ROOT, '.core');
fs.mkdirSync(coreDir, { recursive: true });

// Zona horaria IANA válida, o la del sistema (con aviso) si la configurada no existe.
function resolveTimezone(value) {
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!value) return system;
  try { new Intl.DateTimeFormat('es', { timeZone: value }); return value; } catch {
    console.warn(`  [AVISO] JARVIS_TIMEZONE="${value}" no es una zona horaria válida (ejemplo: America/Argentina/Buenos_Aires). Uso la del sistema: ${system}.`);
    return system;
  }
}

module.exports = Object.freeze({
  port: Number(process.env.JARVIS_PORT || 7777),
  model: process.env.JARVIS_MODEL || '', // vacío = modelo por defecto de tu cuenta
  // Cuenta de Google con la que abrir Calendar, Gmail, Drive… si hay varias en el navegador.
  googleAccount: process.env.JARVIS_GOOGLE_ACCOUNT || '',
  userName: process.env.JARVIS_USER_NAME || '',
  timezone: resolveTimezone(process.env.JARVIS_TIMEZONE),
  claudeBin: resolveClaudeBin(),
  confirmTimeoutMs: 2 * 60 * 1000, // sin respuesta en 2 minutos → se deniega
  // Solo los conectores que JARVIS conserva (Gmail, Calendar, Drive, GitHub y Discord); '0' carga todos los de la cuenta
  mcpFilter: process.env.JARVIS_MCP_FILTER !== '0',
  // Una frase corta antes de cada herramienta, para que la voz arranque antes; '0' lo apaga
  promptPreamble: process.env.JARVIS_PROMPT_PREAMBLE !== '0',
  // Registro local de tiempos por turno (JSONL); '0' lo apaga
  timingLog: process.env.JARVIS_TIMING_LOG === '0' ? '' : (process.env.JARVIS_TIMING_LOG || path.join(ROOT, 'logs', 'tiempos.jsonl')),
  coreDir,
  publicDir: path.join(ROOT, 'public'),
});
