const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, unmirror, isPinchPose, pinchRatio, palmCenter, createGestureTracker } = require('../public/gestures');

// Mano sintética de 21 puntos, en coordenadas de la persona, con el centro de la palma en (x, y).
// El tamaño de la mano (muñeca 0 → base del mayor 9) es 0.2. Con pose 'pinch', mayor, anular y meñique
// quedan recogidos y la distancia pulgar–índice es ratio × 0.2.
function handAt(x, y, { pose = 'open', ratio = 0.8 } = {}) {
  const p = (dx, dy) => ({ x: x + dx, y: y + dy, z: 0 });
  const curled = pose === 'pinch';
  const lm = new Array(21);
  lm[0] = p(0, 0.1);                       // muñeca
  lm[5] = p(-0.05, -0.05); lm[9] = p(0, -0.1); lm[13] = p(0.05, -0.05); lm[17] = p(0, 0.1); // promedio con 0: (x, y)
  // Índice: siempre extendido
  lm[6] = p(-0.05, -0.15); lm[7] = p(-0.05, -0.2); lm[8] = p(-0.05, -0.25);
  // Pulgar: su punta a ratio × 0.2 a la derecha de la punta del índice
  lm[1] = p(0.03, 0.05); lm[2] = p(0.05, 0); lm[3] = p(0.06, -0.1);
  lm[4] = { x: lm[8].x + ratio * 0.2, y: lm[8].y, z: 0 };
  // Mayor, anular y meñique: PIP a 0.25 de la muñeca; la punta, más cerca (recogido) o más lejos (extendido)
  for (const [pip, tip, dx] of [[10, 12, 0], [14, 16, 0.05], [18, 20, 0.08]]) {
    lm[pip] = p(dx, -0.15);
    lm[pip + 1] = p(dx, curled ? -0.05 : -0.22);
    lm[tip] = p(dx, curled ? 0 : -0.3);
  }
  lm[11] = lm[11] || p(0, -0.2);
  return lm;
}

// Cuadros cada 33 ms. `frames` es una lista de [t, hand|null]; devuelve todos los eventos con su t.
function feed(tracker, frames) {
  const out = [];
  for (const [t, hand] of frames) for (const ev of tracker.update({ t, hand })) out.push({ ...ev, t });
  return out;
}
// Mano quieta en (x, y) entre t0 y t1
function hold(t0, t1, x, y, opts) {
  const f = [];
  for (let t = t0; t <= t1; t += 33) f.push([t, handAt(x, y, opts)]);
  return f;
}
// Movimiento lineal de (x0, y0) a (x1, y1) entre t0 y t0 + ms
function move(t0, ms, [x0, y0], [x1, y1], opts) {
  const f = [];
  for (let t = t0; t <= t0 + ms; t += 33) { const k = Math.min(1, (t - t0) / ms); f.push([t, handAt(x0 + (x1 - x0) * k, y0 + (y1 - y0) * k, opts)]); }
  f.push([t0 + ms, handAt(x1, y1, opts)]);
  return f;
}
const swipes = (evs) => evs.filter((e) => e.type === 'swipe');

test('la mano sintética respeta las reglas de pose', () => {
  assert.equal(isPinchPose(handAt(0.5, 0.5, { pose: 'pinch' })), true);
  assert.equal(isPinchPose(handAt(0.5, 0.5, { pose: 'open' })), false);
  assert.ok(Math.abs(pinchRatio(handAt(0.5, 0.5, { pose: 'pinch', ratio: 0.3 })) - 0.3) < 1e-9);
  const c = palmCenter(handAt(0.4, 0.6));
  assert.ok(Math.abs(c.x - 0.4) < 1e-9 && Math.abs(c.y - 0.6) < 1e-9);
});

test('unmirror flips x only', () => {
  assert.deepEqual(unmirror([{ x: 0.2, y: 0.3, z: -0.1 }]), [{ x: 0.8, y: 0.3, z: -0.1 }]);
});

test('entering hand does not swipe', () => {
  const tr = createGestureTracker();
  const evs = feed(tr, [...move(0, 150, [0.9, 0.5], [0.3, 0.5]), ...hold(183, 800, 0.3, 0.5)]);
  assert.deepEqual(swipes(evs), []);
  assert.deepEqual(evs.filter((e) => e.type === 'hand').map((e) => e.present), [true]);
});

test('fast right-to-left swipe goes left', () => {
  const tr = createGestureTracker();
  const evs = feed(tr, [...hold(0, 250, 0.8, 0.5), ...move(283, 250, [0.8, 0.5], [0.35, 0.5]), ...hold(566, 1000, 0.35, 0.5)]);
  assert.deepEqual(swipes(evs).map((e) => e.dir), ['left']);
});

test('left-to-right swipe goes right', () => {
  const tr = createGestureTracker();
  const evs = feed(tr, [...hold(0, 250, 0.3, 0.5), ...move(283, 250, [0.3, 0.5], [0.75, 0.5]), ...hold(566, 1000, 0.75, 0.5)]);
  assert.deepEqual(swipes(evs).map((e) => e.dir), ['right']);
});

test('fast upward swipe goes up, y downward goes down', () => {
  const up = feed(createGestureTracker(), [...hold(0, 250, 0.5, 0.8), ...move(283, 250, [0.5, 0.8], [0.5, 0.4]), ...hold(566, 1000, 0.5, 0.4)]);
  assert.deepEqual(swipes(up).map((e) => e.dir), ['up']);
  const down = feed(createGestureTracker(), [...hold(0, 250, 0.5, 0.3), ...move(283, 250, [0.5, 0.3], [0.5, 0.7]), ...hold(566, 1000, 0.5, 0.7)]);
  assert.deepEqual(swipes(down).map((e) => e.dir), ['down']);
});

test('slow wide wave does not swipe', () => {
  const evs = feed(createGestureTracker(), [...hold(0, 250, 0.8, 0.5), ...move(283, 700, [0.8, 0.5], [0.3, 0.5]), ...hold(1016, 1500, 0.3, 0.5)]);
  assert.deepEqual(swipes(evs), []);
});

test('short fast flick does not swipe', () => {
  const evs = feed(createGestureTracker(), [...hold(0, 250, 0.6, 0.5), ...move(283, 100, [0.6, 0.5], [0.4, 0.5]), ...hold(416, 1000, 0.4, 0.5)]);
  assert.deepEqual(swipes(evs), []);
});

test('diagonal does not swipe', () => {
  const evs = feed(createGestureTracker(), [...hold(0, 250, 0.7, 0.7), ...move(283, 250, [0.7, 0.7], [0.3, 0.35]), ...hold(566, 1000, 0.3, 0.35)]);
  assert.deepEqual(swipes(evs), []);
});

test('cooldown blocks a second swipe', () => {
  // Ida hacia la izquierda y vuelta hacia la derecha, con `gap` ms de mano quieta entre los dos
  const twoSwipes = (gap) => {
    const t1 = 283 + 250;
    const t2 = t1 + gap;
    return feed(createGestureTracker(), [
      ...hold(0, 250, 0.8, 0.5), ...move(283, 250, [0.8, 0.5], [0.35, 0.5]),
      ...hold(t1 + 33, t2 - 33, 0.35, 0.5), ...move(t2, 250, [0.35, 0.5], [0.8, 0.5]), ...hold(t2 + 283, t2 + 2000, 0.8, 0.5),
    ]);
  };
  assert.deepEqual(swipes(twoSwipes(400)).map((e) => e.dir), ['left']);
  assert.deepEqual(swipes(twoSwipes(900)).map((e) => e.dir), ['left', 'right']);
});

test('pinch zooms continuously', () => {
  const evs = feed(createGestureTracker(), [...hold(0, 100, 0.5, 0.5, { pose: 'pinch', ratio: 0.8 }), ...hold(133, 200, 0.5, 0.5, { pose: 'pinch', ratio: 1.2 })]);
  assert.equal(evs.filter((e) => e.type === 'pinch-start').length, 1);
  const zooms = evs.filter((e) => e.type === 'zoom');
  assert.ok(Math.abs(zooms.at(-1).zoom - 1.5) <= 0.05, String(zooms.at(-1).zoom));
  assert.ok(Math.abs(zooms[0].zoom - 1) <= 0.05);
});

test('zoom respeta los límites', () => {
  const evs = feed(createGestureTracker(), [[0, handAt(0.5, 0.5, { pose: 'pinch', ratio: 0.5 })], [33, handAt(0.5, 0.5, { pose: 'pinch', ratio: 3 })]]);
  assert.equal(evs.filter((e) => e.type === 'zoom').at(-1).zoom, DEFAULTS.zoomMax);
});

test('grab uses hysteresis', () => {
  const ratios = [0.8, 0.24, 0.30, 0.36, 0.24];
  const evs = feed(createGestureTracker(), ratios.map((ratio, i) => [i * 33, handAt(0.5, 0.5, { pose: 'pinch', ratio })]));
  const grabs = evs.filter((e) => ['grab', 'ungrab', 'release'].includes(e.type));
  assert.deepEqual(grabs.map((e) => e.type), ['grab', 'ungrab', 'grab']);
  assert.deepEqual(evs.filter((e) => e.t === 66).map((e) => e.type), ['drag']); // en 0.30 sigue agarrado: solo arrastra
});

test('drag reports offset from grab point', () => {
  const pinch = { pose: 'pinch', ratio: 0.2 };
  const evs = feed(createGestureTracker(), [[0, handAt(0.5, 0.5, { pose: 'pinch', ratio: 0.8 })], [33, handAt(0.5, 0.5, pinch)], ...move(66, 200, [0.5, 0.5], [0.6, 0.45], pinch)]);
  const last = evs.filter((e) => e.type === 'drag').at(-1);
  assert.ok(Math.abs(last.dx - 0.1) < 1e-6, String(last.dx));
  assert.ok(Math.abs(last.dy + 0.05) < 1e-6, String(last.dy));
});

test('release on pose exit or hand loss', () => {
  const pinch = { pose: 'pinch', ratio: 0.8 };
  const a = feed(createGestureTracker(), [[0, handAt(0.5, 0.5, pinch)], [33, handAt(0.5, 0.5, pinch)], [66, handAt(0.5, 0.5)]]);
  assert.deepEqual(a.filter((e) => e.type === 'release').map((e) => e.t), [66]);
  const b = feed(createGestureTracker(), [[0, handAt(0.5, 0.5, pinch)], [33, null], [66, null], [99, null], [133, null], [166, null]]);
  assert.equal(b.filter((e) => e.type === 'release').length, 1);
  assert.ok(b.find((e) => e.type === 'release').t > 33 + DEFAULTS.lostGraceMs - 33);
  // Un cuadro perdido suelto no suelta nada
  const c = feed(createGestureTracker(), [[0, handAt(0.5, 0.5, pinch)], [33, null], [66, handAt(0.5, 0.5, pinch)]]);
  assert.equal(c.filter((e) => e.type === 'release').length, 0);
});

test('no swipe during pinch', () => {
  const pinch = { pose: 'pinch', ratio: 0.8 };
  const evs = feed(createGestureTracker(), [...hold(0, 250, 0.8, 0.5, pinch), ...move(283, 200, [0.8, 0.5], [0.3, 0.5], pinch), ...hold(516, 900, 0.3, 0.5, pinch)]);
  assert.deepEqual(swipes(evs), []);
});

test('al soltar el pellizco el movimiento previo no cuenta como giro', () => {
  const pinch = { pose: 'pinch', ratio: 0.8 };
  const evs = feed(createGestureTracker(), [...hold(0, 250, 0.8, 0.5), ...move(283, 200, [0.8, 0.5], [0.4, 0.5], pinch), ...hold(516, 900, 0.4, 0.5)]);
  assert.deepEqual(swipes(evs), []);
});

test('perder la mano avisa una vez y reset limpia todo', () => {
  const tr = createGestureTracker();
  const evs = feed(tr, [...hold(0, 300, 0.5, 0.5), [333, null], [366, null], [400, null], [433, null], [466, null]]);
  assert.deepEqual(evs.filter((e) => e.type === 'hand').map((e) => e.present), [true, false]);
  tr.reset();
  assert.deepEqual(feed(tr, [[500, null]]), []);
});
