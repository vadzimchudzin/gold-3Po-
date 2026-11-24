// Measures what price actually did at a level: how often it respected the zone versus closed through it.
// This is the evidence behind a zone's strength, so a level that looks neat on a chart but has been
// cut through repeatedly cannot claim a high score.
//
// A "touch" is a run of consecutive candles overlapping the zone, entered from outside it.
// From the first candle of that run the measurement looks at most `horizon` candles ahead (the run
// itself included, so a long run is not given extra look-ahead) and takes the first outcome:
//   respected — price turned back and left the zone by reactionAtr * ATR on the side it arrived from
//               (a touch from below must fall under zone.low, a touch from above must rise over zone.high);
//   broken    — a candle closed through the zone by breakAtr * ATR on the opposite side;
//   neutral   — neither happened inside the horizon (the level was left alone or drifted away).
const finite = n => Number.isFinite(n);

export const DEFAULT_REACTION_OPTIONS = Object.freeze({ horizon: 12, reactionAtr: 0.5, breakAtr: 0.25 });

export function measureZoneReactions(bars, zone, options = {}) {
  const { horizon = DEFAULT_REACTION_OPTIONS.horizon, reactionAtr = DEFAULT_REACTION_OPTIONS.reactionAtr, breakAtr = DEFAULT_REACTION_OPTIONS.breakAtr, atr } = options;
  if (!Array.isArray(bars) || !zone || !finite(zone.low) || !finite(zone.high) || zone.low >= zone.high) throw new TypeError('Invalid zone reaction input');
  if (!finite(atr) || atr <= 0) throw new TypeError('Zone reaction measurement needs a positive ATR');
  if (!Number.isInteger(horizon) || horizon < 1) throw new TypeError('Zone reaction horizon must be a positive integer');
  if (!finite(reactionAtr) || reactionAtr <= 0 || !finite(breakAtr) || breakAtr < 0) throw new TypeError('Invalid zone reaction thresholds');

  let touches = 0, respected = 0, broken = 0, neutral = 0, lastTouchIndex = null, barsToReact = 0;
  const reach = reactionAtr * atr, breakOut = breakAtr * atr;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!finite(bar.h) || !finite(bar.l)) continue;
    if (bar.h < zone.low || bar.l > zone.high) continue;

    // Merge the whole overlapping run into a single touch.
    let end = i;
    while (end + 1 < bars.length && bars[end + 1].h >= zone.low && bars[end + 1].l <= zone.high && finite(bars[end + 1].h) && finite(bars[end + 1].l)) end++;

    const previous = bars[i - 1];
    const approachedFromBelow = previous && finite(previous.c) ? previous.c < zone.low : bar.c < (zone.low + zone.high) / 2;
    touches++;
    lastTouchIndex = end;

    let outcome = 'neutral';
    // Scan from the first candle of the run so the first outcome wins. The horizon counts from the touch
    // itself, so a wide zone that holds price for many candles gets no longer window than a thin one.
    const limit = Math.min(bars.length - 1, i + horizon);
    for (let k = i; k <= limit; k++) {
      const candle = bars[k];
      if (!finite(candle.c) || !finite(candle.h) || !finite(candle.l)) continue;
      // A close through the zone is the stronger signal: assume the level failed even if price also reacted.
      const brokeThrough = approachedFromBelow ? candle.c >= zone.high + breakOut : candle.c <= zone.low - breakOut;
      // The reaction is a move back to the side price arrived from. On candles of the touch itself only the
      // close counts: their wick on that side may have printed before they reached the zone.
      const away = approachedFromBelow ? (k <= end ? candle.c : candle.l) : (k <= end ? candle.c : candle.h);
      const heldAway = approachedFromBelow ? away <= zone.low - reach : away >= zone.high + reach;
      if (brokeThrough) { outcome = 'broken'; break; }
      if (heldAway) { outcome = 'respected'; barsToReact += k - i + 1; break; }
    }
    if (outcome === 'respected') respected++;
    else if (outcome === 'broken') broken++;
    else neutral++;

    i = end;
  }

  // Laplace smoothing: one lucky bounce out of one touch must not read as a 100% zone.
  const rate = (respected + 0.5 * neutral + 0.5) / (touches + 1);
  return {
    touches,
    respected,
    broken,
    neutral,
    rate: Number(rate.toFixed(3)),
    lastTouchIndex,
    avgBarsToReact: respected > 0 ? Number((barsToReact / respected).toFixed(1)) : null
  };
}
