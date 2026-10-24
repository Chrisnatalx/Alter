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
  for (const t of ['mcp__claude_ai_Gmail__create_draft', 'mcp__claude_ai_Google_Calendar__list_events', 'WebSearch', 'mcp__jarvis__abrir_en_navegador']) {
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
  assert.equal(events.length, 0);
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
