// J.A.R.V.I.S. — lógica del cliente.
// Estados: boot → idle ⇄ listening → thinking → speaking → idle.
// Voz de entrada: Web Speech API (SpeechRecognition). Voz de salida: speechSynthesis.
// El texto de Claude llega en streaming por SSE desde /api/chat y se va leyendo por oraciones.

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem('jarvis.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('jarvis.' + k, JSON.stringify(v)); } catch { /* sin storage */ } },
  };

  const STATE_LABEL = { boot: 'INICIANDO', idle: 'EN ESPERA', listening: 'ESCUCHANDO', thinking: 'PROCESANDO', speaking: 'TRANSMITIENDO', confirming: 'AUTORIZACIÓN' };
  // Token que el servidor inyecta en la página; sin él la API rechaza los pedidos.
  const TOKEN = document.querySelector('meta[name="jarvis-token"]')?.content || '';

  const app = {
    state: 'boot',
    sessionId: store.get('sessionId', null),
    turns: 0,
    micOn: store.get('micOn', true), // escucha continua: detecta solo cuándo hablás
    muted: store.get('muted', false),
    micLevel: 0,      // 0..1, nivel del micrófono
    voicePulse: 0,    // 0..1, envolvente simulada de la voz de salida
    abort: null,
    confirm: null,    // acción esperando un sí/no: { id, app, action, detail }
  };

  function setState(s) {
    app.state = s;
    document.body.dataset.state = s;
    $('state-label').textContent = STATE_LABEL[s] || s.toUpperCase();
  }

  // ============================================================
  //  NÚCLEO DE PARTÍCULAS (canvas 2D con proyección 3D propia)
  // ============================================================
  const canvas = $('core');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  const N = 1600;
  const pts = [];
  for (let i = 0; i < N; i++) {
    // Esfera de Fibonacci: distribución uniforme de puntos
    const y = 1 - (i / (N - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = i * Math.PI * (3 - Math.sqrt(5));
    pts.push({ x: Math.cos(th) * r, y, z: Math.sin(th) * r, seed: Math.random() * 1000 });
  }
  const orbiters = Array.from({ length: 140 }, () => ({
    a: Math.random() * Math.PI * 2, r: 1.25 + Math.random() * 0.5, s: (0.2 + Math.random() * 0.6) * (Math.random() < 0.5 ? -1 : 1), tilt: (Math.random() - 0.5) * 0.9,
  }));

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.width = Math.floor(innerWidth * DPR);
    H = canvas.height = Math.floor(innerHeight * DPR);
  }
  addEventListener('resize', resize);
  resize();

  const COLORS = {
    boot: [62, 242, 255], idle: [62, 242, 255], listening: [255, 181, 71], thinking: [169, 139, 255], speaking: [120, 250, 255], confirming: [255, 150, 40],
  };
  let col = [62, 242, 255];
  let energy = 0;
  let rotY = 0, rotX = 0.35;

  function frame(t) {
    const time = t / 1000;
    const target = COLORS[app.state] || COLORS.idle;
    col = col.map((c, i) => c + (target[i] - c) * 0.06);

    // Energía según estado: lo que hace "vivir" al núcleo
    let e = 0.05 + Math.sin(time * 1.2) * 0.02;
    if (app.state === 'listening') e = 0.12 + app.micLevel * 0.9;
    if (app.state === 'thinking') e = 0.25 + Math.sin(time * 8) * 0.06;
    if (app.state === 'speaking') e = 0.18 + app.voicePulse * 0.55 + Math.abs(Math.sin(time * 11)) * 0.08;
    if (app.state === 'confirming') e = 0.15 + app.micLevel * 0.8 + app.voicePulse * 0.4 + (Math.sin(time * 4) > 0.6 ? 0.12 : 0);
    energy += (e - energy) * 0.18;
    app.voicePulse *= 0.93;

    rotY += 0.0025 + energy * 0.02 + (app.state === 'thinking' ? 0.02 : 0);
    rotX = 0.35 + Math.sin(time * 0.3) * 0.15;

    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, W, H);

    const cx = W / 2, cy = H * 0.47;
    const R = Math.min(W, H) * 0.17 * (1 + energy * 0.25);
    const [cr, cg, cb] = col.map(Math.round);

    // Resplandor interno
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.9);
    g.addColorStop(0, `rgba(${cr},${cg},${cb},${0.22 + energy * 0.35})`);
    g.addColorStop(0.35, `rgba(${cr},${cg},${cb},${0.08 + energy * 0.1})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - R * 2, cy - R * 2, R * 4, R * 4);

    ctx.globalCompositeOperation = 'lighter';
    const sy = Math.sin(rotY), cyr = Math.cos(rotY), sx = Math.sin(rotX), cx2 = Math.cos(rotX);
    const fov = 2.6;

    for (const p of pts) {
      // Deformación orgánica: ondas que dependen de la energía
      const wob = 1 + energy * 0.35 * Math.sin(p.y * 6 + time * 4 + p.seed) * Math.cos(p.x * 5 - time * 3)
        + (app.state === 'thinking' ? 0.05 * Math.sin(p.seed + time * 10) : 0);
      let x = p.x * wob, y = p.y * wob, z = p.z * wob;
      // Rotaciones Y y X
      let x1 = x * cyr - z * sy, z1 = x * sy + z * cyr;
      let y1 = y * cx2 - z1 * sx, z2 = y * sx + z1 * cx2;
      const scale = fov / (fov + z2);
      const px = cx + x1 * R * scale, py = cy + y1 * R * scale;
      const depth = (1 - z2) / 2; // 0 atrás · 1 adelante
      const a = 0.15 + depth * 0.75;
      const s = (0.6 + depth * 1.6) * DPR * (1 + energy * 0.4);
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${a})`;
      ctx.fillRect(px, py, s, s);
    }

    // Partículas en órbita
    for (const o of orbiters) {
      o.a += o.s * 0.004 * (1 + energy * 3);
      const x = Math.cos(o.a) * o.r, z = Math.sin(o.a) * o.r, y = Math.sin(o.a) * o.tilt;
      const x1 = x * cyr - z * sy * 0.2;
      const scale = fov / (fov + z * 0.5);
      const px = cx + x1 * R * scale, py = cy + y * R * scale * 0.9;
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${0.25 + energy * 0.5})`;
      ctx.fillRect(px, py, 1.4 * DPR, 1.4 * DPR);
    }

    // Arco de nivel en el HUD
    drawLevelArc(energy);
    $('t-meter').style.width = Math.min(100, energy * 110) + '%';

    requestAnimationFrame(frame);
  }

  // Marcas del anillo de ticks
  (function buildTicks() {
    const g = $('ticks');
    const ns = 'http://www.w3.org/2000/svg';
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * Math.PI * 2;
      const long = i % 10 === 0;
      const r1 = 318, r2 = long ? 334 : 326;
      const l = document.createElementNS(ns, 'line');
      l.setAttribute('x1', Math.cos(a) * r1); l.setAttribute('y1', Math.sin(a) * r1);
      l.setAttribute('x2', Math.cos(a) * r2); l.setAttribute('y2', Math.sin(a) * r2);
      g.appendChild(l);
    }
  })();

  function drawLevelArc(level) {
    const r = 388;
    const span = Math.min(Math.PI * 1.9, 0.15 + level * Math.PI * 1.6);
    const a0 = -Math.PI / 2 - span / 2, a1 = -Math.PI / 2 + span / 2;
    const large = span > Math.PI ? 1 : 0;
    $('arc-level').setAttribute('d',
      `M ${Math.cos(a0) * r} ${Math.sin(a0) * r} A ${r} ${r} 0 ${large} 1 ${Math.cos(a1) * r} ${Math.sin(a1) * r}`);
  }

  requestAnimationFrame(frame);

  // ============================================================
  //  RELOJ Y TELEMETRÍA
  // ============================================================
  function tickClock() {
    const d = new Date();
    $('clock-time').textContent = d.toLocaleTimeString('es-AR', { hour12: false });
    $('clock-date').textContent = d.toLocaleDateString('es-AR', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });
  }
  setInterval(tickClock, 1000); tickClock();

  function updateTelemetry() {
    $('t-session').textContent = app.sessionId ? app.sessionId.slice(0, 8).toUpperCase() : 'NUEVA';
    $('t-turns').textContent = app.turns;
  }

  // ============================================================
  //  VOZ DE SALIDA (speechSynthesis)
  // ============================================================
  const synth = window.speechSynthesis;
  let voices = [];
  let voice = null;
  let pendingUtterances = 0;
  let streamDone = true;

  function scoreVoice(v) {
    let s = 0;
    if (/^es/i.test(v.lang)) s += 100; else return -1;
    if (/es[-_]AR/i.test(v.lang)) s += 30;
    else if (/es[-_](US|MX|419)/i.test(v.lang)) s += 15;
    if (/natural|neural|online/i.test(v.name)) s += 50;
    if (/google/i.test(v.name)) s += 20;
    return s;
  }

  function loadVoices() {
    if (!synth) return;
    voices = synth.getVoices().filter((v) => scoreVoice(v) >= 0).sort((a, b) => scoreVoice(b) - scoreVoice(a));
    const sel = $('voice-select');
    sel.innerHTML = '';
    if (!voices.length) { sel.innerHTML = '<option>Sin voces en español</option>'; return; }
    for (const v of voices) {
      const o = document.createElement('option');
      o.value = v.name; o.textContent = `${v.name.replace(/^Microsoft\s+/, '').replace(/\s*-\s*Spanish.*$/, '')} · ${v.lang}`;
      sel.appendChild(o);
    }
    const saved = store.get('voice', null);
    voice = voices.find((v) => v.name === saved) || voices[0];
    sel.value = voice.name;
  }
  if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; }
  $('voice-select').addEventListener('change', (e) => {
    voice = voices.find((v) => v.name === e.target.value) || voice;
    store.set('voice', voice && voice.name);
    speak('Así suena mi nueva voz.', true);
  });
  const rateEl = $('rate'), pitchEl = $('pitch');
  rateEl.value = store.get('rate', 1.05); pitchEl.value = store.get('pitch', 0.95);
  rateEl.addEventListener('change', () => store.set('rate', +rateEl.value));
  pitchEl.addEventListener('change', () => store.set('pitch', +pitchEl.value));

  // Limpia lo que no conviene leer en voz alta
  function forSpeech(text) {
    return text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, 'el enlace')
      .replace(/[*_#>~|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function speak(text, standalone = false) {
    const clean = forSpeech(text);
    if (!clean || !synth || app.muted) { if (standalone) return; maybeFinishSpeaking(); return; }
    const u = new SpeechSynthesisUtterance(clean);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = 'es-AR';
    u.rate = +rateEl.value; u.pitch = +pitchEl.value;
    u.onstart = () => { app.voicePulse = 1; if (app.state === 'thinking') setState('speaking'); };
    u.onboundary = () => { app.voicePulse = Math.min(1, app.voicePulse + 0.6); };
    u.onend = u.onerror = () => { pendingUtterances = Math.max(0, pendingUtterances - 1); maybeFinishSpeaking(); };
    pendingUtterances++;
    synth.speak(u);
  }

  function maybeFinishSpeaking() {
    if (pendingUtterances > 0) return;
    // Terminó de preguntar si autorizás la acción: ahora escucha el sí/no
    if (app.state === 'confirming') { if (app.confirm) listenForConfirm(); return; }
    if (!streamDone) return;
    if (app.state === 'speaking' || app.state === 'thinking') {
      setState('idle');
      if (app.micOn) setTimeout(() => { if (app.state === 'idle' && app.micOn) startListening(); }, 350);
    }
  }

  function stopSpeaking() {
    pendingUtterances = 0;
    if (synth) synth.cancel();
  }

  // Chrome a veces "se duerme" con colas largas: un pause/resume periódico lo mantiene vivo.
  setInterval(() => { if (synth && synth.speaking && !synth.paused) { synth.pause(); synth.resume(); } }, 12000);

  // ============================================================
  //  CONVERSACIÓN CON CLAUDE (SSE sobre fetch)
  // ============================================================
  function addLog(who, text) {
    const li = document.createElement('li');
    li.className = who;
    const label = who === 'user' ? 'VOS' : who === 'sys' ? 'SISTEMA' : 'J.A.R.V.I.S.';
    li.innerHTML = `<b>${label} · ${new Date().toLocaleTimeString('es-AR', { hour12: false })}</b>`;
    const span = document.createElement('span');
    span.textContent = text;
    li.appendChild(span);
    $('log').appendChild(li);
    li.scrollIntoView({ block: 'end' });
    return span;
  }

  async function ask(text) {
    text = text.trim();
    if (!text) { setState('idle'); return; }
    interrupt();
    $('sub-user').textContent = text;
    $('sub-ai').textContent = '';
    addLog('user', text);
    const aiSpan = addLog('ai', '…');
    setState('thinking');
    $('t-link').textContent = 'TRANSMITIENDO';

    const controller = new AbortController();
    app.abort = controller;
    streamDone = false;
    let full = '';
    let speakBuf = '';
    const t0 = performance.now();
    let firstToken = true;

    const flushSentences = (force) => {
      // Lee por oraciones completas para que la voz empiece rápido y suene natural
      const re = /[^.!?¿¡…\n]*[.!?…\n]+["')\]]*\s*/g;
      let m, last = 0;
      while ((m = re.exec(speakBuf)) !== null) {
        if (m[0].trim().length > 1) speak(m[0]);
        last = re.lastIndex;
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      speakBuf = speakBuf.slice(last);
      if (force && speakBuf.trim()) { speak(speakBuf); speakBuf = ''; }
    };

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Jarvis-Token': TOKEN },
        body: JSON.stringify({ text, sessionId: app.sessionId }),
        signal: controller.signal,
      });
      if (res.status === 403) throw new Error('El servidor se reinició: recargá la página con F5.');
      if (!res.ok || !res.body) throw new Error('El servidor respondió ' + res.status);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const ev = /^event: (.+)$/m.exec(raw)?.[1];
          const dataLine = /^data: (.+)$/m.exec(raw)?.[1];
          if (!ev || !dataLine) continue;
          const data = JSON.parse(dataLine);
          if (ev === 'init') {
            $('t-model').textContent = (data.model || '—').replace(/^claude-/, '').toUpperCase();
          } else if (ev === 'delta') {
            if (firstToken) { firstToken = false; $('t-latency').textContent = Math.round(performance.now() - t0) + ' ms'; }
            full += data.text; speakBuf += data.text;
            $('sub-ai').textContent = full;
            aiSpan.textContent = full;
            flushSentences(false);
          } else if (ev === 'tool') {
            $('t-action').textContent = data.app.toUpperCase();
          } else if (ev === 'confirm') {
            flushSentences(true); // primero termina de decir qué va a hacer
            showConfirm(data);
          } else if (ev === 'done') {
            app.sessionId = data.sessionId; store.set('sessionId', app.sessionId);
            app.turns++; updateTelemetry();
          } else if (ev === 'error') {
            throw new Error(data.message);
          }
        }
      }
      flushSentences(true);
      $('t-link').textContent = 'ESTABLE';
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error(err);
      const msg = /logged in|login/i.test(err.message)
        ? 'No hay sesión de Claude iniciada. Abrí una terminal, corré claude y hacé login.'
        : 'Perdí el enlace con el núcleo. ' + err.message;
      $('sub-ai').textContent = msg;
      aiSpan.textContent = msg;
      $('t-link').textContent = 'FALLA';
      speak('Perdí el enlace con el núcleo.');
    } finally {
      if (app.abort === controller) app.abort = null;
      streamDone = true;
      maybeFinishSpeaking();
    }
  }

  function interrupt() {
    if (app.abort) { app.abort.abort(); app.abort = null; } // el servidor deniega lo pendiente al cortarse
    closeConfirm();
    stopSpeaking();
    streamDone = true;
  }

  // ============================================================
  //  CONFIRMACIÓN DE ACCIONES (cada herramienta espera un sí/no)
  // ============================================================
  function showConfirm(data) {
    app.confirm = data;
    $('confirm-title').textContent = data.title || (data.action ? `${data.app} · ${data.action}` : data.app);
    $('confirm-detail').textContent = data.detail || '';
    $('confirm').hidden = false;
    $('t-action').textContent = 'ESPERANDO OK';
    addLog('sys', `Pide autorización: ${data.app}${data.action ? ' · ' + data.action : ''}`);
    setState('confirming');
    speak(`¿Me autorizás a usar ${data.app}?`);
  }

  function closeConfirm() {
    app.confirm = null;
    $('confirm').hidden = true;
    if (rec && app.state === 'confirming') rec.abort();
  }

  function answerConfirm(allow) {
    if (!app.confirm) return;
    const { id } = app.confirm;
    closeConfirm();
    stopSpeaking();
    addLog('sys', allow ? 'Autorizado.' : 'Rechazado.');
    $('t-action').textContent = allow ? 'EJECUTANDO' : 'CANCELADA';
    setState('thinking');
    fetch('/api/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Jarvis-Token': TOKEN },
      body: JSON.stringify({ id, allow }),
    }).catch((e) => console.error('No pude enviar la confirmación', e));
  }

  // Devuelve true (sí), false (no) o null (no se entendió). Gana la primera palabra clave dicha.
  function parseYesNo(text) {
    const t = ' ' + text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z\s]/g, ' ') + ' ';
    const find = (words) => Math.min(...words.map((w) => { const i = t.indexOf(' ' + w + ' '); return i < 0 ? Infinity : i; }));
    const yes = find(['si', 'dale', 'confirmo', 'confirmar', 'confirmado', 'ok', 'okey', 'okay', 'claro', 'adelante', 'hacelo', 'de una', 'afirmativo', 'perfecto', 'listo', 'autorizo', 'autorizado', 'yes']);
    const no = find(['no', 'cancela', 'cancelar', 'cancelalo', 'negativo', 'para', 'frena', 'nada', 'nope']);
    if (yes === Infinity && no === Infinity) return null;
    return yes < no;
  }

  function listenForConfirm() {
    if (!SR || !app.micOn || rec || !app.confirm) return;
    ensureMicMeter();
    let said = '';
    rec = new SR();
    rec.lang = 'es-AR';
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (e) => { said = Array.from(e.results).map((r) => r[0].transcript).join(' '); $('sub-user').textContent = said; };
    rec.onend = () => {
      rec = null;
      if (!app.confirm) return;
      const v = said ? parseYesNo(said) : null;
      if (v !== null) answerConfirm(v);
      else if (said) speak('No te entendí. Decí sí o no.'); // al terminar de hablar vuelve a escuchar
      else setTimeout(listenForConfirm, 250);
    };
    try { rec.start(); } catch { rec = null; }
  }

  $('confirm-yes').addEventListener('click', () => answerConfirm(true));
  $('confirm-no').addEventListener('click', () => answerConfirm(false));

  // ============================================================
  //  VOZ DE ENTRADA (SpeechRecognition) + nivel de micrófono
  // ============================================================
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let heard = '';
  let recErrors = 0; // errores seguidos (p. ej. sin red): espaciamos los reintentos

  async function ensureMicMeter() {
    if (ensureMicMeter.done) return;
    ensureMicMeter.done = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const an = ac.createAnalyser(); an.fftSize = 512;
      ac.createMediaStreamSource(stream).connect(an);
      const data = new Uint8Array(an.fftSize);
      (function loop() {
        an.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) { const d = (v - 128) / 128; sum += d * d; }
        const rms = Math.sqrt(sum / data.length);
        app.micLevel = app.state === 'listening' || (app.state === 'confirming' && rec) ? Math.min(1, rms * 6) : 0;
        requestAnimationFrame(loop);
      })();
    } catch (e) {
      console.warn('Sin medidor de micrófono:', e);
    }
  }

  function startListening() {
    if (!SR) { $('sub-ai').textContent = 'Este navegador no soporta reconocimiento de voz. Usá Chrome o Edge, o escribí abajo.'; return; }
    if (app.state === 'listening') return;
    interrupt(); // hablar encima de JARVIS lo interrumpe
    ensureMicMeter();
    heard = '';
    rec = new SR();
    rec.lang = 'es-AR';
    rec.interimResults = true;
    rec.continuous = false; // el reconocedor detecta el silencio y cierra la frase solo
    rec.onresult = (e) => {
      recErrors = 0;
      let finalT = '', interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalT += r[0].transcript; else interim += r[0].transcript;
      }
      heard = (finalT + ' ' + interim).trim();
      $('sub-user').textContent = heard;
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        $('sub-ai').textContent = 'Necesito permiso para usar el micrófono.';
        app.micOn = false; syncButtons();
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        recErrors++;
      }
    };
    rec.onend = () => {
      rec = null;
      if (app.state !== 'listening') return;
      if (heard) ask(heard);
      else {
        // Nadie habló: seguimos escuchando (con espera creciente si hubo errores)
        setState('idle');
        const delay = recErrors ? Math.min(10000, 1000 * 2 ** recErrors) : 250;
        if (app.micOn) setTimeout(() => { if (app.state === 'idle' && app.micOn) startListening(); }, delay);
      }
    };
    $('sub-user').textContent = '';
    setState('listening');
    try { rec.start(); } catch { setState('idle'); }
  }

  function toggleMic() {
    app.micOn = !app.micOn; store.set('micOn', app.micOn); syncButtons();
    if (app.state === 'confirming') { if (app.micOn) listenForConfirm(); else if (rec) rec.abort(); return; }
    if (app.micOn && app.state === 'idle') startListening();
    if (!app.micOn && rec) { rec.abort(); setState('idle'); }
  }

  // Barra espaciadora: prende/apaga el micrófono. ESC: corta la respuesta en curso.
  addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || document.activeElement === $('text-input') || app.state === 'boot') return;
    e.preventDefault();
    toggleMic();
  });
  addEventListener('keydown', (e) => {
    if (e.code !== 'Escape') return;
    interrupt(); if (rec) rec.abort(); setState('idle');
    if (app.micOn) setTimeout(startListening, 300);
  });

  // Tocar el núcleo mientras JARVIS habla lo interrumpe y vuelve a escucharte.
  $('core-btn').addEventListener('click', () => {
    if (app.state === 'speaking' || app.state === 'thinking') {
      interrupt(); setState('idle');
      if (app.micOn) startListening();
    } else toggleMic();
  });

  // ============================================================
  //  CONTROLES
  // ============================================================
  function syncButtons() {
    const m = $('mode-btn');
    m.textContent = app.micOn ? 'MICRÓFONO · ON' : 'MICRÓFONO · OFF';
    m.classList.toggle('on', app.micOn);
    const v = $('mute-btn');
    v.textContent = app.muted ? 'VOZ · OFF' : 'VOZ · ON';
    v.classList.toggle('on', !app.muted);
    $('text-input').placeholder = app.micOn ? 'Te escucho… o escribí acá' : 'Micrófono apagado (ESPACIO para prenderlo). Escribí acá…';
  }
  $('mode-btn').addEventListener('click', (e) => { e.currentTarget.blur(); toggleMic(); });
  $('mute-btn').addEventListener('click', (e) => {
    e.currentTarget.blur();
    app.muted = !app.muted; store.set('muted', app.muted); syncButtons();
    if (app.muted) { stopSpeaking(); maybeFinishSpeaking(); }
  });
  $('reset-btn').addEventListener('click', (e) => {
    e.currentTarget.blur();
    interrupt();
    app.sessionId = null; app.turns = 0; store.set('sessionId', null); updateTelemetry();
    $('log').innerHTML = ''; $('sub-user').textContent = ''; $('sub-ai').textContent = 'Memoria de conversación reiniciada.';
    setState('idle');
    speak('Memoria reiniciada. Empecemos de cero.', true);
  });
  $('log-toggle').addEventListener('click', () => $('log-panel').classList.toggle('collapsed'));
  $('text-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('text-input').value; $('text-input').value = '';
    $('text-input').blur();
    if (app.confirm) { const yn = parseYesNo(v); if (yn !== null) { answerConfirm(yn); return; } }
    ask(v);
  });

  // ============================================================
  //  SECUENCIA DE ARRANQUE
  // ============================================================
  const BOOT_LINES = [
    ['Inicializando matriz holográfica', 'OK'],
    ['Calibrando núcleo de partículas', 'OK'],
    ['Enlace neuronal con Claude', 'OK'],
    ['Módulo de reconocimiento de voz', SR ? 'OK' : 'NO DISPONIBLE'],
    ['Síntesis de voz', synth ? 'OK' : 'NO DISPONIBLE'],
    ['Protocolos de personalidad', 'OK'],
  ];

  async function boot() {
    syncButtons(); updateTelemetry();
    // ?skip salta la animación (útil al recargar); el audio se habilita con el primer clic o tecla
    if (new URLSearchParams(location.search).has('skip')) { setState('idle'); if (app.micOn) startListening(); return; }
    const log = $('boot-log');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const [label, status] of BOOT_LINES) {
      const line = document.createElement('div');
      log.appendChild(line);
      const txt = `> ${label} `;
      for (let i = 0; i <= txt.length; i += 2) { line.textContent = txt.slice(0, i); await wait(12); }
      const dots = document.createElement('span'); line.appendChild(dots);
      for (let i = 0; i < 6; i++) { dots.textContent += '.'; await wait(35); }
      const st = document.createElement('span');
      st.className = status === 'OK' ? 'ok' : 'warn';
      st.textContent = ' [' + status + ']';
      line.appendChild(st);
      await wait(90);
    }
    const ready = document.createElement('div'); ready.className = 'ok'; ready.textContent = '\n> SISTEMA LISTO.';
    log.appendChild(ready);
    if (!SR) { const w = $('boot-warn'); w.hidden = false; w.textContent = 'Para hablar por voz abrí esta página en Chrome o Edge. Igual podés escribir.'; }
    const btn = $('boot-btn');
    btn.hidden = false; btn.focus();
    btn.addEventListener('click', () => {
      // El primer clic habilita audio y micrófono (los navegadores lo exigen)
      setState('idle');
      ensureMicMeter();
      const h = new Date().getHours();
      const saludo = h < 12 ? 'Buen día' : h < 20 ? 'Buenas tardes' : 'Buenas noches';
      const intro = `${saludo}. Sistemas en línea. ${app.micOn ? 'Te escucho, hablame cuando quieras.' : 'El micrófono está apagado, tocá la barra espaciadora para prenderlo.'}`;
      $('sub-ai').textContent = intro;
      streamDone = true;
      setState('speaking');
      if (app.muted) setState('idle');
      speak(intro);
    }, { once: true });
  }
  boot();
})();
