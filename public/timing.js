// Tiempos de voz de cada turno, medidos en la página con performance.now(): fin del habla, frase
// cerrada, mensaje enviado, primera frase en cola para la voz y comienzo de la voz. Se juntan con
// el evento `timing` del servidor y se mandan a POST /api/timing. Funciona en el navegador
// (window.JarvisTiming) y en Node (module.exports), para poder probarlo con node:test.

(function (root) {
  // Marcas de un turno; null = esa etapa no ocurrió (p. ej. un mensaje escrito no tiene fin del habla)
  function emptyMarks() {
    return { speechEnd: null, final: null, post: null, firstQueued: null, speechStart: null, listenMode: 'clasica' };
  }

  const diff = (from, to) => (from == null || to == null ? null : Math.round(to - from));

  function buildVoiceReport(marks, server) {
    const m = { ...emptyMarks(), ...marks };
    if (!m.listenMode) m.listenMode = 'clasica';
    return {
      turn: server?.turn ?? null,
      ...m,
      endToFinalMs: diff(m.speechEnd, m.final),
      finalToPostMs: diff(m.final, m.post),
      postToSpeechStartMs: diff(m.post, m.speechStart),
      speechEndToSpeechStartMs: diff(m.speechEnd, m.speechStart),
      server: server || null,
    };
  }

  // Una línea para el title de VOZ: habla→final 640 ms · init 900 · texto 1800 · voz 2300 · Agent(agenda) 200–3100
  function formatBreakdown(report) {
    const parts = [];
    const add = (label, v) => { if (v != null) parts.push(`${label} ${Math.round(v)}`); };
    add('habla→final', report.endToFinalMs);
    add('init', report.server?.initMs);
    add('texto', report.server?.firstTextMs);
    add('voz', report.postToSpeechStartMs);
    if (parts.length) parts[0] += ' ms';
    for (const t of report.server?.tools || []) {
      const name = t.agent ? `${t.name}(${t.agent})` : t.name;
      parts.push(`${name} ${t.startMs ?? '…'}–${t.endMs ?? '…'}`);
    }
    return parts.join(' · ');
  }

  // Listo para reportar: llegaron los tiempos del servidor y, o ya sonó la voz, o el turno terminó sin
  // nada en cola para decir (voz silenciada o sin speechSynthesis): ahí no se espera un onstart que no llega.
  function isReportReady(turn) {
    if (!turn?.server) return false;
    const m = turn.marks || {};
    return m.speechStart != null || (m.firstQueued == null && !!turn.ended);
  }

  const api = { emptyMarks, buildVoiceReport, formatBreakdown, isReportReady };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JarvisTiming = api;
})(typeof window !== 'undefined' ? window : globalThis);
