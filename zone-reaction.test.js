import test from 'node:test';
import assert from 'node:assert/strict';
import { measureZoneReactions } from './zone-reaction.js';

const bar = (h, l, c) => ({ h, l, c });
const zone = { low: 99, high: 101, mid: 100 };

test('a level price bounces from is measured as respected', () => {
  // Approached from below, rejected back down below the zone: the zone acted as resistance.
  const bars = [bar(98, 97, 98), bar(99.5, 98, 99.2), bar(100.2, 99.1, 99.6), bar(98.8, 97.5, 97.8)];
  const out = measureZoneReactions(bars, zone, { atr: 1 });
  assert.equal(out.touches, 1);
  assert.equal(out.respected, 1);
  assert.equal(out.broken, 0);
  assert.equal(out.neutral, 0);
  assert.equal(out.rate, 0.75, 'one bounce out of one touch is smoothed, not a 100% claim');
  assert.equal(out.lastTouchIndex, 2, 'the touch ends at the last candle overlapping the zone');
  assert.equal(out.avgBarsToReact, 3);
});

test('a wick through the far side of the zone is not a bounce', () => {
  // Approached from below, poked above the zone and closed back inside: no move back down, so no reaction.
  const bars = [bar(98, 97, 98), bar(99.5, 98, 99.5), bar(101.6, 99.4, 100.5)];
  const out = measureZoneReactions(bars, zone, { atr: 1 });
  assert.equal(out.respected, 0, 'moving further in the approach direction is not a rejection');
  assert.equal(out.neutral, 1);
});

test('a level price closes through is measured as broken', () => {
  const bars = [bar(98, 97, 98), bar(99.5, 98, 99.5), bar(102.5, 100, 102)];
  const out = measureZoneReactions(bars, zone, { atr: 1 });
  assert.equal(out.touches, 1);
  assert.equal(out.broken, 1);
  assert.equal(out.respected, 0);
  assert.equal(out.rate, 0.25);
});

test('consecutive candles inside the zone count as a single touch', () => {
  const bars = [bar(98, 97, 98), bar(99.6, 98.7, 99.4), bar(100.8, 99.3, 100.2), bar(101.6, 99.9, 100.4), bar(99.8, 98.1, 98.3)];
  const out = measureZoneReactions(bars, zone, { atr: 1 });
  assert.equal(out.touches, 1, 'a run inside the zone is one touch, not one per candle');
  assert.equal(out.lastTouchIndex, 4);
  assert.equal(out.respected, 1, 'the last candle of the run closed back below the zone');
});

test('an untouched level is scored neutral instead of pretending', () => {
  const out = measureZoneReactions([bar(90, 89, 89.5), bar(91, 90, 90.5)], zone, { atr: 1 });
  assert.equal(out.touches, 0);
  assert.equal(out.rate, 0.5);
  assert.equal(out.lastTouchIndex, null);
});

test('a reaction that arrives after the horizon is not credited', () => {
  const bars = [
    bar(96, 95, 96),
    bar(99.9, 98.6, 99.1),
    bar(98.9, 98.7, 98.8),
    bar(98.9, 98.7, 98.8),
    bar(98.4, 97.6, 97.8)
  ];
  const out = measureZoneReactions(bars, zone, { atr: 1, horizon: 2 });
  assert.equal(out.touches, 1);
  assert.equal(out.neutral, 1, 'the level was left alone inside the horizon');
  assert.equal(out.respected, 0);
  assert.equal(out.rate, 0.5);
});

test('a long touch gets no more look-ahead than the horizon', () => {
  // Five candles sit in the zone, then price rejects. With horizon 3 counted from the touch, the
  // rejection on the sixth candle after the touch began is outside the window.
  const bars = [
    bar(98, 97, 98),
    bar(99.6, 98.6, 99.2),
    bar(100.4, 99.2, 99.8),
    bar(100.6, 99.4, 100.1),
    bar(100.5, 99.3, 99.9),
    bar(100.2, 99.1, 99.5),
    bar(98.9, 97.4, 97.6)
  ];
  const out = measureZoneReactions(bars, zone, { atr: 1, horizon: 3 });
  assert.equal(out.touches, 1);
  assert.equal(out.lastTouchIndex, 5);
  assert.equal(out.respected, 0, 'a reaction past horizon candles from the touch must not be credited');
  assert.equal(out.neutral, 1);
});

test('support is measured in the opposite direction', () => {
  // Approached from above, bounced back up above the zone: the zone acted as support.
  const bars = [bar(103, 102, 102.5), bar(101.4, 100.2, 100.6), bar(102.3, 101.2, 102)];
  const out = measureZoneReactions(bars, zone, { atr: 1 });
  assert.equal(out.respected, 1, 'rejection upwards from above counts as respected');
  assert.equal(out.rate, 0.75);

  const fellThrough = measureZoneReactions([bar(103, 102, 102.5), bar(101.4, 100.2, 100.6), bar(100.8, 98.2, 99.2)], zone, { atr: 1 });
  assert.equal(fellThrough.respected, 0, 'a drop into the zone from above is not a bounce');
});

// Each scenario is written for resistance (approach from below) and mirrored around the zone for support.
const mirror = bars => bars.map(b => bar(200 - b.l, 200 - b.h, 200 - b.c));
const scenarios = [
  {
    name: 'strong bounce',
    bars: [bar(98, 97, 98), bar(99.5, 98, 99.2), bar(98.8, 97.5, 97.8)],
    expect: { touches: 1, respected: 1, broken: 0, neutral: 0 }
  },
  {
    name: 'false breakout: wick through, close back, then rejection',
    bars: [bar(98, 97, 98), bar(101.8, 98.6, 100.4), bar(100.2, 98, 98.3)],
    expect: { touches: 1, respected: 1, broken: 0, neutral: 0 }
  },
  {
    name: 'real breakout: close beyond the zone',
    bars: [bar(98, 97, 98), bar(99.5, 98, 99.5), bar(102.5, 100, 102), bar(102.8, 101.6, 102.4)],
    expect: { touches: 1, respected: 0, broken: 1, neutral: 0 }
  },
  {
    name: 'sideways drift under the zone',
    bars: [bar(98, 97, 98), bar(99.4, 98.7, 99.1), bar(98.9, 98.6, 98.8), bar(98.9, 98.6, 98.7), bar(98.9, 98.6, 98.8)],
    expect: { touches: 1, respected: 0, broken: 0, neutral: 1 }
  },
  {
    name: 'repeated retest: two separate touches, each rejected',
    bars: [bar(98, 97, 98), bar(99.5, 98, 99.2), bar(98.8, 97.5, 97.8), bar(98.5, 97.6, 98.2), bar(99.6, 98.2, 99.4), bar(98.9, 97.9, 98)],
    expect: { touches: 2, respected: 2, broken: 0, neutral: 0 }
  },
  {
    name: 'first outcome wins: rejection inside the touch, break later',
    bars: [bar(98, 97, 98), bar(99.2, 98, 98.2), bar(101.6, 99, 101.5), bar(102.4, 101.4, 102)],
    expect: { touches: 1, respected: 1, broken: 0, neutral: 0 }
  }
];

for (const scenario of scenarios) {
  for (const [side, bars] of [['resistance', scenario.bars], ['support', mirror(scenario.bars)]]) {
    test(`${side}: ${scenario.name}`, () => {
      const out = measureZoneReactions(bars, zone, { atr: 1 });
      for (const [key, value] of Object.entries(scenario.expect)) assert.equal(out[key], value, key);
    });
  }
}

test('thresholds and inputs are validated', () => {
  const bars = [bar(98, 97, 98)];
  assert.throws(() => measureZoneReactions(bars, zone, { atr: 0 }), /positive ATR/);
  assert.throws(() => measureZoneReactions(bars, zone, { atr: 1, horizon: 0 }), /horizon/);
  assert.throws(() => measureZoneReactions(bars, { low: 5, high: 5 }, { atr: 1 }), /Invalid zone/);
  assert.throws(() => measureZoneReactions('nope', zone, { atr: 1 }), /Invalid zone/);
  assert.throws(() => measureZoneReactions(bars, zone, { atr: 1, reactionAtr: 0 }), /thresholds/);
});
