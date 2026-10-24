const test = require('node:test');
const assert = require('node:assert/strict');
const { createInputQueue, mapMessage, Session } = require('../src/session');

const init = { type: 'system', subtype: 'init', session_id: 'sid-1', model: 'haiku' };
const delta = (text, parent = null) => ({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const success = { type: 'result', subtype: 'success', session_id: 'sid-1', result: 'ok' };
const mkState = () => ({ userSince: false, taskSince: false, interrupting: false, turnStartedAt: Date.now(), sessionId: null, tasks: [] });

test('createInputQueue entrega en orden lo enviado antes y después de iterar', async () => {
  const q = createInputQueue();
  q.push('a');
  q.push('b');
  const it = q.iterable[Symbol.asyncIterator]();
  assert.equal((await it.next()).value.message.content, 'a');
  assert.deepEqual((await it.next()).value, { type: 'user', message: { role: 'user', content: 'b' }, parent_tool_use_id: null, session_id: '' });
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
  // las banderas se limpian: el siguiente init vuelve a ser 'user'
  assert.deepEqual(mapMessage(init, state)[0], ['turn', { origin: 'user' }]);
});

test('si la persona escribió, el origen es user aunque haya llegado una tarea', () => {
  const state = mkState();
  state.taskSince = true;
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
  const calls = { interrupt: 0, stopTask: [], close: 0, args: null };
  let release;
  const gate = new Promise((r) => { release = r; });
  const queryFn = (args) => {
    calls.args = args;
    return {
      async *[Symbol.asyncIterator]() { for (const m of script) yield m; await gate; },
      async interrupt() { calls.interrupt++; },
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
  const { queryFn, calls } = fakeQuery();
  const events = [];
  const s = new Session({ config, emit: (e, d) => events.push([e, d]), sdk: fakeSdk, queryFn });
  s.start({});
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
