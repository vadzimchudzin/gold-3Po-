import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createMarketServer } from './server.js';
import { createLicenseManager, issueLicenseKey } from './license.js';
import { createSetupStore } from './setup-store.js';
import { createSettingsStore } from './settings-store.js';

// The live window: once the tick buffer is full the chart must keep following the market. The old
// incremental bar cache measured "new ticks" by the buffer length, which stops growing at the cap, so
// every tick after that was silently ignored and the app showed an archive while MT5 kept quoting.

function testLicense() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const machineId = 'AAAA-BBBB-CCCC-DDDD';
  const key = issueLicenseKey({ privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), machineId, days: 30, nowMs: Date.now() });
  return createLicenseManager({ publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), machineId, now: () => Date.now(), licenseFile: null, stateFile: null, initialKey: key });
}

async function startServer(options = {}) {
  const app = createMarketServer({
    token: 'test-secret', staleAfterMs: 10000, storageFile: null, license: testLicense(),
    setupStore: createSetupStore({ file: null }), settingsStore: createSettingsStore({ file: null }),
    comexFeed: null, ...options
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: 'http://127.0.0.1:' + app.server.address().port, close: () => new Promise(resolve => app.server.close(resolve)) };
}

const auth = { authorization: 'Bearer test-secret', 'content-type': 'application/json' };
const FEED = 'a'.repeat(32);
const T0 = Date.parse('2026-11-17T15:00:00.000Z');
const tick = (n, price) => ({ timestamp: new Date(T0 + n * 20_000).toISOString(), sequence: n + 1, bid: price, ask: price + 0.2, last: price, tickVolume: 1, realVolume: 0, flags: 2, eventId: 'T-' + n });

async function send(base, route, ticks) {
  const response = await fetch(base + '/v1/ingest/mt5/' + route, { method: 'POST', headers: auth, body: JSON.stringify({ source: 'mt5', symbol: 'XAUUSD', feedId: FEED, ticks }) });
  assert.equal(response.status, 202, await response.text());
}
const analysis = async (base, extra = '') => (await fetch(base + `/v1/market/analysis?symbol=XAUUSD&feedId=${FEED}&limit=200${extra}`)).json();

test('a full tick buffer keeps moving the chart with every new live tick', async () => {
  const { base, close } = await startServer({ maxEvents: 30 });
  try {
    const ticks = Array.from({ length: 30 }, (_, n) => tick(n, 2600 + n * 0.1));
    await send(base, 'live-batch', ticks);
    const before = await analysis(base);
    assert.equal(before.bars.at(-1).c, 2602.9);
    // The buffer is at its cap: every further tick pushes an old one out.
    for (let n = 30; n < 40; n++) await send(base, 'live-batch', [tick(n, 2700 + n)]);
    const after = await analysis(base);
    assert.equal(after.lastQuote.last, 2739);
    assert.equal(after.bars.at(-1).c, 2739, 'the forming candle follows the newest tick, not the archive');
    assert.equal(after.bars.at(-1).h, 2739);
  } finally { await close(); }
});

test('history that arrives after live ticks is merged in time order, never appended after them', async () => {
  const { base, close } = await startServer();
  try {
    await send(base, 'live-batch', [tick(100, 2650), tick(101, 2651)]);
    await analysis(base);
    // A backfill window older than the live ticks arrives later (history is loaded beside the live feed).
    await send(base, 'history', Array.from({ length: 50 }, (_, n) => ({ ...tick(n, 2600 + n), sequence: 1 })));
    const result = await analysis(base);
    const times = result.bars.map(bar => Date.parse(bar.time));
    assert.deepEqual(times, [...times].sort((a, b) => a - b), 'bars are in time order');
    assert.equal(result.bars.at(-1).c, 2651, 'the last candle is still the live one');
    assert.equal(result.bars[0].o, 2600, 'the oldest candle opens at the oldest tick');
  } finally { await close(); }
});

test('history batches reach the page as one notice, not one stream frame per tick', async () => {
  const { base, close } = await startServer();
  const controller = new AbortController();
  try {
    const stream = await fetch(base + '/v1/stream', { signal: controller.signal });
    const reader = stream.body.getReader();
    let text = '';
    const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); } } catch {} })();
    await send(base, 'history', Array.from({ length: 200 }, (_, n) => ({ ...tick(n, 2600), sequence: 1 })));
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal((text.match(/event: market\n/g) || []).length, 0, 'no per-tick frames for history');
    assert.equal((text.match(/event: history\n/g) || []).length, 1, 'one history notice');
    controller.abort();
    await pump;
  } finally { controller.abort(); await close(); }
});

test('price ladders are sent only for the candles the footprint shows', async () => {
  const { base, close } = await startServer();
  try {
    await send(base, 'live-batch', Array.from({ length: 120 }, (_, n) => tick(n, 2600 + (n % 7))));
    const full = await analysis(base, '&intervalMs=300000');
    const from = full.bars.at(-3).timeMs;
    const light = await analysis(base, '&intervalMs=300000&levelsFrom=' + from);
    assert.equal(light.bars.length, full.bars.length, 'every candle is still drawn');
    assert.ok(light.bars.slice(0, -3).every(bar => bar.levels === undefined && Number.isFinite(bar.c)));
    assert.deepEqual(light.bars.slice(-3).map(bar => bar.levels), full.bars.slice(-3).map(bar => bar.levels));
  } finally { await close(); }
});

test('the timeframe can be asked for explicitly, without waiting for the settings save', async () => {
  const { base, close } = await startServer();
  try {
    await send(base, 'live-batch', Array.from({ length: 120 }, (_, n) => tick(n, 2600 + (n % 7))));
    const m5 = await analysis(base, '&intervalMs=300000');
    assert.equal(m5.intervalMs, 300000);
    const h1 = await analysis(base, '&intervalMs=3600000');
    assert.equal(h1.intervalMs, 3600000);
    assert.ok(h1.bars.length < m5.bars.length);
  } finally { await close(); }
});

const postRates = (base, rates, extra = {}) => fetch(base + '/v1/ingest/mt5/rates', { method: 'POST', headers: auth,
  body: JSON.stringify({ source: 'mt5', symbol: 'XAUUSD', feedId: FEED, rates, ...extra }) });
const minute = (t, o, h, l, c, v = 5) => ({ t, o, h, l, c, v, rv: 0 });

test('candles come from the broker M1 bars at once, with the footprint on top where ticks exist', async () => {
  const { base, close } = await startServer();
  try {
    // Three hours of broker minutes, no ticks yet: the chart is complete from the first answer.
    const start = T0 - 3 * 3600_000;
    const rates = Array.from({ length: 180 }, (_, i) => minute(start + i * 60_000, 2600 + i * 0.1, 2600.5 + i * 0.1, 2599.8 + i * 0.1, 2600.2 + i * 0.1, 7));
    const response = await postRates(base, rates, { clockOffsetMs: 0, clockOffsetReliable: true });
    assert.equal(response.status, 202);
    const onlyCandles = await analysis(base, '&intervalMs=900000');
    assert.equal(onlyCandles.candleSource, 'mt5_m1_rates');
    assert.equal(onlyCandles.bars.length, 12, 'three hours of 15m candles');
    const first = onlyCandles.bars[0];
    assert.equal(first.o, 2600);
    assert.equal(first.h, 2600.5 + 14 * 0.1, 'the high of the candle is the highest of its 15 minutes');
    assert.equal(first.c, Number((2600.2 + 14 * 0.1).toFixed(10)));
    assert.equal(first.coverage, 0, 'no ticks: the candle says its footprint is empty');
    assert.equal(first.rateVolume, 15 * 7);
    // Ticks arrive for the newest candle: it keeps MT5's open and gains a footprint.
    await send(base, 'live-batch', [tick(0, 2618.4), tick(1, 2618.9), tick(2, 2618.6)]);
    const withTicks = await analysis(base, '&intervalMs=900000');
    const live = withTicks.bars.at(-1);
    assert.equal(live.time, new Date(T0).toISOString());
    assert.equal(live.tickCount, 3);
    assert.ok(live.levels.length > 0, 'the tick candle has a price ladder');
  } finally { await close(); }
});

test('H4 candles start on the broker clock, as in MT5, not on UTC', async () => {
  const { base, close } = await startServer();
  try {
    const shift = 2 * 3600_000; // a broker on UTC+2
    const start = Date.parse('2026-11-17T00:00:00.000Z');
    const rates = Array.from({ length: 12 * 60 }, (_, i) => minute(start + i * 60_000, 2600, 2601, 2599, 2600));
    await postRates(base, rates, { clockOffsetMs: shift, clockOffsetReliable: true });
    const h4 = await analysis(base, '&intervalMs=14400000');
    assert.equal(h4.clockOffsetMs, shift);
    // Server time 00:00, 04:00, 08:00 … is UTC 22:00, 02:00, 06:00 …
    assert.deepEqual(h4.bars.map(bar => bar.time.slice(11, 16)), ['22:00', '02:00', '06:00', '10:00']);
    // A later reconnect on a closed market (unreliable shift) does not overwrite the measured one.
    await postRates(base, [minute(start + 12 * 3600_000, 2600, 2601, 2599, 2600)], { clockOffsetMs: 0, clockOffsetReliable: false });
    assert.equal((await analysis(base, '&intervalMs=14400000')).clockOffsetMs, shift);
  } finally { await close(); }
});

test('coverage tells the bridge which tick windows are already held, using the broker minutes', async () => {
  const { base, close } = await startServer();
  try {
    const start = T0;
    await postRates(base, Array.from({ length: 10 }, (_, i) => minute(start + i * 60_000, 2600, 2601, 2599, 2600, i === 5 ? 0 : 3)), { clockOffsetMs: 0, clockOffsetReliable: true });
    // Ticks every 20 s for the first ten minutes (tick(n) is T0 + n·20 s).
    await send(base, 'history', Array.from({ length: 30 }, (_, n) => ({ ...tick(n, 2600), sequence: 1 })));
    const ask = async windows => (await (await fetch(base + '/v1/ingest/mt5/coverage', { method: 'POST', headers: auth,
      body: JSON.stringify({ source: 'mt5', symbol: 'XAUUSD', feedId: FEED, windows }) })).json()).covered;
    assert.deepEqual(await ask([
      { fromMs: start, toMs: start + 10 * 60_000 },              // every traded minute has ticks
      { fromMs: start + 10 * 60_000, toMs: start + 40 * 60_000 }, // after the candles: heuristic, no ticks
      { fromMs: start - 3600_000, toMs: start }                  // before any candle, no ticks
    ]), [true, false, false]);
    const unauthorised = await fetch(base + '/v1/ingest/mt5/coverage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(unauthorised.status, 401);
  } finally { await close(); }
});

test('signals are read from the same window the chart draws', async () => {
  const { base, close } = await startServer();
  try {
    await send(base, 'live-batch', Array.from({ length: 120 }, (_, n) => tick(n, 2600 + (n % 7))));
    const signals = await (await fetch(base + `/v1/market/signals?symbol=XAUUSD&feedId=${FEED}&intervalMs=300000`)).json();
    assert.equal(signals.intervalMs, 300000);
    assert.ok(Array.isArray(signals.signals));
    for (const signal of signals.signals) assert.ok(Number.isFinite(signal.timeMs));
  } finally { await close(); }
});
