// Order-flow math shared by the server analysis and the live browser path.
// The definitions match the published behaviour of TradingView's volume footprint and
// Quantower's cluster chart, so a number here means the same thing it means there:
//  - imbalance is diagonal: ask volume at a price against bid volume one level below,
//    and bid volume against ask volume one level above (max >= ratio x min);
//  - the value area is the 70% of a bar's volume traded around its point of control;
//  - an unfinished auction is a bar extreme where both sides still printed.

const finite = n => Number.isFinite(n);
const positive = n => finite(n) && n > 0;
const volumeOf = row => (Number(row.bid) || 0) + (Number(row.ask) || 0) + (Number(row.unknown) || 0);

export const DEFAULT_FOOTPRINT_OPTIONS = Object.freeze({
  imbalanceRatio: 3,      // 300%: the bigger side must be three times the smaller one
  imbalanceLevels: 3,     // consecutive imbalanced levels that make a stack
  minLevelVolume: 3,      // a row thinner than this is noise, never an imbalance
  valueAreaShare: 0.7,    // share of the bar's volume the value area must cover
  absorptionMultiple: 2,  // an edge row carrying this many median rows was absorbed
  ticksPerRow: 1          // price steps grouped into one footprint row (1 = the source precision)
});

// Which side a quote-only print belongs to. Explicit MT5 BUY/SELL flags (or a vendor aggressor) win.
// A Last-mode print through the quote is classified by the quote. A print on the Bid, which is every tick
// of an OTC Bid chart such as RoboForex XAUUSD, follows the tick rule on the chart price: an uptick is a
// buy, a downtick a sell, an unchanged price keeps the previous side. The server aggregation and the
// live browser bar use this one function, seeded with the same state, so both split volume alike.
export function createTickClassifier(state = {}) {
  let prevPrice = finite(state.prevPrice) ? state.prevPrice : null;
  let prevSide = state.prevSide === 'buy' || state.prevSide === 'sell' ? state.prevSide : null;
  return {
    classify(tick = {}) {
      const price = Number(tick.last);
      const flags = Number.isInteger(tick.flags) ? tick.flags : 0;
      let side = tick.aggressorSide === 'buy' || tick.aggressorSide === 'sell' ? tick.aggressorSide
        : (flags & 32) ? 'buy' : (flags & 64) ? 'sell' : null;
      const bid = Number(tick.bid), ask = Number(tick.ask);
      if (!side && finite(bid) && finite(ask) && ask > bid && finite(price)) {
        if (price >= ask) side = 'buy';
        else if (price < bid) side = 'sell';
      }
      // The tick rule only for prints that carry no quote information: a Bid-chart print sits on the
      // Bid by construction. A Last print between the quotes stays unknown instead of being guessed.
      const onBid = !finite(bid) || price <= bid;
      if (!side && onBid && finite(price) && prevPrice !== null) {
        side = price > prevPrice ? 'buy' : price < prevPrice ? 'sell' : prevSide;
      }
      if (finite(price) && price > 0) prevPrice = price;
      if (side === 'buy' || side === 'sell') prevSide = side;
      return side || 'unknown';
    },
    state: () => ({ prevPrice, prevSide })
  };
}

export function validateFootprintOptions(input = {}) {
  const o = { ...DEFAULT_FOOTPRINT_OPTIONS };
  for (const [key, value] of Object.entries(input || {})) {
    if (!(key in o) || value === undefined || value === null) continue;
    o[key] = Number(value);
  }
  const num = (key, lo, hi) => {
    if (!finite(o[key]) || o[key] < lo || o[key] > hi) throw new TypeError(`${key} must be between ${lo} and ${hi}`);
  };
  num('imbalanceRatio', 1.5, 10);
  num('valueAreaShare', 0.5, 0.95);
  num('absorptionMultiple', 1.5, 6);
  const int = (key, lo, hi) => {
    if (!Number.isInteger(o[key]) || o[key] < lo || o[key] > hi) throw new TypeError(`${key} must be an integer ${lo}..${hi}`);
  };
  int('imbalanceLevels', 2, 10);
  int('minLevelVolume', 1, 100);
  int('ticksPerRow', 1, 500);
  return o;
}

// Row grouping: the source keeps its own precision (one price step per tick row); the user chooses how
// many of those steps one footprint row shows. Volumes are summed, never re-estimated.
function groupRows(rows, rowStep) {
  const grouped = new Map();
  for (const row of rows) {
    const price = Number((Math.round(row.price / rowStep) * rowStep).toFixed(8));
    const target = grouped.get(price) || { price, bid: 0, ask: 0, unknown: 0 };
    target.bid += row.bid; target.ask += row.ask; target.unknown += row.unknown;
    grouped.set(price, target);
  }
  return [...grouped.values()].sort((a, b) => b.price - a.price);
}

export function tickSide(event = {}) {
  const side = event.aggressorSide ?? event.direction;
  return side === 'buy' || side === 'sell' ? side : 'unknown';
}

// Broker tick volume is activity, not contracts: only a reported size is used when the side is known.
export function tickVolume(event = {}) {
  if (tickSide(event) === 'unknown') return 1;
  const real = Number(event.realVolume), tick = Number(event.tickVolume);
  if (positive(real)) return real;
  if (positive(tick)) return tick;
  return 1;
}

export function emptyBar(timeMs, price) {
  return { timeMs, o: price, h: price, l: price, c: price, tickCount: 0, volume: 0, bid: 0, ask: 0, unknown: 0, levels: new Map() };
}

// One tick into one price row of a forming bar. Used by the server aggregation and by the
// browser, so a bar is built the same way whether it arrives whole or tick by tick.
export function applyTickToBar(bar, tick, priceStep) {
  if (!bar || !tick || !positive(priceStep)) throw new TypeError('Invalid footprint tick input');
  if (!bar.levels || typeof bar.levels.get !== 'function') throw new TypeError('Invalid footprint bar');
  const price = Number(tick.last);
  if (!positive(price)) throw new TypeError('Invalid footprint tick price');
  const step = Math.round(price / priceStep) * priceStep;
  const key = step.toFixed(8);
  let row = bar.levels.get(key);
  if (!row) { row = { price: step, bid: 0, ask: 0, unknown: 0 }; bar.levels.set(key, row); }
  const volume = tick.volume === undefined ? tickVolume(tick) : (positive(tick.volume) ? tick.volume : 1);
  const side = tickSide(tick);
  if (side === 'buy') { row.ask += volume; bar.ask += volume; }
  else if (side === 'sell') { row.bid += volume; bar.bid += volume; }
  else { row.unknown += volume; bar.unknown += volume; }
  bar.volume += volume;
  bar.tickCount += 1;
  bar.h = Math.max(bar.h, price);
  bar.l = Math.min(bar.l, price);
  bar.c = price;
  return bar;
}

function sortedRows(input) {
  const rows = input instanceof Map ? [...input.values()] : (Array.isArray(input) ? input : []);
  return rows
    .filter(row => row && positive(row.price))
    .map(row => ({ price: row.price, bid: Number(row.bid) || 0, ask: Number(row.ask) || 0, unknown: Number(row.unknown) || 0 }))
    .sort((a, b) => b.price - a.price);
}

// Value area: start at the point of control and grow towards the heavier neighbour until the
// required share of the bar's volume is covered. A tie takes the row above, which keeps the
// result deterministic instead of depending on iteration order.
function valueAreaAround(rows, pocIndex, total, share) {
  const need = total * share;
  let low = pocIndex, high = pocIndex, covered = volumeOf(rows[pocIndex]);
  while (covered < need && (low > 0 || high < rows.length - 1)) {
    const above = low > 0 ? volumeOf(rows[low - 1]) : -1;
    const below = high < rows.length - 1 ? volumeOf(rows[high + 1]) : -1;
    if (above < 0 && below < 0) break;
    if (below > above) { high += 1; covered += below; }
    else { low -= 1; covered += Math.max(above, 0); }
  }
  const included = rows.slice(low, high + 1);
  return {
    low: included.at(-1).price,
    high: included[0].price,
    volume: included.reduce((sum, row) => sum + volumeOf(row), 0),
    rows: included.length,
    share: total > 0 ? Number((included.reduce((sum, row) => sum + volumeOf(row), 0) / total).toFixed(4)) : 0
  };
}

// The ladder's price step when the caller did not pass one: the smallest distance between rows.
function smallestGap(levels) {
  let gap = Infinity;
  for (let i = 1; i < levels.length; i++) {
    const d = Math.abs(levels[i - 1].price - levels[i].price);
    if (d > 1e-9 && d < gap) gap = d;
  }
  return finite(gap) ? gap : 0;
}

function median(values) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function footprintOf(input, options = {}) {
  const o = validateFootprintOptions(options);
  const sourceRows = sortedRows(input);
  const sourceStep = positive(options.priceStep) ? options.priceStep : smallestGap(sourceRows);
  const rowStep = o.ticksPerRow > 1 && sourceStep > 0 ? sourceStep * o.ticksPerRow : sourceStep;
  const rows = o.ticksPerRow > 1 && sourceStep > 0 ? groupRows(sourceRows, rowStep) : sourceRows;
  const total = rows.reduce((sum, row) => sum + volumeOf(row), 0);
  const bid = rows.reduce((sum, row) => sum + row.bid, 0);
  const ask = rows.reduce((sum, row) => sum + row.ask, 0);
  const unknown = rows.reduce((sum, row) => sum + row.unknown, 0);
  const levels = rows.map(row => ({ ...row, total: volumeOf(row) }));
  const delta = ask - bid;
  if (!rows.length) {
    return {
      levels: [], total: 0, bid: 0, ask: 0, unknown: 0, delta: 0, deltaRatio: 0,
      poc: null, valueArea: null, imbalances: [], stackedImbalances: [],
      absorbedLevels: [], unfinishedHigh: false, unfinishedLow: false,
      maxLevelVolume: 0, medianLevelVolume: 0
    };
  }

  const mid = (finite(options.h) && finite(options.l)) ? (options.h + options.l) / 2 : rows[0].price;
  let pocIndex = 0;
  for (let i = 1; i < levels.length; i++) {
    const better = levels[i].total > levels[pocIndex].total;
    const tie = levels[i].total === levels[pocIndex].total;
    if (better || (tie && Math.abs(levels[i].price - mid) < Math.abs(levels[pocIndex].price - mid))) pocIndex = i;
  }

  // Diagonal imbalance: buy volume here against sell volume one price step lower, and the mirror.
  // Neighbours are compared only when they really are one step apart: rows with an untraded price
  // between them are not adjacent levels, even though they sit next to each other in the array.
  const step = rowStep;
  const adjacent = (a, b) => !!a && !!b && step > 0 && Math.abs(Math.abs(a.price - b.price) - step) < step * 1e-6;
  const imbalances = [];
  for (let i = 0; i < levels.length; i++) {
    const below = adjacent(levels[i], levels[i + 1]) ? levels[i + 1] : null;
    const above = adjacent(levels[i], levels[i - 1]) ? levels[i - 1] : null;
    if (below && levels[i].ask >= o.minLevelVolume && below.bid > 0 && levels[i].ask >= o.imbalanceRatio * below.bid) {
      imbalances.push({ side: 'buy', price: levels[i].price, ratio: Number((levels[i].ask / below.bid).toFixed(2)) });
    }
    if (above && levels[i].bid >= o.minLevelVolume && above.ask > 0 && levels[i].bid >= o.imbalanceRatio * above.ask) {
      imbalances.push({ side: 'sell', price: levels[i].price, ratio: Number((levels[i].bid / above.ask).toFixed(2)) });
    }
  }

  const stackedImbalances = [];
  for (const side of ['buy', 'sell']) {
    let run = [];
    for (let i = 0; i < levels.length; i++) {
      const hit = imbalances.some(item => item.side === side && item.price === levels[i].price);
      // A stack is consecutive price steps: a gap in the ladder ends the run.
      if (hit && run.length && !adjacent(levels[i], levels[i - 1])) {
        if (run.length >= o.imbalanceLevels) stackedImbalances.push({ side, prices: run });
        run = [];
      }
      if (hit) run.push(levels[i].price);
      else {
        if (run.length >= o.imbalanceLevels) stackedImbalances.push({ side, prices: run });
        run = [];
      }
    }
    if (run.length >= o.imbalanceLevels) stackedImbalances.push({ side, prices: run });
  }

  // Unfinished auction: the bar's extreme still shows volume on both sides, so the auction
  // never closed there and the level tends to pull price back.
  const top = levels[0], bottom = levels.at(-1);
  const unfinishedHigh = top.bid > 0 && top.ask > 0;
  const unfinishedLow = bottom.bid > 0 && bottom.ask > 0;

  // Absorption: an outer row carrying far more aggressive volume than a typical row while price
  // closed back inside the bar. That is a passive order soaking up the aggression, not a breakout.
  // Only volume with a known aggressor counts: ticks the broker did not classify cannot show that
  // anyone was absorbed, so they never create an absorption mark on their own.
  // The threshold compares like with like: aggressive volume against the median aggressive row, so
  // unclassified ticks neither create a mark nor inflate the bar it is measured against.
  const rowVolumes = levels.map(row => row.total).filter(value => value > 0);
  const medianLevelVolume = median(rowVolumes);
  const medianAggressive = median(levels.map(row => row.bid + row.ask).filter(value => value > 0));
  const absorbedLevels = [];
  if (medianAggressive > 0 && finite(options.c)) {
    for (const row of levels) {
      const edge = row === top || row === bottom || Math.abs(row.price - options.h) < 1e-9 || Math.abs(row.price - options.l) < 1e-9;
      if (!edge) continue;
      const aggressive = row.bid + row.ask;
      if (aggressive < o.absorptionMultiple * medianAggressive) continue;
      if (Math.abs(options.c - row.price) < 1e-9) continue;
      absorbedLevels.push({ price: row.price, volume: aggressive, multiple: Number((aggressive / medianAggressive).toFixed(2)) });
    }
  }

  return {
    levels, total, bid, ask, unknown, delta,
    deltaRatio: total > 0 ? Number((delta / total).toFixed(4)) : 0,
    poc: levels[pocIndex].price,
    valueArea: valueAreaAround(levels, pocIndex, total, o.valueAreaShare),
    imbalances, stackedImbalances, absorbedLevels, unfinishedHigh, unfinishedLow,
    maxLevelVolume: Math.max(...levels.map(row => row.total)),
    medianLevelVolume
  };
}

// Session volume profile: the same aggregation over a whole trading day instead of one bar.
// A point of control that later price never traded back through is "naked" and acts as a magnet.
export function sessionProfile(bars, { priceStep = 0.1, sessionMs = 86400000, options = {} } = {}) {
  if (!Array.isArray(bars) || !positive(priceStep)) throw new TypeError('Invalid session profile input');
  const sessions = new Map();
  for (const bar of bars) {
    const time = Date.parse(bar.time);
    if (!finite(time)) continue;
    const key = Math.floor(time / sessionMs) * sessionMs;
    let session = sessions.get(key);
    if (!session) {
      session = emptyBar(key, Number(bar.o));
      session.first = key;
      session.last = key;
      sessions.set(key, session);
    }
    for (const row of bar.levels || []) {
      const price = Number(row.price);
      if (!positive(price)) continue;
      const levelKey = price.toFixed(8);
      let target = session.levels.get(levelKey);
      if (!target) { target = { price, bid: 0, ask: 0, unknown: 0 }; session.levels.set(levelKey, target); }
      target.bid += Number(row.bid) || 0;
      target.ask += Number(row.ask) || 0;
      target.unknown += Number(row.unknown) || 0;
    }
    session.h = Math.max(session.h, Number(bar.h));
    session.l = Math.min(session.l, Number(bar.l));
    session.c = Number(bar.c);
    session.last = time;
  }
  const ordered = [...sessions.values()].sort((a, b) => a.first - b.first);
  const profiles = ordered.map(session => {
    const foot = footprintOf([...session.levels.values()], { ...options, priceStep, h: session.h, l: session.l, c: session.c });
    return {
      start: new Date(session.first).toISOString(),
      end: new Date(session.last).toISOString(),
      high: session.h, low: session.l,
      poc: foot.poc,
      valueArea: foot.valueArea,
      volume: foot.total,
      levels: foot.levels
    };
  });
  const naked = [];
  for (let i = 0; i < profiles.length - 1; i++) {
    const profile = profiles[i];
    if (!positive(profile.poc)) continue;
    const revisited = profiles.slice(i + 1).some(later =>
      later.levels.some(row => Math.abs(row.price - profile.poc) < priceStep / 2 && row.total > 0));
    if (!revisited) naked.push({ price: profile.poc, session: profile.start, volume: profile.volume });
  }
  return { sessions: profiles, current: profiles.at(-1) || null, naked: naked.slice(-5) };
}

// Cumulative delta against price: when the total imbalance keeps falling while price keeps
// rising (or the mirror), buyers and sellers disagree with the move.
export function cumulativeDivergence(bars, { lookback = 20, minDeltaShare = 0.05 } = {}) {
  const window = (Array.isArray(bars) ? bars : []).slice(-Math.max(2, lookback));
  if (window.length < 4) return { side: null, priceChange: 0, deltaChange: 0, window: window.length };
  const first = window[0], last = window.at(-1);
  const priceChange = Number(last.c) - Number(first.o);
  // Cumulative delta entering the window is the first bar's cumulative delta minus its own delta.
  const startCum = Number(first.cumulativeDelta ?? 0) - Number(first.delta ?? 0);
  const deltaChange = Number(last.cumulativeDelta ?? 0) - startCum;
  const volume = window.reduce((sum, bar) => sum + (Number(bar.volume) || 0), 0);
  if (Math.abs(deltaChange) < minDeltaShare * Math.max(1, volume)) return { side: null, priceChange, deltaChange, window: window.length };
  if (priceChange > 0 && deltaChange < 0) return { side: 'bearish', priceChange, deltaChange, window: window.length };
  if (priceChange < 0 && deltaChange > 0) return { side: 'bullish', priceChange, deltaChange, window: window.length };
  return { side: null, priceChange, deltaChange, window: window.length };
}

// What one footprint cell shows in each display mode. Every value comes from the same price row; a
// mode never invents a number the row does not hold. Without a known aggressor (only unclassified
// ticks) the side-based modes show nothing rather than a fake split.
export const FOOTPRINT_MODES = Object.freeze(['bidask', 'delta', 'deltaPct', 'volume', 'buy', 'sell']);
export function footprintCell(row, mode) {
  if (!FOOTPRINT_MODES.includes(mode)) throw new TypeError('Unknown footprint mode: ' + mode);
  const bid = Number(row?.bid) || 0, ask = Number(row?.ask) || 0, unknown = Number(row?.unknown) || 0;
  const total = bid + ask + unknown, sided = bid + ask, delta = ask - bid;
  const tone = delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'neutral';
  if (total <= 0) return { text: '', tone: 'neutral', value: null };
  switch (mode) {
    case 'bidask': return { text: sided ? `${bid} ${ask}` : '·', tone, value: null };
    case 'delta': return { text: sided ? (delta > 0 ? '+' : '') + delta : '', tone, value: sided ? delta : null };
    case 'deltaPct': {
      if (!sided) return { text: '', tone: 'neutral', value: null };
      const pct = Math.round(100 * delta / sided);
      return { text: (pct > 0 ? '+' : '') + pct + '%', tone, value: pct };
    }
    case 'volume': return { text: String(total), tone: 'neutral', value: total };
    case 'buy': return { text: ask ? String(ask) : '', tone: ask ? 'positive' : 'neutral', value: ask };
    case 'sell': return { text: bid ? String(bid) : '', tone: bid ? 'negative' : 'neutral', value: bid };
  }
}
