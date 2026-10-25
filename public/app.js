// J.A.R.V.I.S. — lógica del cliente.
// Estados: boot → idle ⇄ listening → thinking → speaking → idle.
// Voz de entrada: Web Speech API (SpeechRecognition). Voz de salida: speechSynthesis.
// El texto de Claude llega por el canal de eventos permanente (SSE en /api/events) y se va leyendo por oraciones;
// los mensajes, interrupciones y confirmaciones salen por POST.

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
  // El servidor reemplaza el marcador por el nombre; si no lo hizo (o está vacío), saluda sin nombre
  const USER_RAW = document.querySelector('meta[name="jarvis-user"]')?.content || '';
  const USER = USER_RAW === '__JARVIS_USER__' ? '' : USER_RAW;

  const app = {
    state: 'boot',
    sessionId: store.get('sessionId', null),
    turns: 0,
    micOn: store.get('micOn', true), // escucha continua: detecta solo cuándo hablás
    muted: store.get('muted', false),
    micLevel: 0,      // 0..1, nivel del micrófono
    voicePulse: 0,    // 0..1, envolvente simulada de la voz de salida
    confirm: null,    // acción esperando un sí/no: { id, app, action, detail }
    replaced: false,  // otra ventana tomó el canal: esta queda inerte
    camOn: store.get('camOn', true), // cámara para los gestos con la mano (siempre activa salvo que la apagues)
  };

  function setState(s) {
    app.state = s;
    document.body.dataset.state = s;
    $('state-label').textContent = STATE_LABEL[s] || s.toUpperCase();
    // Si una tarea terminó mientras JARVIS estaba ocupado, su resultado se dice ahora que queda libre
    if (s === 'idle' && taskQueue.length) {
      setTimeout(() => { if (taskQueue.length && canSayTask()) sayTaskTurn(taskQueue.shift()); }, 0);
    }
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
    for (const w of words(clean)) spoken.add(w); // para reconocer su propio eco al interrumpir
    const u = new SpeechSynthesisUtterance(clean);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = 'es-AR';
    u.rate = +rateEl.value; u.pitch = +pitchEl.value;
    u.onstart = () => { app.voicePulse = 1; if (app.state === 'thinking') setState('speaking'); startBargeIn(); };
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
  //  CONVERSACIÓN CON CLAUDE (canal de eventos + POST)
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

  // Panel TAREAS: una fila por tarea, con el estado del SDK traducido
  const TASK_STATUS = { running: 'EN CURSO', completed: 'LISTA', failed: 'FALLÓ', stopped: 'CANCELADA' };
  const taskRows = new Map();
  function setTask(id, status, description) {
    let row = taskRows.get(id);
    if (!row) {
      const li = document.createElement('li');
      const desc = document.createElement('span'); desc.className = 'desc';
      const st = document.createElement('span'); st.className = 'st';
      const btn = document.createElement('button'); btn.className = 'btn mini'; btn.textContent = 'CANCELAR';
      btn.onclick = () => post('/api/tasks/stop', { taskId: id }).catch((e) => console.error('No pude cancelar la tarea', e));
      li.append(desc, st, btn);
      $('tasks').appendChild(li);
      row = { li, desc, st, btn };
      taskRows.set(id, row);
    }
    if (description) { row.desc.textContent = description; row.desc.title = description; }
    else if (!row.desc.textContent) row.desc.textContent = id;
    row.st.textContent = TASK_STATUS[status] || status;
    row.li.className = status;
    row.btn.hidden = status !== 'running';
  }

  const post = (url, body = {}) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Jarvis-Token': TOKEN },
    body: JSON.stringify(body),
  });

  // Turno de la persona en curso: { aiSpan, full, speakBuf, t0, firstToken }. null si no hay ninguno.
  let cur = null;
  let userBusy = false;    // el servidor está respondiendo a la persona (interrumpible)
  let turnOrigin = 'user'; // quién arrancó el turno que está llegando por el canal
  let askSeq = 0;          // sube con cada ask() e interrupt(): un ask viejo no manda su mensaje si lo cortaron antes
  let activeTurn = false;  // hay un turno en curso en el servidor (desde su `turn` hasta su `done`/`error`)
  let staleTurn = false;   // solo el turno que estaba activo al interrumpir: se ignora hasta que termine
  let taskBuffer = '';     // texto de un turno de tarea: se acumula y se dice entero al terminar
  const taskQueue = [];    // resultados de tareas esperando a que JARVIS esté libre

  // Un turno de tarea terminó con una pregunta de la persona aún abierta y no llegó el turno de esa pregunta
  // (se absorbió en el de la tarea): pasados unos segundos se da por cerrada para que no quede en PROCESANDO.
  let foldTimer = null;
  function armFoldTimer() {
    clearTimeout(foldTimer);
    foldTimer = setTimeout(() => {
      if (!cur || activeTurn) return;
      flushSentences(true);
      cur = null; userBusy = false; streamDone = true;
      $('t-link').textContent = 'ESTABLE';
      maybeFinishSpeaking();
    }, 3000);
  }

  // Tras cerrarse una confirmación: con un turno en curso sigue procesando; sin turno vuelve a espera y escucha
  function leaveConfirming() {
    if (app.state !== 'confirming') return;
    if (activeTurn) { setState('thinking'); return; }
    streamDone = true;
    setState('idle');
    if (app.micOn) setTimeout(() => { if (app.state === 'idle' && app.micOn) startListening(); }, 350);
  }

  async function ask(text) {
    text = text.trim();
    if (!text) { setState('idle'); return; }
    if (app.replaced) return;
    const stale = interrupt();
    const seq = ++askSeq;
    spoken = new Set();
    $('sub-user').textContent = text;
    $('sub-ai').textContent = '';
    addLog('user', text);
    const turn = { aiSpan: addLog('ai', '…'), full: '', speakBuf: '', t0: performance.now(), firstToken: true };
    userBusy = true;
    setState('thinking');
    $('t-link').textContent = 'TRANSMITIENDO';
    streamDone = false;
    // La primera respuesta continúa el saludo de arranque en vez de saludar de nuevo
    const greetContext = app.greetPending ? `[Al iniciar ya le dijiste: «${GREETING}». Esta es su respuesta.]\n` : '';
    app.greetPending = false;

    try {
      if (stale) await stale; // que el corte llegue al servidor antes que el mensaje nuevo
      if (seq !== askSeq) return; // ESC o una pregunta nueva mientras esperaba el corte: este mensaje ya no se manda
      cur = turn; // recién ahora: lo que llegue del turno cortado no se pinta como respuesta nueva
      const res = await post('/api/message', { text: greetContext + text, sessionId: app.sessionId });
      if (res.status === 403) throw new Error('El servidor se reinició: recargá la página con F5.');
      if (!res.ok) throw new Error('El servidor respondió ' + res.status);
    } catch (err) {
      failTurn(err.message);
    }
  }

  // Lee por oraciones completas para que la voz empiece rápido y suene natural
  function flushSentences(force) {
    if (!cur) return;
    const re = /[^.!?¿¡…\n]*[.!?…\n]+["')\]]*\s*/g;
    let m, last = 0;
    while ((m = re.exec(cur.speakBuf)) !== null) {
      if (m[0].trim().length > 1) speak(m[0]);
      last = re.lastIndex;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    cur.speakBuf = cur.speakBuf.slice(last);
    if (force && cur.speakBuf.trim()) { speak(cur.speakBuf); cur.speakBuf = ''; }
  }

  // El turno de la persona no pudo completarse (error del servidor o enlace caído)
  function failTurn(message) {
    console.error(message);
    const msg = /logged in|login/i.test(message)
      ? 'No hay sesión de Claude iniciada. Abrí una terminal, corré claude y hacé login.'
      : 'Perdí el enlace con el núcleo. ' + message;
    $('sub-ai').textContent = msg;
    if (cur) cur.aiSpan.textContent = msg; else addLog('sys', msg);
    $('t-link').textContent = 'FALLA';
    const hadTurn = !!cur;
    cur = null; userBusy = false; streamDone = true;
    if (hadTurn) speak('Perdí el enlace con el núcleo.');
    maybeFinishSpeaking();
  }

  // Terminó un turno de tarea sin una respuesta a la persona en curso: si quedó en 'procesando' (p. ej. tras una
  // confirmación) vuelve a espera, y eso también reparte lo que haya en la cola de tareas.
  function endIdleTurn() {
    if (cur || app.state !== 'thinking') return;
    streamDone = true;
    maybeFinishSpeaking();
  }

  // Corta la voz local y, si el servidor está respondiendo, también esa respuesta.
  // Devuelve la promesa del POST (o null) para que ask() espere antes de mandar lo nuevo.
  function interrupt(onlyIfActive = false) {
    let sent = null;
    askSeq++;
    const userTurnActive = activeTurn && turnOrigin !== 'task';
    // El servidor decide qué cortar: el turno de la persona y sus mensajes en cola; un turno de tarea sigue.
    // Con onlyIfActive (empezar a escuchar) solo avisa si hay un turno de la persona en curso.
    if (!onlyIfActive || userTurnActive) sent = post('/api/interrupt').catch((e) => console.error('No pude interrumpir', e));
    if (userTurnActive) staleTurn = true; // lo que siga de ese turno se ignora hasta su `done`
    cur = null; userBusy = false;
    closeConfirm();
    stopSpeaking();
    streamDone = true;
    return sent;
  }

  // ------------------------------------------------------------
  //  Turnos de tareas: lo que Claude dice por su cuenta (terminó una tarea) se dice cuando hay silencio
  // ------------------------------------------------------------
  const canSayTask = () => !app.replaced && (app.state === 'idle' || (app.state === 'listening' && !heard));

  function queueTaskTurn(text) {
    text = text.trim();
    if (!text) return;
    if (canSayTask()) sayTaskTurn(text); else taskQueue.push(text);
  }

  function sayTaskTurn(text) {
    // Cortar la escucha mientras habla: si no, el micrófono capta su propia voz como si fuera tuya
    setState('speaking');
    dropRec();
    streamDone = true;
    spoken = new Set();
    $('sub-ai').textContent = text;
    addLog('ai', text);
    speak(text);
  }

  // ------------------------------------------------------------
  //  Canal de eventos permanente (fetch en streaming: EventSource no puede mandar el token)
  // ------------------------------------------------------------
  function onEvent(ev, data) {
    switch (ev) {
      case 'turn':
        clearTimeout(foldTimer); // llegó el turno que se esperaba: nada que cerrar a mano
        turnOrigin = data.origin;
        activeTurn = true;
        staleTurn = false; // un turno nuevo: el interrumpido ya terminó
        if (data.origin === 'task') { taskBuffer = ''; break; }
        if (!cur) { // turno de la persona sin un ask pendiente: se trata como una respuesta normal
          dropRec();
          spoken = new Set();
          $('sub-ai').textContent = '';
          cur = { aiSpan: addLog('ai', '…'), full: '', speakBuf: '', t0: performance.now(), firstToken: true };
          userBusy = true; streamDone = false;
          setState('thinking');
          $('t-link').textContent = 'TRANSMITIENDO';
        }
        break;
      case 'init': // el servidor lo repite en cada turno
        $('t-model').textContent = (data.model || '—').replace(/^claude-/, '').toUpperCase();
        if (data.sessionId) { app.sessionId = data.sessionId; store.set('sessionId', app.sessionId); updateTelemetry(); }
        break;
      case 'delta':
        if (staleTurn) break;
        if (turnOrigin === 'task') { taskBuffer += data.text; break; }
        if (!cur) break;
        if (cur.firstToken) { cur.firstToken = false; $('t-latency').textContent = Math.round(performance.now() - cur.t0) + ' ms'; }
        cur.full += data.text; cur.speakBuf += data.text;
        $('sub-ai').textContent = cur.full;
        cur.aiSpan.textContent = cur.full;
        flushSentences(false);
        break;
      case 'tool':
        if (!staleTurn) $('t-action').textContent = data.app.toUpperCase();
        break;
      case 'open':
        addLog('sys', 'Abrí: ' + data.url);
        break;
      case 'music':
        // Con música sonando el micrófono la tomaría como si fueras vos: se apaga hasta que toques ESPACIO.
        if (app.micOn) toggleMic();
        addLog('sys', `Música: ${data.title || 'YouTube'}. Micrófono apagado, ESPACIO para volver a hablarme.`);
        break;
      case 'confirm':
        if (staleTurn) break;
        if (app.confirm?.id === data.id) break; // reenvío al reconectar de una que ya está en pantalla
        flushSentences(true); // primero termina de decir qué va a hacer
        showConfirm(data);
        break;
      case 'confirm_closed': // el servidor cerró la confirmación (vencida, cortada o ya respondida)
        if (!app.confirm || app.confirm.id !== data.id) break; // ya la cerró la persona: no se repite
        closeConfirm();
        stopSpeaking();
        addLog('sys', data.allowed ? 'Autorizado.' : 'Autorización vencida.');
        leaveConfirming();
        break;
      case 'denied':
        addLog('sys', `Un subagente intentó ${data.action || data.app}${data.action ? ' (' + data.app + ')' : ''} y se lo impedí.`);
        break;
      case 'task': {
        setTask(data.id, data.status, data.description);
        addLog('sys', data.status === 'running'
          ? 'Tarea en segundo plano: ' + (data.description || data.id)
          : `Tarea ${TASK_STATUS[data.status] || data.status}${data.summary ? ': ' + data.summary : ''}`);
        break;
      }
      case 'tasks': // lista completa de tareas vivas (también al reconectar): las que no están conservan su último estado
        for (const t of data.tasks || []) setTask(t.id, 'running', t.description);
        break;
      case 'done':
        if (data.sessionId) { app.sessionId = data.sessionId; store.set('sessionId', app.sessionId); }
        activeTurn = false;
        if (staleTurn) { staleTurn = false; updateTelemetry(); break; } // cierre del turno que se interrumpió
        if (turnOrigin === 'task') {
          const t = taskBuffer; taskBuffer = ''; turnOrigin = 'user'; queueTaskTurn(t); endIdleTurn();
          if (cur) armFoldTimer(); // un mensaje de la persona pudo quedar absorbido por este turno de tarea
          break;
        }
        if (data.interrupted && cur) break; // cierre tardío de un turno cortado: la pregunta vigente sigue esperando
        flushSentences(true);
        if (!data.interrupted) app.turns++;
        updateTelemetry();
        $('t-link').textContent = 'ESTABLE';
        cur = null; userBusy = false; streamDone = true;
        maybeFinishSpeaking();
        break;
      case 'error':
        activeTurn = false;
        if (staleTurn) { staleTurn = false; break; }
        if (turnOrigin === 'task') { taskBuffer = ''; turnOrigin = 'user'; addLog('sys', 'Error en una tarea: ' + data.message); endIdleTurn(); break; }
        failTurn(data.message);
        break;
      case 'replaced': // otra ventana tomó el canal: esta se calla y no reconecta
        app.replaced = true; taskQueue.length = 0
        dropRec(); closeConfirm(); stopSpeaking();
        stopCam(); // la otra ventana usa la cámara
        cur = null; userBusy = false; streamDone = true;
        $('replaced').hidden = false;
        $('t-link').textContent = 'CEDIDO';
        setState('idle');
        break;
      case 'reset':
        cur = null; userBusy = false; streamDone = true; taskBuffer = ''; taskQueue.length = 0; activeTurn = false; staleTurn = false;
        closeConfirm(); stopSpeaking(); taskRows.clear(); $('tasks').innerHTML = '';
        app.sessionId = null; app.turns = 0; store.set('sessionId', null); updateTelemetry();
        $('log').innerHTML = ''; $('sub-user').textContent = ''; $('sub-ai').textContent = 'Memoria de conversación reiniciada.';
        // Habla en estado "speaking" para que, al terminar, vuelva a espera y reabra el micrófono como siempre
        setState('speaking');
        dropRec();
        speak('Memoria reiniciada. Empecemos de cero.');
        break;
    }
  }

  // Lee el stream SSE (`event:` + `data:` separados por línea en blanco; los `: ping` se ignoran)
  async function readEvents(res) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const ev = /^event: (.+)$/m.exec(raw)?.[1];
        const dataLine = /^data: (.+)$/m.exec(raw)?.[1];
        if (!ev || !dataLine) continue;
        try { onEvent(ev, JSON.parse(dataLine)); } catch (e) { console.error('Evento con falla:', ev, e); }
      }
    }
  }

  async function connectEvents() {
    let fails = 0;
    while (!app.replaced) {
      try {
        const res = await fetch('/api/events', { headers: { 'X-Jarvis-Token': TOKEN } });
        if (res.status === 403) {
          const msg = 'El servidor se reinició: recargá la página con F5.';
          $('sub-ai').textContent = msg; addLog('sys', msg); $('t-link').textContent = 'FALLA';
          return; // con otro token no tiene sentido reintentar
        }
        if (!res.ok || !res.body) throw new Error('El servidor respondió ' + res.status);
        fails = 0;
        $('t-link').textContent = 'ESTABLE';
        await readEvents(res);
      } catch (err) {
        console.warn('Canal de eventos:', err.message);
      }
      if (app.replaced) return;
      // Se cortó: si había un turno en curso no va a llegar su final
      if (cur || userBusy) failTurn('Se cortó el canal con el servidor.');
      $('t-link').textContent = 'RECONECTANDO';
      staleTurn = false; activeTurn = false;
      await new Promise((r) => setTimeout(r, Math.min(10000, 1000 * 2 ** fails++))); // 1, 2, 4, 8, 10 s
    }
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
    dropRec(); // la escucha del sí/no arranca sola cuando termina la pregunta
    setState('confirming');
    speak(data.speech || `¿Me autorizás a usar ${data.app}?`);
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
    if (id === 'reset') { // confirmación local de NUEVA: no pasa por /api/confirm
      if (allow) post('/api/new', { force: true }).catch((e) => console.error('No pude reiniciar', e));
      else { setState('idle'); if (app.micOn) setTimeout(() => { if (app.state === 'idle' && app.micOn) startListening(); }, 350); }
      return;
    }
    $('t-action').textContent = allow ? 'EJECUTANDO' : 'CANCELADA';
    leaveConfirming(); // con turno en curso: procesando; sin turno (p. ej. ya venció): a espera
    post('/api/confirm', { id, allow }).then((res) => {
      // 404: el servidor ya la había cerrado (venció o se cortó). Si no hay turno, no queda nada esperando
      if (res.status === 404) { addLog('sys', 'Autorización vencida.'); $('t-action').textContent = 'VENCIDA'; }
    }).catch((e) => console.error('No pude enviar la confirmación', e));
  }

  // Devuelve true (sí), false (no) o null (no se entendió). Si la frase trae un sí y un no
  // («no hace falta, sí»), es ambigua y se vuelve a preguntar: enviar o borrar no se adivina.
  function parseYesNo(text) {
    const t = ' ' + text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
    const has = (words) => words.some((w) => t.includes(' ' + w + ' '));
    const yes = has(['si', 'dale', 'confirmo', 'confirmar', 'confirmado', 'ok', 'okey', 'okay', 'claro', 'adelante', 'hacelo', 'de una', 'afirmativo', 'perfecto', 'listo', 'autorizo', 'autorizado', 'yes']);
    const no = has(['no', 'cancela', 'cancelar', 'cancelalo', 'negativo', 'para', 'frena', 'nada', 'nope']);
    if (yes === no) return null;
    return yes;
  }

  function listenForConfirm() {
    if (!SR || !app.micOn || app.replaced || rec || !app.confirm) return;
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
      if (said) addLog('sys', `Escuché: «${said}»`); // deja registro de qué se entendió como sí/no
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
    if (app.replaced) return;
    if (!SR) { $('sub-ai').textContent = 'Este navegador no soporta reconocimiento de voz. Usá Chrome o Edge, o escribí abajo.'; return; }
    if (app.state === 'listening') return;
    stopBargeIn();
    interrupt(true); // hablar encima de JARVIS lo interrumpe
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

  // ------------------------------------------------------------
  //  Interrumpir hablando: escucha mientras JARVIS habla. El micrófono también capta los
  //  parlantes, así que se ignoran las palabras que JARVIS dijo en este turno; corta solo
  //  si oye varias palabras nuevas o una orden de corte.
  // ------------------------------------------------------------
  let spoken = new Set();
  const STOP_WORDS = ['basta', 'callate', 'para', 'espera', 'stop', 'alto', 'silencio', 'jarvis'];
  const BARGE_MIN_WORDS = 3;
  function words(s) {
    return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  }

  // Diagnóstico del micrófono: abrir con ?debug para ver en el registro qué oye y por qué corta o no.
  const DEBUG = new URLSearchParams(location.search).has('debug');
  function dbg(msg) { if (DEBUG) { console.log('[mic]', msg); addLog('sys', '[mic] ' + msg); } }

  function startBargeIn() {
    if (!SR || !app.micOn || app.replaced || rec || app.state !== 'speaking') return;
    let cut = false;
    heard = '';
    const r = rec = new SR();
    r.bargeIn = true;
    r.lang = 'es-AR';
    r.interimResults = true;
    r.continuous = false;
    r.onresult = (e) => {
      const w = words(Array.from(e.results).map((x) => x[0].transcript).join(' '));
      if (!cut) {
        const foreign = w.filter((x) => !spoken.has(x));
        const isFinal = e.results[e.results.length - 1].isFinal;
        if (foreign.length < BARGE_MIN_WORDS && !foreign.some((x) => STOP_WORDS.includes(x))) {
          if (isFinal) dbg(`ignoro «${w.join(' ')}» · nuevas: [${foreign.join(', ')}]`);
          return;
        }
        dbg(`CORTO con «${w.join(' ')}» · nuevas: [${foreign.join(', ')}]`);
        cut = true;
        interrupt(); // corta la voz y la respuesta en curso
        setState('listening');
      }
      let i = 0;
      while (i < w.length && spoken.has(w[i])) i++; // descarta el eco del principio
      heard = w.slice(i).join(' ');
      $('sub-user').textContent = heard;
    };
    r.onerror = (e) => { if (e.error !== 'aborted') dbg(`error de escucha: ${e.error}`); };
    r.onend = () => {
      if (rec === r) rec = null;
      dbg(`fin de escucha (estado: ${app.state}${cut ? ', interrumpido' : ''})`);
      if (cut) {
        if (app.state !== 'listening') return;
        if (heard) ask(heard);
        else { setState('idle'); if (app.micOn) setTimeout(() => { if (app.state === 'idle' && app.micOn) startListening(); }, 250); }
      } else if (app.state === 'speaking') setTimeout(startBargeIn, 100); // sigue hablando: seguir atento
    };
    try { r.start(); dbg('escucho mientras hablo'); } catch { rec = null; }
  }

  function stopBargeIn() {
    if (!rec?.bargeIn) return;
    const r = rec; rec = null;
    r.onend = null; r.onresult = null;
    r.abort();
  }

  // Corta cualquier escucha en curso sin que dispare sus callbacks (otra cosa toma el micrófono)
  function dropRec() {
    if (!rec) return;
    const r = rec; rec = null;
    r.onend = null; r.onresult = null;
    r.abort();
  }

  function toggleMic() {
    app.micOn = !app.micOn; store.set('micOn', app.micOn); syncButtons();
    if (app.state === 'confirming') { if (app.micOn) listenForConfirm(); else if (rec) rec.abort(); return; }
    if (app.state === 'speaking') { if (app.micOn) startBargeIn(); else stopBargeIn(); return; }
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
    if (app.micOn) setTimeout(() => { if (app.state === 'idle') startListening(); }, 300); // si habló una tarea, no se la corta
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
    const c = $('cam-btn');
    c.textContent = app.camOn ? 'CÁMARA · ON' : 'CÁMARA · OFF';
    c.classList.toggle('on', app.camOn);
  }
  $('mode-btn').addEventListener('click', (e) => { e.currentTarget.blur(); toggleMic(); });
  $('mute-btn').addEventListener('click', (e) => {
    e.currentTarget.blur();
    app.muted = !app.muted; store.set('muted', app.muted); syncButtons();
    if (app.muted) { stopSpeaking(); maybeFinishSpeaking(); }
  });
  // NUEVA: el servidor cierra la sesión y avisa con `reset` (ahí se limpia la pantalla).
  // Si hay tareas en curso pide confirmar con el mismo panel y la misma escucha de sí/no.
  async function newConversation() {
    if (app.replaced) return;
    const stale = interrupt();
    try {
      if (stale) await stale;
      const res = await post('/api/new');
      if (res.status === 409) {
        const { running } = await res.json();
        dropRec();
        showConfirm({
          id: 'reset', app: 'NUEVA', action: '',
          title: `Hay ${running} ${running === 1 ? 'tarea' : 'tareas'} en curso y se van a cancelar`,
          detail: '',
          speech: `Hay ${running} ${running === 1 ? 'tarea' : 'tareas'} en curso y se van a cancelar. ¿Confirmás?`,
        });
      } else if (!res.ok) throw new Error('El servidor respondió ' + res.status);
    } catch (err) {
      console.error('No pude reiniciar la conversación', err);
      addLog('sys', 'No pude reiniciar la conversación: ' + err.message);
    }
  }
  $('reset-btn').addEventListener('click', (e) => {
    e.currentTarget.blur();
    newConversation();
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
  //  CÁMARA Y GESTOS (hands.js entrega la mano; gestures.js la convierte en eventos)
  // ============================================================
  const tracker = window.JarvisGestures?.createGestureTracker();
  const cam = { status: 'off', detail: '', hand: false };

  function setHandState() {
    const el = $('hand-state');
    let text = 'CÁMARA APAGADA';
    if (cam.status === 'loading') text = 'CÁMARA · INICIANDO';
    else if (cam.status === 'on') text = cam.hand ? 'MANO DETECTADA' : 'SIN MANO';
    else if (cam.status === 'denied') text = 'GESTOS NO DISPONIBLES: SIN PERMISO DE CÁMARA';
    else if (cam.status === 'no-model') text = 'GESTOS NO DISPONIBLES: corré npm run modelo';
    else if (cam.status === 'error') text = 'GESTOS NO DISPONIBLES: ' + (cam.detail || 'ERROR').slice(0, 60);
    el.textContent = text;
    el.classList.toggle('present', cam.status === 'on' && cam.hand);
    el.classList.toggle('unavailable', ['denied', 'no-model', 'error'].includes(cam.status));
  }

  function startCam() {
    if (!window.JarvisHands || !tracker || app.replaced) { if (!window.JarvisHands) { cam.status = 'error'; cam.detail = 'sin módulo de manos'; setHandState(); } return; }
    JarvisHands.start({
      onFrame: (t, hand) => {
        if (DEBUG) cam.x = hand ? JarvisGestures.palmCenter(hand).x : null;
        for (const ev of tracker.update({ t, hand })) onGesture(ev);
      },
      onStatus: (status, detail) => {
        cam.status = status; cam.detail = detail || '';
        if (status !== 'on') cam.hand = false;
        if (status !== 'on' && status !== 'loading') console.warn('Gestos:', status, detail || '');
        setHandState();
      },
    });
  }

  function stopCam() {
    window.JarvisHands?.stop();
    tracker?.reset();
    onGesture({ type: 'release' }); // lo que estuviera agarrado vuelve a su lugar
    cam.status = 'off'; cam.hand = false;
    setHandState();
  }

  function toggleCam() {
    app.camOn = !app.camOn; store.set('camOn', app.camOn); syncButtons();
    if (app.camOn) startCam(); else stopCam();
  }

  // Un evento del rastreador: la presencia la muestra el indicador; el pellizco mueve el núcleo y el giro, el carrusel
  function onGesture(ev) {
    if (ev.type === 'hand') { cam.hand = ev.present; setHandState(); return; }
  }

  $('cam-btn').addEventListener('click', (e) => { e.currentTarget.blur(); toggleCam(); });
  // C: prende/apaga la cámara (no mientras escribís ni durante el arranque)
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyC' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || document.activeElement === $('text-input') || app.state === 'boot') return;
    toggleCam();
  });
  // ?debug: tiempo medio de detección de manos cada 5 s, y la x de la palma (si al mover la mano hacia tu
  // izquierda sube en vez de bajar, la webcam ya viene espejada: hay que sacar el unmirror en hands.js)
  if (DEBUG) {
    setInterval(() => {
      if (cam.status !== 'on') return;
      const s = JarvisHands.takeStats();
      console.log(`[cam] detectForVideo ${s.avgMs.toFixed(1)} ms promedio · ${s.frames} cuadros en 5 s`);
    }, 5000);
    setInterval(() => { if (cam.status === 'on' && cam.x != null) console.log(`[cam] palma x=${cam.x.toFixed(2)}`); }, 500);
  }

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

  const GREETING = `Hola${USER ? ' ' + USER : ''}, ¿cómo estás?`;

  async function boot() {
    syncButtons(); updateTelemetry();
    connectEvents();
    // ?skip salta la animación (útil al recargar); el audio se habilita con el primer clic o tecla
    if (new URLSearchParams(location.search).has('skip')) { setState('idle'); if (app.micOn) startListening(); if (app.camOn) startCam(); return; }
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
    await wait(600);
    // Entra solo al terminar la animación, sin botón
    setState('idle');
    ensureMicMeter();
    if (app.camOn) startCam();
    const intro = `${GREETING}${app.micOn ? '' : ' El micrófono está apagado, tocá la barra espaciadora para prenderlo.'}`;
    $('sub-ai').textContent = intro;
    addLog('ai', intro);
    app.greetPending = true; // el primer mensaje le avisa a Claude que ya saludó
    streamDone = true;
    setState('speaking');
    if (app.muted) setState('idle');
    speak(intro);
    // Chrome bloquea la síntesis de voz sin un gesto previo: si el saludo no sonó, se repite con el primer clic o tecla
    setTimeout(() => {
      if (!synth || app.muted || synth.speaking || synth.pending) return;
      const retry = (e) => {
        if (e.code === 'Space') return; // la barra espaciadora ya tiene su propio uso (micrófono)
        removeEventListener('pointerdown', retry); removeEventListener('keydown', retry);
        if (app.state !== 'idle' && app.state !== 'listening') return; // ya arrancó la conversación
        // Cortar la escucha mientras habla: si no, el micrófono capta su propia voz como si fuera tuya
        setState('speaking');
        if (rec) rec.abort();
        streamDone = true;
        speak(intro);
      };
      addEventListener('pointerdown', retry); addEventListener('keydown', retry);
    }, 1200);
  }
  boot();
})();
