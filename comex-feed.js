// COMEX gold futures (GC, front month) for the spot chart: exchange volume that spot gold does not have.
//
// Source: the public Yahoo Finance chart feed of GC=F, one-minute bars with real exchange volume. It is
// free, needs no key, and is delayed (CME rules: about 10 minutes); the page says so next to every
// number. A licensed real-time trade feed can still be pushed into /v1/ingest/comex/trade.
//
// What the trader gets: the GC price and its basis to spot (futures carry a premium), the session's
// COMEX volume profile (POC, value area, high/low) converted to spot prices by that basis, and the
// session volume. The read is started on the first request and repeated every pollMs while used.

const MINUTE = 60_000;
const SOURCE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1m&range=1d&includePrePost=true';

// The CME Globex gold day starts at 18:00 New York time.
export function sessionStart(nowMs) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(nowMs)).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  const nyAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  const offset = nyAsUtc - Math.floor(nowMs / MINUTE) * MINUTE; // New York minus UTC, in ms
  let start = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 18, 0) - offset;
  if (start > nowMs) start -= 86_400_000;
  return start;
}

// Volume spread evenly over each minute's range, in 0.1 steps (the GC tick), then POC and the 70% value area.
export function volumeProfile(bars, step = 0.1) {
  const buckets = new Map();
  let total = 0, high = -Infinity, low = Infinity;
  for (const bar of bars) {
    if (!(bar.v > 0)) continue;
    const lo = Math.round(bar.l / step), hi = Math.round(bar.h / step);
    const share = bar.v / (hi - lo + 1);
    for (let k = lo; k <= hi; k++) buckets.set(k, (buckets.get(k) || 0) + share);
    total += bar.v;
    if (bar.h > high) high = bar.h;
    if (bar.l < low) low = bar.l;
  }
  if (!buckets.size) return null;
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  let poc = keys[0];
  for (const k of keys) if (buckets.get(k) > buckets.get(poc)) poc = k;
  let lo = keys.indexOf(poc), hi = lo, inside = buckets.get(poc);
  while (inside < total * 0.7 && (lo > 0 || hi < keys.length - 1)) {
    const down = lo > 0 ? buckets.get(keys[lo - 1]) : -1, up = hi < keys.length - 1 ? buckets.get(keys[hi + 1]) : -1;
    if (up >= down) { hi += 1; inside += up; } else { lo -= 1; inside += down; }
  }
  const price = k => Number((k * step).toFixed(2));
  return { poc: price(poc), vah: price(keys[hi]), val: price(keys[lo]), high: Number(high.toFixed(2)), low: Number(low.toFixed(2)), volume: Math.round(total) };
}

export function parseChart(body) {
  const result = body?.chart?.result?.[0];
  if (!result) throw new Error(body?.chart?.error?.description || 'пустой ответ');
  const meta = result.meta || {};
  const times = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < times.length; i++) {
    const bar = { t: times[i] * 1000, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i] ?? 0 };
    if (![bar.o, bar.h, bar.l, bar.c].every(Number.isFinite) || bar.h < bar.l) continue;
    bars.push(bar);
  }
  return {
    contract: typeof meta.shortName === 'string' ? meta.shortName : 'GC',
    exchange: meta.fullExchangeName || meta.exchangeName || 'COMEX',
    price: Number.isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice : bars.at(-1)?.c ?? null,
    priceTimeMs: Number.isFinite(meta.regularMarketTime) ? meta.regularMarketTime * 1000 : bars.at(-1)?.t ?? null,
    previousClose: Number.isFinite(meta.chartPreviousClose) ? meta.chartPreviousClose : null,
    bars
  };
}

export function createComexFeed({ fetchImpl = globalThis.fetch, now = () => Date.now(), enabled = true, pollMs = 30_000, idleMs = 5 * 60_000, url = SOURCE_URL } = {}) {
  let data = null, error = null, loadingSince = 0, lastAsked = 0, timer = null, inFlight = null;

  async function load() {
    if (inFlight) return inFlight;
    loadingSince = now();
    inFlight = (async () => {
      try {
        const response = await fetchImpl(url, { headers: { 'user-agent': 'Mozilla/5.0 GOLD-3Po', accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        data = { ...parseChart(await response.json()), loadedAt: now() };
        error = null;
      } catch (failure) {
        error = failure?.name === 'TimeoutError' ? 'нет ответа за 10 с' : (failure?.message || 'ошибка сети');
      } finally { inFlight = null; }
    })();
    return inFlight;
  }

  function schedule() {
    if (timer || !enabled) return;
    timer = setInterval(() => {
      if (now() - lastAsked > idleMs) { clearInterval(timer); timer = null; return; }
      void load();
    }, pollMs);
    timer.unref?.();
  }

  // spotAt(ms): the MT5 price at a past time. The GC quote is delayed, so the basis is measured at the GC
  // bar's own time, not against the live spot.
  function summary({ spotAt = null } = {}) {
    if (!enabled) return { enabled: false, status: 'disabled' };
    lastAsked = now();
    if (!data && !inFlight && (!error || now() - loadingSince > pollMs)) void load();
    schedule();
    if (!data) return { enabled: true, status: error ? 'error' : 'loading', error, source: 'Yahoo Finance GC=F' };
    const session = data.bars.filter(bar => bar.t >= sessionStart(data.bars.at(-1)?.t ?? now()));
    const profile = volumeProfile(session);
    const lastBar = data.bars.at(-1) || null;
    const spotThen = lastBar && typeof spotAt === 'function' ? spotAt(lastBar.t + MINUTE - 1) : null;
    const basis = lastBar && Number.isFinite(spotThen) && spotThen > 0 ? Number((lastBar.c - spotThen).toFixed(2)) : null;
    const toSpot = price => basis === null ? null : Number((price - basis).toFixed(2));
    const levels = profile ? [
      { key: 'poc', label: 'COMEX POC', price: profile.poc },
      { key: 'vah', label: 'COMEX VAH', price: profile.vah },
      { key: 'val', label: 'COMEX VAL', price: profile.val },
      { key: 'high', label: 'COMEX макс. сессии', price: profile.high },
      { key: 'low', label: 'COMEX мин. сессии', price: profile.low }
    ].map(level => ({ ...level, spotPrice: toSpot(level.price) })) : [];
    const delayMs = data.priceTimeMs ? Math.max(0, now() - data.priceTimeMs) : null;
    return {
      enabled: true,
      status: error ? 'stale' : delayMs !== null && delayMs > 30 * MINUTE ? 'closed' : 'delayed',
      error, source: 'Yahoo Finance GC=F', exchange: data.exchange, contract: data.contract,
      price: data.price, priceTime: data.priceTimeMs ? new Date(data.priceTimeMs).toISOString() : null, delayMs,
      change: Number.isFinite(data.previousClose) && Number.isFinite(data.price) ? Number((data.price - data.previousClose).toFixed(2)) : null,
      sessionVolume: profile?.volume ?? 0, lastMinuteVolume: lastBar?.v ?? null,
      basis, basisAt: lastBar ? new Date(lastBar.t).toISOString() : null,
      levels, loadedAt: new Date(data.loadedAt).toISOString(),
      note: 'Данные COMEX бесплатные и приходят с задержкой около 10 минут. Уровни переведены в цену спота через базис.'
    };
  }

  function stop() { clearInterval(timer); timer = null; }
  return { summary, load, stop };
}
