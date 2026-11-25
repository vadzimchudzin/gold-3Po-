// TradingView-style viewport for a canvas time series, shared by the price chart and the footprint.
//
// Time: every bar is `barSpacing` pixels wide and the newest bar sits `rightOffset` bars from the right
// edge of the plot. Dragging changes rightOffset, the wheel changes barSpacing around the cursor, so the
// bar under the cursor stays put. When the trader is looking at the newest bars the view follows new
// candles; scrolled back into history it stays on the bars being read.
// Price: automatic (fitted to the visible bars) until the trader drags the plot vertically or stretches
// the price axis; a double click returns it to automatic.

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function createViewport({ barSpacing = 9, minSpacing = 2, maxSpacing = 160, rightOffset = 3 } = {}) {
  return { barSpacing, minSpacing, maxSpacing, rightOffset, defaultSpacing: barSpacing, defaultOffset: rightOffset, priceAuto: true, priceMin: null, priceMax: null };
}

// Centre x of bar `index` among `count` bars in a plot `width` pixels wide.
export function barX(view, index, count, width) {
  return width - (view.rightOffset + (count - 1 - index) + 0.5) * view.barSpacing;
}

// The bar under x, unclamped (may be < 0 or >= count).
export function indexAt(view, x, count, width) {
  return Math.round(count - 1 - ((width - x) / view.barSpacing - 0.5 - view.rightOffset));
}

export function visibleRange(view, count, width) {
  if (!count) return { from: 0, to: -1 };
  const from = clamp(indexAt(view, 0, count, width) - 1, 0, count - 1);
  const to = clamp(indexAt(view, width, count, width) + 1, 0, count - 1);
  return { from, to };
}

// Keep at least two bars on screen whichever way the series is dragged.
function limitOffset(view, count, width) {
  const visibleBars = width / view.barSpacing;
  view.rightOffset = clamp(view.rightOffset, -(count - 2), Math.max(2, visibleBars - 2));
}

export function panTime(view, dx, count, width) {
  view.rightOffset -= dx / view.barSpacing;
  limitOffset(view, count, width);
}

export function zoomTime(view, factor, anchorX, count, width) {
  const before = view.barSpacing;
  const next = clamp(before * factor, view.minSpacing, view.maxSpacing);
  if (next === before) return;
  const fromRight = width - clamp(anchorX, 0, width);
  view.rightOffset += fromRight * (1 / next - 1 / before);
  view.barSpacing = next;
  limitOffset(view, count, width);
}

// New candles arrived: a view on the newest bars follows them; a view scrolled into history stays put.
export function followNewBars(view, added) {
  if (added > 0 && view.rightOffset < -0.5) view.rightOffset -= added;
}

export function resetTime(view) {
  view.barSpacing = view.defaultSpacing;
  view.rightOffset = view.defaultOffset;
}

// The automatic price band: the visible highs and lows with a margin, never a flat line.
export function autoPriceRange(bars, from, to, { margin = 0.08, minSpan = 0 } = {}) {
  let low = Infinity, high = -Infinity;
  for (let i = from; i <= to; i++) {
    const bar = bars[i];
    if (!bar) continue;
    if (bar.l < low) low = bar.l;
    if (bar.h > high) high = bar.h;
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  let span = Math.max(high - low, minSpan, Math.abs(high) * 1e-4);
  const mid = (high + low) / 2;
  span *= 1 + margin * 2;
  return { min: mid - span / 2, max: mid + span / 2 };
}

export function priceRangeOf(view, auto) {
  if (view.priceAuto || !Number.isFinite(view.priceMin) || !Number.isFinite(view.priceMax)) return auto;
  return { min: view.priceMin, max: view.priceMax };
}

// Leave automatic mode from whatever is on screen now.
function manual(view, range) {
  if (view.priceAuto || !Number.isFinite(view.priceMin)) { view.priceMin = range.min; view.priceMax = range.max; }
  view.priceAuto = false;
}

export function panPrice(view, dy, height, range) {
  manual(view, range);
  const shift = dy * (view.priceMax - view.priceMin) / Math.max(1, height);
  view.priceMin += shift;
  view.priceMax += shift;
}

export function scalePrice(view, factor, range) {
  manual(view, range);
  const mid = (view.priceMax + view.priceMin) / 2;
  const half = Math.max((view.priceMax - view.priceMin) / 2 * factor, 1e-6);
  view.priceMin = mid - half;
  view.priceMax = mid + half;
}

export function resetPrice(view) {
  view.priceAuto = true;
  view.priceMin = null;
  view.priceMax = null;
}

// Round grid steps (1, 2, 2.5, 5 × 10^n) with at least `minPixels` between lines.
export function niceStep(span, pixels, minPixels = 42) {
  const raw = span * minPixels / Math.max(1, pixels);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map(m => m * magnitude).find(step => step >= raw) || raw;
}
