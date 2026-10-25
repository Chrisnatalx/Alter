// J.A.R.V.I.S. — cámara y seguimiento de manos en el navegador (MediaPipe HandLandmarker).
// Todo corre acá: el video no se muestra ni sale de la máquina. MediaPipe, sus .wasm y el modelo se
// sirven desde /vendor/ (el propio servidor), y la CSP connect-src 'self' bloquea su telemetría.
// Entrega por cuadro los 21 puntos de la mano en coordenadas de la persona (JarvisGestures.unmirror), o null.

(() => {
  'use strict';

  const MODEL = '/vendor/models/hand_landmarker.task';
  const DETECT_MS = 66; // ~15 fps: alcanza para los gestos y deja aire al núcleo de partículas

  let running = false;
  let gen = 0;            // sube con cada start/stop: una carga vieja que termina tarde no arranca nada
  let stream = null, video = null, landmarker = null, timer = null;
  let cb = { onFrame() {}, onStatus() {} };
  const stats = { n: 0, ms: 0 };

  function cleanup() {
    clearTimeout(timer); timer = null;
    if (stream) for (const tr of stream.getTracks()) tr.stop(); // apaga la luz de la cámara
    stream = null;
    if (video) { video.srcObject = null; video = null; }
    if (landmarker) { try { landmarker.close(); } catch { /* ya cerrado */ } landmarker = null; }
  }

  function fail(my, status, detail) {
    if (my !== gen) return;
    running = false;
    cleanup();
    cb.onStatus(status, detail);
  }

  function loop() {
    if (!running || !landmarker || !video) return;
    timer = setTimeout(loop, DETECT_MS);
    const t = performance.now();
    // Pestaña oculta: sin detección; los null hacen que el rastreador suelte lo que tenía agarrado
    if (document.hidden || video.readyState < 2) { cb.onFrame(t, null); return; }
    let res;
    try { res = landmarker.detectForVideo(video, t); } catch (e) { console.warn('Detección de manos:', e); return; }
    stats.n++; stats.ms += performance.now() - t;
    const lm = res?.landmarks?.[0];
    cb.onFrame(t, lm ? window.JarvisGestures.unmirror(lm) : null);
  }

  async function start({ onFrame, onStatus }) {
    if (running) return;
    running = true;
    const my = ++gen;
    cb = { onFrame, onStatus };
    onStatus('loading');
    try {
      // Sin modelo no tiene sentido pedir la cámara
      const head = await fetch(MODEL, { method: 'HEAD' });
      if (!head.ok) { fail(my, head.status === 404 ? 'no-model' : 'error', 'modelo: ' + head.status); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
      } catch (e) {
        fail(my, e.name === 'NotAllowedError' || e.name === 'SecurityError' ? 'denied' : 'error', e.message || e.name);
        return;
      }
      if (my !== gen) { for (const tr of stream.getTracks()) tr.stop(); return; }
      video = document.createElement('video'); // no se agrega al DOM: nunca se ve
      video.muted = true; video.playsInline = true; video.srcObject = stream;
      await video.play();
      const { FilesetResolver, HandLandmarker } = await import('/vendor/mediapipe/vision_bundle.mjs');
      const fileset = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
      const opts = (delegate) => ({ baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: 'VIDEO', numHands: 1 });
      let lmk;
      try { lmk = await HandLandmarker.createFromOptions(fileset, opts('GPU')); } catch (e) {
        console.warn('HandLandmarker con GPU falló, pruebo con CPU:', e);
        lmk = await HandLandmarker.createFromOptions(fileset, opts('CPU'));
      }
      if (my !== gen) { lmk.close(); return; }
      landmarker = lmk;
      onStatus('on');
      loop();
    } catch (e) {
      console.error('Cámara y gestos:', e);
      fail(my, 'error', e.message || String(e));
    }
  }

  function stop() {
    gen++;
    running = false;
    cleanup();
  }

  // Tiempo medio de detectForVideo desde la última consulta (para ?debug)
  function takeStats() {
    const r = { frames: stats.n, avgMs: stats.n ? stats.ms / stats.n : 0 };
    stats.n = 0; stats.ms = 0;
    return r;
  }

  window.JarvisHands = { start, stop, takeStats };
})();
