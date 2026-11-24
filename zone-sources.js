// Extra level sources, so zones are not built from swing shapes alone.
// Everything is derived from the same broker history: completed days and sessions, the previous week,
// higher-timeframe swings (H1/H4 built from the same candles) and the volume profile.
// A level that several sources agree on is a confluence zone, which the finder scores higher.
const finite = n => Number.isFinite(n);
const timeOf = bar => Number.isFinite(Date.parse(bar?.time)) ? Date.parse(bar.time) : null;
const HOUR = 3600_000;

// Extremes of a filtered slice of candles. The indexes point into the original series (`__i`), not into
// the slice, so a level's age and formation time come from the candle that actually set it.
function extremes(bars) {
  let high = -Infinity, low = Infinity, close = null, open = null, highIndex = -1, lowIndex = -1, openIndex = -1;
  for (const b of bars) {
    if (!finite(b.h) || !finite(b.l)) continue;
    if (b.h > high) { high = b.h; highIndex = b.__i; }
    if (b.l < low) { low = b.l; lowIndex = b.__i; }
    if (finite(b.c)) close = b.c;
    if (open === null && finite(b.o)) { open = b.o; openIndex = b.__i; }
  }
  return high > low ? { high, low, close, open, highIndex, lowIndex, openIndex } : null;
}

function aggregated(bars, bucketMs) {
  const out = [];
  for (const bar of bars) {
    const time = timeOf(bar);
    if (time === null) continue;
    const start = Math.floor(time / bucketMs) * bucketMs;
    const last = out.at(-1);
    if (last && last.start === start) {
      last.h = Math.max(last.h, bar.h); last.l = Math.min(last.l, bar.l); last.c = bar.c; last.i = bar.__i;
    } else out.push({ start, o: bar.o, h: bar.h, l: bar.l, c: bar.c, i: bar.__i });
  }
  return out;
}

function pivots(series, width = 2) {
  const found = [];
  for (let i = width; i < series.length - width; i++) {
    const around = series.slice(i - width, i + width + 1);
    const bar = series[i];
    if (!finite(bar.h) || !finite(bar.l) || bar.h <= bar.l) continue;
    if (around.every(x => x.h <= bar.h)) found.push({ price: bar.h, type: 'high', index: bar.i ?? i });
    if (around.every(x => x.l >= bar.l)) found.push({ price: bar.l, type: 'low', index: bar.i ?? i });
  }
  return found;
}

// Volume profile over the recent window: point of control plus the 70% value area edges.
function volumeProfile(bars, priceStep) {
  const window = bars.slice(-96);
  const bins = new Map();
  for (const bar of window) {
    const rows = Array.isArray(bar.levels) && bar.levels.length
      ? bar.levels.map(l => [l.price, (l.bid || 0) + (l.ask || 0) + (l.unknown || 0)])
      : [[(bar.h + bar.l + (bar.c ?? bar.h)) / 3, finite(bar.volume) && bar.volume > 0 ? bar.volume : 1]];
    for (const [price, volume] of rows) {
      if (!finite(price) || !(volume > 0)) continue;
      const key = Math.round(price / priceStep) * priceStep;
      const entry = bins.get(key) || { volume: 0, peak: 0, index: Number.isInteger(bar.__i) ? bar.__i : 0 };
      entry.volume += volume;
      if (volume > entry.peak) { entry.peak = volume; entry.index = Number.isInteger(bar.__i) ? bar.__i : entry.index; }
      bins.set(key, entry);
    }
  }
  if (bins.size < 5) return [];
  const sorted = [...bins.entries()].sort((a, b) => b[1].volume - a[1].volume);
  const total = sorted.reduce((sum, [, entry]) => sum + entry.volume, 0);
  const poc = sorted[0][0];
  const order = [...bins.keys()].sort((a, b) => a - b);
  const pocIndex = order.indexOf(poc);
  let lowIndex = pocIndex, highIndex = pocIndex, accumulated = bins.get(poc).volume;
  while (accumulated < total * 0.7 && (lowIndex > 0 || highIndex < order.length - 1)) {
    const below = lowIndex > 0 ? bins.get(order[lowIndex - 1]).volume : -1;
    const above = highIndex < order.length - 1 ? bins.get(order[highIndex + 1]).volume : -1;
    if (above >= below) { highIndex++; accumulated += above; } else { lowIndex--; accumulated += below; }
  }
  const at = price => bins.get(price).index;
  return [
    { price: poc, label: 'Volume POC', source: 'volume', weight: 0.7, index: at(poc) },
    { price: order[highIndex], label: 'Value area high', source: 'volume', weight: 0.55, index: at(order[highIndex]) },
    { price: order[lowIndex], label: 'Value area low', source: 'volume', weight: 0.55, index: at(order[lowIndex]) }
  ];
}

export function collectSourceLevels(bars, { priceStep = 0.1, use = {} } = {}) {
  if (!Array.isArray(bars) || !finite(priceStep) || priceStep <= 0) throw new TypeError('Invalid source level input');
  if (bars.length < 6) return [];
  const allowed = { priorDay: use.priorDay !== false, sessions: use.sessions !== false, week: use.week !== false, higherTf: use.higherTf !== false, volume: use.volume !== false };
  const levels = [];
  const indexed = bars.map((bar, i) => ({ ...bar, __i: i }));
  const timed = indexed.filter(bar => timeOf(bar) !== null);

  if (timed.length >= 20) {
    const days = new Map();
    for (const bar of timed) {
      const key = new Date(timeOf(bar)).toISOString().slice(0, 10);
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(bar);
    }
    const keys = [...days.keys()].sort();
    // Previous completed day: the strongest reference for an intraday chart.
    if (allowed.priorDay) for (const [offset, weight] of [[2, 0.9], [3, 0.5]]) {
      const day = extremes(days.get(keys.at(-offset)) || []);
      if (!day) continue;
      const tag = offset === 2 ? 'Prior day' : 'Two days ago';
      levels.push({ price: day.high, label: tag + ' high', source: 'day', weight, index: day.highIndex });
      levels.push({ price: day.low, label: tag + ' low', source: 'day', weight, index: day.lowIndex });
    }
    const today = keys.at(-1);
    const sessions = [['Asia', 0, 7], ['London', 7, 12], ['New York', 12, 17]];
    if (allowed.sessions) for (const [name, from, to] of sessions) {
      const sessionBars = timed.filter(bar => {
        const time = timeOf(bar);
        const day = new Date(time).toISOString().slice(0, 10);
        const hour = new Date(time).getUTCHours();
        return (day === today || day === keys.at(-2)) && hour >= from && hour < to;
      });
      const session = extremes(sessionBars);
      if (!session) continue;
      levels.push({ price: session.high, label: name + ' high', source: 'session', weight: 0.6, index: session.highIndex });
      levels.push({ price: session.low, label: name + ' low', source: 'session', weight: 0.6, index: session.lowIndex });
    }
    // Week boundaries: Monday-based week open plus the previous week's extremes.
    const weeks = new Map();
    for (const bar of timed) {
      const time = timeOf(bar);
      const date = new Date(time);
      const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((date.getUTCDay() + 6) % 7)));
      const key = monday.toISOString().slice(0, 10);
      if (!weeks.has(key)) weeks.set(key, []);
      weeks.get(key).push(bar);
    }
    const weekKeys = [...weeks.keys()].sort();
    const currentWeek = extremes(weeks.get(weekKeys.at(-1)) || []);
    if (allowed.week && currentWeek && finite(currentWeek.open)) levels.push({ price: currentWeek.open, label: 'Weekly open', source: 'week', weight: 0.5, index: currentWeek.openIndex });
    const previousWeek = extremes(weeks.get(weekKeys.at(-2)) || []);
    if (allowed.week && previousWeek) {
      levels.push({ price: previousWeek.high, label: 'Prior week high', source: 'week', weight: 0.65, index: previousWeek.highIndex });
      levels.push({ price: previousWeek.low, label: 'Prior week low', source: 'week', weight: 0.65, index: previousWeek.lowIndex });
    }
    // Higher-timeframe swings: the same candles, bucketed into 4h and 1h structures.
    for (const [name, bucket] of [['H4', 4 * HOUR], ['H1', HOUR]]) {
      if (!allowed.higherTf) break;
      const series = aggregated(timed, bucket);
      if (series.length < 12) continue;
      for (const pivot of pivots(series, 2).slice(-6)) {
        levels.push({ price: pivot.price, label: `${name} swing ${pivot.type === 'high' ? 'high' : 'low'}`, source: name.toLowerCase(), weight: 0.75, index: pivot.index });
      }
    }
  }

  if (allowed.volume) levels.push(...volumeProfile(indexed, priceStep));
  return levels.filter(level => finite(level.price) && level.price > 0);
}
