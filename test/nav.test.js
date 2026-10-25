const test = require('node:test');
const assert = require('node:assert/strict');
const { RING, navigate, agoLabel, viewPayload } = require('../public/nav');

const at = (face, from = face) => ({ face, from });

test('navigate recorre el anillo y sube al clima', () => {
  assert.deepEqual(RING, ['core', 'calendar', 'mail']);
  assert.equal(navigate(at('core'), 'left').face, 'calendar');
  assert.equal(navigate(at('calendar'), 'left').face, 'mail');
  assert.equal(navigate(at('mail'), 'left').face, 'core');
  assert.equal(navigate(at('core'), 'right').face, 'mail');
  assert.equal(navigate(at('mail'), 'right').face, 'calendar');
  assert.deepEqual(navigate(at('calendar'), 'up'), { face: 'weather', from: 'calendar' });
  assert.equal(navigate(navigate(at('calendar'), 'up'), 'down').face, 'calendar');
  const w = { face: 'weather', from: 'mail' };
  assert.equal(navigate(w, 'left'), w);
  assert.equal(navigate(w, 'up'), w);
  const c = at('core');
  assert.equal(navigate(c, 'down'), c);
});

test('agoLabel', () => {
  assert.equal(agoLabel(null, 0), 'SIN DATOS');
  assert.equal(agoLabel(0, 30e3), 'ACTUALIZADO RECIÉN');
  assert.equal(agoLabel(0, 7 * 60e3), 'ACTUALIZADO HACE 7 MIN');
  assert.equal(agoLabel(0, 125 * 60e3), 'ACTUALIZADO HACE 2 H');
});

test('viewPayload uses the frozen list', () => {
  const A = [{ id: 'a1', from: 'Ana', subject: 'Uno', unread: true, date: 'x' }, { id: 'a2', from: 'Beto', subject: 'Dos', unread: false, date: 'y' }];
  const cache = { google: { data: { inbox: [{ id: 'b1', from: 'C', subject: 'Nuevo', unread: true }] } } };
  const p = viewPayload('mail', { shownInbox: A, week: null, cache });
  assert.deepEqual(p.threads.map((t) => t.id), ['a1', 'a2']);
  assert.deepEqual(p.threads[0], { id: 'a1', from: 'Ana', subject: 'Uno', unread: true }); // sin campos de más
  assert.equal(viewPayload('core', {}), null);
  assert.deepEqual(viewPayload('calendar', { week: { start: '2026-10-26', end: '2026-11-01' } }), { face: 'calendar', week: { start: '2026-10-26', end: '2026-11-01' } });
  assert.deepEqual(viewPayload('weather', {}), { face: 'weather' });
  assert.deepEqual(viewPayload('mail', {}), { face: 'mail', threads: [] });
});
