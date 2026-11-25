import { measureZoneReactions } from './zone-reaction.js';
import { collectSourceLevels } from './zone-sources.js';
import { applyTickToBar, footprintOf, sessionProfile, cumulativeDivergence, tickVolume, emptyBar, validateFootprintOptions, createTickClassifier } from './footprint-engine.js';
const finite = n => Number.isFinite(n);
const floorTime = (ms, interval) => Math.floor(ms / interval) * interval;
// One place for the strength formula: shape (touches, pivot reaction), measured reaction, confluence, recency, volume, freshness, distance.
const scoreZone = factors => 0.18 * factors.touches + 0.18 * factors.reaction + 0.20 * factors.measured + 0.12 * factors.confluence + 0.12 * factors.recency + 0.07 * factors.volume + 0.05 * factors.freshness + 0.08 * factors.proximity;

export function normalizeTick(input) {
  const time = Date.parse(input.timestamp);
  if (!Number.isFinite(time)) throw new TypeError('Invalid tick timestamp');
  const source = input.source || 'mt5';
  if (input.type === 'trade' || source === 'comex') {
    const direction = ['buy','sell','unknown'].includes(input.aggressorSide) ? input.aggressorSide : 'unknown';
    if (!finite(input.price) || input.price <= 0 || !finite(input.size) || input.size <= 0) throw new TypeError('Invalid exchange trade price or size');
    return { timestamp:new Date(time).toISOString(), time, bid:null, ask:null, last:input.price, volume:input.size, direction, source, symbol:String(input.symbol||'GC').toUpperCase(), type:'trade' };
  }
  if (!finite(input.bid) || !finite(input.ask) || input.bid <= 0 || input.ask < input.bid) throw new TypeError('Invalid tick quote');
  const last = finite(input.last) && input.last > 0 ? input.last : (input.bid + input.ask) / 2;
  // Only what the tick itself proves: a vendor aggressor, MT5 BUY/SELL flags, or a Last print through
  // the quote. A print at the Bid of a Bid chart proves nothing; the tick rule in addTicks decides it.
  const flags = Number.isInteger(input.flags) ? input.flags : 0;
  const direction = ['buy','sell'].includes(input.aggressorSide) ? input.aggressorSide
    : (flags & 32) ? 'buy' : (flags & 64) ? 'sell'
    : input.ask > input.bid && last >= input.ask ? 'buy'
    : input.ask > input.bid && last < input.bid ? 'sell'
    : 'unknown';
  return { timestamp:new Date(time).toISOString(), time, bid:input.bid, ask:input.ask, last, volume:tickVolume({ ...input, direction }), direction, source, symbol:String(input.symbol||'XAUUSD').toUpperCase(), type:'quote' };
}

// priceStep is the analysis grid for zones and bar heuristics (exhaustion range, zone padding).
// footprintStep is the footprint's source precision (the broker tick size when known); it only
// decides how traded prices fall into footprint rows, so a fine broker grid does not change zones.
export function buildMarketAnalysis(events, options = {}) {
  const { bars, ticks } = aggregateTicks(events, options);
  return finishAnalysis(bars, {
    ...options,
    tickCount: ticks.length,
    hasComex: ticks.some(event => event.source === 'comex'),
    comexOnly: ticks.length > 0 && ticks.every(event => event.source === 'comex')
  });
}

// Ticks into bars, and nothing else. Kept separate so a caller holding a long tick buffer can
// aggregate once and only re-run the cheap derived part per request.
export function aggregateTicks(events, { intervalMs = 15 * 60_000, footprintStep = 0.1, limit = 10000 } = {}) {
  if (!Array.isArray(events) || !finite(intervalMs) || intervalMs <= 0 || !finite(footprintStep) || footprintStep <= 0) throw new TypeError('Invalid analysis input');
  const stamped = events.map(event => ({ at: Date.parse(event.timestamp), event })).filter(item => finite(item.at));
  let lastMs = -Infinity;
  for (const item of stamped) if (item.at > lastMs) lastMs = item.at;
  // Only the last `limit` bars are kept, so older ticks cannot change the answer. Two bars of margin
  // keep the oldest kept bar complete instead of partial.
  const fromMs = finite(lastMs) ? lastMs - (Math.max(1, limit) + 2) * intervalMs : -Infinity;
  const ticks = stamped.filter(item => item.at >= fromMs).sort((a, b) => a.at - b.at).map(item => item.event);
  const bars = new Map();
  addTicks(bars, ticks, intervalMs, footprintStep);
  return { bars, ticks };
}

// Applies time-ordered ticks. The tick-rule state travels with the bar map, so a buffer that only grew
// is extended with its new tail and classifies exactly as a full rebuild would.
export function addTicks(bars, events, intervalMs, footprintStep, classifier = bars._classifier || (bars._classifier = createTickClassifier())) {
  for (const event of events) {
    const t = normalizeTick(event);
    if (t.type === 'quote') {
      const side = classifier.classify({ ...event, last: t.last });
      if (side !== t.direction) { t.direction = side; t.volume = tickVolume({ ...event, direction: side, aggressorSide: undefined }); }
    }
    const start = floorTime(t.time, intervalMs);
    let bar = bars.get(start);
    if (!bar) { bar = { ...emptyBar(start, t.last), time: new Date(start).toISOString() }; bars.set(start, bar); }
    applyTickToBar(bar, t, footprintStep);
  }
  return bars;
}

// Everything derived from the bars: footprint columns, sweeps, zones, profile. Reading only. A closed
// bar's footprint is cached on the bar and reused until it receives another tick or the options change.
export function finishAnalysis(bars, { intervalMs = 15 * 60_000, priceStep = 0.1, footprintStep = priceStep, limit = 10000, maxZones, zoneOptions = {}, footprintOptions = {}, tickCount = 0, hasComex = false, comexOnly = false } = {}) {
  if (!(bars instanceof Map) || !finite(priceStep) || priceStep <= 0) throw new TypeError('Invalid analysis input');
  const keys = [...bars.keys()].sort((a, b) => a - b).slice(-Math.max(1, limit));
  const rawBars = keys.map(key => bars.get(key));
  const foot = validateFootprintOptions(footprintOptions);
  const footKey = JSON.stringify([foot, footprintStep]);
  let cumulativeDelta = 0;
  const result = rawBars.map((bar, barIndex, allBars) => {
    const total=bar.bid+bar.ask+bar.unknown;
    const delta=bar.ask-bar.bid;
    cumulativeDelta += delta;
    const cacheKey = footKey + '|' + bar.tickCount;
    if (bar._footKey !== cacheKey) { bar._foot = footprintOf(bar.levels, { ...foot, priceStep: footprintStep, h: bar.h, l: bar.l, c: bar.c }); bar._footKey = cacheKey; }
    const fp = bar._foot;
    const prior=allBars.slice(Math.max(0,barIndex-20),barIndex);
    const priorHigh=prior.length?Math.max(...prior.map(x=>x.h)):null,priorLow=prior.length?Math.min(...prior.map(x=>x.l)):null;
    const sweeps=[];
    if(priorHigh!==null&&bar.h>priorHigh&&bar.c<priorHigh)sweeps.push({side:'buy-side',level:priorHigh,reclaimed:true});
    if(priorLow!==null&&bar.l<priorLow&&bar.c>priorLow)sweeps.push({side:'sell-side',level:priorLow,reclaimed:true});
    const range=Math.max(0,bar.h-bar.l),body=Math.abs(bar.c-bar.o),directionalKnown=bar.unknown===0&&total>0;
    const absorption=directionalKnown&&total>=3&&range>0&&body/range<=0.25&&Math.abs(delta)/total<=0.2;
    const exhaustion=directionalKnown&&total>=3&&Math.abs(delta)/total>=0.7&&range<=priceStep*5;
    return {time:bar.time,timeMs:bar.timeMs,o:bar.o,h:bar.h,l:bar.l,c:bar.c,tickCount:bar.tickCount,volume:total,bid:bar.bid,ask:bar.ask,unknown:bar.unknown,delta,cumulativeDelta,levels:fp.levels,imbalances:fp.imbalances,stackedImbalances:fp.stackedImbalances,
      poc:fp.poc,valueArea:fp.valueArea,deltaRatio:fp.deltaRatio,absorbedLevels:fp.absorbedLevels,
      unfinishedHigh:fp.unfinishedHigh,unfinishedLow:fp.unfinishedLow,maxLevelVolume:fp.maxLevelVolume,
      sweeps,absorption,exhaustion};
  });
  const zones = detectLiquidityZones(result, priceStep, { ...zoneOptions, ...(maxZones === undefined ? {} : { maxZones }) });
  return { bars:result, zones, intervalMs, timeframeMinutes:intervalMs/60000, footprintStep, ticksPerRow: foot.ticksPerRow, rowStep: Number((footprintStep * foot.ticksPerRow).toFixed(8)), tickRule: bars._classifier ? bars._classifier.state() : null, profile:sessionProfile(result, { priceStep: footprintStep, options: foot }), divergence:cumulativeDivergence(result), tickCount, volumeKind:hasComex?'exchange_trade_size':'tick_activity_for_unknown_side; broker_reported_volume_only_with_explicit_aggressor', sideClassification:comexOnly?'licensed_vendor_aggressor_side; unknown_when_unavailable':'explicit_mt5_tick_flags; otherwise_price_against_quote', generatedAt:new Date().toISOString() };
}

export const DEFAULT_ZONE_OPTIONS = Object.freeze({
  minZones: 3,          // try to always offer at least this many reaction levels
  maxZones: 7,          // never draw more than this
  pivotWidth: 2,        // bars on each side that must be lower/higher for a swing (1..6)
  atrPeriod: 14,        // volatility unit for every distance below
  clusterAtr: 0.35,     // swings closer than this many ATR form one zone
  zoneWidthAtr: 0.15,   // minimum zone thickness in ATR
  maxDistanceAtr: 15,   // ignore levels farther than this from the current price
  reactionBars: 6,      // bars after a swing used to measure how hard price reacted
  usePriorDay: true,    // include the previous completed day's extremes
  useSessions: true,    // include Asia / London / New York session extremes
  useWeek: true,        // include the weekly open and the previous week's extremes
  useHigherTf: true,    // include H1/H4 swings aggregated from the same candles
  useVolume: true       // include the volume profile (POC, value-area edges)
});

export function validateZoneOptions(input = {}) {
  const o = { ...DEFAULT_ZONE_OPTIONS };
  for (const [key, value] of Object.entries(input || {})) {
    if (!(key in o) || value === undefined || value === null) continue;
    o[key] = typeof value === 'boolean' ? value : Number(value);
  }
  const int = (k, lo, hi) => { if (!Number.isInteger(o[k]) || o[k] < lo || o[k] > hi) throw new TypeError(`${k} must be an integer ${lo}..${hi}`); };
  const num = (k, lo, hi) => { if (!finite(o[k]) || o[k] < lo || o[k] > hi) throw new TypeError(`${k} must be between ${lo} and ${hi}`); };
  int('minZones', 1, 20); int('maxZones', 1, 20); int('pivotWidth', 1, 6); int('atrPeriod', 2, 200); int('reactionBars', 1, 50);
  num('clusterAtr', 0.05, 3); num('zoneWidthAtr', 0.02, 2); num('maxDistanceAtr', 1, 100);
  for (const flag of ['usePriorDay', 'useSessions', 'useWeek', 'useHigherTf', 'useVolume']) {
    if (typeof o[flag] !== 'boolean') throw new TypeError(`${flag} must be a boolean`);
  }
  if (o.minZones > o.maxZones) o.minZones = o.maxZones;
  return o;
}

function averageTrueRange(bars, period) {
  const ranges = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], prev = bars[i - 1];
    ranges.push(prev ? Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c)) : b.h - b.l);
  }
  const recent = ranges.slice(-period).filter(r => r > 0);
  return recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
}

const median = values => { const v = values.filter(finite).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; };

// Reaction zones: price areas where the market has turned before and is likely to react again.
// Every distance is measured in ATR so the same settings work on any timeframe and volatility.
// `strength` is a 0..1 ranking score built from transparent factors; it is not a calibrated probability.
export function detectLiquidityZones(bars, priceStep = 0.1, options = {}) {
  if (!Array.isArray(bars) || !finite(priceStep) || priceStep <= 0) throw new TypeError('Invalid liquidity input');
  const legacyCap = typeof options === 'number';
  let o;
  if (legacyCap) o = { ...DEFAULT_ZONE_OPTIONS, maxZones: Number.isInteger(options) && options >= 1 && options <= 20 ? options : DEFAULT_ZONE_OPTIONS.maxZones };
  else {
    const raw = { ...(options || {}) };
    if (raw.maxZones !== undefined && !(Number.isInteger(raw.maxZones) && raw.maxZones >= 1 && raw.maxZones <= 20)) delete raw.maxZones;
    o = validateZoneOptions(raw);
  }
  if (legacyCap && o.minZones > o.maxZones) o.minZones = o.maxZones;
  if (bars.length < 6) return [];
  // The newest bar may still be forming: swings are confirmed only by closed bars.
  const closed = bars.slice(0, -1);
  const last = bars.at(-1).c;
  const atr = averageTrueRange(closed, o.atrPeriod);
  if (!(atr > 0) || !finite(last)) return [];
  const w = o.pivotWidth;
  const vol = b => finite(b.volume) && b.volume > 0 ? b.volume : finite(b.tickCount) && b.tickCount > 0 ? b.tickCount : 0;
  const medVol = median(closed.map(vol));

  const pivots = [];
  for (let i = w; i < closed.length - w; i++) {
    const b = closed[i];
    if (!(b.h > b.l)) continue; // zero-range bars are not swing evidence
    const prev = closed.slice(i - w, i), next = closed.slice(i + 1, i + 1 + w);
    const around = [...prev, ...next];
    const after = closed.slice(i + 1, i + 1 + o.reactionBars);
    const relVol = medVol > 0 ? vol(b) / medVol : 1;
    if (around.every(x => b.h >= x.h) && around.some(x => b.h > x.h))
      pivots.push({ type: 'high', price: b.h, index: i, reaction: (b.h - Math.min(...after.map(x => x.l))) / atr, relVol });
    if (around.every(x => b.l <= x.l) && around.some(x => b.l < x.l))
      pivots.push({ type: 'low', price: b.l, index: i, reaction: (Math.max(...after.map(x => x.h)) - b.l) / atr, relVol });
  }

  // Cluster swings by price (highs and lows together: a broken high that later holds as support is one level).
  const tolerance = o.clusterAtr * atr;
  const clusters = [];
  for (const p of pivots.sort((a, b) => a.price - b.price)) {
    const c = clusters.at(-1);
    if (c && p.price - c.min <= tolerance) { c.items.push(p); c.max = p.price; } // bounded span: no chaining
    else clusters.push({ items: [p], min: p.price, max: p.price });
  }

  const pad = Math.max(priceStep, (o.zoneWidthAtr * atr) / 2);
  const halfLife = Math.max(20, closed.length / 3);
  const candidates = [];
  for (const c of clusters) {
    const items = c.items.sort((a, b) => a.index - b.index);
    const latest = items.at(-1);
    const low = c.min - pad, high = c.max + pad;
    // Walk the closes after the last swing. One clean cross turns support into resistance (or back):
    // that is a FLIPPED level and is kept. Two or more crosses mean price chops through it: dropped.
    let pos = latest.type === 'high' ? -1 : 1, crossings = 0, state = 'UNTESTED';
    for (let i = latest.index + 1; i < closed.length; i++) {
      const b = closed[i];
      const now = b.c > high ? 1 : b.c < low ? -1 : 0;
      if (now !== 0 && now !== pos) { crossings++; pos = now; continue; }
      if (i > latest.index + w && b.h >= low && b.l <= high) state = (pos < 0 ? b.h > high : b.l < low) ? 'SWEPT' : 'TESTED';
    }
    const broken = crossings >= 2;
    if (crossings === 1) state = 'FLIPPED';
    const type = last >= (c.min + c.max) / 2 ? 'low' : 'high'; // side relative to current price
    if (broken) continue; // consumed liquidity no longer offers a reaction level
    const mid = (c.min + c.max) / 2;
    const distanceAtr = Math.abs(mid - last) / atr;
    if (distanceAtr > o.maxDistanceAtr) continue;
    const touches = items.length;
    const avgReaction = items.reduce((a, p) => a + (finite(p.reaction) ? p.reaction : 0), 0) / touches;
    const avgVol = items.reduce((a, p) => a + p.relVol, 0) / touches;
    const factors = {
      touches: 1 - Math.exp(-touches / 1.5),
      reaction: Math.min(1, avgReaction / 2),
      recency: Math.exp(-((closed.length - 1 - latest.index) / halfLife) * Math.LN2),
      volume: medVol > 0 ? Math.min(1, avgVol / 2) : 0.5,
      freshness: state === 'UNTESTED' ? 1 : state === 'TESTED' ? 0.8 : state === 'FLIPPED' ? 0.75 : 0.65,
      proximity: 1 / (1 + distanceAtr / 6)
    };
    const score = 0;
    const highs = items.filter(p => p.type === 'high').length, lows = touches - highs;
    candidates.push({ low, high, mid, type, state, touches, score, factors, distanceAtr, formedIndex: latest.index,
      label: highs && lows ? 'Role-flip level (highs + lows)' : highs ? (touches > 1 ? 'Repeated swing highs' : 'Swing high') : (touches > 1 ? 'Repeated swing lows' : 'Swing low') });
  }

  // Confluence: levels several independent sources agree on outrank a bare swing shape.
  const sources = collectSourceLevels(closed, { priceStep, use: { priorDay: o.usePriorDay, sessions: o.useSessions, week: o.useWeek, higherTf: o.useHigherTf, volume: o.useVolume } });
  for (const z of candidates) {
    const agreed = sources.filter(s => Math.abs(s.price - z.mid) <= Math.max(pad, tolerance * 1.5));
    z.sources = [...new Set(agreed.map(s => s.label))].slice(0, 3);
    z.factors.confluence = Math.min(1, agreed.length / 2);
  }
  for (const s of sources) {
    if (candidates.some(z => Math.abs(z.mid - s.price) < Math.max(tolerance, pad * 2))) continue;
    const distanceAtr = Math.abs(s.price - last) / atr;
    if (distanceAtr > o.maxDistanceAtr) continue;
    const index = Number.isInteger(s.index) ? s.index : closed.length - 1;
    const factors = { touches: 0.25, reaction: s.weight, measured: 0.5, confluence: 0, recency: Math.exp(-((closed.length - 1 - index) / halfLife) * Math.LN2), volume: s.source === 'volume' ? 1 : 0.5, freshness: 1, proximity: 1 / (1 + distanceAtr / 6) };
    candidates.push({ low: s.price - pad, high: s.price + pad, mid: s.price, type: s.price > last ? 'high' : 'low', state: 'UNTESTED', touches: 0, score: 0, factors, distanceAtr, formedIndex: index, reference: true, label: s.label, source: s.source, sources: [s.label] });
  }

  // Measure what price actually did at each level, then score: a zone's strength must be backed by evidence.
  for (const z of candidates) {
    z.reactions = measureZoneReactions(closed, z, { atr });
    z.factors.measured = z.reactions.rate;
    z.score = scoreZone(z.factors) * (z.reference ? 0.8 : 1);
  }

  // Keep the strongest of levels that sit on top of each other; a crowded chart hides the useful ones.
  const minGap = Math.max(2 * tolerance, 0.5 * atr) + 2 * pad;
  candidates.sort((a, b) => b.score - a.score || a.distanceAtr - b.distanceAtr);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const z = candidates[i];
    if (candidates.slice(0, i).some(k => Math.abs(k.mid - z.mid) < minGap)) candidates.splice(i, 1);
  }

  // Too few swing levels (trend or short history): fill with weaker, well-known reference levels.
  const sideEmpty = above => !candidates.some(z => (z.mid > last) === above);
  if (candidates.length < o.minZones || sideEmpty(true) || sideEmpty(false)) {
    const covered = price => candidates.some(z => price >= z.low - tolerance && price <= z.high + tolerance);
    const extra = [];
    for (const span of [10, 50, closed.length]) {
      const from = Math.max(0, closed.length - span);
      let hi = -Infinity, lo = Infinity, hiI = -1, loI = -1;
      for (let i = from; i < closed.length; i++) { if (closed[i].h > hi) { hi = closed[i].h; hiI = i; } if (closed[i].l < lo) { lo = closed[i].l; loI = i; } }
      if (hi > last + pad) extra.push({ price: hi, type: 'high', label: `${span === closed.length ? 'Range' : span + '-bar'} high`, index: hiI, weight: 0.5 });
      if (lo < last - pad) extra.push({ price: lo, type: 'low', label: `${span === closed.length ? 'Range' : span + '-bar'} low`, index: loI, weight: 0.5 });
    }
    const buckets = new Map();
    for (const b of closed) {
      const parts = Array.isArray(b.levels) && b.levels.length ? b.levels.map(l => [l.price, (l.bid || 0) + (l.ask || 0) + (l.unknown || 0)]) : [[(b.h + b.l + b.c) / 3, vol(b) || 1]];
      for (const [price, v] of parts) { const k = Math.round(price / tolerance); buckets.set(k, (buckets.get(k) || 0) + v); }
    }
    const node = [...buckets.entries()].sort((a, b) => b[1] - a[1])[0];
    if (node) { const price = node[0] * tolerance; if (Math.abs(price - last) > pad * 2) extra.push({ price, type: price > last ? 'high' : 'low', label: 'Volume node', index: closed.length - 1, weight: 0.6 }); }
    // Round numbers: a step of 1/2/5 x 10^k close to 4 ATR ($10 on 15m gold).
    const raw = 4 * atr, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 5, 10].map(m => m * mag).find(v => v >= raw) || 10 * mag;
    for (let k = 1; k <= 3; k++) {
      extra.push({ price: (Math.ceil(last / step) + k - 1) * step, type: 'high', label: 'Round number', index: closed.length - 1, weight: 0.35 });
      extra.push({ price: (Math.floor(last / step) - k + 1) * step, type: 'low', label: 'Round number', index: closed.length - 1, weight: 0.35 });
    }
    // Fill alternating above/below price so both directions get reference levels.
    const above = extra.filter(e => e.price > last), below = extra.filter(e => e.price < last);
    const order = [];
    for (let i = 0; i < Math.max(above.length, below.length); i++) { if (above[i]) order.push(above[i]); if (below[i]) order.push(below[i]); }
    for (const e of order) {
      // Fill up to the minimum, and always give an empty side of price one reference level.
      if (candidates.length >= o.minZones && !sideEmpty(e.price > last)) continue;
      if (Math.abs(e.price - last) <= pad || covered(e.price) || candidates.some(k => Math.abs(k.mid - e.price) < minGap)) continue;
      const distanceAtr = Math.abs(e.price - last) / atr;
      if (distanceAtr > o.maxDistanceAtr) continue;
      const factors = { touches: 0.3, reaction: e.weight, confluence: 0, recency: Math.exp(-((closed.length - 1 - e.index) / halfLife) * Math.LN2), volume: e.label === 'Volume node' ? 1 : 0.5, freshness: 1, proximity: 1 / (1 + distanceAtr / 6) };
      const z = { low: e.price - pad, high: e.price + pad, mid: e.price, type: e.type, state: 'UNTESTED', touches: 0, score: 0, factors, distanceAtr, formedIndex: e.index, reference: true, label: e.label, sources: [] };
      z.reactions = measureZoneReactions(closed, z, { atr });
      z.factors.measured = z.reactions.rate;
      z.score = scoreZone(z.factors) * 0.8;
      candidates.push(z);
    }
  }

  // Rank, then keep at least one level on each side of price when there is room.
  const ranked = candidates.sort((a, b) => b.score - a.score || a.distanceAtr - b.distanceAtr);
  const picked = ranked.slice(0, o.maxZones);
  if (o.maxZones >= 3) {
    for (const above of [true, false]) {
      if (picked.some(z => (z.mid > last) === above)) continue;
      const best = ranked.find(z => (z.mid > last) === above && !picked.includes(z));
      if (!best) continue;
      const counts = side => picked.filter(z => (z.mid > last) === side).length;
      let drop = -1;
      for (let i = picked.length - 1; i >= 0; i--) if ((picked[i].mid > last) !== above && counts(!above) > 1) { drop = i; break; }
      if (picked.length < o.maxZones) picked.push(best); else if (drop >= 0) picked[drop] = best;
    }
    picked.sort((a, b) => b.score - a.score || a.distanceAtr - b.distanceAtr);
  }

  const seen = new Set();
  return picked.map(z => {
    const side = z.type === 'high' ? 'buy' : 'sell';
    let id = `LQ-${side}-${z.mid.toFixed(2)}`;
    for (let n = 2; seen.has(id); n++) id = `LQ-${side}-${(z.mid + n * 0.001).toFixed(2)}`;
    seen.add(id);
    const distance = z.mid - last;
    const state = last >= z.low && last <= z.high ? 'AT PRICE' : z.state === 'UNTESTED' && Math.abs(distance) <= pad * 3 ? 'NEAR PRICE' : z.state;
    return {
      id, side, low: Number(z.low.toFixed(5)), high: Number(z.high.toFixed(5)),
      strength: Number(Math.min(0.98, Math.max(0.05, z.score)).toFixed(2)),
      label: z.state === 'FLIPPED' && !z.label.startsWith('Role-flip') ? `${z.label} · role flip` : z.label, distance: (distance > 0 ? '+' : '') + distance.toFixed(2), distanceAtr: Number(z.distanceAtr.toFixed(2)),
      state, formedAt: closed[z.formedIndex]?.time ?? null, touches: z.touches, reactions: z.reactions, sources: z.sources || [],
      factors: Object.fromEntries(Object.entries(z.factors).map(([k, v]) => [k, Number(v.toFixed(2))]))
    };
  });
}
