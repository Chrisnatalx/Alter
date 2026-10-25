// Caché de «feeds» para las vistas (Calendar, Mail y Clima). Los datos se traen en segundo plano y
// quedan en memoria: girar el carrusel no espera a nadie ni gasta un turno de la conversación.

// Por tipo de feed: una sola carga a la vez; si falla, se conserva lo anterior y se anota el error.
// Después de una falla, los refrescos de rutina (al conectar, al volver a la pestaña, el intervalo) esperan
// `errorBackoffMs`; el que pide una escritura de JARVIS pasa igual.
function createFeedCache({ loaders, intervalMs, hasClient, emit, now = Date.now, timers = { setInterval, clearInterval }, errorBackoffMs = 2 * 60 * 1000 }) {
  const kinds = Object.keys(loaders);
  const state = Object.fromEntries(kinds.map((k) => [k, { data: null, updatedAt: null, error: null, lastErrorAt: null, refreshing: false }]));
  const inflight = {};
  const again = {}; // pedido por escritura mientras había una carga en curso: se repite al terminar
  let timer = null;

  const snapshot = () => Object.fromEntries(kinds.map((k) => [k, { ...state[k] }]));

  function publish(reason) {
    const snap = snapshot();
    try { emit('feeds', reason ? { ...snap, reason } : snap); } catch { /* sin cliente: da igual */ }
  }

  // Nunca rechaza. `reason: 'write'` avisa a la interfaz que JARVIS cambió algo (repinta Mail aunque esté abierta).
  function refresh(kind, { ifOlderMs, reason } = {}) {
    const st = state[kind];
    if (!st) return Promise.resolve();
    if (inflight[kind]) {
      // La carga en curso pudo empezar antes de la escritura: sus datos no alcanzan
      if (reason !== 'write') return inflight[kind];
      again[kind] ||= inflight[kind].then(() => { again[kind] = null; return refresh(kind, { reason }); });
      return again[kind];
    }
    if (ifOlderMs != null && st.updatedAt != null && now() - st.updatedAt < ifOlderMs) return Promise.resolve();
    if (reason !== 'write' && st.error && st.lastErrorAt != null && now() - st.lastErrorAt < errorBackoffMs) return Promise.resolve();
    st.refreshing = true;
    inflight[kind] = Promise.resolve()
      .then(() => loaders[kind]())
      .then((data) => { st.data = data; st.updatedAt = now(); st.error = null; },
        (err) => { st.error = err?.message || String(err); st.lastErrorAt = now(); console.warn(`  [FEEDS] ${kind}: ${st.error}`); })
      .then(() => { st.refreshing = false; inflight[kind] = null; publish(reason); });
    return inflight[kind];
  }

  const refreshAll = (opts) => Promise.all(kinds.map((k) => refresh(k, opts))).then(() => {});

  return {
    snapshot,
    refresh,
    refreshAll,
    // Solo con un navegador conectado: sin nadie mirando no tiene sentido gastar cupo
    start() {
      if (timer) return;
      timer = timers.setInterval(() => { if (hasClient()) refreshAll(); }, intervalMs);
      timer.unref?.();
    },
    stop() { if (timer) timers.clearInterval(timer); timer = null; },
  };
}

// Acciones de Gmail y Calendar que solo leen (como las nombra describeTool, con espacios).
const READ_ACTIONS = new Set([
  'list calendars', 'list events', 'get event', 'search events', 'suggest time',
  'search threads', 'get thread', 'get message', 'list labels', 'list drafts', 'get draft',
]);
const WATCHED_APPS = new Set(['Gmail', 'Google Calendar']);

// Mira los eventos de la sesión: si en un turno corrió de verdad una herramienta de Gmail o Calendar que no
// es de lectura (respondió, archivó, borró, creó un evento…), al terminar ese turno pide un refresco.
// «De verdad» = su `tool_result` llegó sin error: una confirmación rechazada o un turno cortado no cuentan.
// Sin navegador conectado no pide nada: nadie está mirando las vistas.
function createFeedWatcher(onDirty, { hasClient = () => true } = {}) {
  let dirty = false;
  return (event, data) => {
    if (event === 'tool_result') {
      if (data?.ok && WATCHED_APPS.has(data.app) && !READ_ACTIONS.has(data.action)) dirty = true;
    } else if (event === 'done' || event === 'error') {
      const fire = dirty && hasClient();
      dirty = false;
      if (fire) onDirty();
    }
  };
}

module.exports = { createFeedCache, createFeedWatcher, READ_ACTIONS };
