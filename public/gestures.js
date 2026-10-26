// J.A.R.V.I.S. — rastreador de gestos de la mano. Puro: recibe los 21 puntos de MediaPipe por cuadro y
// devuelve eventos (giros, pellizco, agarre). Sin DOM ni dependencias, así se prueba en Node.
// Coordenadas «de la persona»: x crece hacia su derecha (la webcam viene sin espejar, ver unmirror) e
// y hacia abajo, las dos en fracción del cuadro (0..1).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JarvisGestures = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  // Valores iniciales: se ajustan probando frente a la cámara
  const DEFAULTS = Object.freeze({
    swipeMinDx: 0.25,    // recorrido horizontal mínimo (medido: los giros reales recorren ~0.3 del cuadro)
    swipeMinDy: 0.30,    // recorrido vertical mínimo
    swipeWindowMs: 300,  // ventana de tiempo del gesto
    swipeMaxSlope: 0.5,  // desvío máximo en el otro eje, en proporción al recorrido
    cooldownMs: 800,     // enfriamiento después de un giro
    reverseMs: 1500,     // …y para el lado contrario: la mano que vuelve a donde arrancó (medido: ~1 s después) no deshace el giro
    stableMs: 200,       // tiempo de mano estable antes de contar movimiento
    exitMinDx: 0.08,     // giro que sale del cuadro: recorrido mínimo en la ventana antes de perder la mano
    edgeMargin: 0.12,    // …y la última posición tiene que estar así de cerca del borde por el que salió
    lostGraceMs: 350,    // tolerancia a cuadros sin mano: en un giro brusco la mano se desenfoca y se pierde 2–4 cuadros
    grabIn: 0.25,        // umbral para agarrar (entrada de la histéresis)
    grabOut: 0.35,       // umbral para soltar (salida de la histéresis)
    zoomMin: 0.6,
    zoomMax: 2.5,
  });

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  // La imagen de la webcam es la que ve la cámara, no un espejo: lo que para la persona es su derecha
  // está a la izquierda del cuadro. Se da vuelta x para trabajar con sus direcciones.
  const unmirror = (lm) => lm.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z }));

  // Pose de pellizco: mayor, anular y meñique recogidos (la punta más cerca de la muñeca que su PIP) y el
  // índice estirado. Así una mano abierta cualquiera no hace zoom.
  function isPinchPose(lm) {
    const w = lm[0];
    const curled = [[12, 10], [16, 14], [20, 18]].every(([tip, pip]) => dist(lm[tip], w) < dist(lm[pip], w));
    return curled && dist(lm[8], w) > dist(lm[5], w);
  }

  // Distancia pulgar–índice relativa al tamaño de la mano (muñeca → base del mayor): no depende de lo cerca que esté
  const pinchRatio = (lm) => dist(lm[4], lm[8]) / dist(lm[0], lm[9]);

  const palmCenter = (lm) => {
    const ids = [0, 5, 9, 13, 17];
    return { x: ids.reduce((s, i) => s + lm[i].x, 0) / ids.length, y: ids.reduce((s, i) => s + lm[i].y, 0) / ids.length };
  };

  function createGestureTracker(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    let presentSince = null; // desde cuándo se ve la mano sin cortes
    let lastSeen = null;
    let stable = false;      // presente sin cortes por stableMs: recién ahí su movimiento cuenta
    let history = [];        // [{ t, x, y }] del centro de la palma, dentro de la ventana
    let cooldownUntil = 0;
    let last = null;         // { dir, t } del último giro, para no tomar la vuelta de la mano como giro contrario
    let swipeReadyAt = 0;    // desde cuándo cuenta el movimiento para girar (al estabilizarse y después de un pellizco)
    let pinch = null;        // { ratio0, grabbed, grabPoint, zoom }

    function reset() {
      presentSince = null; lastSeen = null; stable = false; history = []; cooldownUntil = 0; last = null; swipeReadyAt = 0; pinch = null;
    }

    const OPPOSITE = { left: 'right', right: 'left', up: 'down', down: 'up' };
    const isReturn = (dir, t) => last !== null && OPPOSITE[dir] === last.dir && t < last.t + o.reverseMs;

    function emitSwipe(dir, t, events) {
      events.push({ type: 'swipe', dir });
      cooldownUntil = t + o.cooldownMs;
      last = { dir, t };
    }

    // La mano se perdió en medio de un movimiento rápido hacia un costado, justo en el borde: salió del
    // cuadro haciendo el gesto (lo normal si arranca cerca del borde). Cuenta como giro. Solo de costado:
    // bajar el brazo también saca la mano rápido por abajo, y eso no es un gesto.
    function exitSwipe(events) {
      if (!stable || pinch || history.length < 2) return;
      const first = history[0], end = history[history.length - 1];
      if (end.t < cooldownUntil || end.t < swipeReadyAt) return;
      const dx = end.x - first.x, dy = end.y - first.y;
      if (Math.abs(dx) < o.exitMinDx || Math.abs(dy) > o.swipeMaxSlope * Math.abs(dx)) return;
      if (dx < 0 ? end.x > o.edgeMargin : end.x < 1 - o.edgeMargin) return;
      const dir = dx < 0 ? 'left' : 'right';
      if (!isReturn(dir, end.t)) emitSwipe(dir, end.t, events);
    }

    function lose(events) {
      exitSwipe(events);
      if (pinch) { events.push({ type: 'release' }); pinch = null; }
      if (stable) events.push({ type: 'hand', present: false });
      presentSince = null; lastSeen = null; stable = false; history = [];
    }

    // Pellizco: el zoom sigue al ratio respecto del de entrada; con los dedos juntos agarra y arrastra.
    function updatePinch(lm, events) {
      const ratio = pinchRatio(lm);
      if (!pinch) {
        pinch = { ratio0: ratio, grabbed: false, grabPoint: null, zoom: 1 };
        events.push({ type: 'pinch-start' });
        history = [];
      }
      const point = mid(lm[4], lm[8]);
      if (!pinch.grabbed && ratio < o.grabIn) {
        pinch.grabbed = true;
        pinch.grabPoint = point;
        events.push({ type: 'grab' });
      } else if (pinch.grabbed && ratio > o.grabOut) {
        pinch.grabbed = false;
        pinch.ratio0 = ratio / pinch.zoom; // el zoom sigue desde donde quedó, sin saltar
        events.push({ type: 'ungrab' });
      }
      if (pinch.grabbed) events.push({ type: 'drag', dx: point.x - pinch.grabPoint.x, dy: point.y - pinch.grabPoint.y });
      else {
        pinch.zoom = clamp(ratio / pinch.ratio0, o.zoomMin, o.zoomMax);
        events.push({ type: 'zoom', zoom: pinch.zoom });
      }
    }

    // Giro: recorrido largo, en poco tiempo y casi sin desvío en el otro eje. Compara con la muestra
    // más vieja de la ventana: un vaivén lento o un movimiento corto no llegan.
    function updateSwipe(t, lm, events) {
      const c = palmCenter(lm);
      // Lo que se mueve en el enfriamiento, o antes de que la mano se estabilice, no cuenta
      if (t < cooldownUntil || t < swipeReadyAt) { history = [{ t, ...c }]; return; }
      history.push({ t, ...c });
      while (history.length && history[0].t < t - o.swipeWindowMs) history.shift();
      const dx = c.x - history[0].x;
      const dy = c.y - history[0].y;
      let dir = null;
      if (Math.abs(dx) >= o.swipeMinDx && Math.abs(dy) <= o.swipeMaxSlope * Math.abs(dx)) dir = dx < 0 ? 'left' : 'right';
      else if (Math.abs(dy) >= o.swipeMinDy && Math.abs(dx) <= o.swipeMaxSlope * Math.abs(dy)) dir = dy < 0 ? 'up' : 'down';
      if (!dir || isReturn(dir, t)) return;
      emitSwipe(dir, t, events);
      history = [];
    }

    function update({ t, hand }) {
      const events = [];
      if (!hand) {
        if (lastSeen !== null && t - lastSeen > o.lostGraceMs) lose(events);
        return events;
      }
      if (presentSince === null) presentSince = t;
      lastSeen = t;
      if (!stable && t - presentSince >= o.stableMs) {
        stable = true;
        history = []; // el movimiento de la mano que entra al cuadro no es un gesto
        events.push({ type: 'hand', present: true });
      }
      // Pellizco: recién con la mano estable (una mano que entra no toca el núcleo); mientras dura, no hay giros
      if (isPinchPose(hand)) { if (stable) updatePinch(hand, events); return events; }
      if (pinch) {
        events.push({ type: 'release' });
        pinch = null; history = [];
        swipeReadyAt = t + o.stableMs; // la mano que suelta suele moverse: se espera a que se asiente
      }
      if (stable) updateSwipe(t, hand, events);
      return events;
    }

    return { update, reset };
  }

  return { DEFAULTS, unmirror, isPinchPose, pinchRatio, palmCenter, createGestureTracker };
});
