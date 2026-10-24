// Cuenta los mensajes de la persona que ya salieron por POST pero cuyo turno todavía no empezó
// en el canal de eventos, y cuáles se cancelaron antes de empezar (ESC, una pregunta nueva).
// Sin esto, la respuesta de un mensaje cancelado se hablaría igual cuando su turno llegue.
// Sirve en el navegador (global `createAskTracker`) y en Node (tests).

(function (root) {
  function createAskTracker() {
    let pending = 0; // enviados, turno sin empezar
    let drop = 0;    // de esos, cuántos hay que descartar (siempre <= pending)
    return {
      sent() { pending++; },
      // El POST falló: el mensaje nunca quedó encolado
      failed() { pending = Math.max(0, pending - 1); drop = Math.min(drop, pending); },
      // Cancela todo lo que aún no empezó
      cancel() { drop = pending; },
      // Empieza un turno de la persona. 'drop': era de un mensaje cancelado; 'ask': el esperado;
      // 'orphan': nadie lo esperaba. El SDK puede juntar dos mensajes en un turno: por eso nunca baja de 0.
      started() {
        if (pending === 0) return 'orphan';
        pending--;
        if (drop > 0) { drop--; return 'drop'; }
        return 'ask';
      },
      reset() { pending = 0; drop = 0; },
      counts() { return { pending, drop }; },
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createAskTracker };
  else root.createAskTracker = createAskTracker;
})(typeof window !== 'undefined' ? window : globalThis);
