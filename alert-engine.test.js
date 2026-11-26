import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlertEngine, normalizeAlerts } from './alert-engine.js';

test('a price alert rings once, when the price crosses it in either direction', () => {
  const engine = createAlertEngine({ now: () => 1000 });
  const alerts = [{ id: 'a', price: 2650, active: true }, { id: 'b', price: 2640, active: true }];
  assert.deepEqual(engine.onPrice(2645, { alerts }), [], 'the first price is only a baseline');
  assert.deepEqual(engine.onPrice(2649.9, { alerts }), []);
  const up = engine.onPrice(2650.1, { alerts });
  assert.equal(up.length, 1); assert.equal(up[0].id, 'a'); assert.equal(up[0].direction, 'up');
  assert.equal(alerts[0].active, false); assert.equal(alerts[0].triggeredAt, 1000);
  assert.deepEqual(engine.onPrice(2649, { alerts }), [], 'a fired alert stays quiet');
  const down = engine.onPrice(2639, { alerts });
  assert.deepEqual(down.map(e => [e.id, e.direction]), [['b', 'down']]);
});

test('a zone alert rings when the price enters a strong enough zone, with a cooldown', () => {
  let clock = 0;
  const engine = createAlertEngine({ now: () => clock, zoneCooldownMs: 1000 });
  const zones = [{ id: 'z1', low: 2650, high: 2652, strength: 0.8 }, { id: 'z2', low: 2630, high: 2632, strength: 0.3 }];
  const rules = { zones: true, zoneMinStrength: 0.6 };
  assert.deepEqual(engine.onPrice(2648, { zones, rules }), []);
  assert.equal(engine.onPrice(2651, { zones, rules })[0].id, 'z1');
  assert.deepEqual(engine.onPrice(2651.5, { zones, rules }), [], 'already inside');
  engine.onPrice(2648, { zones, rules });
  assert.deepEqual(engine.onPrice(2651, { zones, rules }), [], 'within the cooldown');
  clock = 5000; engine.onPrice(2648, { zones, rules });
  assert.equal(engine.onPrice(2651, { zones, rules }).length, 1, 'after the cooldown');
  engine.onPrice(2635, { zones, rules });
  assert.deepEqual(engine.onPrice(2631, { zones, rules }), [], 'a weak zone does not ring');
  assert.deepEqual(engine.onPrice(2660, { zones, rules: { zones: false } }), []);
});

test('signal alerts ring only for signals that appear after the first list', () => {
  const engine = createAlertEngine();
  const rules = { signals: true };
  assert.deepEqual(engine.onSignals([{ id: 's1' }, { id: 's2' }], rules), [], 'what was on screen is not news');
  assert.deepEqual(engine.onSignals([{ id: 's1' }, { id: 's2' }, { id: 's3' }], rules).map(e => e.id), ['s3']);
  assert.deepEqual(engine.onSignals([{ id: 's4' }], { signals: false }), []);
  engine.reset();
  assert.deepEqual(engine.onSignals([{ id: 's9' }], rules), [], 'a new timeframe is a new baseline');
});

test('stored alerts are cleaned up and bounded', () => {
  const state = normalizeAlerts({ alerts: [{ id: 'x', price: '2650.5', note: 'n'.repeat(200) }, { price: -1 }, null], rules: { zones: true, zoneMinStrength: 5, signals: 'yes' } });
  assert.equal(state.alerts.length, 1);
  assert.equal(state.alerts[0].price, 2650.5);
  assert.equal(state.alerts[0].note.length, 80);
  assert.deepEqual(state.rules, { zones: true, zoneMinStrength: 0.95, signals: false, sound: true });
  assert.deepEqual(normalizeAlerts(null), { alerts: [], rules: { zones: false, zoneMinStrength: 0.6, signals: false, sound: true } });
});
