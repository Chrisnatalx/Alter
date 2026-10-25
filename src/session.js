// Sesión viva con Claude: una sola query de larga duración alimentada por una cola de entrada.
// Los mensajes de la persona se empujan a la cola; los de Claude salen como eventos para la interfaz.

const { buildAgentOptions } = require('./agent-options');
const { createPermissionGate, describeTool } = require('./permissions');
const { createJarvisTools } = require('./tools');
const { nowLine, viewLine } = require('./prompt');
const crypto = require('crypto');

const UUID = /^[0-9a-f-]{36}$/i;

// Cola async: `push` puede llamarse antes o después de que alguien empiece a iterar.
function createInputQueue() {
  const items = [];
  let wake = null;
  let closed = false;
  const notify = () => { if (wake) { const w = wake; wake = null; w(); } };
  async function* iterate() {
    for (;;) {
      while (items.length) yield items.shift();
      if (closed) return;
      await new Promise((r) => { wake = r; });
    }
  }
  return {
    // Devuelve el uuid del mensaje (el SDK lo respeta y permite cancelarlo por él), o null si ya está cerrada
    push(text) {
      if (closed) return null;
      const uuid = crypto.randomUUID();
      items.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '', uuid });
      notify();
      return uuid;
    },
    // Descarta lo que todavía no se le entregó al SDK; devuelve los uuid descartados
    clear() { return items.splice(0).map((i) => i.uuid); },
    close() { closed = true; notify(); },
    iterable: iterate(),
  };
}

function createState() {
  return { userSince: false, taskPending: 0, interrupting: false, turnActive: false, turnOrigin: null, turnStartedAt: 0, sessionId: null, model: null, tasks: [] };
}

// Traduce un mensaje del SDK a eventos para la interfaz. Pura salvo por `state`, que se muta.
function mapMessage(msg, state) {
  if (msg.type === 'system') {
    switch (msg.subtype) {
      case 'init': {
        // La persona escribió → turno suyo; si no, uno por cada notificación de tarea aún sin turno; si no, suyo
        let origin = 'user';
        if (state.userSince) state.userSince = false;
        else if (state.taskPending > 0) { state.taskPending--; origin = 'task'; }
        state.turnStartedAt = Date.now();
        state.turnActive = true; // hay un turno en curso hasta que llegue su result
        state.turnOrigin = origin;
        state.sessionId = msg.session_id;
        state.model = msg.model;
        return [['turn', { origin }], ['init', { sessionId: msg.session_id, model: msg.model }]];
      }
      case 'task_started':
        return [['task', { id: msg.task_id, status: 'running', description: msg.description, agent: msg.subagent_type }]];
      case 'task_notification':
        state.taskPending++; // un turno que sigue lo arranca la tarea, no la persona
        return [['task', { id: msg.task_id, status: msg.status, summary: msg.summary }]];
      case 'background_tasks_changed':
        state.tasks = (msg.tasks || []).map((t) => ({ id: t.task_id, description: t.description, agent: t.subagent_type }));
        return [['tasks', { tasks: state.tasks }]];
      default:
        return [];
    }
  }
  if (msg.type === 'stream_event') {
    if (msg.parent_tool_use_id != null) return []; // texto y herramientas de un subagente: no se leen en voz alta
    const ev = msg.event;
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') return [['delta', { text: ev.delta.text }]];
    if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      if (ev.content_block.id) (state.toolUses ||= new Map()).set(ev.content_block.id, ev.content_block.name);
      return [['tool', describeTool(ev.content_block.name)]];
    }
    return [];
  }
  // Resultado de una herramienta del orquestador: dice si de verdad corrió (una denegación vuelve como error).
  // Lo usa el servidor para refrescar las vistas solo después de una escritura que se hizo.
  if (msg.type === 'user' && msg.parent_tool_use_id == null && Array.isArray(msg.message?.content)) {
    const out = [];
    for (const b of msg.message.content) {
      const name = b?.type === 'tool_result' && state.toolUses?.get(b.tool_use_id);
      if (!name) continue;
      state.toolUses.delete(b.tool_use_id);
      out.push(['tool_result', { ...describeTool(name), ok: !b.is_error }]);
    }
    return out;
  }
  if (msg.type === 'result') {
    const interrupting = state.interrupting;
    state.interrupting = false;
    state.turnActive = false;
    const sessionId = msg.session_id || state.sessionId;
    if (msg.subtype === 'success' && !msg.is_error) return [['done', { sessionId, ms: Date.now() - state.turnStartedAt }]];
    if (msg.subtype === 'error_during_execution' && interrupting) return [['done', { sessionId, interrupted: true }]];
    return [['error', { message: msg.result || msg.errors?.join(' ') || 'Error de Claude' }]];
  }
  return [];
}

class Session {
  constructor({ config, emit, sdk, queryFn = sdk.query }) {
    this.config = config;
    this.emit = emit;
    this.queryFn = queryFn;
    this.queue = createInputQueue();
    this.state = createState();
    this.gate = createPermissionGate({ emit, timeoutMs: config.confirmTimeoutMs });
    this.tools = createJarvisTools(sdk, { emit, googleAccount: config.googleAccount });
    this.q = null;
    this._closed = false;
    this.pushed = []; // uuid de mensajes enviados desde el último turno de la persona: pueden seguir en cola
  }

  get sessionId() { return this.state.sessionId; }
  get closed() { return this._closed; }
  get model() { return this.state.model; }
  get tasks() { return this.state.tasks; }

  start({ resumeId } = {}) {
    if (this.q) return;
    const options = buildAgentOptions({
      config: this.config,
      canUseTool: this.gate.canUseTool,
      mcpServers: { jarvis: this.tools },
    });
    if (resumeId && UUID.test(resumeId)) options.resume = resumeId;
    this.q = this.queryFn({ prompt: this.queue.iterable, options });
    this._consume();
  }

  async _consume() {
    try {
      for await (const msg of this.q) {
        // Con la sesión cerrada (p. ej. tras NUEVA) lo que aún llega es viejo: se procesa pero no se emite
        const events = mapMessage(msg, this.state);
        if (msg.type === 'system' && msg.subtype === 'init' && this.state.turnOrigin === 'user') this.pushed = [];
        if (!this._closed) for (const [event, data] of events) this.emit(event, data);
      }
      if (!this._closed) this.emit('error', { message: 'La sesión terminó inesperadamente.' });
    } catch (err) {
      if (!this._closed) this.emit('error', { message: err.message || String(err) });
    }
    this._closed = true; // el servidor crea una sesión nueva cuando esta ya no sirve
    this.queue.close(); // y un send() tardío no queda encolado hacia nadie
    this.gate.denyAll();
  }

  // `view`: la cara del carrusel que mira la persona (opcional); va como contexto después de la fecha
  send(text, view) {
    this.state.userSince = true;
    const vl = viewLine(view);
    const uuid = this.queue.push(`[Fecha y hora actual: ${nowLine(this.config.timezone)}]\n${vl ? vl + '\n' : ''}${text}`);
    if (uuid) this.pushed.push(uuid);
    return uuid;
  }

  // Corta el turno de la persona y descarta los mensajes suyos que aún esperan; las tareas en segundo plano
  // y sus notificaciones siguen (una cancelación masiva de la cola también descartaría esas notificaciones).
  async interrupt() {
    const st = this.state;
    const local = this.queue.clear(); // lo que no salió hacia el SDK no debe salir nunca
    this.pushed = this.pushed.filter((id) => !local.includes(id));
    if (!this.q) { st.userSince = false; return; }
    // Un uuid ya consumido o inexistente rechaza la cancelación: no importa
    const cancel = (ids) => Promise.all(ids.map((id) => Promise.resolve().then(() => this.q.cancelAsyncMessage(id)).catch(() => {})));
    if (st.turnActive && st.turnOrigin !== 'task') {
      this.gate.denyAll();
      st.interrupting = true;
      let r;
      try { r = await this.q.interrupt(); } catch (err) { st.interrupting = false; throw err; }
      // El recibo lista lo que quedó en cola sin correr: se cancela solo lo que mandó la persona
      const still = new Set(r?.still_queued || []);
      const ids = this.pushed.filter((id) => still.has(id));
      this.pushed = [];
      await cancel(ids);
    } else {
      // Turno de tarea o ninguno: no se aborta nada; solo se cancelan los mensajes de la persona que esperan
      await cancel(this.pushed.splice(0));
    }
    st.userSince = false; // lo que esperaba su turno se descartó: el próximo turno no es de la persona
  }

  async stopTask(taskId) { await this.q?.stopTask(taskId); }

  runningTasks() { return this.state.tasks.length; }

  confirm(id, allow) { return this.gate.confirm(id, allow); }

  pendingConfirms() { return this.gate.pending(); }

  close() {
    this._closed = true;
    this.queue.close();
    this.gate.denyAll();
    this.q?.close?.();
  }
}

module.exports = { createInputQueue, mapMessage, Session };
