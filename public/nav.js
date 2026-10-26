// ALTER — navegación del carrusel de vistas y datos de la vista abierta. Puro, sin DOM.
// El anillo es Núcleo → Calendar → Mail (y de vuelta al Núcleo); el Clima queda arriba, fuera del anillo.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AlterNav = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const RING = ['core', 'calendar', 'mail'];

  // `left` (mano hacia la izquierda de la persona) avanza; `right` retrocede; `up` sube al Clima
  // recordando de qué cara vino, y `down` vuelve a ella. Lo demás no cambia nada.
  function navigate(nav, dir) {
    const i = RING.indexOf(nav.face);
    if (i >= 0) {
      if (dir === 'left') { const face = RING[(i + 1) % RING.length]; return { face, from: face }; }
      if (dir === 'right') { const face = RING[(i + RING.length - 1) % RING.length]; return { face, from: face }; }
      if (dir === 'up') return { face: 'weather', from: nav.face };
    }
    if (nav.face === 'weather' && dir === 'down') return { face: nav.from, from: nav.from };
    return nav;
  }

  function agoLabel(updatedAt, now) {
    if (updatedAt == null) return 'SIN DATOS';
    const min = Math.floor((now - updatedAt) / 60000);
    if (min < 1) return 'ACTUALIZADO RECIÉN';
    if (min < 60) return `ACTUALIZADO HACE ${min} MIN`;
    return `ACTUALIZADO HACE ${Math.floor(min / 60)} H`;
  }

  // Lo que viaja con el mensaje de la persona (POST /api/message, `view`). En Mail va la lista que
  // está en pantalla (congelada al entrar), no la de la caché: «el segundo» es el que ve.
  function viewPayload(face, { shownInbox, week } = {}) {
    switch (face) {
      case 'mail': return { face, threads: (shownInbox || []).map(({ id, from, subject, unread }) => ({ id, from, subject, unread })) };
      case 'calendar': return { face, week };
      case 'weather': return { face };
      default: return null;
    }
  }

  // La bandeja que se ve en Mail queda congelada mientras la cara está abierta: { inbox, feed } con el feed
  // de Google del momento (para su «actualizado hace…»).
  const freezeInbox = (google) => ({ inbox: google?.data?.inbox || [], feed: google || null });

  // Con datos nuevos: se reemplaza si los trajo una escritura de ALTER (un hilo borrado no puede seguir
  // siendo «el segundo») o si al congelar todavía no había datos (si no, Mail quedaría vacía hasta salir).
  function nextFrozen(frozen, google, reason) {
    if (reason === 'write' || (!frozen?.feed?.data && google?.data)) return freezeInbox(google);
    if (!frozen?.feed?.data) return { ...frozen, feed: google || frozen?.feed || null }; // sin datos aún: al menos el error
    return frozen;
  }

  return { RING, navigate, agoLabel, viewPayload, freezeInbox, nextFrozen };
});
