const test = require('node:test');
const assert = require('node:assert/strict');
const { RING, navigate, agoLabel, viewPayload, freezeInbox, nextFrozen } = require('../public/nav');

test('la lista congelada de Mail', () => {
  const g1 = { data: { inbox: [{ id: 'a' }] }, updatedAt: 1 };
  const g2 = { data: { inbox: [{ id: 'b' }] }, updatedAt: 2 };
  const empty = freezeInbox(null); // se abrió Mail antes de que llegaran datos
  assert.deepEqual(empty.inbox, []);
  // sin datos al congelar: el primer refresco la reemplaza aunque no sea por escritura
  assert.deepEqual(nextFrozen(empty, g1, undefined).inbox, [{ id: 'a' }]);
  // con datos: un refresco común no la toca…
  const f1 = freezeInbox(g1);
  assert.equal(nextFrozen(f1, g2, undefined), f1);
  // …uno por escritura de ALTER sí
  assert.deepEqual(nextFrozen(f1, g2, 'write').inbox, [{ id: 'b' }]);
  // un refresco que falló sin datos deja la lista vacía pero muestra el error
  const failed = nextFrozen(empty, { data: null, error: 'x' }, undefined);
  assert.deepEqual(failed.inbox, []);
  assert.equal(failed.feed.error, 'x');
  assert.deepEqual(nextFrozen(failed, g1, undefined).inbox, [{ id: 'a' }]); // y el siguiente con datos la llena
});

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
