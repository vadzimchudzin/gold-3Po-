import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createMarketServer } from './server.js';
import { createLicenseManager, issueLicenseKey } from './license.js';
import { createSetupStore } from './setup-store.js';
import { createSettingsStore } from './settings-store.js';
import { createPatternStore } from './pattern-store.js';

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
    patternStore: createPatternStore({ file: null }), ...options
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
