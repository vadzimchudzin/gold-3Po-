import { createServer } from 'node:http';
import { readFile, appendFile, mkdir, open, writeFile, rename } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { generateSignals } from './strategy-engine.js';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { createTickStore, createSeenSet } from './tick-store.js';
import { createRateStore } from './rate-store.js';
import { createComexFeed } from './comex-feed.js';
import { TIMEFRAMES } from './settings-store.js';
import { createLicenseManager } from './license.js';
import { createSetupStore } from './setup-store.js';
import { createSettingsStore } from './settings-store.js';

const MAX_BODY_BYTES = 1024 * 1024;
const STREAM_PING_MS = 5000;
const LIVE_FRAMES_PER_BATCH = 50;
const MAX_EVENTS = 1000000;
// Candles the chart, the zones and the MT5 indicator are computed over.
const ANALYSIS_BARS = 800;
// Only the newest MAX_EVENTS lines are ever read back, so the archive is trimmed on startup once it
// grows past this size: an append-only file that history backfills had pushed to 4.9 GB.
const MAX_STORAGE_BYTES = 256 * 1024 * 1024;
const STATIC_FILES = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/zone-labels.js': ['zone-labels.js', 'text/javascript; charset=utf-8'], '/chart-view.js': ['chart-view.js', 'text/javascript; charset=utf-8'], '/quote-display.js': ['quote-display.js', 'text/javascript; charset=utf-8'], '/footprint-engine.js': ['footprint-engine.js', 'text/javascript; charset=utf-8'], '/market-data.js': ['market-data.js', 'text/javascript; charset=utf-8'], '/market-client.js': ['market-client.js', 'text/javascript; charset=utf-8'], '/strategy-client.js': ['strategy-client.js', 'text/javascript; charset=utf-8'], '/alerts-client.js': ['alerts-client.js', 'text/javascript; charset=utf-8'], '/archive-client.js': ['archive-client.js', 'text/javascript; charset=utf-8'], '/alert-engine.js': ['alert-engine.js', 'text/javascript; charset=utf-8'], '/rate-store.js': ['rate-store.js', 'text/javascript; charset=utf-8'], '/market-engine.js': ['market-engine.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/c3po.png': ['c3po.png', 'image/png'], '/license-client.js': ['license-client.js', 'text/javascript; charset=utf-8'], '/settings-client.js': ['settings-client.js', 'text/javascript; charset=utf-8'], '/assets/atmosphere.jpg': ['assets/atmosphere.jpg', 'image/jpeg'], '/mt5-client.js': ['mt5-client.js', 'text/javascript; charset=utf-8'], '/mt5-status.js': ['mt5-status.js', 'text/javascript; charset=utf-8'], '/footprint-candle.js': ['footprint-candle.js', 'text/javascript; charset=utf-8'], '/delta-pane.js': ['delta-pane.js', 'text/javascript; charset=utf-8'], '/updates-client.js': ['updates-client.js', 'text/javascript; charset=utf-8'] };
// The candles carry their price ladders only from `fromMs` on: the chart needs OHLC and delta for every
// candle, the footprint needs ladders only for the columns it shows. Sending every ladder made each
// refresh a multi-megabyte answer.
function withLevelsFrom(bars, fromMs) {
  if (!Number.isFinite(fromMs) || fromMs <= 0) return bars;
  return bars.map(bar => bar.timeMs >= fromMs ? bar : { ...bar, levels: undefined, imbalances: undefined, stackedImbalances: undefined, absorbedLevels: undefined, trimmed: true });
}
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const positive = n => Number.isFinite(n) && n > 0;
const validTimestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

// Read only the latest retained JSONL records. Never materialize a growing archive as one JS string.
async function readRecentLines(file, maxLines, chunkSize = 1024 * 1024) {
  const handle = await open(file, 'r');
  try {
    let offset = (await handle.stat()).size;
    let carry = Buffer.alloc(0);
    const newestFirst = [];
    while (offset > 0 && newestFirst.length < maxLines) {
      const start = Math.max(0, offset - chunkSize);
      const chunk = Buffer.alloc(offset - start);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
      if (!bytesRead) break;
      const combined = Buffer.concat([chunk.subarray(0, bytesRead), carry]);
      let lineEnd = combined.length;
      for (let index = combined.length - 1; index >= 0 && newestFirst.length < maxLines; index -= 1) {
        if (combined[index] !== 10) continue;
        if (lineEnd > index + 1) newestFirst.push(combined.subarray(index + 1, lineEnd));
        lineEnd = index;
      }
      carry = combined.subarray(0, lineEnd);
      offset = start;
    }
    if (offset === 0 && carry.length && newestFirst.length < maxLines) newestFirst.push(carry);
    return newestFirst.reverse();
  } finally {
    await handle.close();
  }
}
// The archive keeps every event ever ingested, but startup only ever reads the newest MAX_EVENTS
// lines. Rewrite it down to that window (atomically, via a temp file) so a long-lived install does
// not carry gigabytes of unreachable history.
async function trimStorage(file, maxLines, maxBytes = MAX_STORAGE_BYTES) {
  let size = 0;
  try {
    const handle = await open(file, 'r');
    try { size = (await handle.stat()).size; } finally { await handle.close(); }
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (size <= maxBytes) return false;
  const recent = await readRecentLines(file, maxLines);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, recent.map(line => line.toString('utf8').replace(/\r?\n$/, '')).join('\n') + '\n');
  await rename(tmp, file);
  return true;
}
// GOLD-3Po is a gold-only workspace: broker XAUUSD (incl. suffix variants like XAUUSD./XAUUSD-ECN)
// and COMEX GC futures (GC, GCZ6, …). Everything else is rejected at the ingest boundary.
const isGoldSymbol = (source, symbol) => source === 'comex'
  ? /^GC[A-Z0-9]*$/i.test(symbol)
  : /^(?:XAUUSD|GOLD)[A-Z0-9._#+-]{0,20}$/i.test(symbol) && !symbol.includes('..');
const goldOnly = (source, symbol) => { if (!isGoldSymbol(source, symbol)) throw Object.assign(new Error('GOLD-3Po is gold-only: accepted symbols are XAUUSD (MT5) and GC futures (COMEX).'), { status: 422 }); };

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''; let bytes = 0; let tooLarge = false;
    req.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_BODY_BYTES) { tooLarge = true; return; } if (!tooLarge) body += chunk; });
    req.on('end', () => { if (tooLarge) { reject(Object.assign(new Error('Payload too large'), { status: 413 })); return; } try { resolve(JSON.parse(body)); } catch { reject(Object.assign(new Error('Body must be valid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}
function tokenMatches(header, token) {
  if (!token || !header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7)); const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function eventFingerprint(event) {
  const fields = event.source === 'comex'
    ? [event.source,event.symbol,event.tradeId]
    : [event.source,event.symbol,event.feedId || 'legacy',event.timestamp,event.bid,event.ask,event.last,event.tickVolume,event.realVolume,event.flags,event.sequence];
  return createHash('sha256').update(fields.map(value => String(value ?? '')).join('|')).digest('hex');
}
function normalizeMt5(input) {
  const feedId = input?.feedId ?? null;
  if (feedId !== null && (typeof feedId !== 'string' || !/^[a-f0-9]{32}$/i.test(feedId))) {
    throw Object.assign(new Error('Invalid MT5 feed identity.'), { status: 422 });
  }
  if (input?.source !== 'mt5' || typeof input.symbol !== 'string' || !input.symbol.trim() || !validTimestamp(input.timestamp) || !Number.isSafeInteger(input.sequence) || input.sequence < 1 || !positive(input.bid) || !positive(input.ask) || input.ask < input.bid || !positive(input.last) || !Number.isFinite(input.tickVolume) || input.tickVolume < 0 || !Number.isFinite(input.realVolume) || input.realVolume < 0) throw Object.assign(new Error('Invalid MT5 tick. Required: source, symbol, ISO timestamp, positive sequence, bid, ask, last, tickVolume and realVolume.'), { status: 422 });
  goldOnly('mt5', input.symbol.trim().toUpperCase());
  return { type: 'quote', source: 'mt5', venue: 'broker_otc', symbol: input.symbol.trim().toUpperCase(), feedId, timestamp: new Date(input.timestamp).toISOString(), sequence: input.sequence, eventId: typeof input.eventId === 'string' && input.eventId.length <= 160 ? input.eventId : '', bid: input.bid, ask: input.ask, last: input.last, tickVolume: input.tickVolume, realVolume: input.realVolume, aggressorSide: ['buy','sell'].includes(input.aggressorSide) ? input.aggressorSide : (Number.isInteger(input.flags) && (input.flags & 32) ? 'buy' : Number.isInteger(input.flags) && (input.flags & 64) ? 'sell' : 'unknown'), flags: Number.isInteger(input.flags) ? input.flags : 0, volumeKind: 'broker_tick_or_reported_volume' };
}
function normalizeComex(input) {
  if (input?.source !== 'comex' || typeof input.symbol !== 'string' || !input.symbol.trim() || !validTimestamp(input.timestamp) || !Number.isSafeInteger(input.sequence) || input.sequence < 1 || typeof input.tradeId !== 'string' || !input.tradeId.trim() || !positive(input.price) || !positive(input.size) || !['buy','sell','unknown'].includes(input.aggressorSide)) throw Object.assign(new Error('Invalid COMEX trade. Required: source, symbol, ISO timestamp, positive sequence, tradeId, price, size and aggressorSide.'), { status: 422 });
  goldOnly('comex', input.symbol.trim().toUpperCase());
  return { type: 'trade', source: 'comex', venue: 'comex_futures', symbol: input.symbol.trim().toUpperCase(), timestamp: new Date(input.timestamp).toISOString(), sequence: input.sequence, eventId: 'COMEX-' + input.tradeId.trim(), tradeId: input.tradeId.trim(), price: input.price, size: input.size, aggressorSide: input.aggressorSide, volumeKind: 'exchange_trade_size' };
}

export function createMarketServer({ token = process.env.MARKET_INGEST_TOKEN, now = () => Date.now(), staleAfterMs = 15000, storageFile = process.env.MARKET_DATA_FILE || './data/market-events.jsonl', license = null, setupStore = null, settingsStore = null, comexFeed = undefined, metaFile = undefined, maxEvents = MAX_EVENTS, maxStorageBytes = MAX_STORAGE_BYTES, streamPingMs = STREAM_PING_MS } = {}) {
  const lastSequence = new Map(); const feeds = new Map(); const activeFeeds = new Map(); const clients = new Set();
  const feedScopeKey = (source, symbol) => source + ':' + symbol;
  const feedSequenceKey = (source, symbol, feedId) => source + ':' + symbol + ':' + (feedId || 'legacy');
  // Keep MT5 bridge batches on the same account-scoped feed as the desktop Python connector.
  // Never infer an unidentified bridge's account from whichever terminal connected most recently.
  function feedIdFromAccount(body, symbol) {
    const login = String(body?.accountLogin ?? '').trim();
    const server = typeof body?.accountServer === 'string' ? body.accountServer.trim().toLowerCase() : '';
    if (!/^[0-9]{1,20}$/.test(login) || !server || server.length > 128) return null;
    return createHash('sha256').update([server, login, symbol.trim().toUpperCase()].join('|')).digest('hex').slice(0, 32);
  }
  // The chart must show the data the terminal is streaming right now. An unqualified request is
  // therefore resolved to the feed with the newest event instead of "whatever account was ingested
  // last": a leftover bucket written without account metadata must never win over a live account.
  function newestFeed(source, symbol) {
    let best = null, bestTime = -1, bestBound = false;
    for (const [feedId, item] of feedQuoteIndex(source, symbol)) {
      const bound = feedId !== null;
      if (item.timeMs > bestTime) { best = feedId; bestTime = item.timeMs; bestBound = bound; continue; }
      // Same tick time: an account-bound feed beats an unattached one, and between two accounts the
      // one ingested last is the live one.
      if (item.timeMs === bestTime && (bound ? !bestBound || bestBound : false)) { best = feedId; bestBound = bound; }
    }
    return bestTime < 0 ? undefined : best;
  }
  function selectFeedEvents(source, symbol, url) {
    const requested = url.searchParams.get('feedId');
    if (requested !== null && requested !== 'legacy' && !/^[a-f0-9]{32}$/i.test(requested)) return null;
    const accountFeedId = source === 'mt5' ? feedIdFromAccount({
      accountLogin: url.searchParams.get('accountLogin'),
      accountServer: url.searchParams.get('accountServer')
    }, symbol) : null;
    const newest = requested === null ? newestFeed(source, symbol) : undefined;
    const feedId = requested === 'legacy' ? null
      : requested !== null ? requested
      : newest !== undefined ? newest
      : accountFeedId ?? activeFeeds.get(feedScopeKey(source, symbol))?.feedId ?? null;
    if (feedId) activeFeeds.set(feedScopeKey(source, symbol), { feedId, receivedAt: now() });
    return { feedId, events: store.select(source, symbol, feedId) };
  }
  const licenseManager = license || createLicenseManager({ now, required: process.env.LICENSE_REQUIRED !== '0' });
  const setups = setupStore || createSetupStore({ file: process.env.SETUPS_FILE || './data/setups.json', now });
  const settings = settingsStore || createSettingsStore({ file: process.env.SETTINGS_FILE || './data/settings.json' });
  // COMEX gold futures (GC): a delayed public quote, read on the service side so the page and MT5 share it.
  const comex = comexFeed === undefined ? createComexFeed({ now, enabled: process.env.COMEX_FEED !== '0' && !process.env.NODE_TEST_CONTEXT }) : comexFeed;
  let activateAttempts = [];
  const eventBufferCap = Number.isInteger(maxEvents) && maxEvents > 0 ? maxEvents : MAX_EVENTS;
  const store = createTickStore({ cap: eventBufferCap });
  const seenEventIds = createSeenSet(Math.max(1000, eventBufferCap * 2));
  // External clock reference: newest ingested market event timestamp (broker/exchange time).
  const feedNowMs = () => store.newestTimeMs();
  const dataFile = storageFile;
  // Dedup identities are scoped per feed: brokers reuse sequence numbers across symbols.
  const dedupeKey = (event, id) => `${event.source}:${event.symbol}:${event.feedId || 'legacy'}:${id}`;
  const storageReady = dataFile ? (async () => {
    try {
      await trimStorage(dataFile, eventBufferCap, maxStorageBytes);
      const recentLines = await readRecentLines(dataFile, eventBufferCap);
      const restored = [];
      for (const rawLine of recentLines) {
        const line = rawLine.toString('utf8');
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          restored.push(event);
          const eventId = event.eventId || eventFingerprint(event);
          seenEventIds.add(dedupeKey(event, eventId));
          seenEventIds.add(dedupeKey(event, eventFingerprint(event)));
          indexQuote(event);
          const scope = feedScopeKey(event.source, event.symbol);
          const scopedKey = feedSequenceKey(event.source, event.symbol, event.feedId);
          const receivedAt = Date.parse(event.receivedAt) || Date.now();
          if (event.source === 'mt5' && event.feedId) {
            const active = activeFeeds.get(scope);
            if (!active || receivedAt >= active.receivedAt) activeFeeds.set(scope, { feedId: event.feedId, receivedAt });
          }
          if (!event.historical) {
            lastSequence.set(scopedKey, Math.max(lastSequence.get(scopedKey) || 0, event.sequence || 0));
            const existing = feeds.get(scopedKey);
            feeds.set(scopedKey, { source:event.source, symbol:event.symbol, feedId:event.feedId || null, lastSequence:event.sequence, receivedAt, accepted:(existing?.accepted || 0)+1 });
          }
        } catch {}
      }
      // One sorted insert for the whole archive instead of one per line.
      store.add(restored);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  })() : Promise.resolve();
  async function persistMany(storedEvents) { if (!dataFile || !storedEvents.length) return; await mkdir(dirname(dataFile), { recursive:true }); await appendFile(dataFile, storedEvents.map(event => JSON.stringify(event)).join('\n')+'\n'); }
  async function persist(stored) { return persistMany([stored]); }
  let settingsRevision = 0; // rises on every settings or setup change
  // The broker's M1 candles per feed, and the broker's clock shift per feed (candles start on the
  // server's clock, as in MT5). The shift is kept on disk: a weekend start cannot measure it.
  const rates = createRateStore();
  const feedMeta = new Map();
  const metaPath = metaFile !== undefined ? metaFile : (dataFile ? dirname(dataFile) + '/feed-meta.json' : null);
  const metaReady = metaPath ? readFile(metaPath, 'utf8').then(text => {
    for (const [key, value] of Object.entries(JSON.parse(text) || {})) if (Number.isSafeInteger(value?.clockOffsetMs)) feedMeta.set(key, { clockOffsetMs: value.clockOffsetMs });
  }).catch(() => {}) : Promise.resolve();
  async function persistMeta() {
    if (!metaPath) return;
    try { await mkdir(dirname(metaPath), { recursive: true }); await writeFile(metaPath, JSON.stringify(Object.fromEntries(feedMeta)), 'utf8'); } catch {}
  }
  const alignFor = (source, symbol, feedId) => feedMeta.get(feedSequenceKey(source, symbol, feedId))?.clockOffsetMs ?? 0;
  const ratesFor = (source, symbol, feedId, intervalMs) => rates.aggregate(feedSequenceKey(source, symbol, feedId), intervalMs, alignFor(source, symbol, feedId));
  // Broker symbol specifications (tick size) reported by the MT5 connector with each tick batch.
  // Only gold symbols are stored and the map is capped, so the ingest token cannot grow it without
  // bound. A batch with spec: null clears the stored one, so after a reconnect to a broker that does
  // not report a tick size rows fall back to the default instead of keeping the previous broker's grid.
  const symbolSpecs = new Map();
  const SYMBOL_SPECS_MAX = 16;
  function rememberSpec(source, symbol, feedId, spec) {
    if (typeof symbol !== 'string') return;
    const name = symbol.trim().toUpperCase();
    if (!isGoldSymbol(source, name)) return;
    const key = feedSequenceKey(source, name, feedId);
    const tickSize = Number(spec?.tickSize);
    // Only an explicit null clears: the MT5 session sends it when the broker gave no tick size. A batch
    // without the field (an older connector) leaves a size another batch reported alone.
    if (spec === undefined) return;
    const before = symbolSpecs.get(key)?.tickSize ?? null;
    if (spec === null) symbolSpecs.delete(key);
    else {
      if (!Number.isFinite(tickSize) || tickSize <= 0 || tickSize > 100) return;
      if (!symbolSpecs.has(key) && symbolSpecs.size >= SYMBOL_SPECS_MAX) symbolSpecs.delete(symbolSpecs.keys().next().value);
      symbolSpecs.set(key, { tickSize });
    }
    // The footprint grid changed: pages reload the window instead of drawing new ticks on the old grid.
    const after = symbolSpecs.get(key)?.tickSize ?? null;
    if (after !== before) broadcast('spec', { source, symbol: name, feedId: feedId || null, tickSize: after });
  }
  // The footprint's source precision: the broker's tick size when MT5 reported it, otherwise the
  // analysis step. The user's row grouping is applied on top of this, never instead.
  function footprintStepFor(source, symbol, feedId, analysisStep) {
    return symbolSpecs.get(feedSequenceKey(source, symbol, feedId))?.tickSize ?? analysisStep;
  }
  // One XAUUSD symbol can be fed by several MT5 accounts at once, each with its own price level.
  // The newest price per feed is what makes a "the app says 4000, the terminal says 3600" report
  // attributable instead of invisible.
  function feedQuoteIndex(source, symbol) {
    const index = new Map();
    const prefix = `${source}|${symbol}|`;
    for (const [key, entry] of quoteIndex) if (key.startsWith(prefix)) index.set(entry.feedId, entry);
    return index;
  }
  // Newest quote per feed, maintained as ticks are stored. Deriving it by scanning the buffer cost
  // three passes over every stored tick on each analysis request — more than the analysis itself.
  const quoteIndex = new Map();
  const quoteKey = event => `${event.source}|${event.symbol}|${event.feedId || ''}`;
  const indexQuote = event => {
    const price = Number.isFinite(event.last) ? event.last : Number.isFinite(event.bid) ? event.bid : null;
    if (!(price > 0)) return;
    const timeMs = Date.parse(event.timestamp) || 0;
    const key = quoteKey(event), entry = quoteIndex.get(key);
    if (!entry || timeMs >= entry.timeMs) quoteIndex.set(key, { feedId: event.feedId || null, price, timeMs, timestamp: event.timestamp, bid: event.bid, ask: event.ask, last: event.last, sequence: event.sequence, receivedAt: event.receivedAt, receivedMs: Date.parse(event.receivedAt) || 0 });
  };
  const storeEvents = list => { for (const event of list) indexQuote(event); return store.add(list); };
  // Two accounts quoting the same instrument more than 1.5% apart are not the same market: the
  // app is showing one of them, the terminal may be showing the other.
  const PRICE_CONFLICT_RATIO = 1.015;
  function priceConflictOf(feedPrices) {
    if (feedPrices.length < 2) return null;
    const levels = feedPrices.map(feed => feed.price).filter(price => Number.isFinite(price) && price > 0);
    if (levels.length < 2) return null;
    const low = Math.min(...levels), high = Math.max(...levels);
    if (!(low > 0) || high / low < PRICE_CONFLICT_RATIO) return null;
    return {
      ratio: Number((high / low).toFixed(4)),
      low,
      high,
      feeds: feedPrices.map(feed => ({ feedId: feed.feedId, price: feed.price, timestamp: feed.timestamp, active: feed.active }))
    };
  }
  // The analysis grid for zones and bar heuristics: the caller's priceStep, otherwise 0.1.
  function analysisStep(requested) {
    const asked = Number(requested);
    return Number.isFinite(asked) && asked > 0 ? Math.min(100, Math.max(0.001, asked)) : 0.1;
  }
  function broadcast(type, payload) {
    const packet = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) { try { client.write(packet); } catch {} }
  }
  function health() {
    const at = now();
    return { status: 'ok', ingestConfigured: Boolean(token), durableStorage: Boolean(dataFile), eventCount: store.count(), memoryLimit: eventBufferCap, connectedStreams: clients.size, feeds: [...feeds.values()].map(feed => ({ ...feed, ageMs: Math.max(0, at - feed.receivedAt), status: at - feed.receivedAt <= staleAfterMs ? 'online' : 'stale' })) };
  }
  const server = createServer(async (req, res) => {
   try {
    await storageReady;
    await metaReady;
    const url = new URL(req.url || '/', 'http://localhost');
    const asset = STATIC_FILES[url.pathname];
    if (req.method === 'GET' && asset) { try { const content = await readFile(new URL('./' + asset[0], import.meta.url)); res.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-cache' }); res.end(content); return; } catch { return json(res, 500, { error: 'asset_read_failed' }); } }
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, health());
    if (req.method === 'GET' && url.pathname === '/v1/license/status') return json(res, 200, await licenseManager.status(feedNowMs()));
    if (req.method === 'POST' && url.pathname === '/v1/license/activate') {
      const at = now();
      activateAttempts = activateAttempts.filter(t => at - t < 60000);
      if (activateAttempts.length >= 10) return json(res, 429, { error: 'too_many_attempts', message: 'Wait a minute before trying again.' });
      activateAttempts.push(at);
      try {
        const body = await readJson(req);
        const result = await licenseManager.activate(typeof body?.key === 'string' ? body.key.trim() : '');
        return json(res, result.valid ? 200 : 422, result);
      } catch (error) { return json(res, error.status || 400, { error: 'invalid_request', message: error.message }); }
    }
    // Licence gate: analysis, replay, backtest, signals, risk and SSE require a valid licence.
    // Ingest stays open so an expired licence never loses incoming market data; /health stays open for diagnostics.
    if (!url.pathname.startsWith('/v1/ingest/')) {
      const licenceStatus = await licenseManager.status(feedNowMs());
      if (!licenceStatus.valid) return json(res, 402, { error: 'license_required', reason: licenceStatus.reason, machineId: licenceStatus.machineId, activate: '/v1/license/activate' });
    }
    if (req.method === 'GET' && url.pathname === '/v1/quote') {
      const symbol = (url.searchParams.get('symbol') || 'XAUUSD').toUpperCase();
      if (!isGoldSymbol('mt5', symbol)) return json(res, 400, { error: 'symbol_not_gold' });
      const wanted = url.searchParams.get('feedId');
      if (wanted && !/^[a-f0-9]{32}$/i.test(wanted)) return json(res, 400, { error: 'invalid_feed_id' });
      const entries = [...feedQuoteIndex('mt5', symbol).values()];
      const quote = wanted
        ? entries.find(item => item.feedId === wanted)
        : entries.sort((a, b) => b.receivedMs - a.receivedMs)[0];
      if (!quote) return json(res, 404, { error: 'no_quote' });
      return json(res, 200, { source: 'mt5', symbol, feedId: quote.feedId, bid: quote.bid, ask: quote.ask, last: quote.last, timestamp: quote.timestamp, sequence: quote.sequence, receivedAt: quote.receivedAt, ageMs: Math.max(0, now() - quote.receivedMs) });
    }
    if (req.method === 'GET' && url.pathname === '/v1/chart/zones') {
      const symbol = (url.searchParams.get('symbol') || 'XAUUSD').toUpperCase();
      const source = (url.searchParams.get('source') || 'mt5').toLowerCase();
      if (!['mt5','comex'].includes(source)) return json(res,400,{error:'unsupported_market_source'});
      if (!isGoldSymbol(source, symbol)) return json(res,400,{error:'symbol_not_gold',message:'GOLD-3Po is gold-only: XAUUSD (MT5) or GC futures (COMEX).'});
      const current = await settings.get();
      const rawInterval = url.searchParams.get('intervalMs');
      const intervalMs = rawInterval === null ? current.zones.timeframeMinutes * 60000 : Number(rawInterval);
      if (!Number.isInteger(intervalMs) || intervalMs < 60000 || intervalMs > 86400000) return json(res,400,{error:'invalid_interval',message:'intervalMs must be an integer between 60000 and 86400000.'});
      const selection = selectFeedEvents(source, symbol, url);
      if (!selection) return json(res, 400, { error: 'invalid_feed_id' });
      const { feedId } = selection;
      // The same incremental window as the chart, and the same bar count, so MT5 draws the zones the
      // app shows.
      const zoneStep = footprintStepFor(source, symbol, feedId, 0.1);
      const analysis = store.analysis(source, symbol, feedId,
        { intervalMs, priceStep: 0.1, footprintStep: zoneStep, limit: ANALYSIS_BARS, alignMs: alignFor(source, symbol, feedId), rates: ratesFor(source, symbol, feedId, intervalMs), zoneOptions: current.zones, footprintOptions: current.footprint });
      const zones = analysis.zones.map(zone => ({
        id: zone.id, side: zone.side, low: zone.low, high: zone.high,
        strength: zone.strength, label: zone.label, distance: zone.distance, state: zone.state
      }));
      // zonesVisible travels with the payload so the desktop service can clear MT5 the moment it is
      // switched off, without a second request.
      return json(res, 200, { symbol, source, feedId, intervalMs, lastPrice: analysis.bars.length ? analysis.bars.at(-1).c : null, zones, style: current.mt5, zonesVisible: current.mt5.zonesVisible !== false, generatedAt: new Date(now()).toISOString() });
    }
    if (url.pathname === '/v1/settings' || url.pathname === '/v1/settings/reset') {
      try {
        if (req.method === 'GET' && url.pathname === '/v1/settings') return json(res, 200, await settings.get());
        if (req.method === 'PUT' && url.pathname === '/v1/settings') { const updated = await settings.update(await readJson(req)); settingsRevision += 1; return json(res, 200, updated); }
        if (req.method === 'POST' && url.pathname === '/v1/settings/reset') { const reset = await settings.reset(); settingsRevision += 1; return json(res, 200, reset); }
        return json(res, 405, { error: 'method_not_allowed' });
      } catch (error) { return json(res, error.status || 422, { error: 'invalid_settings', message: error.message }); }
    }
    if (['/v1/setups', '/v1/setups/apply', '/v1/setups/export', '/v1/setups/import', '/v1/setups/clear'].includes(url.pathname)) {
      try {
        if (req.method === 'GET' && url.pathname === '/v1/setups') return json(res, 200, await setups.list());
        if (req.method === 'GET' && url.pathname === '/v1/setups/export') {
          const id = url.searchParams.get('id'); const version = url.searchParams.get('version');
          if (!id) return json(res, 422, { error: 'invalid_setup_request', message: 'id is required' });
          return json(res, 200, await setups.exportDefinition(id, version === null ? null : Number(version)));
        }
        if (req.method === 'DELETE' && url.pathname === '/v1/setups') {
          const id = url.searchParams.get('id');
          if (!id) return json(res, 422, { error: 'invalid_setup_request', message: 'id is required' });
          const result = await setups.remove(id); settingsRevision += 1; return json(res, 200, result);
        }
        if (req.method === 'POST' && url.pathname === '/v1/setups') {
          const body = await readJson(req);
          const result = await setups.save(body?.name, body?.definition);
          return json(res, 200, result);
        }
        if (req.method === 'POST' && url.pathname === '/v1/setups/import') {
          const body = await readJson(req);
          const result = await setups.importSetup(body?.name, body?.definition);
          return json(res, 200, result);
        }
        if (req.method === 'POST' && url.pathname === '/v1/setups/clear') { const result = await setups.clearActive(); settingsRevision += 1; return json(res, 200, result); }
        if (req.method === 'POST' && url.pathname === '/v1/setups/apply') {
          const body = await readJson(req);
          if (typeof body?.id !== 'string') return json(res, 422, { error: 'invalid_setup_request', message: 'id is required' });
          const applied = await setups.apply(body.id, body.version ?? null);
          // A profile that carries zone and footprint settings switches them too: one click, one look.
          const definition = applied.activeDefinition;
          const patch = {};
          if (definition.zones) patch.zones = definition.zones;
          if (definition.footprint) patch.footprint = definition.footprint;
          const appliedSettings = Object.keys(patch).length ? await settings.update(patch) : await settings.get();
          settingsRevision += 1;
          return json(res, 200, { ...applied, settings: appliedSettings });
        }
        return json(res, 405, { error: 'method_not_allowed' });
      } catch (error) { return json(res, error.status || 422, { error: 'invalid_setup', message: error.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/v1/market/snapshot') {
      const symbol = url.searchParams.get('symbol')?.toUpperCase(); const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)));
      const selected = store.recent(symbol, limit);
      return json(res, 200, { count: selected.length, events: selected });
    }
    if (req.method === 'GET' && url.pathname === '/v1/market/analysis') {
      const symbol = (url.searchParams.get('symbol') || 'XAUUSD').toUpperCase();
      
      const source = (url.searchParams.get('source') || 'mt5').toLowerCase();
      if (!['mt5','comex'].includes(source)) return json(res,400,{error:'unsupported_market_source'});
      if (!isGoldSymbol(source, symbol)) return json(res,400,{error:'symbol_not_gold',message:'GOLD-3Po is gold-only: XAUUSD (MT5) or GC futures (COMEX).'});
      const selection = selectFeedEvents(source, symbol, url);
      if (!selection) return json(res, 400, { error: 'invalid_feed_id' });
      const { feedId, events: selected } = selection;
      const priceStep = analysisStep(url.searchParams.get('priceStep'));
      const footprintStep = footprintStepFor(source, symbol, feedId, priceStep);
      const current = await settings.get();
      // The page names the timeframe it draws, so a click on 5m is answered in 5m at once instead of
      // after the settings save; without it the saved timeframe is used.
      const askedMinutes = Number(url.searchParams.get('intervalMs')) / 60000;
      const minutes = TIMEFRAMES.includes(askedMinutes) ? askedMinutes : Number(current.zones.timeframeMinutes || 15);
      const intervalMs = minutes * 60000;
      // How much history the caller draws. The chart shows a window of it, so asking for the whole
      // archive costs a rebuild over every tick and a JSON of thousands of bars for a view of a few
      // hundred. The default stays generous for other callers.
      const limit = Math.min(20000, Math.max(20, Number(url.searchParams.get('limit') || ANALYSIS_BARS)));
      // The newest tick is the one the rest of the page prints. Scanning the tail keeps this O(1) on
      // a 100k-event buffer instead of timestamping every event on every request.
      const tail = selected.slice(-200);
      const lastQuote = tail.reduce((latest, event) =>
        !latest || Date.parse(event.timestamp) > Date.parse(latest.timestamp) ? event : latest, null);
      const feed = health().feeds.find(f => f.source === source && f.symbol === symbol && (f.feedId || null) === feedId) || null;
      const feedPrices = source === 'mt5'
        ? [...feedQuoteIndex(source, symbol).values()]
            .sort((a, b) => b.timeMs - a.timeMs)
            .map(item => ({ feedId: item.feedId, price: item.price, timestamp: item.timestamp, ageMs: Math.max(0, now() - item.timeMs), active: (item.feedId || null) === (feedId || null) }))
        : [];
      const alignMs = alignFor(source, symbol, feedId);
      const candles = ratesFor(source, symbol, feedId, intervalMs);
      const analysis = store.analysis(source, symbol, feedId,
        { intervalMs, priceStep, footprintStep, limit, alignMs, rates: candles, fresh: url.searchParams.get('fresh') === '1', zoneOptions: current.zones, footprintOptions: current.footprint });
      return json(res, 200, {
        symbol, source, feedId, intervalMs, timeframeMinutes: intervalMs / 60000,
        ...analysis,
        clockOffsetMs: alignMs,
        candleSource: candles ? 'mt5_m1_rates' : 'ticks',
        candleRange: rates.range(feedSequenceKey(source, symbol, feedId)),
        bars: withLevelsFrom(analysis.bars, Number(url.searchParams.get('levelsFrom'))),
        lastQuote: lastQuote && source === 'mt5' ? { sequence: lastQuote.sequence, bid: lastQuote.bid, ask: lastQuote.ask, last: lastQuote.last, timestamp: lastQuote.timestamp, receivedAt: lastQuote.receivedAt } : null,
        feed,
        // No live feed for this account: the chart is drawn from stored ticks. Say when they end, so
        // the client can label the strip as an archive instead of presenting an old price as live.
        archive: feed ? null : (lastQuote ? { lastTickAt: lastQuote.timestamp, count: selected.length } : null),
        // The feed the terminal is streaming right now, whatever this request asked for, so a client
        // pinned to a silent account can follow the live one instead of showing a stale level.
        liveFeedId: source === 'mt5' ? newestFeed(source, symbol) ?? null : null,
        feedPrices,
        priceConflict: priceConflictOf(feedPrices)
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/market/signals') {
      const symbol = (url.searchParams.get('symbol') || 'XAUUSD').toUpperCase();
      const source = (url.searchParams.get('source') || 'mt5').toLowerCase();
      if (!['mt5','comex'].includes(source)) return json(res,400,{error:'unsupported_market_source'});
      if (!isGoldSymbol(source, symbol)) return json(res,400,{error:'symbol_not_gold',message:'GOLD-3Po is gold-only: XAUUSD (MT5) or GC futures (COMEX).'});
      const askedMinutes = Number(url.searchParams.get('intervalMs')) / 60000;
      const current = await settings.get();
      const intervalMs = (TIMEFRAMES.includes(askedMinutes) ? askedMinutes : Number(current.zones.timeframeMinutes || 15)) * 60000;
      const selection = selectFeedEvents(source, symbol, url);
      if (!selection) return json(res, 400, { error: 'invalid_feed_id' });
      const { feedId } = selection;
      const active = await setups.activeDefinition();
      // The same incremental window the chart draws, so a signal marker sits on the candle on screen.
      const analysis = store.analysis(source, symbol, feedId,
        { intervalMs, priceStep: 0.1, footprintStep: footprintStepFor(source, symbol, feedId, 0.1), limit: ANALYSIS_BARS, alignMs: alignFor(source, symbol, feedId), rates: ratesFor(source, symbol, feedId, intervalMs), zoneOptions: current.zones, footprintOptions: current.footprint });
      let signals;
      try { signals = generateSignals(analysis.bars, active.strategy); }
      catch (error) { return json(res, 422, { error: 'invalid_strategy', message: error.message }); }
      // Ids by candle time, not by index: the window slides, and an index would rename every signal.
      const list = signals.slice(-50).map(signal => {
        const timeMs = analysis.bars[signal.index]?.timeMs ?? Date.parse(signal.time);
        return { ...signal, id: `SIG-${timeMs}-${signal.side}-${signal.level}`, timeMs, closed: signal.index < analysis.bars.length - 1 };
      });
      const library = await setups.list();
      const profile = library.setups.find(item => item.id === library.activeId);
      return json(res, 200, { symbol, source, feedId, intervalMs, strategy: profile ? { id: profile.id, name: profile.name, version: library.activeVersion } : null, signals: list, latest: list.at(-1) || null,
        caveat: 'Оценка — сумма весов выполненных условий стратегии, а не вероятность. Это не торговая рекомендация.' });
    }
    if (req.method === 'GET' && url.pathname === '/v1/comex') {
      if (!comex) return json(res, 200, { enabled: false, status: 'disabled' });
      const symbol = (url.searchParams.get('symbol') || 'XAUUSD').toUpperCase();
      if (!isGoldSymbol('mt5', symbol)) return json(res, 400, { error: 'symbol_not_gold' });
      const feedId = newestFeed('mt5', symbol) ?? null;
      return json(res, 200, comex.summary({ spotAt: ms => store.priceAt('mt5', symbol, feedId, ms) }));
    }
    if (req.method === 'GET' && url.pathname === '/v1/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write('event: ready\ndata: {"status":"connected"}\n\n'); clients.add(res);
      // A frame every 5 s even in a quiet market: the page tells a stalled stream from a quiet one by it.
      const beat = setInterval(() => { try { res.write('event: ping\ndata: {}\n\n'); } catch {} }, streamPingMs);
      beat.unref?.();
      res.on('close', () => { clearInterval(beat); clients.delete(res); }); return;
    }
    if (req.method === 'POST' && (url.pathname === '/v1/ingest/mt5/rates' || url.pathname === '/v1/ingest/mt5/coverage')) {
      if (!token) return json(res, 503, { error: 'ingest_not_configured' });
      if (!tokenMatches(req.headers.authorization, token)) return json(res, 401, { error: 'unauthorized' });
      try {
        const body = await readJson(req);
        const symbol = typeof body?.symbol === 'string' ? body.symbol.trim().toUpperCase() : '';
        if (body?.source !== 'mt5' || !isGoldSymbol('mt5', symbol)) return json(res, 422, { error: 'invalid_symbol', message: 'Expected a supported gold symbol.' });
        const feedId = body.feedId ?? null;
        if (feedId !== null && (typeof feedId !== 'string' || !/^[a-f0-9]{32}$/i.test(feedId))) return json(res, 422, { error: 'invalid_feed_id' });
        const key = feedSequenceKey('mt5', symbol, feedId);
        if (url.pathname.endsWith('/coverage')) {
          if (!Array.isArray(body.windows) || body.windows.length > 2000) return json(res, 422, { error: 'invalid_coverage_request', message: 'Expected up to 2000 windows.' });
          const known = rates.range(key);
          const covered = body.windows.map(w => {
            const fromMs = Number(w?.fromMs), toMs = Number(w?.toMs);
            if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return false;
            // The broker's minutes decide only where they are known for the whole window.
            const minutes = known && fromMs >= known.first && toMs <= known.last + 3 * 60_000 ? rates.tradedMinutes(key, fromMs, toMs) : null;
            return store.covers('mt5', symbol, feedId, fromMs, toMs, minutes);
          });
          return json(res, 200, { covered });
        }
        if (!Array.isArray(body.rates) || body.rates.length > 5000) return json(res, 422, { error: 'invalid_rates_batch', message: 'Expected up to 5000 M1 candles.' });
        const offset = Number(body.clockOffsetMs);
        if (Number.isSafeInteger(offset) && Math.abs(offset) <= 14 * 3600000 && (body.clockOffsetReliable === true || !feedMeta.has(key))) {
          if (feedMeta.get(key)?.clockOffsetMs !== offset) { feedMeta.set(key, { clockOffsetMs: offset }); store.dropCaches('mt5', symbol, feedId); await persistMeta(); }
        }
        const result = rates.add(key, body.rates);
        // A bulk load (connect, a deeper archive) redraws the page; the periodic refresh of the newest
        // minutes is picked up by the page's own reload.
        if (result.accepted > 60) broadcast('candles', { source: 'mt5', symbol, feedId, accepted: result.accepted });
        return json(res, 202, result);
      } catch (error) { return json(res, error.status || 422, { error: 'invalid_rates_batch', message: error.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/v1/ingest/mt5/live-batch') {
      if (!token) return json(res, 503, { error: 'ingest_not_configured' });
      if (!tokenMatches(req.headers.authorization, token)) return json(res, 401, { error: 'unauthorized' });
      try {
        const body = await readJson(req);
        if (body?.source !== 'mt5' || !Array.isArray(body.ticks) || body.ticks.length < 1 || body.ticks.length > 1000 || typeof body.symbol !== 'string') return json(res, 422, { error:'invalid_live_batch', message:'Expected 1..1000 MT5 ticks and a symbol.' });
        const symbol = body.symbol.trim().toUpperCase();
        const scope = feedScopeKey('mt5', symbol);
        const feedId = body.feedId ?? feedIdFromAccount(body, symbol);
        if (feedId !== null && (typeof feedId !== 'string' || !/^[a-f0-9]{32}$/i.test(feedId))) return json(res, 422, { error: 'invalid_feed_id' });
        const key = feedSequenceKey('mt5', symbol, feedId);
        if (feedId) activeFeeds.set(scope, { feedId, receivedAt: now() });
        rememberSpec('mt5', symbol, feedId, body.spec);
        let sequenceCursor = lastSequence.get(key) || 0;
        let duplicates = 0;
        const additions = [];
        for (const raw of body.ticks) {
          const event = normalizeMt5({ ...raw, source:'mt5', symbol, feedId });
          const eventId = event.eventId || eventFingerprint(event);
          const legacyId = eventFingerprint(event);
          if (seenEventIds.has(dedupeKey(event, eventId)) || seenEventIds.has(dedupeKey(event, legacyId))) { duplicates++; continue; }
          if (event.sequence <= sequenceCursor) return json(res, 409, { error:'sequence_not_increasing', lastAcceptedSequence:sequenceCursor });
          sequenceCursor = event.sequence;
          additions.push({ ...event, eventId, receivedAt:new Date(now()).toISOString() });
        }
        await persistMany(additions);
        for (const stored of additions) {
          seenEventIds.add(dedupeKey(stored, stored.eventId));
          seenEventIds.add(dedupeKey(stored, eventFingerprint(stored)));
        }
        storeEvents(additions);
        if (additions.length) {
          const existing = feeds.get(key), newest = additions.at(-1);
          feeds.set(key,{source:'mt5',symbol:newest.symbol,feedId:newest.feedId,lastSequence:newest.sequence,receivedAt:Date.parse(newest.receivedAt),accepted:(existing?.accepted||0)+additions.length});
          // A normal poll carries a handful of ticks and each one moves the live candle. A resend of a
          // queue built up during an outage would be thousands of frames: the page gets the newest tick
          // and one notice to reload the window instead.
          const streamed = additions.length > LIVE_FRAMES_PER_BATCH ? [newest] : additions;
          if (streamed.length < additions.length) broadcast('history', { source: 'mt5', symbol, feedId, accepted: additions.length, live: true });
          for (const stored of streamed) broadcast('market', stored);
        }
        if (additions.length) lastSequence.set(key, sequenceCursor);
        return json(res, 202, { accepted:additions.length, duplicates, total:body.ticks.length, lastAcceptedSequence:lastSequence.get(key)||0 });
      } catch(error) { return json(res,error.status||422,{error:'invalid_live_batch',message:error.message}); }
    }
    if (req.method === 'POST' && url.pathname === '/v1/ingest/mt5/spec/reset') {
      if (!token) return json(res, 503, { error: 'ingest_not_configured' });
      if (!tokenMatches(req.headers.authorization, token)) return json(res, 401, { error: 'unauthorized' });
      try {
        const body = await readJson(req);
        if (body?.source !== 'mt5' || typeof body.symbol !== 'string' || !isGoldSymbol('mt5', body.symbol.trim().toUpperCase())) {
          return json(res, 422, { error: 'invalid_symbol', message: 'Expected a supported gold symbol.' });
        }
        const feedId = body.feedId ?? null;
        if (feedId !== null && (typeof feedId !== 'string' || !/^[a-f0-9]{32}$/i.test(feedId))) return json(res, 422, { error: 'invalid_feed_id' });
        symbolSpecs.delete(feedSequenceKey('mt5', body.symbol.trim().toUpperCase(), feedId));
        return json(res, 200, { reset: true, symbol: body.symbol.trim().toUpperCase(), feedId });
      } catch (error) { return json(res, 400, { error: 'invalid_request', message: error.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/v1/ingest/mt5/history') {
      if (!token) return json(res, 503, { error: 'ingest_not_configured' });
      if (!tokenMatches(req.headers.authorization, token)) return json(res, 401, { error: 'unauthorized' });
      try {
        const body = await readJson(req);
        if (body?.source !== 'mt5' || !Array.isArray(body.ticks) || body.ticks.length < 1 || body.ticks.length > 1000 || typeof body.symbol !== 'string') return json(res, 422, { error: 'invalid_history_batch', message: 'Expected 1..1000 MT5 ticks and a symbol.' });
        const symbol = body.symbol.trim().toUpperCase();
        const scope = feedScopeKey('mt5', symbol);
        const feedId = body.feedId ?? feedIdFromAccount(body, symbol);
        if (feedId !== null && (typeof feedId !== 'string' || !/^[a-f0-9]{32}$/i.test(feedId))) return json(res, 422, { error: 'invalid_feed_id' });
        if (feedId) activeFeeds.set(scope, { feedId, receivedAt: now() });
        rememberSpec('mt5', symbol, feedId, body.spec);
        let accepted = 0; let duplicates = 0; let rejected = 0;
        const additions = [];
        for (const raw of body.ticks) {
          try {
            const event = normalizeMt5({ ...raw, source:'mt5', symbol, feedId });
            const eventId = event.eventId || eventFingerprint(event);
            const legacyId = eventFingerprint(event);
            if (seenEventIds.has(dedupeKey(event, eventId)) || seenEventIds.has(dedupeKey(event, legacyId))) { duplicates++; continue; }
            const stored = { ...event, eventId, receivedAt:new Date(now()).toISOString(), historical:true };
            additions.push(stored);
          } catch { rejected++; }
        }
        await persistMany(additions);
        for (const stored of additions) {
          seenEventIds.add(dedupeKey(stored, stored.eventId));
          seenEventIds.add(dedupeKey(stored, eventFingerprint(stored)));
          accepted++;
        }
        storeEvents(additions);
        // History is a window loaded beside the live feed: one notice per batch, never a frame per tick.
        if (additions.length) broadcast('history', { source: 'mt5', symbol, feedId, accepted: additions.length, from: additions[0].timestamp, to: additions.at(-1).timestamp });
        return json(res,202,{accepted,duplicates,rejected,total:body.ticks.length});
      } catch(error) { return json(res,error.status||400,{error:'invalid_request',message:error.message}); }
    }
    const routes = { '/v1/ingest/mt5/tick': normalizeMt5, '/v1/ingest/comex/trade': normalizeComex };
    const normalize = routes[url.pathname];
    if (req.method !== 'POST' || !normalize) return json(res, 404, { error: 'not_found' });
    if (!token) return json(res, 503, { error: 'ingest_not_configured', message: 'Set MARKET_INGEST_TOKEN before accepting market events.' });
    if (!tokenMatches(req.headers.authorization, token)) return json(res, 401, { error: 'unauthorized' });
    try {
      const body = await readJson(req);
      if (url.pathname === '/v1/ingest/mt5/tick' && body.feedId === undefined) {
        body.feedId = feedIdFromAccount(body, String(body.symbol || '').trim().toUpperCase());
      }
      const event = normalize(body);
      if (event.source === 'mt5') rememberSpec('mt5', event.symbol, event.feedId, body.spec);
      const eventId = event.eventId || eventFingerprint(event);
      const legacyId = eventFingerprint(event);
      if (seenEventIds.has(dedupeKey(event, eventId)) || seenEventIds.has(dedupeKey(event, legacyId))) return json(res, 409, { error: 'duplicate_event', eventId });
      const key = feedSequenceKey(event.source, event.symbol, event.feedId);
      const previous = lastSequence.get(key) || 0;
      if (event.sequence <= previous) return json(res, 409, { error: 'sequence_not_increasing', lastAcceptedSequence: previous });
      const receivedAt = now();
      const stored = { ...event, eventId, receivedAt: new Date(receivedAt).toISOString() };
      await persist(stored);
      seenEventIds.add(dedupeKey(event, eventId));
      seenEventIds.add(dedupeKey(event, legacyId));
      lastSequence.set(key, event.sequence);
      storeEvents([stored]);
      const existing = feeds.get(key);
      feeds.set(key, { source:event.source, symbol:event.symbol, feedId:event.feedId || null, lastSequence:event.sequence, receivedAt, accepted:(existing?.accepted||0)+1 });
      if (event.source === 'mt5' && event.feedId) activeFeeds.set(feedScopeKey(event.source, event.symbol), { feedId:event.feedId, receivedAt });
      broadcast('market', stored);
      return json(res, 202, { accepted: true, event: stored });
    } catch (error) { return json(res, error.status || 400, { error: error.status === 422 ? 'invalid_event' : 'invalid_request', message: error.message }); }
   } catch (error) {
    if (!res.headersSent) json(res, 500, { error: 'internal_error', message: error instanceof Error ? error.message : String(error) });
    else res.end();
   }
  });
  return { server, health };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.MARKET_INGEST_TOKEN) { process.stderr.write('MARKET_INGEST_TOKEN is required. Copy .env.example and set a long random token.\n'); process.exit(1); }
  const { server } = createMarketServer(); const port = Number(process.env.PORT || 8787); const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => process.stdout.write('GOLD-3Po Market Data API listening on http://' + host + ':' + server.address().port + '\n'));
  const stop = () => server.close(() => process.exit(0)); process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
