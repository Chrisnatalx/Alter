// Funciones puras del guion de medición (scripts/medir.js): pedidos fijos, parser del canal de
// eventos, medianas, resumen por pedido y tabla de comparación entre configuraciones.

// Los cuatro pedidos típicos del spec: saludo, agenda, correo y una búsqueda web
const REQUESTS = [
  { id: 'saludo', text: 'Hola ALTER, ¿cómo andás?' },
  { id: 'agenda', text: '¿Qué tengo hoy en el calendario?' },
  { id: 'correo', text: 'Leé mi último mail.' },
  { id: 'web', text: 'Buscá en la web el pronóstico del tiempo para mañana en Buenos Aires.' },
];

// Prueba de delegación (MEDIR_DELEGACION=1): una investigación larga que debería ir al investigador en segundo plano
const DELEGATION_REQUEST = { id: 'delegacion', text: 'Investigá a fondo las novedades de Node 24 y avisame.' };

// La misma regex que flushSentences en public/app.js (una prueba lo verifica): así «primera frase»
// es lo mismo que la interfaz le entrega a la voz.
const SENTENCE_RE = /[^.!?…\n]*[.!?…\n]+["')\]]*\s*/g;

// Hay una frase que la interfaz ya leería en voz alta (igual que flushSentences: más de un carácter)
function hasFirstSentence(text) {
  const re = new RegExp(SENTENCE_RE.source, 'g'); // copia: la global guarda lastIndex entre llamadas
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].trim().length > 1) return true;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return false;
}

// Orden de los pedidos: cada corrida en una sesión nueva, para que ninguna repetición se conteste con lo
// que ya está en la conversación. Así el primer pedido de cada corrida incluye crear la sesión (frío).
function planRuns(runs, requests) {
  const plan = [];
  for (let run = 1; run <= runs; run++) {
    requests.forEach((request, i) => plan.push({ run, request, cold: i === 0, newSession: i === 0 && run > 1 }));
  }
  return plan;
}

function median(values) {
  const v = values.filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Parser incremental de SSE: junta trozos partidos, ignora comentarios (`: ping`) y datos que no son JSON
function createSseParser(onEvent) {
  let buf = '';
  return (chunk) => {
    buf += chunk.replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) continue;
      try { onEvent(event, JSON.parse(data.join('\n'))); } catch { /* dato roto: se ignora */ }
    }
  };
}

// El modelo se fija siempre a mano: una mejora no puede venir de un cambio de modelo escondido
function checkEnv(env) {
  if (!env.MEDIR_CONFIG) return 'Falta MEDIR_CONFIG (una etiqueta para esta configuración, p. ej. base).';
  if (!/^[\w-]+$/.test(env.MEDIR_CONFIG)) return 'MEDIR_CONFIG solo puede tener letras, números, - y _ (va en el nombre del archivo).';
  if (!env.ALTER_MODEL) return 'Falta ALTER_MODEL: en cada comparación el modelo se fija de forma explícita.';
  return null;
}

// En el flujo del servidor, ¿el primer texto llegó antes que la primera herramienta? null si no hubo herramientas
function textBeforeTool(record) {
  const tools = record.server?.tools || [];
  if (!tools.length || record.server.firstTextMs == null) return null;
  return record.server.firstTextMs < Math.min(...tools.map((t) => t.startMs));
}

function stats(records) {
  return {
    n: records.length,
    firstSentenceMs: median(records.map((r) => r.firstSentenceMs)),
    firstTextMs: median(records.map((r) => r.server?.firstTextMs)),
    initMs: median(records.map((r) => r.server?.initMs)),
    doneMs: median(records.map((r) => r.server?.doneMs)),
  };
}

// Medianas por pedido y globales, sin interrumpidos ni timeouts; el arranque en frío va aparte
function summarizeRuns(records) {
  const valid = records.filter((r) => !r.interrupted && !r.timeout);
  const warm = valid.filter((r) => !r.cold);
  const byRequest = {};
  for (const id of [...new Set(warm.map((r) => r.request))]) byRequest[id] = stats(warm.filter((r) => r.request === id));
  return { byRequest, all: stats(warm), cold: stats(valid.filter((r) => r.cold)) };
}

const IMPROVEMENT_MS = 300;
const fmt = (v) => (v == null ? '—' : String(Math.round(v)));

// Tabla de texto: mediana de primera frase por pedido y global; el primer resultado es la base
function compareResults(results) {
  const ids = REQUESTS.map((r) => r.id);
  const base = results[0];
  const width = Math.max(8, ...results.map((r) => r.config.length));
  const col = (s) => String(s).padStart(14);
  const lines = [['config'.padEnd(width), ...ids.map(col), col('frío'), col('global'), '  Δ global'].join('')];
  const cell = (r, pick) => {
    const v = pick(r.summary);
    const b = pick(base.summary);
    return col(r === base || v == null || b == null ? fmt(v) : `${fmt(v)} (${fmt(v - b)})`);
  };
  for (const r of results) {
    const cells = ids.map((id) => cell(r, (s) => s.byRequest[id]?.firstSentenceMs));
    cells.push(cell(r, (s) => s.cold?.firstSentenceMs));
    const g = r.summary.all.firstSentenceMs;
    const bg = base.summary.all.firstSentenceMs;
    let delta = '';
    if (r !== base && g != null && bg != null) {
      delta = `  ${fmt(g - bg)} ms`;
      if (bg - g >= IMPROVEMENT_MS) delta += '  ✔ ≥300 ms';
    }
    lines.push([r.config.padEnd(width), ...cells, col(fmt(g)), delta].join(''));
  }
  lines.push('(mediana del tiempo hasta la primera frase, en ms; «global» sin el arranque en frío, que va en su columna; entre paréntesis, contra la base)');
  return lines.join('\n');
}

// Registros `voz` de logs/tiempos.jsonl agrupados por modo de escucha
function summarizeVoice(records) {
  const voz = records.filter((r) => r.tipo === 'voz');
  if (!voz.length) return 'No hay registros de voz.';
  const groups = new Map();
  for (const r of voz) {
    const mode = r.listenMode || 'clasica';
    if (!groups.has(mode)) groups.set(mode, []);
    groups.get(mode).push(r);
  }
  const lines = [];
  for (const [mode, rs] of groups) {
    const m = (k) => fmt(median(rs.map((r) => r[k])));
    lines.push(`${mode}: n=${rs.length} · habla→final ${m('endToFinalMs')} · envío→voz ${m('postToSpeechStartMs')} · habla→voz ${m('speechEndToSpeechStartMs')} (medianas, ms)`);
  }
  return lines.join('\n');
}

module.exports = { REQUESTS, DELEGATION_REQUEST, SENTENCE_RE, hasFirstSentence, planRuns, textBeforeTool, median, createSseParser, checkEnv, summarizeRuns, compareResults, summarizeVoice };
