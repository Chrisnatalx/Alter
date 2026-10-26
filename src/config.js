// Configuración de ALTER, leída del entorno (.env). Los datos personales (nombre, zona
// horaria, cuenta de Google) viven solo en .env, nunca en el código.

require('../env');
const fs = require('fs');
const path = require('path');

const os = require('os');

const ROOT = path.join(__dirname, '..');

// Una variable de prendido/apagado está apagada con 0, false, no u off (sin importar mayúsculas ni espacios)
const isOff = (value) => ['0', 'false', 'no', 'off'].includes(String(value ?? '').trim().toLowerCase());

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
    console.warn(`  [AVISO] ALTER_TIMEZONE="${value}" no es una zona horaria válida (ejemplo: America/Argentina/Buenos_Aires). Uso la del sistema: ${system}.`);
    return system;
  }
}

module.exports = Object.freeze({
  port: Number(process.env.ALTER_PORT || 7777),
  model: process.env.ALTER_MODEL || '', // vacío = modelo por defecto de tu cuenta
  // Cuenta de Google con la que abrir Calendar, Gmail, Drive… si hay varias en el navegador.
  googleAccount: process.env.ALTER_GOOGLE_ACCOUNT || '',
  userName: process.env.ALTER_USER_NAME || '',
  timezone: resolveTimezone(process.env.ALTER_TIMEZONE),
  claudeBin: resolveClaudeBin(),
  confirmTimeoutMs: 2 * 60 * 1000, // sin respuesta en 2 minutos → se deniega
  // Solo los conectores que ALTER conserva (Gmail, Calendar, Drive, GitHub y Discord); '0' carga todos los de la cuenta
  mcpFilter: !isOff(process.env.ALTER_MCP_FILTER),
  claudeHome: os.homedir(), // de acá se leen (solo lectura) los plugins instalados para el filtro
  // Una frase corta antes de cada herramienta, para que la voz arranque antes; '0' lo apaga
  promptPreamble: !isOff(process.env.ALTER_PROMPT_PREAMBLE),
  // Registro local de tiempos por turno (JSONL); '0' lo apaga
  timingLog: process.env.ALTER_TIMING_LOG === '0' ? '' : (process.env.ALTER_TIMING_LOG || path.join(ROOT, 'logs', 'tiempos.jsonl')),
  // Refresco en segundo plano de Calendar y Gmail para las vistas (src/feeds/): query aparte, solo lectura
  feedModel: process.env.ALTER_FEED_MODEL || 'haiku',
  feedTimeoutMs: 120000,
  inboxSize: 8, // hilos de la bandeja que entran en la cara de Mail
  feedIntervalMs: 10 * 60 * 1000, // cada 10 minutos, solo con la página abierta
  feedStaleMs: 5 * 60 * 1000,     // al volver a la pestaña, se refresca si los datos tienen más de 5 minutos
  coreDir,
  publicDir: path.join(ROOT, 'public'),
  // Lo que la página carga de /vendor/: MediaPipe desde node_modules y el modelo de manos (npm run modelo)
  vendor: Object.freeze({
    '/vendor/mediapipe/': path.join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision'),
    '/vendor/models/': path.join(ROOT, 'vendor'),
  }),
});
