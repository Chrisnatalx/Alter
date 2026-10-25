#!/usr/bin/env node
// Guion de medición de JARVIS por HTTP: levanta el servidor con la configuración del entorno, manda
// los cuatro pedidos fijos varias veces en una sola sesión y guarda los tiempos por etapa.
// Seguridad: toda confirmación se rechaza (allow:false) y, si el servidor llega a permitir un envío,
// el guion corta y sale con código 2. Consume cupo de tu cuenta y puede abrir pestañas.
//
//   MEDIR_CONFIG=base JARVIS_MODEL=<id> [JARVIS_MCP_FILTER=1] [JARVIS_PROMPT_DIRECT=1] node scripts/medir.js
//   node scripts/medir.js --comparar logs/medicion-a.json logs/medicion-b.json …
//   node scripts/medir.js --voz logs/tiempos.jsonl

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { REQUESTS, hasFirstSentence, createSseParser, checkEnv, summarizeRuns, compareResults, summarizeVoice } = require('./medir-lib');

const ROOT = path.join(__dirname, '..');
const LOGS = path.join(ROOT, 'logs');
const REQUEST_TIMEOUT_MS = 150000;
const TASKS_WAIT_MS = 180000;
const SETTLE_MS = 2000;
// El mismo criterio que guard() en scripts/e2e.sh
const GUARD_RE = /CONFIRMADO|AUTOM.TICO\].*(send|reply|forward)/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

// Muestra el resumen de una corrida: medianas por pedido y el arranque en frío aparte
function printSummary(summary) {
  const row = (label, s) => console.log(`  ${label.padEnd(8)} n=${s.n}  primera frase ${s.firstSentenceMs ?? '—'}  primer texto ${s.firstTextMs ?? '—'}  init ${s.initMs ?? '—'}  fin ${s.doneMs ?? '—'}`);
  for (const [id, s] of Object.entries(summary.byRequest)) row(id, s);
  row('global', summary.all);
  row('frío', summary.cold);
}

async function run() {
  const env = process.env;
  const problem = checkEnv(env);
  if (problem) { console.error(problem); process.exit(1); }
  const port = Number(env.MEDIR_PORT || 7789);
  const runs = Number(env.MEDIR_RUNS || 3);
  const base = `http://127.0.0.1:${port}`;
  console.log(`AVISO: este guion consume cupo de tu suscripción de Claude (${runs * REQUESTS.length} turnos) y puede abrir pestañas del navegador.`);
  console.log(`Todas las confirmaciones se rechazan. Configuración: ${env.MEDIR_CONFIG} · modelo ${env.JARVIS_MODEL} · puerto ${port}`);

  fs.mkdirSync(LOGS, { recursive: true });
  const label = `${env.MEDIR_CONFIG}-${stamp()}`;
  const serverLog = fs.createWriteStream(path.join(LOGS, `medir-servidor-${label}.log`));
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...env, JARVIS_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const kill = () => { try { server.kill(); } catch { /* ya terminó */ } };
  process.on('exit', kill);
  process.on('SIGINT', () => process.exit(130));

  let blocked = null;
  const onServerOutput = (chunk) => {
    const s = chunk.toString();
    serverLog.write(s);
    for (const line of s.split('\n')) if (GUARD_RE.test(line)) blocked = line.trim();
  };
  server.stdout.on('data', onServerOutput);
  server.stderr.on('data', onServerOutput);

  // Espera a que el servidor responda y saca el token de la página, como e2e.sh
  let token = '';
  for (let i = 0; i < 100 && !token; i++) {
    try { token = ((await (await fetch(base + '/')).text()).match(/name="jarvis-token" content="([^"]*)"/) || [])[1] || ''; } catch { /* todavía no escucha */ }
    if (!token) await sleep(200);
  }
  if (!token) throw new Error('No arrancó el servidor (ver logs/medir-servidor-*.log)');
  const headers = { 'x-jarvis-token': token, 'Content-Type': 'application/json' };
  const post = (route, body) => fetch(base + '/api/' + route, { method: 'POST', headers, body: JSON.stringify(body) });

  // Estado que alimenta el canal de eventos
  const st = { origin: 'user', activeTurn: false, tasks: [], model: null, current: null };
  const onEvent = (event, data) => {
    const cur = st.current;
    switch (event) {
      case 'turn': st.origin = data.origin; st.activeTurn = true; break;
      case 'init': if (data.model) st.model = data.model; break;
      case 'tasks': st.tasks = data.tasks || []; break;
      case 'confirm':
        if (cur) cur.denied = true;
        post('confirm', { id: data.id, allow: false }).then((r) => console.log(`  [DENEGADO] confirmación ${data.id} (HTTP ${r.status})`)).catch(() => {});
        break;
      case 'delta':
        if (st.origin === 'task' || !cur || cur.finished) break;
        if (cur.httpFirstTextMs == null) cur.httpFirstTextMs = Date.now() - cur.t0;
        cur.text += data.text;
        if (cur.firstSentenceMs == null && hasFirstSentence(cur.text)) cur.firstSentenceMs = Date.now() - cur.t0;
        break;
      case 'timing':
        if (cur && !cur.finished) { const { initMs, firstTextMs, doneMs, tools, interrupted } = data; cur.server = { initMs, firstTextMs, doneMs, tools }; cur.interrupted = !!interrupted; }
        break;
      case 'done':
      case 'error': {
        const wasTask = st.origin === 'task';
        st.activeTurn = false; st.origin = 'user';
        if (wasTask || !cur || cur.finished) break;
        if (event === 'error') { cur.interrupted = true; cur.error = data.message; }
        if (data.interrupted) cur.interrupted = true;
        cur.finished = true; cur.resolve();
        break;
      }
      default: break;
    }
  };

  const ac = new AbortController();
  const events = await fetch(base + '/api/events', { headers, signal: ac.signal });
  if (!events.ok) throw new Error('El canal de eventos respondió ' + events.status);
  const feed = createSseParser(onEvent);
  (async () => {
    const dec = new TextDecoder();
    try { for await (const chunk of events.body) feed(dec.decode(chunk, { stream: true })); } catch { /* se cierra al salir */ }
  })();

  const records = [];
  let first = true;
  for (let run = 1; run <= runs; run++) {
    for (const req of REQUESTS) {
      if (blocked) break;
      const cur = { request: req.id, run, cold: first, interrupted: false, timeout: false, denied: false, firstSentenceMs: null, httpFirstTextMs: null, server: null, text: '', t0: 0, finished: false };
      first = false;
      const finished = new Promise((r) => { cur.resolve = r; });
      st.current = cur;
      process.stdout.write(`  [${run}/${runs}] ${req.id} … `);
      cur.t0 = Date.now();
      const res = await post('message', { text: req.text });
      if (res.status !== 202) throw new Error(`POST /api/message respondió ${res.status}`);
      let timeoutHandle;
      const timer = new Promise((r) => { timeoutHandle = setTimeout(() => r('timeout'), REQUEST_TIMEOUT_MS); });
      const guard = (async () => { while (!blocked && !cur.finished) await sleep(200); return blocked ? 'blocked' : 'ok'; })();
      const outcome = await Promise.race([finished.then(() => 'ok'), timer, guard]);
      clearTimeout(timeoutHandle);
      if (outcome === 'timeout') { cur.timeout = true; cur.finished = true; await post('interrupt', {}).catch(() => {}); }
      const { t0, resolve, finished: done, ...record } = cur; // eslint-disable-line no-unused-vars
      records.push(record);
      console.log(cur.timeout ? 'TIMEOUT' : `primera frase ${cur.firstSentenceMs ?? '—'} ms · fin ${cur.server?.doneMs ?? '—'} ms${cur.denied ? ' · confirmación denegada' : ''}${cur.interrupted ? ' · interrumpido' : ''}`);
      if (blocked) break;
      // Antes del pedido siguiente: que terminen las tareas en segundo plano y el turno que las cuenta
      const until = Date.now() + TASKS_WAIT_MS;
      while (!blocked && (st.tasks.length || st.activeTurn) && Date.now() < until) await sleep(500);
      await sleep(SETTLE_MS);
    }
    if (blocked) break;
  }
  st.current = null;
  ac.abort();

  if (blocked) {
    console.error(`BLOQUEADO: el servidor permitió un envío: ${blocked}`);
    kill();
    process.exit(2);
  }

  const summary = summarizeRuns(records);
  const out = {
    config: env.MEDIR_CONFIG,
    env: { JARVIS_MODEL: env.JARVIS_MODEL, JARVIS_MCP_FILTER: env.JARVIS_MCP_FILTER, JARVIS_PROMPT_DIRECT: env.JARVIS_PROMPT_DIRECT },
    model: st.model,
    records,
    summary,
  };
  const file = path.join(LOGS, `medicion-${label}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nModelo informado por init: ${st.model}`);
  printSummary(summary);
  console.log(`\nResultados en ${path.relative(ROOT, file)} (tienen texto real de tus mails: no se suben).`);
  serverLog.end();
  process.exit(0); // el exit mata el servidor
}

async function main() {
  const [mode, ...files] = process.argv.slice(2);
  if (mode === '--comparar') {
    if (files.length < 2) { console.error('Uso: node scripts/medir.js --comparar base.json variante.json …'); process.exit(1); }
    console.log(compareResults(files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))));
    return;
  }
  if (mode === '--voz') {
    console.log(summarizeVoice(readJsonl(files[0] || path.join(LOGS, 'tiempos.jsonl'))));
    return;
  }
  await run();
}

main().catch((err) => { console.error('ERROR:', err.message || err); process.exit(1); });
