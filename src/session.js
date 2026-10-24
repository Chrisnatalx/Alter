// Sesión viva con Claude: una sola query de larga duración alimentada por una cola de entrada.
// Los mensajes de la persona se empujan a la cola; los de Claude salen como eventos para la interfaz.

const { buildAgentOptions } = require('./agent-options');
const { createPermissionGate, describeTool } = require('./permissions');
const { createJarvisTools } = require('./tools');
const { nowLine } = require('./prompt');

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
    push(text) {
      if (closed) return;
      items.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' });
      notify();
    },
    close() { closed = true; notify(); },
    iterable: iterate(),
  };
}

function createState() {
  return { userSince: false, taskSince: false, interrupting: false, turnActive: false, turnStartedAt: 0, sessionId: null, model: null, tasks: [] };
}

// Traduce un mensaje del SDK a eventos para la interfaz. Pura salvo por `state`, que se muta.
function mapMessage(msg, state) {
  if (msg.type === 'system') {
    switch (msg.subtype) {
      case 'init': {
        const origin = state.userSince ? 'user' : state.taskSince ? 'task' : 'user';
        state.userSince = false;
        state.taskSince = false;
        state.turnStartedAt = Date.now();
        state.turnActive = true; // hay un turno en curso hasta que llegue su result
        state.sessionId = msg.session_id;
        state.model = msg.model;
        return [['turn', { origin }], ['init', { sessionId: msg.session_id, model: msg.model }]];
      }
      case 'task_started':
        return [['task', { id: msg.task_id, status: 'running', description: msg.description, agent: msg.subagent_type }]];
      case 'task_notification':
        state.taskSince = true; // el turno que sigue lo arranca la tarea, no la persona
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
    if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') return [['tool', describeTool(ev.content_block.name)]];
    return [];
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

  send(text) {
    this.state.userSince = true;
    this.queue.push(`[Fecha y hora actual: ${nowLine(this.config.timezone)}]\n${text}`);
  }

  // Corta solo el turno actual: las tareas en segundo plano siguen.
  async interrupt() {
    this.gate.denyAll();
    if (!this.q) return;
    // Sin turno en curso no hay nada que cortar: marcar la bandera haría pasar un error real por interrupción
    if (this.state.turnActive) this.state.interrupting = true;
    try { await this.q.interrupt(); } catch (err) { this.state.interrupting = false; throw err; }
  }

  async stopTask(taskId) { await this.q?.stopTask(taskId); }

  runningTasks() { return this.state.tasks.length; }

  confirm(id, allow) { return this.gate.confirm(id, allow); }

  close() {
    this._closed = true;
    this.queue.close();
    this.gate.denyAll();
    this.q?.close?.();
  }
}

module.exports = { createInputQueue, mapMessage, Session };
