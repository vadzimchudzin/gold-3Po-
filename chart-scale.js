// Responsive base pitch plus explicit trader-controlled zoom.
// Dense history becomes horizontally scrollable; zoom-out fits more bars into the panel.
export const MIN_BAR_PX = Object.freeze({ compact: 5, laptop: 3, wide: 2 });
export const CHART_AXIS = Object.freeze({ left: 64, right: 85 });
export const CHART_ZOOM = Object.freeze({ min: 0.25, max: 8 });

export function minBarWidth(paneWidth) {
  if (!Number.isFinite(paneWidth) || paneWidth <= 0) throw new TypeError('paneWidth must be a positive number');
  if (paneWidth >= 1600) return MIN_BAR_PX.wide;
  if (paneWidth >= 900) return MIN_BAR_PX.laptop;
  return MIN_BAR_PX.compact;
}

export function chartScale({ panelWidth, bars, left = CHART_AXIS.left, right = CHART_AXIS.right, zoom = 1 } = {}) {
  if (!Number.isFinite(panelWidth) || panelWidth <= 0) throw new TypeError('panelWidth must be a positive number');
  if (!Number.isInteger(bars) || bars < 0) throw new TypeError('bars must be a non-negative integer');
  if (!Number.isFinite(zoom) || zoom < CHART_ZOOM.min || zoom > CHART_ZOOM.max) {
    throw new TypeError(`zoom must be between ${CHART_ZOOM.min} and ${CHART_ZOOM.max}`);
  }
  const pane = Math.max(200, Math.round(panelWidth) - left - right);
  const minBar = minBarWidth(pane);
  if (bars === 0) return { pane, minBar, width: pane, svgWidth: left + pane + right, step: pane, zoom };
  const fitStep = pane / bars;
  const baseStep = Math.max(minBar, fitStep);
  const desiredStep = Math.max(0.5, baseStep * zoom);
  const width = Math.max(pane, Math.round(bars * desiredStep));
  const step = width / bars;
  return { pane, minBar, width, svgWidth: left + width + right, step, zoom };
}

// One wheel notch. TradingView zooms the time axis with a plain wheel and the price axis with
// Shift held; Ctrl/Meta alone is the browser's pinch gesture and stays on the time axis.
export const CHART_WHEEL_STEP = 1.12;

export function wheelIntent({ deltaY = 0, shiftKey = false } = {}) {
  if (!Number.isFinite(deltaY) || deltaY === 0) return null;
  return { axis: shiftKey ? 'price' : 'time', factor: deltaY < 0 ? CHART_WHEEL_STEP : 1 / CHART_WHEEL_STEP };
}

// Zoom keeps the price or time under the cursor still: the content is scaled about the pointer,
// then the scroll offset is corrected for the new width.
export function zoomScrollAnchor({ scrollLeft = 0, viewportWidth, widthBefore, widthAfter, anchorX }) {
  if (!(widthBefore > 0) || !(widthAfter > 0)) throw new TypeError('widths must be positive');
  const local = Math.max(0, Math.min(Number.isFinite(anchorX) ? anchorX : 0, Math.max(0, viewportWidth)));
  const contentX = Math.max(0, scrollLeft) + local;
  const next = contentX * (widthAfter / widthBefore) - local;
  const maxScroll = Math.max(0, widthAfter - Math.max(0, viewportWidth));
  return Math.max(0, Math.min(maxScroll, next));
}

// Sticky price extent. Re-centring the axis on every render is what makes a live chart jump: the
// whole series shifts vertically each time a tick prints. The visible band is kept as long as the
// data stays inside it, expanded when price leaves it, and recomputed only on a real change of
// scale, viewport or instrument.
export const PRICE_RANGE = Object.freeze({ paddingRatio: 0.04, minPadding: 0.02, minRange: 0.01, feedJumpFactor: 3 });

export function priceRange({
  prices,
  previous = null,
  zoom = 1,
  paddingRatio = PRICE_RANGE.paddingRatio,
  minPadding = PRICE_RANGE.minPadding,
  minRange = PRICE_RANGE.minRange,
  feedJumpFactor = PRICE_RANGE.feedJumpFactor
} = {}) {
  const values = (Array.isArray(prices) ? prices : []).map(Number).filter(value => Number.isFinite(value));
  if (!values.length) throw new TypeError('prices must contain at least one finite number');
  if (!Number.isFinite(zoom) || zoom < CHART_ZOOM.min || zoom > CHART_ZOOM.max) {
    throw new TypeError(`zoom must be between ${CHART_ZOOM.min} and ${CHART_ZOOM.max}`);
  }
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = Math.max(minRange, hi - lo);
  const padding = Math.max(minPadding, span * paddingRatio);
  const fresh = () => {
    const visible = (hi - lo + padding * 2) / zoom;
    const center = (lo + hi) / 2;
    return { min: center - visible / 2, max: center + visible / 2, zoom, fresh: true };
  };
  if (!previous || !Number.isFinite(previous.min) || !Number.isFinite(previous.max) || previous.max <= previous.min) return fresh();
  if (previous.zoom !== zoom) return fresh();
  // A series far outside the previous band is a different instrument or timeframe, not a tick.
  if (hi - lo > (previous.max - previous.min) * feedJumpFactor) return fresh();
  if (lo >= previous.min && hi <= previous.max) return { min: previous.min, max: previous.max, zoom, fresh: false };
  // Only the edge price actually left grows, so the rest of the ladder keeps its position.
  if (hi < previous.min || lo > previous.max) return fresh();
  return {
    min: lo < previous.min ? Math.min(previous.min, lo - padding) : previous.min,
    max: hi > previous.max ? Math.max(previous.max, hi + padding) : previous.max,
    zoom,
    fresh: false
  };
}
