import { addTicks, finishAnalysis } from './market-engine.js';
import { createTickClassifier, emptyBar } from './footprint-engine.js';
import { bucketStart } from './rate-store.js';

// The live window: one time-ordered tick buffer per feed (source + symbol + MT5 account), trimmed from
// the oldest end in chunks, and an incremental bar cache per feed and timeframe.
//
// The cache tracks what it consumed by a monotonic append counter, never by the buffer length: the
// length stops growing once the window is full, and a cache keyed on it ignored every new tick from
// then on (the chart froze on the archive while MT5 kept quoting). History that arrives after live
// ticks (backfill runs beside the live feed) is merged into place, and only the candles it touches are
// rebuilt, so bars stay in time order without re-aggregating the whole window.

const EDIT_LOG = 64;

const lowerBound = (times, value) => {
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < value) lo = mid + 1; else hi = mid; }
  return lo;
};

export function createTickStore({ cap = 1_000_000 } = {}) {
  const feeds = new Map();
  const capacity = Number.isInteger(cap) && cap > 0 ? cap : 1_000_000;
  // Trim in chunks on a big window (one splice per ~20k ticks, not one per tick); exact on a small one.
  const slack = capacity >= 10_000 ? Math.floor(capacity * 0.02) : 0;
  let total = 0;
  const feedKey = (source, symbol, feedId) => `${source}:${symbol}:${feedId || 'legacy'}`;

  function feedFor(source, symbol, feedId, create = false) {
    const key = feedKey(source, symbol, feedId);
    let feed = feeds.get(key);
    if (!feed && create) {
      feed = { key, source, symbol, feedId: feedId || null, ticks: [], times: [], appended: 0, epoch: 0, edits: [], caches: new Map() };
      feeds.set(key, feed);
    }
    return feed;
  }

  function trim() {
    if (total <= capacity + slack) return;
    while (total > capacity) {
      let oldest = null;
      for (const feed of feeds.values()) if (feed.times.length && (!oldest || feed.times[0] < oldest.times[0])) oldest = feed;
      if (!oldest) break;
      const next = [...feeds.values()].filter(feed => feed !== oldest && feed.times.length).reduce((min, feed) => Math.min(min, feed.times[0]), Infinity);
      const older = Number.isFinite(next) ? Math.max(1, lowerBound(oldest.times, next)) : oldest.times.length;
      const count = Math.min(total - capacity, older);
      oldest.ticks.splice(0, count);
      oldest.times.splice(0, count);
      total -= count;
      if (!oldest.ticks.length && !oldest.caches.size) feeds.delete(oldest.key);
    }
  }

  // Adds events of any feeds, in any order. Returns per-feed summaries { feed, appended, merged, from, to }.
  function add(events) {
    const groups = new Map();
    for (const event of events) {
      const at = Date.parse(event.timestamp);
      if (!Number.isFinite(at)) continue;
      const feed = feedFor(event.source, event.symbol, event.feedId, true);
      if (!groups.has(feed)) groups.set(feed, []);
      groups.get(feed).push({ at, event });
    }
    const summaries = [];
    for (const [feed, items] of groups) {
      items.sort((a, b) => a.at - b.at);
      const lastMs = feed.times.length ? feed.times.at(-1) : -Infinity;
      const split = lowerBound(items.map(item => item.at), lastMs);
      const older = items.slice(0, split), newer = items.slice(split);
      for (const item of newer) { feed.ticks.push(item.event); feed.times.push(item.at); }
      feed.appended += newer.length;
      let from = null, to = null;
      if (older.length) {
        // Merge two sorted runs once per batch, not one splice per tick.
        const ticks = [], times = [];
        let i = 0, j = 0;
        while (i < feed.times.length || j < older.length) {
          if (j >= older.length || (i < feed.times.length && feed.times[i] <= older[j].at)) { ticks.push(feed.ticks[i]); times.push(feed.times[i]); i += 1; }
          else { ticks.push(older[j].event); times.push(older[j].at); j += 1; }
        }
        feed.ticks = ticks; feed.times = times;
        from = older[0].at; to = older.at(-1).at;
        feed.epoch += 1;
        feed.edits.push({ epoch: feed.epoch, from, to });
        if (feed.edits.length > EDIT_LOG) feed.edits.shift();
      }
      total += items.length;
      summaries.push({ feed, appended: newer.length, merged: older.length, from, to });
    }
    trim();
    return summaries;
  }

  // The window's bars for one feed and timeframe, brought up to date with every tick stored since the
  // last call, then the derived analysis (footprint, zones, profile) over the newest `limit` bars.
  function analysis(source, symbol, feedId, options) {
    const feed = feedFor(source, symbol, feedId, true);
    const { intervalMs, footprintStep, limit, fresh = false, alignMs = 0, rates = null } = options;
    const cacheKey = [intervalMs, footprintStep, limit, alignMs].join('|');
    let cache = feed.caches.get(cacheKey);
    const keep = Math.max(1, limit) + 2;
    const rebuild = () => {
      const bars = new Map();
      const lastMs = feed.times.length ? feed.times.at(-1) : 0;
      const fromMs = bucketStart(lastMs, intervalMs, alignMs) - (keep - 1) * intervalMs;
      const start = lowerBound(feed.times, fromMs);
      addTicks(bars, feed.ticks.slice(start), intervalMs, footprintStep, undefined, alignMs);
      return { bars, epoch: feed.epoch, appended: feed.appended };
    };
    const firstEdit = feed.edits.length ? feed.edits[0].epoch : feed.epoch + 1;
    if (!cache || fresh || cache.appended > feed.appended || (cache.epoch < feed.epoch && cache.epoch + 1 < firstEdit)) {
      cache = rebuild();
      if (feed.caches.size > 6) feed.caches.delete(feed.caches.keys().next().value);
      feed.caches.set(cacheKey, cache);
    } else {
      const pending = feed.appended - cache.appended;
      if (pending > feed.ticks.length) cache = Object.assign(cache, rebuild());
      else {
        if (pending > 0) addTicks(cache.bars, feed.ticks.slice(feed.ticks.length - pending), intervalMs, footprintStep, undefined, alignMs);
        for (const edit of feed.edits) if (edit.epoch > cache.epoch) rebuildRange(feed, cache.bars, edit.from, edit.to, intervalMs, footprintStep, keep, alignMs);
        cache.appended = feed.appended;
        cache.epoch = feed.epoch;
      }
    }
    if (cache.bars.size > keep * 2) {
      const old = [...cache.bars.keys()].sort((a, b) => a - b).slice(0, cache.bars.size - keep);
      for (const key of old) cache.bars.delete(key);
    }
    const ticks = feed.ticks;
    return finishAnalysis(rates ? mergeRates(cache, rates, intervalMs, keep) : cache.bars, {
      ...options,
      tickCount: ticks.length,
      hasComex: source === 'comex',
      comexOnly: source === 'comex' && ticks.length > 0
    });
  }

  // Rebuild only the candles an out-of-order batch touched, from the merged buffer.
  function rebuildRange(feed, bars, from, to, intervalMs, footprintStep, keep, alignMs = 0) {
    const newestMs = feed.times.length ? feed.times.at(-1) : 0;
    const windowStart = bucketStart(newestMs, intervalMs, alignMs) - (keep - 1) * intervalMs;
    const first = Math.max(windowStart, bucketStart(from, intervalMs, alignMs));
    const last = bucketStart(to, intervalMs, alignMs);
    if (last < first) return;
    for (let key = first; key <= last; key += intervalMs) bars.delete(key);
    const start = lowerBound(feed.times, first), end = lowerBound(feed.times, last + intervalMs);
    const before = start > 0 ? feed.ticks[start - 1] : null;
    const seed = createTickClassifier({ prevPrice: before ? Number(before.last) : null });
    addTicks(bars, feed.ticks.slice(start, end), intervalMs, footprintStep, seed, alignMs);
  }

  // The window drawn: the broker's candles (exact OHLC as MT5 draws them) with the tick footprint on
  // top wherever ticks exist. A candle without ticks is still drawn, from MT5's own bar, and says so
  // through coverage 0. Tick bars are updated in place so their footprint cache survives.
  function mergeRates(cache, rates, intervalMs, keep) {
    const tickKeys = [...cache.bars.keys()];
    const rateKeys = rates.keys.slice(-keep);
    const union = [...new Set([...rateKeys, ...tickKeys])].sort((a, b) => a - b).slice(-keep);
    if (!cache.rateOnly) cache.rateOnly = new Map();
    const merged = new Map();
    const latest = rates.latestMinute;
    for (const key of union) {
      const tb = cache.bars.get(key), rb = rates.bars.get(key);
      if (tb && rb) {
        const closed = rb.last + 60_000 >= key + intervalMs || latest >= key + intervalMs;
        if (closed) { tb.o = rb.o; tb.h = rb.h; tb.l = rb.l; tb.c = rb.c; }
        else {
          tb.o = rb.o;
          tb.h = Math.max(tb.h, rb.h);
          tb.l = Math.min(tb.l, rb.l);
          if (!(tb.lastMs >= rb.last)) tb.c = rb.c;
        }
        tb.rateVolume = rb.v;
        tb.coverage = rb.v > 0 ? Math.min(1, Number((tb.tickCount / rb.v).toFixed(3))) : null;
        merged.set(key, tb);
      } else if (tb) {
        merged.set(key, tb);
      } else {
        let bar = cache.rateOnly.get(key);
        if (!bar) { bar = { ...emptyBar(key, rb.o), time: new Date(key).toISOString() }; cache.rateOnly.set(key, bar); }
        bar.o = rb.o; bar.h = rb.h; bar.l = rb.l; bar.c = rb.c;
        bar.unknown = rb.v; bar.volume = rb.v; bar.rateVolume = rb.v; bar.coverage = 0;
        merged.set(key, bar);
      }
    }
    if (cache.rateOnly.size > keep * 2) for (const key of [...cache.rateOnly.keys()]) if (!merged.has(key)) cache.rateOnly.delete(key);
    // The tick-rule state the page continues from lives on the tick bar map.
    merged._classifier = cache.bars._classifier;
    return merged;
  }

  // Whether the window [fromMs, toMs) is already held in full. With the broker's candles known for
  // that time, "full" means a tick in (almost) every minute MT5 recorded trading in; a few minutes are
  // allowed to miss, because an Ask-only change counts in MT5's tick volume but is not a chart tick.
  // Without candles, the stored ticks must reach both ends with no hole longer than ten minutes.
  function covers(source, symbol, feedId, fromMs, toMs, minutes = null) {
    if (Array.isArray(minutes) && !minutes.length) return true;
    const feed = feedFor(source, symbol, feedId, false);
    if (!feed || !feed.times.length) return false;
    if (Array.isArray(minutes)) {
      let hits = 0;
      for (const minute of minutes) {
        const i = lowerBound(feed.times, minute);
        if (i < feed.times.length && feed.times[i] < minute + 60_000) hits += 1;
      }
      return hits >= Math.ceil(minutes.length * 0.95);
    }
    const start = lowerBound(feed.times, fromMs), end = lowerBound(feed.times, toMs);
    if (end <= start) return false;
    const gap = 10 * 60_000;
    if (feed.times[start] - fromMs > gap || toMs - feed.times[end - 1] > gap) return false;
    for (let i = start + 1; i < end; i++) if (feed.times[i] - feed.times[i - 1] > gap) return false;
    return true;
  }

  // The last chart price at or before `ms` (within ten minutes), or null.
  function priceAt(source, symbol, feedId, ms) {
    const feed = feedFor(source, symbol, feedId, false);
    if (!feed || !feed.times.length) return null;
    const i = lowerBound(feed.times, ms + 1) - 1;
    if (i < 0 || ms - feed.times[i] > 10 * 60_000) return null;
    const tick = feed.ticks[i];
    const price = Number(tick.last) > 0 ? Number(tick.last) : Number(tick.bid);
    return price > 0 ? price : null;
  }

  function select(source, symbol, feedId) {
    const feed = feedFor(source, symbol, feedId, false);
    return feed ? feed.ticks : [];
  }

  function feedsOf(source, symbol) {
    return [...feeds.values()].filter(feed => feed.source === source && feed.symbol === symbol && feed.ticks.length);
  }

  // The newest `limit` events of a symbol across feeds, in time order.
  function recent(symbol, limit) {
    const picked = [];
    for (const feed of feeds.values()) {
      if (symbol && feed.symbol !== symbol) continue;
      const start = Math.max(0, feed.ticks.length - limit);
      for (let i = start; i < feed.ticks.length; i++) picked.push({ at: feed.times[i], event: feed.ticks[i] });
    }
    return picked.sort((a, b) => a.at - b.at).slice(-limit).map(item => item.event);
  }

  function newestTimeMs() {
    let newest = 0;
    for (const feed of feeds.values()) if (feed.times.length && feed.times.at(-1) > newest) newest = feed.times.at(-1);
    return newest;
  }

  function dropCaches(source, symbol, feedId) {
    const feed = feedFor(source, symbol, feedId, false);
    if (feed) feed.caches.clear();
  }

  return { add, analysis, covers, priceAt, select, feedsOf, recent, newestTimeMs, dropCaches, count: () => total };
}

// Remembers recently seen event ids in two generations, so de-duplication stays O(1) and its memory
// stays bounded instead of growing with every tick ever ingested.
export function createSeenSet(capacity = 2_000_000) {
  let current = new Set(), previous = new Set();
  return {
    has: key => current.has(key) || previous.has(key),
    add(key) {
      current.add(key);
      if (current.size >= capacity) { previous = current; current = new Set(); }
    }
  };
}
