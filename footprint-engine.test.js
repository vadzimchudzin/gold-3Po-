import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FOOTPRINT_OPTIONS, validateFootprintOptions, applyTickToBar, emptyBar,
  footprintOf, sessionProfile, cumulativeDivergence, tickVolume
} from './footprint-engine.js';

const rows = (list) => list.map(([price, bid, ask, unknown = 0]) => ({ price, bid, ask, unknown }));

test('a tick lands in its price row and updates the bar the same way the server does', () => {
  const bar = emptyBar(0, 100);
  applyTickToBar(bar, { last: 100.04, volume: 5, direction: 'buy' }, 0.1);
  applyTickToBar(bar, { last: 100.07, volume: 2, direction: 'sell' }, 0.1);
  applyTickToBar(bar, { last: 99.98, volume: 1 }, 0.1);
  assert.equal(bar.volume, 8);
  assert.equal(bar.tickCount, 3);
  assert.equal(bar.h, 100.07);
  assert.equal(bar.l, 99.98);
  assert.equal(bar.c, 99.98);
  assert.equal(bar.ask, 5);
  assert.equal(bar.bid, 2);
  assert.equal(bar.unknown, 1);
  const byPrice = [...bar.levels.values()].sort((a, b) => b.price - a.price);
  assert.deepEqual(byPrice.map(row => [Number(row.price.toFixed(2)), row.bid, row.ask, row.unknown]), [
    [100.1, 2, 0, 0],
    [100, 0, 5, 1]
  ], '100.04 and 99.98 share the 100.0 row; the unknown side is kept apart');
  assert.deepEqual(applyTickToBar(emptyBar(0, 100), { last: 100, tickVolume: 4, aggressorSide: 'buy' }, 0.1).ask, 4);
  assert.equal(tickVolume({ aggressorSide: 'unknown', realVolume: 50, tickVolume: 10 }), 1, 'an unknown side is one tick of activity');
  assert.equal(tickVolume({ aggressorSide: 'buy', realVolume: 0, tickVolume: 7 }), 7);
  assert.equal(tickVolume({ aggressorSide: 'sell', realVolume: 12, tickVolume: 7 }), 12, 'reported size wins over tick count');
  assert.throws(() => applyTickToBar(bar, { last: 0 }, 0.1), /tick price/);
  assert.throws(() => applyTickToBar(bar, { last: 10 }, 0), /Invalid/);
});

test('the point of control is the heaviest row and the value area covers 70% around it', () => {
  // Volumes 10, 60, 20, 10 from the highest price down: 100 in total.
  const profile = { h: 105, l: 102, c: 104 };
  const source = [[105, 5, 5], [104, 30, 30], [103, 8, 12], [102, 5, 5]];
  const foot = footprintOf(rows(source), profile);
  assert.equal(foot.total, 100);
  assert.equal(foot.poc, 104);
  assert.deepEqual({ low: foot.valueArea.low, high: foot.valueArea.high, rows: foot.valueArea.rows }, { low: 103, high: 104, rows: 2 });
  assert.ok(foot.valueArea.volume >= 70, 'the value area must cover at least 70% of the bar');
  assert.ok(foot.valueArea.share >= 0.7 && foot.valueArea.share < 0.95);
  assert.deepEqual(footprintOf(rows(source), { ...profile, valueAreaShare: 0.5 }).valueArea.rows, 1, 'at 50% the point of control alone is enough');
  assert.deepEqual(footprintOf(rows(source), { ...profile, valueAreaShare: 0.95 }).valueArea.rows, 4, 'a wider share takes every row');
});

test('imbalance is diagonal: ask against bid one level lower, and the mirror', () => {
  // 300% default: 9 ask at 104 against 3 bid at 103 is a buy imbalance.
  const foot = footprintOf(rows([[104, 1, 9], [103, 3, 1], [102, 1, 1]]), { h: 104, l: 102, c: 103 });
  assert.deepEqual(foot.imbalances, [{ side: 'buy', price: 104, ratio: 3 }]);
  const mirrored = footprintOf(rows([[104, 1, 1], [103, 9, 1], [102, 1, 1]]), { h: 104, l: 102, c: 103 });
  assert.deepEqual(mirrored.imbalances, [{ side: 'sell', price: 103, ratio: 9 }]);
  const quiet = footprintOf(rows([[104, 4, 8], [103, 3, 1]]), { h: 104, l: 103, c: 103 });
  assert.deepEqual(quiet.imbalances, [], 'a 2.7:1 ratio is not an imbalance at 300%');
  const tuned = footprintOf(rows([[104, 4, 8], [103, 3, 1]]), { h: 104, l: 103, c: 103, imbalanceRatio: 2 });
  assert.equal(tuned.imbalances.length, 1, 'the ratio is a real setting, not a constant');
  assert.equal(DEFAULT_FOOTPRINT_OPTIONS.imbalanceRatio, 3);
});

test('three imbalanced levels in a row make a stack, two do not', () => {
  const stack = footprintOf(rows([[107, 1, 10], [106, 1, 10], [105, 1, 10], [104, 1, 1]]), { h: 107, l: 104, c: 106 });
  assert.equal(stack.stackedImbalances.length, 1);
  assert.equal(stack.stackedImbalances[0].side, 'buy');
  assert.deepEqual(stack.stackedImbalances[0].prices, [107, 106, 105]);
  const pair = footprintOf(rows([[106, 1, 10], [105, 1, 10], [104, 1, 1]]), { h: 106, l: 104, c: 105 });
  assert.deepEqual(pair.stackedImbalances, [], 'two levels are not a stack');
});

test('imbalance compares neighbouring price steps, not neighbouring array rows', () => {
  // 103 never traded, so 104 and 102 are two steps apart: there is no diagonal pair to compare.
  const gapped = footprintOf(rows([[104, 1, 12], [102, 2, 1]]), { h: 104, l: 102, c: 103, priceStep: 1 });
  assert.deepEqual(gapped.imbalances, [], 'rows two steps apart must not be compared as neighbours');
  const adjacent = footprintOf(rows([[104, 1, 12], [103, 2, 1]]), { h: 104, l: 103, c: 103, priceStep: 1 });
  assert.equal(adjacent.imbalances.filter(item => item.side === 'buy').length, 1, 'the same rows one step apart are compared');
  // The step is taken from the rows when the caller does not pass it.
  const inferred = footprintOf(rows([[104, 1, 12], [103.5, 1, 1], [102, 2, 1]]), { h: 104, l: 102, c: 103 });
  assert.ok(!inferred.imbalances.some(item => item.price === 103.5 && item.side === 'buy'), 'with a 0.5 step, 103.5 and 102 are not neighbours');
  // Here the inferred step alone decides: the smallest gap is 1, so 104 and 103 are compared and
  // 103 and 101 (two steps apart) are not.
  const onlyInferred = footprintOf(rows([[104, 1, 12], [103, 2, 12], [101, 2, 1]]), { h: 104, l: 101, c: 103 });
  assert.ok(onlyInferred.imbalances.some(item => item.price === 104 && item.side === 'buy'), '104 against 103 is one inferred step and is compared');
  assert.ok(!onlyInferred.imbalances.some(item => item.price === 103 && item.side === 'buy'), '103 against 101 is two inferred steps and is not compared');
});

test('a stack is broken by an untraded price step', () => {
  const split = footprintOf(rows([[107, 1, 10], [106, 1, 10], [104, 1, 10], [103, 1, 1]]), { h: 107, l: 103, c: 105, priceStep: 1 });
  assert.deepEqual(split.stackedImbalances, [], '107, 106 and 104 are not three consecutive steps');
  const whole = footprintOf(rows([[107, 1, 10], [106, 1, 10], [105, 1, 10], [104, 1, 1]]), { h: 107, l: 104, c: 106, priceStep: 1 });
  assert.deepEqual(whole.stackedImbalances[0].prices, [107, 106, 105]);
});

test('volume without a known aggressor never creates absorption on its own', () => {
  const unknown = footprintOf([{ price: 104, bid: 0, ask: 0, unknown: 40 }, ...rows([[103, 2, 2], [102, 2, 2]])], { h: 104, l: 102, c: 103 });
  assert.deepEqual(unknown.absorbedLevels, [], 'unclassified broker ticks cannot prove absorption');
  const known = footprintOf(rows([[104, 20, 20], [103, 2, 2], [102, 2, 2]]), { h: 104, l: 102, c: 103 });
  assert.equal(known.absorbedLevels.length, 1, 'the same row with a known aggressor is still flagged');
  // Unclassified ticks on the inner rows must not raise the bar a real absorption is measured against.
  const noisy = footprintOf([{ price: 104, bid: 10, ask: 10, unknown: 0 }, { price: 103, bid: 2, ask: 2, unknown: 30 }, { price: 102, bid: 2, ask: 2, unknown: 30 }], { h: 104, l: 102, c: 103 });
  assert.equal(noisy.absorbedLevels.length, 1, 'aggressive volume is compared with the median aggressive row');
  assert.equal(noisy.absorbedLevels[0].multiple, 5);
});

test('an unfinished auction is an extreme that still shows both sides', () => {
  const open = footprintOf(rows([[104, 5, 5], [103, 2, 2], [102, 4, 4]]), { h: 104, l: 102, c: 103 });
  assert.equal(open.unfinishedHigh, true);
  assert.equal(open.unfinishedLow, true);
  const finished = footprintOf(rows([[104, 0, 10], [103, 2, 2], [102, 10, 0]]), { h: 104, l: 102, c: 103 });
  assert.equal(finished.unfinishedHigh, false);
  assert.equal(finished.unfinishedLow, false);
});

test('absorption flags an outer row that soaked up several median rows', () => {
  const foot = footprintOf(rows([[104, 25, 25], [103, 2, 2], [102, 2, 2], [101, 2, 2], [100, 2, 2]]), { h: 104, l: 100, c: 102 });
  assert.equal(foot.absorbedLevels.length, 1);
  assert.equal(foot.absorbedLevels[0].price, 104);
  assert.ok(foot.absorbedLevels[0].multiple >= 2);
  const closedAtTheEdge = footprintOf(rows([[104, 25, 25], [103, 2, 2], [102, 2, 2]]), { h: 104, l: 102, c: 104 });
  assert.deepEqual(closedAtTheEdge.absorbedLevels, [], 'closing at the heavy level is a breakout, not absorption');
  assert.equal(footprintOf([], {}).poc, null);
});

test('footprint options are validated', () => {
  assert.deepEqual(validateFootprintOptions({}), { ...DEFAULT_FOOTPRINT_OPTIONS });
  assert.throws(() => validateFootprintOptions({ imbalanceRatio: 1 }), /imbalanceRatio/);
  assert.throws(() => validateFootprintOptions({ valueAreaShare: 1.5 }), /valueAreaShare/);
  assert.throws(() => validateFootprintOptions({ imbalanceLevels: 1 }), /imbalanceLevels/);
  assert.throws(() => validateFootprintOptions({ minLevelVolume: 0 }), /minLevelVolume/);
  assert.throws(() => validateFootprintOptions({ ticksPerRow: 0 }), /ticksPerRow/);
  assert.throws(() => validateFootprintOptions({ ticksPerRow: 1.5 }), /ticksPerRow/);
});

test('ticks per row groups source price steps into wider rows without losing volume', () => {
  const source = [];
  for (let i = 0; i <= 20; i++) source.push({ price: Number((2648 + i * 0.1).toFixed(1)), bid: 2, ask: 3, unknown: 1 });
  const fine = footprintOf(source, { priceStep: 0.1, h: 2650, l: 2648, c: 2649 });
  const coarse = footprintOf(source, { priceStep: 0.1, ticksPerRow: 5, h: 2650, l: 2648, c: 2649 });
  assert.equal(fine.levels.length, 21, 'one row per source step by default');
  assert.deepEqual(coarse.levels.map(row => row.price), [2650, 2649.5, 2649, 2648.5, 2648], 'rows sit on the 0.5 grid');
  assert.equal(coarse.total, fine.total, 'grouping sums volume, it never re-estimates it');
  assert.equal(coarse.levels.reduce((sum, row) => sum + row.bid, 0), fine.bid);
  // Imbalance neighbours follow the row grid: 0.5 apart rows are adjacent once grouped.
  const ladder = rows([[2650, 0, 0], [2649.9, 0, 12], [2649.5, 1, 1], [2649.4, 2, 1]]).filter(row => row.bid || row.ask);
  const grouped = footprintOf(ladder, { priceStep: 0.1, ticksPerRow: 5, h: 2650, l: 2649.4, c: 2649.5 });
  assert.ok(grouped.imbalances.some(item => item.side === 'buy' && item.price === 2650), 'the 2650 row is compared with the 2649.5 row one grouped step below');
});

test('a bar built tick by tick shows the same grouped ladder as the whole bar', () => {
  // The live view feeds the forming bar's raw level map to footprintOf after every tick; the server
  // groups the finished bar's raw rows once. Both must land on the same rows and volumes.
  const options = { priceStep: 0.1, ticksPerRow: 5 };
  const ticks = [[2648.3, 'sell'], [2648.4, 'buy'], [2648.7, 'buy'], [2649.1, 'sell'], [2648.2, 'buy'], [2649.4, 'buy'], [2648.8, 'sell']];
  const forming = emptyBar(0, ticks[0][0]);
  let live = null;
  for (const [last, direction] of ticks) {
    applyTickToBar(forming, { last, volume: 2, direction }, 0.1);
    live = footprintOf(forming.levels, { ...options, h: forming.h, l: forming.l, c: forming.c });
  }
  const whole = emptyBar(0, ticks[0][0]);
  for (const [last, direction] of ticks) applyTickToBar(whole, { last, volume: 2, direction }, 0.1);
  const server = footprintOf([...whole.levels.values()], { ...options, h: whole.h, l: whole.l, c: whole.c });
  assert.deepEqual(live.levels, server.levels);
  assert.deepEqual(live.levels.map(row => row.price), [2649.5, 2649, 2648.5, 2648], 'the forming bar sits on the grouped 0.5 grid');
  assert.equal(live.poc, server.poc);
});

test('a session profile has its own point of control and reports naked ones', () => {
  const day = (startIso, levels) => ({
    time: startIso, o: 100, h: 110, l: 99, c: 101,
    levels: levels.map(([price, volume]) => ({ price, bid: volume / 2, ask: volume / 2, unknown: 0 }))
  });
  const bars = [
    day('2026-11-18T10:00:00.000Z', [[108, 10], [107, 60], [106, 20]]),
    day('2026-11-18T12:00:00.000Z', [[107, 30], [106, 5]]),
    day('2026-11-19T10:00:00.000Z', [[104, 40], [103, 10], [102, 5]])
  ];
  const profile = sessionProfile(bars, { priceStep: 0.1 });
  assert.equal(profile.sessions.length, 2);
  assert.equal(profile.sessions[0].poc, 107);
  assert.equal(profile.sessions[1].poc, 104);
  assert.equal(profile.current.poc, 104);
  assert.deepEqual(profile.naked.map(item => item.price), [107], 'the 18th POC was never traded again');
  assert.ok(profile.naked[0].volume >= 100);
});

test('cumulative delta that disagrees with price is a divergence, noise is not', () => {
  const bar = (o, c, delta, cumulativeDelta) => ({ o, h: Math.max(o, c), l: Math.min(o, c), c, delta, cumulativeDelta, volume: 100 });
  const bullish = [bar(100, 99, -10, -10), bar(99, 98, -10, -20), bar(98, 97, -10, -30), bar(97, 98.5, 60, 30)];
  assert.equal(cumulativeDivergence(bullish).side, 'bullish', 'price lower, delta higher');
  const bearish = [bar(100, 101, 10, 10), bar(101, 102, 10, 20), bar(102, 103, 10, 30), bar(103, 101.5, -60, -30)];
  assert.equal(cumulativeDivergence(bearish).side, 'bearish', 'price higher, delta lower');
  const noise = [bar(100, 101, 10, 10), bar(101, 102, 10, 20), bar(102, 103, 10, 30), bar(103, 104, 2, 32)];
  assert.equal(cumulativeDivergence(noise).side, null, 'agreeing price and delta is not a divergence');
  assert.equal(cumulativeDivergence([bar(100, 101, 1, 1)]).side, null);
});

test('each footprint display mode shows a value taken from the row itself', async () => {
  const { footprintCell, FOOTPRINT_MODES } = await import('./footprint-engine.js');
  const row = { bid: 3, ask: 9, unknown: 2 };
  assert.deepEqual(footprintCell(row, 'bidask'), { text: '3 9', tone: 'positive', value: null });
  assert.deepEqual(footprintCell(row, 'delta'), { text: '+6', tone: 'positive', value: 6 });
  assert.deepEqual(footprintCell(row, 'deltaPct'), { text: '+50%', tone: 'positive', value: 50 }, 'delta share of the volume with a known side');
  assert.deepEqual(footprintCell(row, 'volume'), { text: '14', tone: 'neutral', value: 14 }, 'total includes unclassified ticks');
  assert.deepEqual(footprintCell(row, 'buy'), { text: '9', tone: 'positive', value: 9 });
  assert.deepEqual(footprintCell(row, 'sell'), { text: '3', tone: 'negative', value: 3 });
  assert.equal(footprintCell({ bid: 5, ask: 1, unknown: 0 }, 'deltaPct').text, '-67%');
  // Only unclassified ticks: side-based modes stay empty instead of inventing a split.
  const unknownOnly = { bid: 0, ask: 0, unknown: 7 };
  for (const mode of ['delta', 'deltaPct', 'buy', 'sell']) assert.equal(footprintCell(unknownOnly, mode).text, '', mode);
  assert.equal(footprintCell(unknownOnly, 'volume').text, '7');
  for (const mode of FOOTPRINT_MODES) assert.equal(footprintCell({ bid: 0, ask: 0, unknown: 0 }, mode).text, '', 'an empty row shows nothing in ' + mode);
  assert.throws(() => footprintCell(row, 'heatmap'), /Unknown footprint mode/);
});
