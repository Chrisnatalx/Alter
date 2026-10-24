const test = require('node:test');
const assert = require('node:assert/strict');
const { createAskTracker } = require('../public/ask-queue');

test('mensaje normal: su turno es el esperado', () => {
  const a = createAskTracker();
  a.sent();
  assert.equal(a.started(), 'ask');
  assert.deepEqual(a.counts(), { pending: 0, drop: 0 });
});

test('escenario A/B: ESC antes de que empiece el turno descarta esa respuesta', () => {
  const a = createAskTracker();
  a.sent();
  a.cancel(); // ESC
  assert.equal(a.started(), 'drop');
  a.sent(); // la siguiente pregunta no se descarta
  assert.equal(a.started(), 'ask');
});

test('escenario C: A, ESC, B: el turno de A se descarta y el de B se atiende', () => {
  const a = createAskTracker();
  a.sent();   // A
  a.cancel(); // ESC (ask() de B también llama a interrupt)
  a.cancel();
  a.sent();   // B
  assert.equal(a.started(), 'drop'); // turno de A
  assert.equal(a.started(), 'ask');  // turno de B
});

test('una pregunta nueva descarta las anteriores que no empezaron', () => {
  const a = createAskTracker();
  a.sent();
  a.cancel(); a.sent(); // segunda pregunta
  a.cancel(); a.sent(); // tercera
  assert.deepEqual([a.started(), a.started(), a.started()], ['drop', 'drop', 'ask']);
});

test('sin mensajes pendientes el turno es huérfano y los contadores no bajan de 0', () => {
  const a = createAskTracker();
  a.cancel();
  assert.equal(a.started(), 'orphan');
  a.failed();
  assert.deepEqual(a.counts(), { pending: 0, drop: 0 });
});

test('un POST fallido no deja descartes colgados', () => {
  const a = createAskTracker();
  a.sent();
  a.cancel();
  a.failed();
  assert.deepEqual(a.counts(), { pending: 0, drop: 0 });
  a.sent();
  assert.equal(a.started(), 'ask');
});

test('reset limpia todo', () => {
  const a = createAskTracker();
  a.sent(); a.sent(); a.cancel();
  a.reset();
  assert.deepEqual(a.counts(), { pending: 0, drop: 0 });
});
