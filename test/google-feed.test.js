const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const {
  READ_TOOLS, FeedSchema, weekRange, groupWeek, buildRefreshPrompt, buildRefreshOptions, toolNames, listMcpTools, runGoogleRefresh,
} = require('../src/feeds/google');

const tz = 'America/Argentina/Buenos_Aires';

test('weekRange va de lunes a domingo en la zona horaria', () => {
  assert.deepEqual(weekRange(new Date('2026-10-25T15:00:00-03:00'), tz), { start: '2026-10-19', end: '2026-10-25' });
  assert.deepEqual(weekRange(new Date('2026-10-26T09:00:00-03:00'), tz), { start: '2026-10-26', end: '2026-11-01' });
  // Domingo 22:00 en Buenos Aires, pero ya lunes en UTC
  assert.deepEqual(weekRange(new Date('2026-10-26T01:00:00Z'), tz), { start: '2026-10-19', end: '2026-10-25' });
});

test('groupWeek: 7 días, día completo arriba, sin duplicados ni rechazados', () => {
  const a = { id: 'a', title: 'Daily', start: '2026-10-26T12:30:00Z', end: '2026-10-26T13:00:00Z', allDay: false, declined: false, calendar: 'Trabajo' };
  const events = [
    a,
    { id: 'b', title: 'Feriado', start: '2026-10-26', end: '2026-10-28', allDay: true, declined: false, calendar: 'Trabajo' },
    { id: 'c', title: 'No voy', start: '2026-10-26T15:00:00Z', end: '2026-10-26T16:00:00Z', allDay: false, declined: true, calendar: 'Trabajo' },
    { ...a, calendar: 'Otro' },
  ];
  const days = groupWeek(events, { start: '2026-10-26' }, tz);
  assert.equal(days.length, 7);
  assert.equal(days[0].date, '2026-10-26');
  assert.deepEqual(days[0].events.map((e) => e.id), ['b', 'a']);
  assert.equal(days[0].events[1].time, '09:30');
  assert.equal(days[0].events[1].endTime, '10:00');
  assert.deepEqual(days[1].events.map((e) => e.id), ['b']);
  assert.deepEqual(days[2].events.map((e) => e.id), []);
  assert.equal(days[6].date, '2026-11-01');
});

test('groupWeek acepta un día completo con hora y offset', () => {
  const days = groupWeek([{ id: 'x', title: 'Viaje', start: '2026-10-27T00:00:00-03:00', end: '2026-10-28T00:00:00-03:00', allDay: true, declined: false, calendar: 'c' }], { start: '2026-10-26' }, tz);
  assert.deepEqual(days.map((d) => d.events.length), [0, 1, 0, 0, 0, 0, 0]);
  assert.equal(days[1].events[0].time, '');
});

test('buildRefreshOptions: solo lectura, sin JARVIS ni subagentes', () => {
  const o = buildRefreshOptions({ config });
  assert.deepEqual(o.tools, []);
  assert.deepEqual(o.allowedTools, READ_TOOLS);
  assert.equal(o.permissionMode, 'dontAsk');
  assert.equal(o.persistSession, false);
  assert.equal(o.outputFormat.type, 'json_schema');
  assert.equal(o.model, config.feedModel);
  assert.ok(!o.systemPrompt.includes('JARVIS'));
  assert.equal(o.agents, undefined);
  assert.equal(o.mcpServers, undefined);
});

test('buildRefreshOptions: conectores del usuario y todo lo demás fuera del contexto', () => {
  const o = buildRefreshOptions({ config, knownTools: [...READ_TOOLS, 'mcp__claude_ai_Gmail__send_message'] });
  assert.deepEqual(o.settingSources, ['user']);
  assert.deepEqual(o.disallowedTools, ['mcp__claude_ai_Gmail__send_message']);
  assert.equal(o.outputFormat.schema.$schema, undefined); // la CLI rechaza el draft 2020-12
  assert.equal(o.outputFormat.schema.type, 'object');
});

test('buildRefreshPrompt pide la semana, los calendarios y la bandeja', () => {
  const p = buildRefreshPrompt({ now: new Date('2026-10-28T10:00:00-03:00'), timezone: tz, inboxSize: 8 });
  assert.ok(p.includes('2026-10-26'));
  assert.ok(p.includes('2026-11-01'));
  assert.ok(p.includes('list_calendars'));
  assert.ok(p.includes('in:inbox'));
  assert.ok(p.includes('8'));
});

test('toolNames arma los nombres completos de las herramientas MCP', () => {
  assert.deepEqual(toolNames([{ name: 'claude.ai Gmail', status: 'connected', tools: [{ name: 'search_threads' }] }, { name: 'x', status: 'failed' }]), ['mcp__claude_ai_Gmail__search_threads']);
});

// ---- runGoogleRefresh con una query falsa ----
const VALID = {
  events: [{ id: 'a', title: 'Daily', start: '2026-10-26T12:30:00Z', end: '2026-10-26T13:00:00Z', allDay: false, declined: false, calendar: 'Trabajo' }],
  inbox: [{ id: 't1', from: 'Ana', subject: 'Hola', date: '2026-10-25', unread: true }, { id: 't2', from: 'Beto', subject: 'Factura', date: '2026-10-24', unread: false }],
};
const INIT = { type: 'system', subtype: 'init', tools: [...READ_TOOLS, 'StructuredOutput'] };
const ok = (over = {}) => ({ type: 'result', subtype: 'success', is_error: false, structured_output: VALID, num_turns: 5, total_cost_usd: 0.01, duration_ms: 9000, ...over });

// Devuelve un queryFn que registra las llamadas. La sonda (prompt no string) responde mcpServerStatus.
function fakeQueryFn(messages, statuses = []) {
  const calls = [];
  const fn = ({ prompt, options }) => {
    calls.push({ prompt, options });
    const isProbe = typeof prompt !== 'string';
    const gen = (async function* () { if (!isProbe) for (const m of messages) yield m; })();
    gen.mcpServerStatus = async () => statuses;
    gen.close = () => {};
    return gen;
  };
  fn.calls = calls;
  return fn;
}
const fresh = () => ({ names: [...READ_TOOLS], at: Date.now() });
const quiet = { log: () => {} };

test('runGoogleRefresh arma la semana, la bandeja y la medición', async () => {
  const queryFn = fakeQueryFn([INIT, ok()]);
  const r = await runGoogleRefresh({ queryFn, config, now: new Date('2026-10-26T10:00:00-03:00'), toolCache: fresh(), logger: quiet });
  assert.equal(r.days.length, 7);
  assert.deepEqual(r.week, { start: '2026-10-26', end: '2026-11-01' });
  assert.equal(r.inbox.length, VALID.inbox.length);
  assert.deepEqual(r.meta, { ms: 9000, turns: 5, costUsd: 0.01 });
  assert.equal(queryFn.calls.length, 1); // con la lista de herramientas fresca no sondea
});

test('invalid structured output rejects', async () => {
  const queryFn = fakeQueryFn([INIT, ok({ structured_output: { events: 'x' } })]);
  await assert.rejects(runGoogleRefresh({ queryFn, config, toolCache: fresh(), logger: quiet }), /JSON/);
});

test('error result rejects', async () => {
  const queryFn = fakeQueryFn([INIT, ok({ subtype: 'error_max_turns', is_error: true })]);
  await assert.rejects(runGoogleRefresh({ queryFn, config, toolCache: fresh(), logger: quiet }), /error_max_turns/);
});

test('missing connectors rejects', async () => {
  const queryFn = fakeQueryFn([{ type: 'system', subtype: 'init', tools: ['StructuredOutput'] }, ok({ structured_output: { events: [], inbox: [] } })]);
  const toolCache = fresh();
  await assert.rejects(runGoogleRefresh({ queryFn, config, toolCache, logger: quiet }), /conectores/);
  assert.equal(toolCache.names, null); // la próxima vez vuelve a sondear
});

test('runGoogleRefresh sin lista de herramientas sondea una vez antes de la query', async () => {
  const statuses = [
    { name: 'claude.ai Gmail', status: 'connected', tools: [{ name: 'search_threads' }, { name: 'send_message' }] },
    { name: 'claude.ai Google Calendar', status: 'connected', tools: [{ name: 'list_calendars' }, { name: 'list_events' }] },
  ];
  const queryFn = fakeQueryFn([INIT, ok()], statuses);
  const toolCache = { names: null, at: 0 };
  await runGoogleRefresh({ queryFn, config, toolCache, logger: quiet });
  assert.equal(queryFn.calls.length, 2);
  assert.notEqual(typeof queryFn.calls[0].prompt, 'string');
  assert.deepEqual(queryFn.calls[1].options.disallowedTools, ['mcp__claude_ai_Gmail__send_message']);
  await runGoogleRefresh({ queryFn, config, toolCache, logger: quiet });
  assert.equal(queryFn.calls.length, 3); // la segunda vez usa la lista guardada
});

test('listMcpTools espera a que no queden conectores pendientes', async () => {
  let n = 0;
  const queryFn = () => {
    const gen = (async function* () {})();
    gen.mcpServerStatus = async () => (++n < 3
      ? [{ name: 'claude.ai Gmail', status: 'pending' }]
      : [{ name: 'claude.ai Gmail', status: 'connected', tools: [{ name: 'search_threads' }] }]);
    gen.close = () => {};
    return gen;
  };
  assert.deepEqual(await listMcpTools({ queryFn, config, pollMs: 1 }), ['mcp__claude_ai_Gmail__search_threads']);
  assert.equal(n, 3);
});

test('FeedSchema rechaza campos de tipo equivocado', () => {
  assert.equal(FeedSchema.safeParse(VALID).success, true);
  assert.equal(FeedSchema.safeParse({ events: 'x', inbox: [] }).success, false);
});
