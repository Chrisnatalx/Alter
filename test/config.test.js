const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

// La config es inmutable y se lee al cargar: se prueba en un proceso aparte con cada valor.
function tzWith(value) {
  const env = { ...process.env, JARVIS_TIMEZONE: value };
  const r = spawnSync(process.execPath, ['-e', 'console.log(require("./src/config").timezone)'], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
  return { out: r.stdout.trim(), err: r.stderr };
}

test('JARVIS_TIMEZONE inválida avisa y usa la zona del sistema', () => {
  const { out, err } = tzWith('Marte/Olimpo');
  assert.equal(out, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.match(err, /JARVIS_TIMEZONE/);
});

test('JARVIS_TIMEZONE válida se respeta sin avisos', () => {
  const { out, err } = tzWith('America/Argentina/Buenos_Aires');
  assert.equal(out, 'America/Argentina/Buenos_Aires');
  assert.equal(err, '');
});
