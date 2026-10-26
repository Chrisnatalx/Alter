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
// Cuadros sin mano cada 33 ms desde t0 hasta pasar la tolerancia (lostGraceMs) contada desde lastSeen
const gone = (t0, lastSeen) => { const f = []; for (let t = t0; t <= lastSeen + DEFAULTS.lostGraceMs + 66; t += 33) f.push([t, null]); return f; };
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

// Caso real (registro de la persona, ~12 cuadros por segundo): la mano quieta cerca del borde izquierdo
// arranca el giro hacia ese lado y sale del cuadro antes de recorrer swipeMinDx. Igual es un giro.
test('a fast swipe that leaves the frame still counts', () => {
  const real = [[40664, 0.11], [40737, 0.13], [40813, 0.15], [40908, 0.17], [41010, 0.18], [41108, 0.18], [41178, 0.18],
    [41247, 0.18], [45160, 0.20], [45236, 0.20], [45326, 0.20], [45431, 0.19], [45507, 0.18], [45604, 0.13], [45674, 0.07]];
  const frames = real.map(([t, x]) => [t, handAt(x, 0.45)]);
  const evs = feed(createGestureTracker(), [...frames, ...gone(45755, 45674)]);
  assert.deepEqual(swipes(evs).map((e) => e.dir), ['left']);
  // Lo mismo por el borde derecho
  const mirrored = real.map(([t, x]) => [t, handAt(1 - x, 0.45)]);
  const evsR = feed(createGestureTracker(), [...mirrored, ...gone(45755, 45674)]);
  assert.deepEqual(swipes(evsR).map((e) => e.dir), ['right']);
});

// Caso real (video de la persona): en el giro brusco la mano se desenfoca y MediaPipe la pierde 2 o 3
// cuadros justo a mitad del recorrido. Recorre ~0.3 del cuadro en ~0.4 s.
test('a swipe with the hand lost mid-stroke still counts', () => {
  const real = [[0, 0.26], [67, 0.24], [133, 0.22], [200, 0.22], [267, 0.23], [333, 0.26], [400, null], [467, null],
    [533, 0.54], [600, 0.56], [667, 0.57], [733, 0.56], [800, 0.55], [867, 0.54]];
  const evs = feed(createGestureTracker(), real.map(([t, x]) => [t, x == null ? null : handAt(x, 0.5)]));
  assert.deepEqual(swipes(evs).map((e) => e.dir), ['right']);
  // Un hueco corto no avisa que se fue la mano
  assert.deepEqual(evs.filter((e) => e.type === 'hand').map((e) => e.present), [true]);
});

test('leaving the frame slowly, or downwards, is not a swipe', () => {
  // Se va despacio por el borde: 0.2 → 0.05 en 1,5 s
  const slow = feed(createGestureTracker(), [...hold(0, 250, 0.2, 0.5), ...move(283, 1500, [0.2, 0.5], [0.05, 0.5]), ...gone(1850, 1783)]);
  assert.deepEqual(swipes(slow), []);
  // Baja el brazo: sale rápido por abajo (no cuenta como giro hacia abajo)
  const drop = feed(createGestureTracker(), [...hold(0, 250, 0.5, 0.8), ...move(283, 150, [0.5, 0.8], [0.5, 0.95]), ...gone(500, 433)]);
  assert.deepEqual(swipes(drop), []);
  // Un movimiento rápido en el medio del cuadro que después pierde la mano (no salió por un borde)
  const mid = feed(createGestureTracker(), [...hold(0, 250, 0.6, 0.5), ...move(283, 100, [0.6, 0.5], [0.45, 0.5]), ...gone(450, 383)]);
  assert.deepEqual(swipes(mid), []);
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
  // La vuelta de la mano a donde arrancó no deshace el giro: el lado contrario espera reverseMs
  assert.deepEqual(swipes(twoSwipes(900)).map((e) => e.dir), ['left']);
  assert.deepEqual(swipes(twoSwipes(DEFAULTS.reverseMs + 100)).map((e) => e.dir), ['left', 'right']);
});

// Caso real (video de la persona, coordenadas de la persona): giro a la derecha que pierde la mano a mitad
// de camino, y ~1 s después la mano vuelve rápido a donde arrancó. Solo cuenta el giro.
test('the hand going back after a swipe does not undo it', () => {
  const real = [[8730, 0.22], [8800, 0.21], [8870, 0.22], [8930, 0.26], [9000, null], [9070, null], [9130, null],
    [9200, 0.60], [9270, 0.57], [9330, 0.57], [9400, 0.56], [9470, 0.56], [9530, 0.55], [9600, 0.54], [9670, 0.54],
    [9730, 0.53], [9800, 0.52], [9870, 0.51], [9930, 0.50], [10000, 0.47], [10070, 0.41], [10130, 0.34], [10200, 0.23],
    [10270, 0.22], [10330, 0.20], [10400, 0.19]];
  const evs = feed(createGestureTracker(), [...hold(8400, 8700, 0.22, 0.6), ...real.map(([t, x]) => [t, x == null ? null : handAt(x, 0.6)])]);
  assert.deepEqual(swipes(evs).map((e) => e.dir), ['right']);
});

test('a second swipe the same way only waits the cooldown', () => {
  const t1 = 283 + 250, t2 = t1 + 900;
  const evs = feed(createGestureTracker(), [
    ...hold(0, 250, 0.8, 0.5), ...move(283, 250, [0.8, 0.5], [0.35, 0.5]), ...hold(t1 + 33, t1 + 400, 0.35, 0.5),
    ...move(t1 + 433, 300, [0.35, 0.5], [0.8, 0.5]), ...hold(t1 + 766, t2 - 33, 0.8, 0.5), // vuelve en el enfriamiento
    ...move(t2, 250, [0.8, 0.5], [0.35, 0.5]), ...hold(t2 + 283, t2 + 1000, 0.35, 0.5),
  ]);
  assert.deepEqual(swipes(evs).map((e) => e.dir), ['left', 'left']);
});

// La mano en pose de pellizco (ratio 0.8) hasta quedar estable: el pellizco arranca en t = 231
const P = (ratio) => ({ pose: 'pinch', ratio });
const steady = () => hold(0, 231, 0.5, 0.5, P(0.8));
const T0 = 264; // primer cuadro después de estabilizar
const ratiosFrom = (t0, ratios) => ratios.map((r, i) => [t0 + i * 33, handAt(0.5, 0.5, P(r))]);

test('el pellizco espera a que la mano esté estable', () => {
  const evs = feed(createGestureTracker(), [...steady(), ...ratiosFrom(T0, [1.2])]);
  const pinchy = evs.filter((e) => ['pinch-start', 'zoom', 'grab', 'drag'].includes(e.type));
  assert.ok(pinchy.every((e) => e.t >= 200), JSON.stringify(pinchy.map((e) => e.t)));
  assert.deepEqual(evs.filter((e) => e.type === 'pinch-start').map((e) => e.t), [231]);
  // Una mano que entra ya pellizcando y se va enseguida no toca el núcleo
  const quick = feed(createGestureTracker(), [...hold(0, 132, 0.5, 0.5, P(0.3)), [165, null], [200, null], [233, null], [266, null]]);
  assert.deepEqual(quick.filter((e) => ['pinch-start', 'zoom', 'grab', 'release'].includes(e.type)), []);
});

test('pinch zooms continuously', () => {
  const evs = feed(createGestureTracker(), [...steady(), ...hold(T0, 330, 0.5, 0.5, P(1.2))]);
  assert.equal(evs.filter((e) => e.type === 'pinch-start').length, 1);
  const zooms = evs.filter((e) => e.type === 'zoom');
  assert.ok(Math.abs(zooms.at(-1).zoom - 1.5) <= 0.05, String(zooms.at(-1).zoom));
  assert.ok(Math.abs(zooms[0].zoom - 1) <= 0.05);
});

test('zoom respeta los límites', () => {
  const evs = feed(createGestureTracker(), [...hold(0, 231, 0.5, 0.5, P(0.5)), ...ratiosFrom(T0, [3])]);
  assert.equal(evs.filter((e) => e.type === 'zoom').at(-1).zoom, DEFAULTS.zoomMax);
});

test('grab uses hysteresis', () => {
  const evs = feed(createGestureTracker(), [...steady(), ...ratiosFrom(T0, [0.24, 0.30, 0.36, 0.24])]);
  const grabs = evs.filter((e) => ['grab', 'ungrab', 'release'].includes(e.type));
  assert.deepEqual(grabs.map((e) => e.type), ['grab', 'ungrab', 'grab']);
  assert.deepEqual(evs.filter((e) => e.t === T0 + 33).map((e) => e.type), ['drag']); // en 0.30 sigue agarrado: solo arrastra
});

test('después de soltar el agarre el zoom sigue desde donde estaba', () => {
  // 0.8 → 0.6 (zoom 0.75) → 0.24 agarra (zoom quieto) → 0.4 suelta: sigue en 0.75, no salta a 0.5 → 0.5 da 0.9375
  const evs = feed(createGestureTracker(), [...steady(), ...ratiosFrom(T0, [0.6, 0.24, 0.4, 0.5])]);
  const zoomAt = (t) => evs.find((e) => e.type === 'zoom' && e.t === t)?.zoom;
  assert.ok(Math.abs(zoomAt(T0) - 0.75) < 1e-9);
  assert.equal(zoomAt(T0 + 33), undefined); // agarrado: sin zoom
  assert.ok(Math.abs(zoomAt(T0 + 66) - 0.75) < 1e-9, String(zoomAt(T0 + 66)));
  assert.ok(Math.abs(zoomAt(T0 + 99) - 0.9375) < 1e-9, String(zoomAt(T0 + 99)));
});

test('drag reports offset from grab point', () => {
  const evs = feed(createGestureTracker(), [...steady(), [T0, handAt(0.5, 0.5, P(0.2))], ...move(T0 + 33, 200, [0.5, 0.5], [0.6, 0.45], P(0.2))]);
  const last = evs.filter((e) => e.type === 'drag').at(-1);
  assert.ok(Math.abs(last.dx - 0.1) < 1e-6, String(last.dx));
  assert.ok(Math.abs(last.dy + 0.05) < 1e-6, String(last.dy));
});

test('release on pose exit or hand loss', () => {
  const a = feed(createGestureTracker(), [...steady(), [T0, handAt(0.5, 0.5)]]);
  assert.deepEqual(a.filter((e) => e.type === 'release').map((e) => e.t), [T0]);
  const b = feed(createGestureTracker(), [...steady(), ...gone(T0, 231)]);
  assert.equal(b.filter((e) => e.type === 'release').length, 1);
  assert.ok(b.find((e) => e.type === 'release').t > 231 + DEFAULTS.lostGraceMs);
  // Un cuadro perdido suelto no suelta nada
  const c = feed(createGestureTracker(), [...steady(), [T0, null], [T0 + 33, handAt(0.5, 0.5, P(0.8))]]);
  assert.equal(c.filter((e) => e.type === 'release').length, 0);
});

test('después de soltar un pellizco los giros esperan a que la mano se estabilice', () => {
  const run = (gap) => {
    const tr = createGestureTracker();
    const rel = 300 + 99; // se suelta el pellizco en este cuadro
    return feed(tr, [
      ...hold(0, 300, 0.8, 0.5), ...hold(333, 366, 0.8, 0.5, P(0.8)), [rel, handAt(0.8, 0.5)],
      ...hold(rel + 33, rel + gap, 0.8, 0.5), ...move(rel + gap + 33, 200, [0.8, 0.5], [0.35, 0.5]), ...hold(rel + gap + 266, rel + gap + 900, 0.35, 0.5),
    ]);
  };
  assert.deepEqual(swipes(run(33)), []);                      // gira enseguida de soltar: no cuenta
  assert.deepEqual(swipes(run(300)).map((e) => e.dir), ['left']); // con la mano quieta un rato, sí
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
  const evs = feed(tr, [...hold(0, 300, 0.5, 0.5), ...gone(333, 297)]);
  assert.deepEqual(evs.filter((e) => e.type === 'hand').map((e) => e.present), [true, false]);
  tr.reset();
  assert.deepEqual(feed(tr, [[2000, null]]), []);
});
