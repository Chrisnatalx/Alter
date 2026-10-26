// Tiempos por etapa de cada turno de la persona: cuándo llegó el mensaje, el init del SDK, el
// primer texto del orquestador, cada herramienta y el fin. Sirve para saber dónde se va el tiempo
// entre que la persona termina de hablar y que ALTER empieza a contestar.

const fs = require('fs');
const path = require('path');

// Objeto mutable que se va completando con cada mensaje del SDK. Los tiempos son absolutos (ms).
function startTurnTiming(receivedAt) {
  return { receivedAt, initAt: null, firstTextAt: null, doneAt: null, interrupted: false, tools: new Map() };
}

// Bloques de contenido de un mensaje assistant/user (el SDK puede mandar un string suelto)
const blocksOf = (msg) => (Array.isArray(msg.message?.content) ? msg.message.content : []);

function trackMessage(timing, msg, at) {
  if (!timing || !msg) return;
  if (msg.parent_tool_use_id != null) return; // lo de un subagente se mide como parte de su herramienta
  if (msg.type === 'system' && msg.subtype === 'init') {
    if (timing.initAt == null) timing.initAt = at;
    return;
  }
  if (msg.type === 'stream_event') {
    const ev = msg.event;
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      if (timing.firstTextAt == null) timing.firstTextAt = at;
    } else if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use' && ev.content_block.id) {
      const b = ev.content_block;
      if (!timing.tools.has(b.id)) timing.tools.set(b.id, { name: b.name, agent: null, startAt: at, endAt: null });
    }
    return;
  }
  if (msg.type === 'assistant') {
    // El mensaje completo trae el input de la herramienta: de ahí sale el subagente de Agent
    for (const b of blocksOf(msg)) {
      if (b.type !== 'tool_use' || !b.id) continue;
      if (!timing.tools.has(b.id)) timing.tools.set(b.id, { name: b.name, agent: null, startAt: at, endAt: null });
      const tool = timing.tools.get(b.id);
      if (b.input?.subagent_type) tool.agent = b.input.subagent_type;
    }
    return;
  }
  if (msg.type === 'user') {
    for (const b of blocksOf(msg)) {
      if (b.type !== 'tool_result') continue;
      const tool = timing.tools.get(b.tool_use_id); // una herramienta que no vimos arrancar se ignora
      if (tool && tool.endAt == null) tool.endAt = at;
    }
    return;
  }
  if (msg.type === 'result') {
    if (timing.doneAt == null) timing.doneAt = at;
    // Cualquier turno que no terminó bien (ESC, hablar encima o un error) queda fuera de las medianas
    timing.interrupted = msg.subtype !== 'success' || !!msg.is_error;
  }
}

// Resumen en ms relativos a la llegada del mensaje; null si la etapa no ocurrió
function summarizeTiming(timing) {
  const rel = (at) => (at == null ? null : at - timing.receivedAt);
  const tools = [...timing.tools.values()]
    .map((t) => ({ name: t.name, agent: t.agent, startMs: rel(t.startAt), endMs: rel(t.endAt) }))
    .sort((a, b) => a.startMs - b.startMs);
  return {
    initMs: rel(timing.initAt),
    firstTextMs: rel(timing.firstTextAt),
    doneMs: rel(timing.doneAt),
    interrupted: timing.interrupted,
    tools,
  };
}

// Registro local en JSONL. Nunca lanza: si no puede escribir, avisa una vez y sigue.
function createTimingLog({ file, appendFile = fs.appendFile, mkdirSync = fs.mkdirSync } = {}) {
  let dirReady = false;
  let warned = false;
  const warnOnce = (err) => {
    if (warned) return;
    warned = true;
    console.warn(`  [AVISO] No pude escribir el registro de tiempos (${file}): ${err.message || err}`);
  };
  return {
    write(record) {
      if (!file) return; // apagado
      try {
        if (!dirReady) { mkdirSync(path.dirname(file), { recursive: true }); dirReady = true; }
        appendFile(file, JSON.stringify(record) + '\n', (err) => { if (err) warnOnce(err); });
      } catch (err) { warnOnce(err); }
    },
  };
}

// Lo que manda la interfaz por POST /api/timing: solo números conocidos y el modo de escucha.
const VOICE_NUMBER_KEYS = ['turn', 'speechEnd', 'final', 'post', 'firstQueued', 'speechStart',
  'endToFinalMs', 'finalToPostMs', 'postToSpeechStartMs', 'speechEndToSpeechStartMs'];

function sanitizeVoiceRecord(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const out = {};
  for (const k of VOICE_NUMBER_KEYS) {
    const v = payload[k];
    if (v === null || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
  }
  if (typeof payload.listenMode === 'string' && payload.listenMode.length <= 20) out.listenMode = payload.listenMode;
  return out;
}

module.exports = { startTurnTiming, trackMessage, summarizeTiming, createTimingLog, sanitizeVoiceRecord };
