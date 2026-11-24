import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSourceLevels } from './zone-sources.js';
import { detectLiquidityZones } from './market-engine.js';
import { zoneLabelRu } from './zone-labels.js';

// Ten days of 15m candles starting Monday 2026-01-05, gold-like range around $2650.
function history(days = 10) {
  const start = Date.UTC(2026, 0, 5);
  const out = [];
  let price = 2650;
  for (let i = 0; i < days * 96; i++) {
    const time = new Date(start + i * 900000).toISOString();
    const open = price;
    price += Math.sin(i / 7) * 1.6 + Math.sin(i / 29) * 1.1;
    const close = price;
    const high = Math.max(open, close) + 0.6 + Math.sin(i / 3) * 0.4;
    const low = Math.min(open, close) - 0.6 - Math.cos(i / 4) * 0.4;
    out.push({ time, o: open, h: high, l: low, c: close, volume: 8 + (i % 7) });
  }
  return out;
}

test('completed days, sessions, weeks and higher timeframes all contribute levels', () => {
  const bars = history();
  const levels = collectSourceLevels(bars, { priceStep: 0.1 });
  const labels = levels.map(level => level.label);
  for (const expected of ['Prior day high', 'Prior day low', 'Asia high', 'London high', 'New York high', 'Weekly open', 'Prior week high']) {
    assert.ok(labels.includes(expected), 'missing source: ' + expected);
  }
  assert.ok(labels.some(label => /^H[14] swing (high|low)$/.test(label)), 'higher-timeframe swings must be derived from the same candles');
  assert.ok(labels.includes('Volume POC'));

  for (const level of levels) {
    assert.ok(Number.isFinite(level.price) && level.price > 0, 'every level is a real price');
    assert.ok(level.weight > 0 && level.weight <= 1);
    assert.ok(Number.isInteger(level.index) && level.index >= 0, 'levels point back at the candle that formed them');
  }
});

test('every source label has a Russian caption for the panel and the MT5 chart', () => {
  const levels = collectSourceLevels(history(), { priceStep: 0.1 });
  const seen = new Set(levels.map(level => level.label));
  assert.ok(seen.size >= 8, 'the sample must exercise the sources');
  for (const label of seen) {
    const ru = zoneLabelRu(label);
    assert.notEqual(ru, label, 'no Russian caption for source label: ' + label);
    assert.doesNotMatch(ru, /\s(high|low)$/, 'untranslated source leaked into the panel: ' + label);
  }
});

test('the prior day extremes match the actual previous session', () => {
  const bars = history();
  const levels = collectSourceLevels(bars, { priceStep: 0.1 });
  const days = new Map();
  for (const bar of bars) {
    const key = bar.time.slice(0, 10);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(bar);
  }
  const keys = [...days.keys()].sort();
  const previousDay = days.get(keys.at(-2));
  const expectedHigh = Math.max(...previousDay.map(bar => bar.h));
  const expectedLow = Math.min(...previousDay.map(bar => bar.l));
  assert.equal(levels.find(level => level.label === 'Prior day high').price, expectedHigh);
  assert.equal(levels.find(level => level.label === 'Prior day low').price, expectedLow);
});

test('calendar levels point at the candle that formed them in the original series', () => {
  const bars = history();
  const levels = collectSourceLevels(bars, { priceStep: 0.1 });
  const byLabel = label => levels.find(level => level.label === label);
  const lastDay = bars.at(-1).time.slice(0, 10);
  const previousDay = bars.filter(bar => bar.time < lastDay).at(-1).time.slice(0, 10);
  const checks = [
    ['Prior day high', 'h', bar => bar.time.startsWith(previousDay)],
    ['Prior day low', 'l', bar => bar.time.startsWith(previousDay)],
    ['London high', 'h', bar => { const hour = new Date(bar.time).getUTCHours(); return hour >= 7 && hour < 12; }],
    ['Prior week high', 'h', bar => bar.time >= '2026-01-05' && bar.time < '2026-01-12'],
    ['Prior week low', 'l', bar => bar.time >= '2026-01-05' && bar.time < '2026-01-12']
  ];
  for (const [label, field, inPeriod] of checks) {
    const level = byLabel(label);
    assert.ok(level, 'missing source: ' + label);
    const candle = bars[level.index];
    assert.ok(candle && inPeriod(candle), label + ' must point at a candle inside its own period');
    assert.equal(candle[field], level.price, label + ' must point at the candle that set the price');
  }
  const weeklyOpen = byLabel('Weekly open');
  assert.equal(bars[weeklyOpen.index].time, '2026-01-12T00:00:00.000Z', 'the weekly open is the first candle of the week');
  assert.equal(bars[weeklyOpen.index].o, weeklyOpen.price);
});

test('a zone built from a calendar source reports when that candle formed it', () => {
  // The finder runs on the closed candles (all but the forming one), so its source levels are the same
  // as collectSourceLevels on that slice, and formedAt must be the time of the candle that set them.
  const bars = history();
  const sources = collectSourceLevels(bars.slice(0, -1), { priceStep: 0.1 });
  const zones = detectLiquidityZones(bars, 0.1, { minZones: 3, maxZones: 12, maxDistanceAtr: 100 });
  const calendar = zones.filter(zone => /^(Prior day|Two days ago|Asia|London|New York|Prior week|Weekly open)/.test(zone.label));
  assert.ok(calendar.length >= 2, 'the sample must surface calendar source zones, got ' + zones.map(zone => zone.label).join(', '));
  const closed = bars.slice(0, -1);
  for (const zone of calendar) {
    const source = sources.find(level => level.label === zone.label);
    assert.ok(source, 'zone label must come from a source level: ' + zone.label);
    assert.equal(zone.formedAt, bars[source.index].time, zone.label + ' must report the time of the candle that set it');
    // That candle is one that actually traded at the level, not a candle from an unrelated day.
    const formed = closed.find(bar => bar.time === zone.formedAt);
    const touched = /high$/.test(zone.label) ? formed.h : /low$/.test(zone.label) ? formed.l : formed.o;
    assert.equal(touched, source.price, zone.label + ' formedAt must be the candle that printed the level');
  }
});

test('the volume profile is ordered and inside the traded range', () => {
  const bars = history();
  const levels = collectSourceLevels(bars, { priceStep: 0.1 });
  const poc = levels.find(level => level.label === 'Volume POC').price;
  const vah = levels.find(level => level.label === 'Value area high').price;
  const val = levels.find(level => level.label === 'Value area low').price;
  assert.ok(val <= poc && poc <= vah, 'value area must bracket the point of control');
  const window = bars.slice(-96);
  assert.ok(poc >= Math.min(...window.map(bar => bar.l)) - 0.05);
  assert.ok(poc <= Math.max(...window.map(bar => bar.h)) + 0.05);
});

test('a series without timestamps falls back to the volume profile instead of inventing calendar levels', () => {
  const bars = history().map(({ time, ...rest }) => rest);
  const labels = collectSourceLevels(bars, { priceStep: 0.1 }).map(level => level.label);
  assert.ok(labels.includes('Volume POC'));
  assert.ok(!labels.includes('Prior day high'), 'no timestamps means no calendar claims');
  assert.ok(!labels.some(label => /^Asia/.test(label)));
});

test('zones report which independent sources agree with them', () => {
  const bars = history();
  const zones = detectLiquidityZones(bars, 0.1, { minZones: 3, maxZones: 7 });
  assert.ok(zones.length >= 3);
  assert.ok(zones.every(zone => Array.isArray(zone.sources)), 'every zone exposes its sources');
  assert.ok(zones.some(zone => zone.sources.length > 0), 'with ten days of history some zone must have corroborating sources');
  assert.ok(zones.every(zone => zone.sources.length <= 3), 'the label list stays readable');
  for (const zone of zones) assert.ok(zone.factors.confluence >= 0 && zone.factors.confluence <= 1);
});

test('each level source can be switched off on its own', () => {
  const bars = history();
  const all = collectSourceLevels(bars, { priceStep: 0.1 }).map(level => level.label);

  const noSessions = collectSourceLevels(bars, { priceStep: 0.1, use: { sessions: false } }).map(level => level.label);
  assert.ok(!noSessions.some(label => /^(Asia|London|New York)/.test(label)), 'session levels must disappear when the switch is off');
  assert.ok(noSessions.includes('Prior day high') && noSessions.includes('Volume POC'), 'the other sources keep working');
  assert.ok(noSessions.length < all.length);

  const noVolume = collectSourceLevels(bars, { priceStep: 0.1, use: { volume: false } }).map(level => level.label);
  assert.ok(!noVolume.some(label => /^(Volume|Value area)/.test(label)), 'the volume profile must disappear when the switch is off');
  assert.ok(noVolume.includes('Prior day high') && noVolume.includes('Weekly open'));

  const noCalendar = collectSourceLevels(bars, { priceStep: 0.1, use: { priorDay: false, sessions: false, week: false, higherTf: false } });
  assert.ok(noCalendar.length > 0 && noCalendar.every(level => /^(Volume|Value area)/.test(level.label)), 'only the volume profile is left when every other source is off');

  const none = collectSourceLevels(bars, { priceStep: 0.1, use: { priorDay: false, sessions: false, week: false, higherTf: false, volume: false } });
  assert.deepEqual(none, [], 'everything switched off yields no invented levels');
});

test('invalid input is rejected', () => {
  assert.deepEqual(collectSourceLevels([]), []);
  assert.throws(() => collectSourceLevels(history(), { priceStep: 0 }), /Invalid source level/);
  assert.throws(() => collectSourceLevels('nope'), /Invalid source level/);
});
