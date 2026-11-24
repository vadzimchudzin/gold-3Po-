import assert from 'node:assert/strict';
import test from 'node:test';
import { deltaPaneMarkup, deltaSeries, formatDelta, DELTA_PANE } from './delta-pane.js';

test('cumulative delta adds every bar delta and keeps the running total', () => {
  const series = deltaSeries([{ delta: 5 }, { delta: -12 }, { delta: 3 }]);
  assert.deepEqual(series.map(item => item.delta), [5, -12, 3]);
  assert.deepEqual(series.map(item => item.cumulative), [5, -7, -4]);
});

test('an unknown aggressor side contributes nothing instead of poisoning the total', () => {
  const series = deltaSeries([{ delta: 4 }, { delta: null }, {}, { delta: 'x' }, { delta: 1 }]);
  assert.deepEqual(series.map(item => item.cumulative), [4, 4, 4, 4, 5]);
});

test('delta values are grouped and signed for reading at a glance', () => {
  assert.equal(formatDelta(12480), '+12\u00a0480');
  assert.equal(formatDelta(-12480), '−12\u00a0480');
  assert.equal(formatDelta(0), '0');
  assert.equal(formatDelta(999), '+999');
  assert.equal(formatDelta(Number.NaN), '0');
});

test('the pane marks the running total against a zero line', () => {
  const bars = [{ delta: 10 }, { delta: 6 }, { delta: -2 }];
  const pane = deltaPaneMarkup(bars, { step: 20, width: 200, svgWidth: 300 });
  assert.equal(pane.current, 14);
  assert.ok(pane.html.includes('delta-zero'), 'zero line is drawn');
  assert.ok(pane.html.includes('delta-area up'), 'net buying fills above the line in the up tone');
  assert.ok(pane.html.includes('delta-value up'), 'the current total is labelled');
  assert.ok(pane.html.includes('+14'), 'the label carries the running total');
  assert.ok(pane.html.includes('delta-caption'), 'the per-bar delta is captioned');

  const netSelling = deltaPaneMarkup([{ delta: -8 }, { delta: -4 }], { step: 20, width: 200 });
  assert.ok(netSelling.html.includes('delta-area down'), 'net selling uses the down tone');
  assert.equal(netSelling.current, -12);
});

test('the area closes on the zero line so it cannot drift off the baseline', () => {
  const pane = deltaPaneMarkup([{ delta: 3 }, { delta: 9 }], { step: 10, width: 100, svgWidth: 180 });
  const mid = (DELTA_PANE.TOP + (DELTA_PANE.HEIGHT - DELTA_PANE.LABEL_ROW) / 2).toFixed(1);
  const area = pane.html.match(/d="([^"]+)" class="delta-area/);
  assert.ok(area, 'the area path exists');
  const escaped = mid.replace('.', '\\.');
  assert.match(area[1], new RegExp(`L[\\d.]+ ${escaped} Z$`), 'the path returns to the zero line: ' + area[1].slice(-30));
});

test('a bigger running total is drawn higher on the pane', () => {
  const pane = deltaPaneMarkup([{ delta: 1 }, { delta: 100 }], { step: 10, width: 100, svgWidth: 180 });
  const ys = [...pane.html.matchAll(/[ML]\d+\.?\d* (\d+\.\d)/g)].map(match => Number(match[1]));
  assert.ok(ys[1] < ys[0], 'the second point sits above the first: ' + ys.join(', '));
});

test('an empty chart yields an empty pane, not a broken path', () => {
  const pane = deltaPaneMarkup([], { step: 10, width: 100 });
  assert.equal(pane.html, '');
  assert.equal(pane.current, 0);
  assert.equal(pane.peak, 0);
});

test('the pane spans the chart width plus the axis gutter', () => {
  assert.equal(deltaPaneMarkup([{ delta: 1 }], { width: 500 }).svgWidth, DELTA_PANE.LEFT + 500 + DELTA_PANE.AXIS);
  assert.equal(deltaPaneMarkup([{ delta: 1 }], { width: 500, svgWidth: 640 }).svgWidth, 640);
  assert.equal(deltaPaneMarkup([{ delta: 1 }], { width: 900, svgWidth: 100 }).svgWidth, DELTA_PANE.LEFT + 900 + 8);
});
