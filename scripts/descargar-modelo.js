// Descarga el modelo de manos de MediaPipe a vendor/ (no viene en el paquete npm). Corre solo después de
// `npm install` y a mano con `npm run modelo`. Comprueba el sha256: si no coincide, lo borra.
// Ante cualquier falla avisa y sale con 0, para no romper `npm install` sin red: los gestos quedan
// apagados y la interfaz dice por qué.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const URL_MODELO = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const SHA256 = 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1';
const DEST = path.join(__dirname, '..', 'vendor', 'hand_landmarker.task');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function main() {
  if (fs.existsSync(DEST) && sha(fs.readFileSync(DEST)) === SHA256) {
    console.log('  [MODELO] hand_landmarker.task ya está y coincide.');
    return;
  }
  console.log('  [MODELO] Descargando el modelo de manos (~7,8 MB)…');
  const res = await fetch(URL_MODELO, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`la descarga respondió ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== SHA256) throw new Error('el archivo descargado no coincide con el sha256 esperado');
  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  fs.writeFileSync(DEST, buf);
  console.log(`  [MODELO] Listo: ${path.relative(process.cwd(), DEST)}`);
}

main().catch((err) => {
  try { fs.rmSync(DEST, { force: true }); } catch { /* no estaba */ }
  console.warn(`  [AVISO] No pude bajar el modelo de manos: ${err.message}. Los gestos quedan apagados; probá de nuevo con: npm run modelo`);
  process.exitCode = 0;
});
