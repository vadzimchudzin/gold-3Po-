import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewport, barX, indexAt, visibleRange, panTime, zoomTime, followNewBars, resetTime, autoPriceRange, priceRangeOf, panPrice, scalePrice, resetPrice, niceStep } from './chart-view.js';

const W = 800;

test('the newest bar sits rightOffset bars from the right edge and x maps back to the same bar', () => {
  const view = createViewport({ barSpacing: 10, rightOffset: 3 });
  assert.equal(barX(view, 99, 100, W), W - 35);
  for (const i of [0, 37, 98, 99]) assert.equal(indexAt(view, barX(view, i, 100, W), 100, W), i);
  const { from, to } = visibleRange(view, 100, W);
  assert.equal(to, 99);
  assert.ok(from <= 100 - Math.floor((W - 30) / 10) && from >= 0);
});

test('dragging right reveals older bars; the series can never be dragged off screen', () => {
  const view = createViewport({ barSpacing: 10, rightOffset: 3 });
  panTime(view, 200, 100, W);
  assert.equal(view.rightOffset, -17, 'twenty bars back');
  assert.ok(visibleRange(view, 100, W).to < 99);
  panTime(view, 1e6, 100, W);
  assert.ok(view.rightOffset >= -98, 'at least two bars stay on screen');
  panTime(view, -1e6, 100, W);
  assert.ok(barX(view, 99, 100, W) > 0, 'the newest bar cannot leave on the left');
});

test('wheel zoom keeps the bar under the cursor where it is', () => {
  const view = createViewport({ barSpacing: 10, rightOffset: 3 });
  const anchor = 400, n = 300;
  const before = indexAt(view, anchor, n, W);
  zoomTime(view, 1.8, anchor, n, W);
  assert.equal(view.barSpacing, 18);
  assert.equal(indexAt(view, anchor, n, W), before);
  zoomTime(view, 0.01, anchor, n, W);
  assert.equal(view.barSpacing, view.minSpacing, 'zoom is bounded');
});

test('a view on the newest bars follows new candles; a view scrolled into history stays on its bars', () => {
  const atEdge = createViewport({ barSpacing: 10, rightOffset: 3 });
  followNewBars(atEdge, 1);
  assert.equal(atEdge.rightOffset, 3, 'the newest bar keeps its place, the series moves left');
  const back = createViewport({ barSpacing: 10, rightOffset: 3 });
  panTime(back, 300, 200, W);
  const shown = indexAt(back, 400, 200, W);
  followNewBars(back, 2);
  assert.equal(indexAt(back, 400, 202, W), shown, 'the bar being read does not move');
  resetTime(back);
  assert.equal(back.rightOffset, 3);
});

test('price is automatic until dragged, then pans and stretches, and a reset returns to automatic', () => {
  const bars = [{ h: 105, l: 100 }, { h: 110, l: 102 }, { h: 108, l: 104 }];
  const auto = autoPriceRange(bars, 0, 2, { margin: 0 });
  assert.deepEqual(auto, { min: 100, max: 110 });
  const view = createViewport();
  assert.deepEqual(priceRangeOf(view, auto), auto);
  panPrice(view, 50, 500, auto);
  assert.equal(view.priceAuto, false);
  assert.deepEqual(priceRangeOf(view, { min: 0, max: 1 }), { min: 101, max: 111 }, 'dragging down by a tenth of the height shows prices a tenth higher');
  scalePrice(view, 2, auto);
  assert.deepEqual(priceRangeOf(view, auto), { min: 96, max: 116 });
  resetPrice(view);
  assert.deepEqual(priceRangeOf(view, auto), auto);
  assert.equal(autoPriceRange([], 0, -1), null);
});

test('grid steps are round numbers with room between the lines', () => {
  assert.equal(niceStep(300, 400, 40), 50);
  assert.equal(niceStep(3, 300, 40), 0.5);
  assert.equal(niceStep(10, 500, 46), 1);
});
