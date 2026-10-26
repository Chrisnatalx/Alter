const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

// La config es inmutable y se lee al cargar: se prueba en un proceso aparte con cada valor.
function tzWith(value) {
  const env = { ...process.env, ALTER_TIMEZONE: value };
  const r = spawnSync(process.execPath, ['-e', 'console.log(require("./src/config").timezone)'], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
  return { out: r.stdout.trim(), err: r.stderr };
}

test('ALTER_TIMEZONE inválida avisa y usa la zona del sistema', () => {
  const { out, err } = tzWith('Marte/Olimpo');
  assert.equal(out, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.match(err, /ALTER_TIMEZONE/);
});

function configWith(env, expr) {
  const r = spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(require("./src/config").${expr}))`], { cwd: path.join(__dirname, '..'), env: { ...process.env, ...env }, encoding: 'utf8' });
  return JSON.parse(r.stdout.trim());
}

test('el preámbulo está prendido salvo con ALTER_PROMPT_PREAMBLE=0', () => {
  assert.equal(configWith({ ALTER_PROMPT_PREAMBLE: '' }, 'promptPreamble'), true);
  assert.equal(configWith({ ALTER_PROMPT_PREAMBLE: '1' }, 'promptPreamble'), true);
  assert.equal(configWith({ ALTER_PROMPT_PREAMBLE: '0' }, 'promptPreamble'), false);
});

test('el filtro de MCP está prendido salvo con ALTER_MCP_FILTER=0', () => {
  assert.equal(configWith({ ALTER_MCP_FILTER: '' }, 'mcpFilter'), true);
  assert.equal(configWith({ ALTER_MCP_FILTER: '1' }, 'mcpFilter'), true);
  assert.equal(configWith({ ALTER_MCP_FILTER: '0' }, 'mcpFilter'), false);
  for (const off of ['false', 'no', 'off', 'OFF', ' No ']) assert.equal(configWith({ ALTER_MCP_FILTER: off }, 'mcpFilter'), false, off);
});

test('ALTER_TIMEZONE válida se respeta sin avisos', () => {
  const { out, err } = tzWith('America/Argentina/Buenos_Aires');
  assert.equal(out, 'America/Argentina/Buenos_Aires');
  assert.equal(err, '');
});
