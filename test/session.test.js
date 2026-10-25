const test = require('node:test');
const assert = require('node:assert/strict');
const { createInputQueue, mapMessage, Session } = require('../src/session');

const init = { type: 'system', subtype: 'init', session_id: 'sid-1', model: 'haiku' };
const delta = (text, parent = null) => ({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const success = { type: 'result', subtype: 'success', session_id: 'sid-1', result: 'ok' };
const mkState = () => ({ userSince: false, taskPending: 0, interrupting: false, turnStartedAt: Date.now(), sessionId: null, tasks: [] });

test('createInputQueue entrega en orden lo enviado antes y después de iterar', async () => {
  const q = createInputQueue();
  q.push('a');
  q.push('b');
  const it = q.iterable[Symbol.asyncIterator]();
  assert.equal((await it.next()).value.message.content, 'a');
  const b = (await it.next()).value;
  assert.match(b.uuid, /^[0-9a-f-]{36}$/); // el uuid permite cancelar el mensaje en el SDK
  assert.deepEqual({ ...b, uuid: undefined }, { type: 'user', message: { role: 'user', content: 'b' }, parent_tool_use_id: null, session_id: '', uuid: undefined });
  const pending = it.next();
  q.push('c');
  assert.equal((await pending).value.message.content, 'c');
  q.close();
  assert.equal((await it.next()).done, true);
});

test('mapMessage: secuencia del spike da turn, init, delta, done', () => {
  const state = mkState();
  state.userSince = true;
  const out = [init, delta('Hola'), success].flatMap((m) => mapMessage(m, state));
  assert.deepEqual(out.map(([e]) => e), ['turn', 'init', 'delta', 'done']);
  assert.deepEqual(out[0][1], { origin: 'user' });
  assert.deepEqual(out[1][1], { sessionId: 'sid-1', model: 'haiku' });
  assert.deepEqual(out[2][1], { text: 'Hola' });
  assert.equal(out[3][1].sessionId, 'sid-1');
  assert.equal(typeof out[3][1].ms, 'number');
});

test('task turn origin: task_notification y luego init sin send da origin task', () => {
  const state = mkState();
  mapMessage({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'listo' }, state);
  assert.deepEqual(mapMessage(init, state)[0], ['turn', { origin: 'task' }]);
  // consumida la notificación, el siguiente init vuelve a ser 'user'
  assert.deepEqual(mapMessage(init, state)[0], ['turn', { origin: 'user' }]);
});

test('si la persona escribió, el origen es user aunque haya llegado una tarea', () => {
  const state = mkState();
  state.taskPending = 1;
  state.userSince = true;
  assert.deepEqual(mapMessage(init, state)[0], ['turn', { origin: 'user' }]);
});

test('un delta con parent_tool_use_id (subagente) no emite nada', () => {
  assert.deepEqual(mapMessage(delta('x', 'abc'), mkState()), []);
});

test('mapMessage: tool_use del orquestador emite tool', () => {
  const msg = { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'WebSearch' } } };
  assert.deepEqual(mapMessage(msg, mkState()), [['tool', { app: 'búsqueda web', action: '' }]]);
});

test('mapMessage: task_started y background_tasks_changed', () => {
  const state = mkState();
  assert.deepEqual(
    mapMessage({ type: 'system', subtype: 'task_started', task_id: 't1', description: 'investigar', subagent_type: 'lento' }, state),
    [['task', { id: 't1', status: 'running', description: 'investigar', agent: 'lento' }]],
  );
  const out = mapMessage({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', description: 'investigar', subagent_type: 'lento' }] }, state);
  assert.deepEqual(out, [['tasks', { tasks: [{ id: 't1', description: 'investigar', agent: 'lento' }] }]]);
  assert.equal(state.tasks.length, 1);
});

test('mapMessage: result interrumpido, otros errores y limpieza de la bandera', () => {
  const state = mkState();
  state.interrupting = true;
  const err = { type: 'result', subtype: 'error_during_execution', session_id: 'sid-1', errors: ['x'] };
  assert.deepEqual(mapMessage(err, state), [['done', { sessionId: 'sid-1', interrupted: true }]]);
  assert.equal(state.interrupting, false);
  assert.deepEqual(mapMessage(err, state), [['error', { message: 'x' }]]);
});

// query falsa: emite el guion y queda viva hasta close(), con espías en interrupt/stopTask/close
function fakeQuery(script = []) {
  const calls = { interrupt: 0, interruptArgs: [], cancelled: [], stopTask: [], close: 0, args: null };
  let release;
  const gate = new Promise((r) => { release = r; });
  const queryFn = (args) => {
    calls.args = args;
    return {
      async *[Symbol.asyncIterator]() { for (const m of script) yield m; await gate; },
      async interrupt(opts) { calls.interrupt++; calls.interruptArgs.push(opts); return calls.interruptResult; },
      async cancelAsyncMessage(id) { calls.cancelled.push(id); },
      async stopTask(id) { calls.stopTask.push(id); },
      close() { calls.close++; release(); },
    };
  };
  return { queryFn, calls };
}
const fakeSdk = { createSdkMcpServer: () => ({}), tool: () => ({}) };
const config = { timezone: 'America/Argentina/Buenos_Aires', confirmTimeoutMs: 5000, googleAccount: '' };
const tick = () => new Promise((r) => setImmediate(r));

test('Session emite los eventos de la query', async () => {
  const { queryFn } = fakeQuery([init, delta('Hola'), success]);
  const events = [];
  const s = new Session({ config, emit: (e) => events.push(e), sdk: fakeSdk, queryFn });
  s.start({});
  s.send('hola');
  await tick();
  assert.deepEqual(events, ['turn', 'init', 'delta', 'done']);
  assert.equal(s.sessionId, 'sid-1');
  s.close();
});

test('send antes de que arranque la query no se pierde y lleva la fecha', async () => {
  const { queryFn, calls } = fakeQuery();
  const s = new Session({ config, emit: () => {}, sdk: fakeSdk, queryFn });
  s.send('hola');
  s.start({});
  const first = (await calls.args.prompt[Symbol.asyncIterator]().next()).value;
  assert.match(first.message.content, /^\[Fecha y hora actual: .+\]\nhola$/);
  s.close();
});

test('send con una vista abierta agrega la línea de la vista después de la fecha', async () => {
  const { queryFn, calls } = fakeQuery();
  const s = new Session({ config, emit: () => {}, sdk: fakeSdk, queryFn });
  s.send('respondé el segundo', { face: 'mail', threads: [{ id: 't1', from: 'Ana', subject: 'Hola', unread: true }, { id: 't2', from: 'Beto', subject: 'Factura', unread: false }] });
  s.start({});
  const first = (await calls.args.prompt[Symbol.asyncIterator]().next()).value;
  assert.match(first.message.content, /^\[Fecha y hora actual: .+\]\n\[Vista en pantalla: Mail;.+\]\nrespondé el segundo$/);
  s.close();
});

test('start: resume solo con UUID válido y sin abortController', () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  const a = fakeQuery();
  const sa = new Session({ config, emit: () => {}, sdk: fakeSdk, queryFn: a.queryFn });
  sa.start({ resumeId: uuid });
  assert.equal(a.calls.args.options.resume, uuid);
  assert.equal(a.calls.args.options.perTaskStopAffordance, true);
  assert.equal(a.calls.args.options.abortController, undefined);
  const b = fakeQuery();
  const sb = new Session({ config, emit: () => {}, sdk: fakeSdk, queryFn: b.queryFn });
  sb.start({ resumeId: 'no-valido' });
  assert.equal(b.calls.args.options.resume, undefined);
  sa.close();
  sb.close();
});

test('interrupt denies pending confirms', async () => {
  const { queryFn, calls } = fakeQuery([init]);
  const events = [];
  const s = new Session({ config, emit: (e, d) => events.push([e, d]), sdk: fakeSdk, queryFn });
  s.start({});
  await tick(); // hay un turno de la persona en curso
  const decision = calls.args.options.canUseTool('mcp__claude_ai_Gmail__send_message', { to: 'a@b.c' }, {});
  assert.equal(events.filter(([e]) => e === 'confirm').length, 1);
  await s.interrupt();
  assert.equal((await decision).behavior, 'deny');
  assert.equal(calls.interrupt, 1);
  s.close();
});

test('stopTask delega en la query y close la cierra', async () => {
  const { queryFn, calls } = fakeQuery();
  const s = new Session({ config, emit: () => {}, sdk: fakeSdk, queryFn });
  s.start({});
  await s.stopTask('t1');
  assert.deepEqual(calls.stopTask, ['t1']);
  s.close();
  assert.equal(calls.close, 1);
  assert.equal(s.closed, true);
});

test('si la query termina sola emite error y queda cerrada', async () => {
  const events = [];
  const queryFn = () => ({ async *[Symbol.asyncIterator]() { yield init; } });
  const s = new Session({ config, emit: (e, d) => events.push([e, d]), sdk: fakeSdk, queryFn });
  s.start({});
  await tick();
  assert.equal(events.at(-1)[0], 'error');
  assert.equal(s.closed, true);
});

test('si la query lanza, emite error con el mensaje', async () => {
  const events = [];
  const queryFn = () => ({ async *[Symbol.asyncIterator]() { throw new Error('boom'); } });
  const s = new Session({ config, emit: (e, d) => events.push([e, d]), sdk: fakeSdk, queryFn });
  s.start({});
  await tick();
  assert.deepEqual(events, [['error', { message: 'boom' }]]);
  assert.equal(s.closed, true);
});

test('interrupt sin turno activo no deja la bandera: un error posterior no es "interrumpido"', async () => {
  const { queryFn } = fakeQuery([]);
  const s = new Session({ config, emit: () => {}, sdk: fakeSdk, queryFn });
  s.start({});
  await s.interrupt(); // no hay turno en curso
  assert.equal(s.state.interrupting, false);
  s.close();
});

test('interrupt con turno activo marca la bandera y result la limpia', async () => {
  const { queryFn } = fakeQuery([init]);
  const s = new Session({ config, emit: () => {}, sdk: fakeSdk, queryFn });
  s.start({});
  await tick();
  assert.equal(s.state.turnActive, true);
  await s.interrupt();
  assert.equal(s.state.interrupting, true);
  mapMessage(success, s.state);
  assert.equal(s.state.turnActive, false);
  assert.equal(s.state.interrupting, false);
  s.close();
});

test('si q.interrupt rechaza, la bandera se limpia', async () => {
  const queryFn = () => ({
    async *[Symbol.asyncIterator]() { yield init; await new Promise(() => {}); },
    async interrupt() { throw new Error('no'); },
    close() {},
  });
  const s = new Session({ config, emit: () => {}, sdk: fakeSdk, queryFn });
  s.start({});
  await tick();
  await assert.rejects(s.interrupt(), /no/);
  assert.equal(s.state.interrupting, false);
});

test('si la query termina sola, la cola de entrada se cierra', async () => {
  const queryFn = () => ({ async *[Symbol.asyncIterator]() { throw new Error('boom'); } });
  const s = new Session({ config, emit: () => {}, sdk: fakeSdk, queryFn });
  s.start({});
  await tick();
  s.send('tarde'); // no debe quedar encolado
  const it = s.queue.iterable[Symbol.asyncIterator]();
  assert.equal((await it.next()).done, true);
});

test('getters tasks y model reflejan el estado', async () => {
  const { queryFn } = fakeQuery([init, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', description: 'd', subagent_type: 'a' }] }]);
  const s = new Session({ config, emit: () => {}, sdk: fakeSdk, queryFn });
  s.start({});
  await tick();
  assert.equal(s.model, 'haiku');
  assert.deepEqual(s.tasks, [{ id: 't1', description: 'd', agent: 'a' }]);
  s.close();
});

test('con la sesión cerrada no emite los mensajes que siguen llegando', async () => {
  const events = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const queryFn = () => ({
    async *[Symbol.asyncIterator]() { yield init; await gate; yield delta('viejo'); yield success; },
    close() {},
  });
  const s = new Session({ config, emit: (e, d) => events.push([e, d]), sdk: fakeSdk, queryFn });
  s.start({});
  await tick();
  s.close();
  release();
  await tick();
  assert.deepEqual(events.map(([e]) => e), ['turn', 'init']); // nada después del cierre, ni siquiera un error
});

const taskInit = { type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'listo' };

test('interrupt en turno de la persona: interrupt simple, cancela solo still_queued que mandó la persona', async () => {
  const { queryFn, calls } = fakeQuery([init]);
  const s = new Session({ config, emit: () => {}, sdk: fakeSdk, queryFn });
  s.start({});
  await tick();
  const it = s.queue.iterable[Symbol.asyncIterator]();
  const u1 = s.send('a'); await it.next(); // ya lo tomó el SDK
  const u2 = s.send('b'); await it.next(); // ya lo tomó el SDK
  s.send('c'); // este queda sin entregar: se descarta local
  calls.interruptResult = { still_queued: [u2, 'notificacion-de-tarea'] };
  const decision = calls.args.options.canUseTool('mcp__claude_ai_Gmail__send_message', { to: 'a@b.c' }, {});
  await s.interrupt();
  assert.equal((await decision).behavior, 'deny');
  assert.deepEqual(calls.interruptArgs, [undefined]); // sin cancelQueued
  assert.deepEqual(calls.cancelled, [u2]); // ni u1 (ya corrió) ni la notificación (no es nuestra)
  assert.equal(s.state.interrupting, true);
  assert.deepEqual(s.pushed, []);
  assert.equal(s.state.userSince, false);
  s.queue.close();
  assert.equal((await it.next()).done, true); // 'c' nunca sale hacia el SDK
  s.close();
});

test('interrupt en turno de tarea: no aborta ni deniega, cancela por uuid los mensajes recordados', async () => {
  const { queryFn, calls } = fakeQuery([taskInit, init]);
  const s = new Session({ config, emit: () => {}, sdk: fakeSdk, queryFn });
  s.start({});
  await tick();
  assert.equal(s.state.turnOrigin, 'task');
  const u1 = s.send('a');
  const u2 = s.send('b');
  const it = s.queue.iterable[Symbol.asyncIterator]();
  await it.next(); await it.next(); // el SDK ya tomó los dos: solo se pueden cancelar por uuid
  let decided = false;
  calls.args.options.canUseTool('mcp__claude_ai_Gmail__send_message', { to: 'a@b.c' }, {}).then(() => { decided = true; });
  await s.interrupt();
  await tick();
  assert.equal(calls.interrupt, 0);
  assert.equal(decided, false); // la confirmación de la tarea sigue pendiente
  assert.deepEqual(calls.cancelled, [u1, u2]);
  assert.equal(s.state.interrupting, false);
  assert.deepEqual(s.pushed, []);
  s.close();
});

test('interrupt sin turno activo: no interrumpe, cancela por uuid lo enviado y limpia la cola local', async () => {
  const { queryFn, calls } = fakeQuery([]);
  const s = new Session({ config, emit: () => {}, sdk: fakeSdk, queryFn });
  s.start({});
  const it = s.queue.iterable[Symbol.asyncIterator]();
  const u1 = s.send('a'); await it.next();
  s.send('b'); // sin entregar
  await s.interrupt();
  assert.equal(calls.interrupt, 0);
  assert.deepEqual(calls.cancelled, [u1]);
  assert.equal(s.state.userSince, false);
  s.queue.close();
  assert.equal((await it.next()).done, true);
  s.close();
});

test('origen: una notificación sigue valiendo para un turno posterior aunque antes corra uno de la persona', () => {
  const state = mkState();
  mapMessage({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'x' }, state);
  state.userSince = true; // la persona pregunta antes de que corra el turno de la tarea
  assert.deepEqual(mapMessage(init, state)[0], ['turn', { origin: 'user' }]);
  assert.deepEqual(mapMessage(init, state)[0], ['turn', { origin: 'task' }]);
  assert.deepEqual(mapMessage(init, state)[0], ['turn', { origin: 'user' }]);
});

test('interrupt en turno de tarea ignora el rechazo de un uuid ya consumido', async () => {
  const { queryFn, calls } = fakeQuery([taskInit, init]);
  const s = new Session({ config, emit: () => {}, sdk: fakeSdk, queryFn });
  s.start({});
  await tick();
  s.q.cancelAsyncMessage = async () => { throw new Error('ya consumido'); };
  s.send('a');
  await s.queue.iterable[Symbol.asyncIterator]().next();
  await s.interrupt(); // no lanza
  assert.equal(calls.interrupt, 0);
  s.close();
});

test('los uuid recordados se olvidan cuando arranca un turno de la persona', async () => {
  const { queryFn } = fakeQuery([init]);
  const s = new Session({ config, emit: () => {}, sdk: fakeSdk, queryFn });
  s.send('a'); // antes de arrancar: el primer init es de la persona
  assert.equal(s.pushed.length, 1);
  s.start({});
  await tick();
  assert.equal(s.state.turnOrigin, 'user');
  assert.deepEqual(s.pushed, []);
  s.close();
});
