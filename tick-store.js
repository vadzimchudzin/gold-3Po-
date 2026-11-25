import { addTicks, finishAnalysis } from './market-engine.js';
import { createTickClassifier } from './footprint-engine.js';

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
    const { intervalMs, footprintStep, limit, fresh = false } = options;
    const cacheKey = [intervalMs, footprintStep, limit].join('|');
    let cache = feed.caches.get(cacheKey);
    const keep = Math.max(1, limit) + 2;
    const rebuild = () => {
      const bars = new Map();
      const lastMs = feed.times.length ? feed.times.at(-1) : 0;
      const fromMs = Math.floor(lastMs / intervalMs) * intervalMs - (keep - 1) * intervalMs;
      const start = lowerBound(feed.times, fromMs);
      addTicks(bars, feed.ticks.slice(start), intervalMs, footprintStep);
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
        if (pending > 0) addTicks(cache.bars, feed.ticks.slice(feed.ticks.length - pending), intervalMs, footprintStep);
        for (const edit of feed.edits) if (edit.epoch > cache.epoch) rebuildRange(feed, cache.bars, edit.from, edit.to, intervalMs, footprintStep, keep);
        cache.appended = feed.appended;
        cache.epoch = feed.epoch;
      }
    }
    if (cache.bars.size > keep * 2) {
      const old = [...cache.bars.keys()].sort((a, b) => a - b).slice(0, cache.bars.size - keep);
      for (const key of old) cache.bars.delete(key);
    }
    const ticks = feed.ticks;
    return finishAnalysis(cache.bars, {
      ...options,
      tickCount: ticks.length,
      hasComex: source === 'comex',
      comexOnly: source === 'comex' && ticks.length > 0
    });
  }

  // Rebuild only the candles an out-of-order batch touched, from the merged buffer.
  function rebuildRange(feed, bars, from, to, intervalMs, footprintStep, keep) {
    const newestMs = feed.times.length ? feed.times.at(-1) : 0;
    const windowStart = Math.floor(newestMs / intervalMs) * intervalMs - (keep - 1) * intervalMs;
    const first = Math.max(windowStart, Math.floor(from / intervalMs) * intervalMs);
    const last = Math.floor(to / intervalMs) * intervalMs;
    if (last < first) return;
    for (let key = first; key <= last; key += intervalMs) bars.delete(key);
    const start = lowerBound(feed.times, first), end = lowerBound(feed.times, last + intervalMs);
    const before = start > 0 ? feed.ticks[start - 1] : null;
    const seed = createTickClassifier({ prevPrice: before ? Number(before.last) : null });
    addTicks(bars, feed.ticks.slice(start, end), intervalMs, footprintStep, seed);
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

  return { add, analysis, select, feedsOf, recent, newestTimeMs, dropCaches, count: () => total };
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
