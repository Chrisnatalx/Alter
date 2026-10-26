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

test('buildRefreshOptions: solo lectura, sin ALTER ni subagentes', () => {
  const o = buildRefreshOptions({ config });
  assert.deepEqual(o.tools, []);
  assert.deepEqual(o.allowedTools, READ_TOOLS);
  assert.equal(o.permissionMode, 'dontAsk');
  assert.equal(o.persistSession, false);
  assert.equal(o.outputFormat.type, 'json_schema');
  assert.equal(o.model, config.feedModel);
  assert.ok(!o.systemPrompt.includes('ALTER'));
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

// Gmail y Calendar conectados, como los ve el refresco antes de mandar el prompt
const CONNECTED = [{ name: 'claude.ai Gmail', status: 'connected', tools: [] }, { name: 'claude.ai Google Calendar', status: 'connected', tools: [] }];

// Devuelve un queryFn que registra las llamadas. La sonda (sin outputFormat) responde `statuses`; el refresco
// responde CONNECTED (o `refreshStatuses`), espera el prompt de la entrada y después emite `messages`.
function fakeQueryFn(messages, statuses = [], refreshStatuses = CONNECTED) {
  const calls = [];
  const fn = ({ prompt, options }) => {
    const call = { prompt, options, sent: [] };
    calls.push(call);
    const isProbe = !options.outputFormat;
    const gen = (async function* () {
      if (isProbe) return;
      for await (const m of prompt) { call.sent.push(m); break; } // el prompt llega recién con los conectores listos
      for (const m of messages) yield m;
    })();
    gen.mcpServerStatus = async () => (isProbe ? statuses : refreshStatuses);
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
  assert.equal(queryFn.calls[0].options.outputFormat, undefined); // la primera es la sonda
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

// ---- Revisión: solo lectura a prueba de fallas, sonda con tope, fechas ----
test('una herramienta de más en el init corta el refresco', async () => {
  const queryFn = fakeQueryFn([{ type: 'system', subtype: 'init', tools: [...READ_TOOLS, 'StructuredOutput', 'mcp__claude_ai_Gmail__send_message'] }, ok()]);
  const toolCache = fresh();
  await assert.rejects(runGoogleRefresh({ queryFn, config, toolCache, logger: quiet }), /solo lectura/);
  assert.equal(toolCache.names, null);
});

test('el init sin StructuredOutput igual vale si trae solo las de lectura', async () => {
  const queryFn = fakeQueryFn([{ type: 'system', subtype: 'init', tools: [...READ_TOOLS] }, ok()]);
  const r = await runGoogleRefresh({ queryFn, config, toolCache: fresh(), logger: quiet });
  assert.equal(r.days.length, 7);
});

test('canUseTool deniega todo lo que no sea de lectura', async () => {
  const { canUseTool } = buildRefreshOptions({ config });
  assert.equal((await canUseTool('mcp__claude_ai_Gmail__send_message', { to: 'x' })).behavior, 'deny');
  assert.equal((await canUseTool('WebSearch', {})).behavior, 'deny');
  const okRead = await canUseTool(READ_TOOLS[0], { a: 1 });
  assert.equal(okRead.behavior, 'allow');
  assert.deepEqual(okRead.updatedInput, { a: 1 });
});

test('solo se conectan los servidores de Gmail y Calendar (por URL)', () => {
  const urls = buildRefreshOptions({ config }).settings.allowedMcpServers.map((s) => s.serverUrl);
  assert.deepEqual(urls, ['https://gmailmcp.googleapis.com/*', 'https://calendarmcp.googleapis.com/*']);
});

test('una sonda colgada vence y no deja el refresco esperando', async () => {
  let closed = false;
  const queryFn = () => {
    const gen = (async function* () {})();
    gen.mcpServerStatus = () => new Promise(() => {}); // nunca contesta
    gen.close = () => { closed = true; };
    return gen;
  };
  await assert.rejects(listMcpTools({ queryFn, config, timeoutMs: 30 }), /tardó/);
  assert.equal(closed, true);
});

test('weekRange no depende de los nombres de los días', () => {
  // Todos los días de una semana dan el mismo lunes, también cerca de la medianoche
  for (let d = 26; d <= 31; d++) assert.equal(weekRange(new Date(`2026-10-${d}T23:59:00-03:00`), tz).start, '2026-10-26');
  assert.equal(weekRange(new Date('2026-11-01T00:01:00-03:00'), tz).start, '2026-10-26');
  assert.equal(weekRange(new Date('2026-11-02T00:01:00-03:00'), tz).start, '2026-11-02');
  assert.equal(weekRange(new Date('2026-10-26T12:00:00Z'), 'Asia/Tokyo').start, '2026-10-26');
});

test('un evento con hora que cruza la medianoche aparece en cada día', () => {
  const days = groupWeek([{ id: 'n', title: 'Guardia', start: '2026-10-27T22:00:00-03:00', end: '2026-10-29T02:00:00-03:00', allDay: false, declined: false, calendar: 'c' }], { start: '2026-10-26' }, tz);
  assert.deepEqual(days.map((d) => d.events.length), [0, 1, 1, 1, 0, 0, 0]);
  assert.equal(days[1].events[0].time, '22:00');
  assert.equal(days[2].events[0].continued, true);
  assert.equal(days[3].events[0].endTime, '02:00');
});

test('un evento que termina justo a la medianoche no ocupa el día siguiente', () => {
  const days = groupWeek([{ id: 'm', title: 'Cena', start: '2026-10-27T21:00:00-03:00', end: '2026-10-28T00:00:00-03:00', allDay: false, declined: false, calendar: 'c' }], { start: '2026-10-26' }, tz);
  assert.deepEqual(days.map((d) => d.events.length), [0, 1, 0, 0, 0, 0, 0]);
});

test('los eventos que empezaron antes del lunes entran en la semana', () => {
  const events = [
    { id: 'v', title: 'Vacaciones', start: '2026-10-20', end: '2026-10-28', allDay: true, declined: false, calendar: 'c' },
    { id: 'h', title: 'Vuelo', start: '2026-10-25T23:00:00-03:00', end: '2026-10-26T03:00:00-03:00', allDay: false, declined: false, calendar: 'c' },
  ];
  const days = groupWeek(events, { start: '2026-10-26' }, tz);
  assert.deepEqual(days[0].events.map((e) => e.id), ['v', 'h']);
  assert.deepEqual(days[1].events.map((e) => e.id), ['v']);
  assert.equal(days[0].events[1].continued, true);
});

test('el prompt sale recién cuando Gmail y Calendar están conectados', async () => {
  const queryFn = fakeQueryFn([INIT, ok()]);
  await runGoogleRefresh({ queryFn, config, toolCache: fresh(), logger: quiet });
  const sent = queryFn.calls[0].sent;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'user');
  assert.match(sent[0].message.content, /list_calendars/);
});

test('si los conectores no conectan, el refresco falla sin mandar el prompt', async () => {
  const pending = [{ name: 'claude.ai Gmail', status: 'pending' }, { name: 'claude.ai Google Calendar', status: 'failed' }];
  const queryFn = fakeQueryFn([INIT, ok()], [], pending);
  await assert.rejects(runGoogleRefresh({ queryFn, config, toolCache: fresh(), logger: quiet, connectTimeoutMs: 50 }), /conectores/);
  assert.equal(queryFn.calls[0].sent.length, 0);
});

test('el refresco lleva la zona horaria y el día de hoy del servidor', async () => {
  const queryFn = fakeQueryFn([INIT, ok()]);
  const r = await runGoogleRefresh({ queryFn, config, now: new Date('2026-10-28T01:00:00Z'), toolCache: fresh(), logger: quiet });
  assert.equal(r.timezone, config.timezone);
  assert.match(r.today, /^\d{4}-\d{2}-\d{2}$/);
});

test('FeedSchema rechaza campos de tipo equivocado', () => {
  assert.equal(FeedSchema.safeParse(VALID).success, true);
  assert.equal(FeedSchema.safeParse({ events: 'x', inbox: [] }).success, false);
});
