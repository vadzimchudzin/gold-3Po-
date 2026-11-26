import test from 'node:test';
import assert from 'node:assert/strict';
import { createComexFeed, parseChart, sessionStart, volumeProfile } from './comex-feed.js';

const T = Date.parse('2026-11-25T15:00:00.000Z');
const body = {
  chart: { result: [{
    meta: { shortName: 'Gold Dec 26', fullExchangeName: 'COMEX', regularMarketPrice: 3610.4, regularMarketTime: T / 1000 + 120, chartPreviousClose: 3600 },
    timestamp: [T / 1000, T / 1000 + 60, T / 1000 + 120],
    indicators: { quote: [{ open: [3609, 3609.5, null], high: [3610, 3610.2, null], low: [3608.8, 3609.4, null], close: [3609.5, 3610.1, null], volume: [120, 40, null] }] }
  }] }
};

test('the GC chart is parsed and empty minutes are skipped', () => {
  const data = parseChart(body);
  assert.equal(data.contract, 'Gold Dec 26');
  assert.equal(data.bars.length, 2);
  assert.equal(data.price, 3610.4);
  assert.throws(() => parseChart({ chart: { result: null, error: { description: 'No data' } } }), /No data/);
});

test('the COMEX session starts at 18:00 New York time, winter and summer', () => {
  assert.equal(new Date(sessionStart(Date.parse('2026-11-25T15:00:00Z'))).toISOString(), '2026-11-24T23:00:00.000Z');
  assert.equal(new Date(sessionStart(Date.parse('2026-11-25T23:30:00Z'))).toISOString(), '2026-11-25T23:00:00.000Z');
  assert.equal(new Date(sessionStart(Date.parse('2026-07-15T12:00:00Z'))).toISOString(), '2026-07-14T22:00:00.000Z');
});

test('the volume profile finds the POC and a 70% value area', () => {
  const profile = volumeProfile([{ l: 100, h: 100, v: 50 }, { l: 100.1, h: 100.1, v: 20 }, { l: 99.9, h: 99.9, v: 20 }, { l: 101, h: 101, v: 10 }]);
  assert.equal(profile.poc, 100);
  assert.ok(profile.val <= 100 && profile.vah >= 100);
  assert.equal(profile.volume, 100);
  assert.equal(volumeProfile([]), null);
});

test('the summary converts COMEX levels to spot prices through the basis measured at the GC bar time', async () => {
  let fetched = 0;
  const feed = createComexFeed({ now: () => T + 10 * 60_000, fetchImpl: async () => { fetched += 1; return { ok: true, json: async () => body }; } });
  assert.equal(feed.summary().status, 'loading');
  await feed.load();
  const summary = feed.summary({ spotAt: () => 3602.1 });
  feed.stop();
  assert.equal(summary.basis, 8, 'GC 3610.1 against spot 3602.1 at the same minute');
  const poc = summary.levels.find(level => level.key === 'poc');
  assert.equal(poc.spotPrice, Number((poc.price - 8).toFixed(2)));
  assert.equal(summary.sessionVolume, 160);
  assert.equal(summary.status, 'delayed');
  assert.ok(fetched >= 1);
  const offline = createComexFeed({ enabled: false });
  assert.equal(offline.summary().status, 'disabled');
});

test('a failed read is reported, not thrown', async () => {
  const feed = createComexFeed({ fetchImpl: async () => { throw new Error('offline'); } });
  await feed.load();
  const summary = feed.summary();
  feed.stop();
  assert.equal(summary.status, 'error');
  assert.equal(summary.error, 'offline');
});
