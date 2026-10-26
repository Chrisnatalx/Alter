// Carga la configuración local desde `.env` (junto a este archivo) a process.env.
// Lo usan server.js y bin/alter.js. Las variables que ya estén definidas en el entorno
// tienen prioridad sobre el archivo. `.env` no se sube al repo: ver `.env.example`.

const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '.env');

if (fs.existsSync(ENV_FILE)) {
  if (typeof process.loadEnvFile === 'function') process.loadEnvFile(ENV_FILE);
  else console.warn('  Aviso: tu versión de Node no lee .env (hace falta 20.12 o superior); se ignora.');
}
