const test = require('node:test');
const assert = require('node:assert/strict');
const { describeTool, needsConfirm, createPermissionGate } = require('../src/permissions');

test('needsConfirm: acciones que envían o borran piden confirmación', () => {
  for (const t of ['mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Gmail__trash_thread', 'mcp__claude_ai_GitHub__merge_pull_request']) {
    assert.equal(needsConfirm(t, {}), true, t);
  }
  assert.equal(needsConfirm('mcp__claude_ai_Google_Calendar__create_event', { attendees: ['a@b.c'] }), true);
});

test('needsConfirm: lectura, borradores y herramientas propias no', () => {
  for (const t of ['mcp__claude_ai_Gmail__create_draft', 'mcp__claude_ai_Google_Calendar__list_events', 'WebSearch', 'mcp__alter__abrir_en_navegador']) {
    assert.equal(needsConfirm(t, {}), false, t);
  }
});

test('describeTool separa app y acción', () => {
  assert.deepEqual(describeTool('mcp__claude_ai_Google_Calendar__create_event'), { app: 'Google Calendar', action: 'create event' });
});

const SEND = 'mcp__claude_ai_Gmail__send_message';
const mkGate = (timeoutMs = 5000) => {
  const events = [];
  const gate = createPermissionGate({ emit: (e, d) => events.push([e, d]), timeoutMs });
  return { gate, events };
};

test('subagent send is denied without asking', async () => {
  const { gate, events } = mkGate();
  const r = await gate.canUseTool(SEND, {}, { agentID: 'x', signal: new AbortController().signal });
  assert.equal(r.behavior, 'deny');
  assert.equal(events.some(([e]) => e === 'confirm'), false);
  assert.equal(gate.pendingCount(), 0);
});

test('confirm resolves allow', async () => {
  const { gate, events } = mkGate();
  const p = gate.canUseTool(SEND, { to: 'x' }, {});
  assert.equal(events[0][0], 'confirm');
  assert.equal(gate.confirm(events[0][1].id, true), true);
  assert.equal((await p).behavior, 'allow');
  assert.equal(gate.confirm('nope', true), false);
});

test('denyAll', async () => {
  const { gate } = mkGate();
  const a = gate.canUseTool(SEND, {}, {});
  const b = gate.canUseTool(SEND, {}, {});
  assert.equal(gate.pendingCount(), 2);
  gate.denyAll();
  assert.equal((await a).behavior, 'deny');
  assert.equal((await b).behavior, 'deny');
  assert.equal(gate.pendingCount(), 0);
});

test('timeout denies', async () => {
  const { gate } = mkGate(20);
  assert.equal((await gate.canUseTool(SEND, {}, {})).behavior, 'deny');
});

test('abort signal denies', async () => {
  const { gate } = mkGate();
  const ac = new AbortController();
  const p = gate.canUseTool(SEND, {}, { signal: ac.signal });
  ac.abort();
  assert.equal((await p).behavior, 'deny');
});

const CAL = (a) => `mcp__claude_ai_Google_Calendar__${a}`;

test('needsConfirm: eventos con invitados (todos los campos) piden confirmación', () => {
  assert.equal(needsConfirm(CAL('create_event'), { attendeeEmails: ['a@b.c'] }), true);
  assert.equal(needsConfirm(CAL('create_event'), { attendees: [{ email: 'a@b.c' }] }), true);
  assert.equal(needsConfirm(CAL('update_event'), { addedAttendees: [{ email: 'a@b.c' }], notificationLevel: 'NONE' }), true);
  assert.equal(needsConfirm(CAL('update_event'), { addedAttendeeEmails: ['a@b.c'], notificationLevel: 'NONE' }), true);
});

test('needsConfirm: crear un evento sin invitados no pide confirmación', () => {
  assert.equal(needsConfirm(CAL('create_event'), { summary: 'x' }), false);
  assert.equal(needsConfirm(CAL('create_event'), { summary: 'x', attendees: [] }), false);
});

test('needsConfirm: update_event confirma salvo notificationLevel NONE sin invitados nuevos', () => {
  assert.equal(needsConfirm(CAL('update_event'), { eventId: '1', start: 'x' }), true); // por defecto avisa a todos
  assert.equal(needsConfirm(CAL('update_event'), { eventId: '1', notificationLevel: 'ALL' }), true);
  assert.equal(needsConfirm(CAL('update_event'), { eventId: '1', notificationLevel: 'EXTERNAL_ONLY' }), true);
  assert.equal(needsConfirm(CAL('update_event'), { eventId: '1', notificationLevel: 'NONE' }), false);
  assert.equal(needsConfirm(CAL('update_event'), { eventId: '1', notificationLevel: 'NONE', addedAttendees: [] }), false);
});

test('needsConfirm: responder a una invitación (RSVP) pide confirmación', () => {
  assert.equal(needsConfirm(CAL('respond_to_event'), { eventId: '1', responseStatus: 'accepted' }), true);
  assert.equal(needsConfirm(CAL('get_event'), {}), false);
});

test('needsConfirm: las herramientas de GitHub que publican piden confirmación; leer no', () => {
  for (const a of ['issue_write', 'sub_issue_write', 'create_pull_request', 'update_pull_request', 'create_or_update_file',
    'update_issue_comment', 'pull_request_review_write', 'add_comment_to_pending_review', 'create_repository',
    'fork_repository', 'push_files', 'merge_pull_request', 'add_issue_comment']) {
    assert.equal(needsConfirm(`mcp__claude_ai_GitHub__${a}`, {}), true, a);
  }
  for (const a of ['issue_read', 'list_issues', 'get_file_contents', 'search_code', 'pull_request_read', 'create_branch']) {
    assert.equal(needsConfirm(`mcp__claude_ai_GitHub__${a}`, {}), false, a);
  }
});

test('gate: confirm_closed sale por cada camino (respuesta, timeout, aborto, denyAll)', async () => {
  const closed = (events) => events.filter(([e]) => e === 'confirm_closed').map(([, d]) => d);
  { // respuesta
    const { gate, events } = mkGate();
    const p = gate.canUseTool(SEND, {}, {});
    const id = events[0][1].id;
    gate.confirm(id, true); await p;
    assert.deepEqual(closed(events), [{ id, allowed: true }]);
  }
  { // timeout
    const { gate, events } = mkGate(20);
    await gate.canUseTool(SEND, {}, {});
    assert.deepEqual(closed(events), [{ id: events[0][1].id, allowed: false }]);
  }
  { // aborto
    const { gate, events } = mkGate();
    const ac = new AbortController();
    const p = gate.canUseTool(SEND, {}, { signal: ac.signal });
    ac.abort(); await p;
    assert.deepEqual(closed(events), [{ id: events[0][1].id, allowed: false }]);
  }
  { // denyAll, y una sola vez aunque se repita
    const { gate, events } = mkGate();
    const p = gate.canUseTool(SEND, {}, {});
    gate.denyAll(); gate.denyAll(); await p;
    assert.deepEqual(closed(events), [{ id: events[0][1].id, allowed: false }]);
  }
});

test('gate.pending devuelve las confirmaciones sin responder', async () => {
  const { gate, events } = mkGate();
  assert.deepEqual(gate.pending(), []);
  const p = gate.canUseTool(SEND, { to: 'x' }, {});
  assert.deepEqual(gate.pending(), [events[0][1]]);
  gate.denyAll(); await p;
  assert.deepEqual(gate.pending(), []);
});

test('el subagente denegado avisa con un evento denied', async () => {
  const { gate, events } = mkGate();
  await gate.canUseTool(SEND, {}, { agentID: 'ag1' });
  assert.deepEqual(events, [['denied', { app: 'Gmail', action: 'send message', agent: 'ag1' }]]);
});
