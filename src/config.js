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

module.exports = Object.freeze({
  port: Number(process.env.JARVIS_PORT || 7777),
  model: process.env.JARVIS_MODEL || '', // vacío = modelo por defecto de tu cuenta
  // Cuenta de Google con la que abrir Calendar, Gmail, Drive… si hay varias en el navegador.
  googleAccount: process.env.JARVIS_GOOGLE_ACCOUNT || '',
  userName: process.env.JARVIS_USER_NAME || '',
  timezone: process.env.JARVIS_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
  claudeBin: resolveClaudeBin(),
  confirmTimeoutMs: 2 * 60 * 1000, // sin respuesta en 2 minutos → se deniega
  coreDir,
  publicDir: path.join(ROOT, 'public'),
});
