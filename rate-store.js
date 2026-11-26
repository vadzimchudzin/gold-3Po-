// The broker's own M1 candles per feed, and their aggregation to any chart timeframe on the broker's
// clock. MT5 builds every timeframe from M1 bars that start on the server's time (UTC + its shift),
// so an H4 candle starts at 00:00, 04:00… server time, not UTC. bucketStart() is the one rule for
// that, used for candles, ticks and the live candle in the page alike.

const MINUTE = 60_000;

export function bucketStart(ms, intervalMs, alignMs = 0) {
  const shift = Number.isFinite(alignMs) ? alignMs : 0;
  return Math.floor((ms + shift) / intervalMs) * intervalMs - shift;
}

const lowerBound = (keys, value) => {
  let lo = 0, hi = keys.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (keys[mid] < value) lo = mid + 1; else hi = mid; }
  return lo;
};

const valid = bar => bar && [bar.t, bar.o, bar.h, bar.l, bar.c].every(Number.isFinite)
  && bar.t > 0 && bar.t % MINUTE === 0 && Math.min(bar.o, bar.h, bar.l, bar.c) > 0
  && bar.h >= Math.max(bar.o, bar.c, bar.l) && bar.l <= Math.min(bar.o, bar.c);

export function createRateStore({ maxMinutes = 60 * 24 * 32, maxFeeds = 16 } = {}) {
  const feeds = new Map();

  function feedOf(key, create = false) {
    let feed = feeds.get(key);
    if (!feed && create) {
      if (feeds.size >= maxFeeds) feeds.delete(feeds.keys().next().value);
      feed = { minutes: new Map(), keys: [], revision: 0, aggregates: new Map() };
      feeds.set(key, feed);
    }
    return feed;
  }

  // Upserts minutes; a minute MT5 sends again (the forming one, a corrected one) replaces the old one.
  function add(key, rates) {
    if (!Array.isArray(rates)) throw new TypeError('rates must be an array');
    const feed = feedOf(key, true);
    let accepted = 0, rejected = 0, from = Infinity, to = -Infinity, unordered = false;
    for (const raw of rates) {
      const bar = { t: Number(raw?.t), o: Number(raw?.o), h: Number(raw?.h), l: Number(raw?.l), c: Number(raw?.c), v: Math.max(0, Number(raw?.v) || 0) };
      if (!valid(bar)) { rejected += 1; continue; }
      if (!feed.minutes.has(bar.t)) {
        if (feed.keys.length && bar.t < feed.keys.at(-1)) unordered = true;
        feed.keys.push(bar.t);
      }
      feed.minutes.set(bar.t, bar);
      accepted += 1;
      if (bar.t < from) from = bar.t;
      if (bar.t > to) to = bar.t;
    }
    if (unordered) feed.keys.sort((a, b) => a - b);
    if (feed.keys.length > maxMinutes) {
      const drop = feed.keys.splice(0, feed.keys.length - maxMinutes);
      for (const t of drop) feed.minutes.delete(t);
      for (const cache of feed.aggregates.values()) cache.dirtyFrom = -Infinity;
    }
    if (accepted) {
      feed.revision += 1;
      for (const cache of feed.aggregates.values()) cache.dirtyFrom = Math.min(cache.dirtyFrom, from);
    }
    return { accepted, rejected, from: accepted ? from : null, to: accepted ? to : null };
  }

  // Candles of one timeframe: Map bucket -> { o, h, l, c, v, first, last } and the sorted bucket keys.
  // Only buckets at or after the oldest changed minute are rebuilt.
  function aggregate(key, intervalMs, alignMs = 0) {
    const feed = feedOf(key);
    if (!feed || !feed.keys.length) return null;
    const cacheKey = intervalMs + '|' + alignMs;
    let cache = feed.aggregates.get(cacheKey);
    if (!cache) {
      if (feed.aggregates.size >= 8) feed.aggregates.delete(feed.aggregates.keys().next().value);
      cache = { bars: new Map(), keys: [], dirtyFrom: -Infinity };
      feed.aggregates.set(cacheKey, cache);
    }
    if (cache.dirtyFrom !== Infinity) {
      const firstBucket = Number.isFinite(cache.dirtyFrom) ? bucketStart(cache.dirtyFrom, intervalMs, alignMs) : -Infinity;
      const keep = lowerBound(cache.keys, firstBucket);
      for (const bucket of cache.keys.splice(keep)) cache.bars.delete(bucket);
      for (let i = Number.isFinite(firstBucket) ? lowerBound(feed.keys, firstBucket) : 0; i < feed.keys.length; i++) {
        const minute = feed.minutes.get(feed.keys[i]);
        const bucket = bucketStart(minute.t, intervalMs, alignMs);
        let bar = cache.bars.get(bucket);
        if (!bar) {
          bar = { o: minute.o, h: minute.h, l: minute.l, c: minute.c, v: 0, first: minute.t, last: minute.t };
          cache.bars.set(bucket, bar);
          cache.keys.push(bucket);
        }
        if (minute.h > bar.h) bar.h = minute.h;
        if (minute.l < bar.l) bar.l = minute.l;
        bar.c = minute.c;
        bar.last = minute.t;
        bar.v += minute.v;
      }
      cache.dirtyFrom = Infinity;
    }
    return { bars: cache.bars, keys: cache.keys, latestMinute: feed.keys.at(-1) };
  }

  // Minutes in [fromMs, toMs) in which the broker recorded ticks.
  function tradedMinutes(key, fromMs, toMs) {
    const feed = feedOf(key);
    if (!feed) return null;
    const out = [];
    for (let i = lowerBound(feed.keys, fromMs); i < feed.keys.length && feed.keys[i] < toMs; i++) {
      const minute = feed.minutes.get(feed.keys[i]);
      if (minute.v > 0) out.push(minute.t);
    }
    return out;
  }

  function range(key) {
    const feed = feedOf(key);
    return feed && feed.keys.length ? { first: feed.keys[0], last: feed.keys.at(-1), count: feed.keys.length } : null;
  }

  return { add, aggregate, tradedMinutes, range };
}
