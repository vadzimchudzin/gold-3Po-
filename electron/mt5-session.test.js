import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeSnapshot, snapshotPath, publishSnapshot, normalizeStyle } from './mt5-snapshot.js';
import { createMt5Session } from './mt5-session.js';

const commonRoot = process.platform === 'win32' ? 'C:\\Common' : '/tmp/g3p-common';

const zone = { id: 'LQ-buy-12.05', side: 'buy', low: 11.9, high: 12.2, strength: 0.69, state: 'UNTESTED' };

test('snapshot format matches the indicator contract', () => {
  const text = encodeSnapshot('XAUUSDm', [{ ...zone, label: 'Repeated swing lows · role flip' }], 1795000000000);
  const lines = text.split('\r\n');
  assert.equal(lines[0], 'G3P2,1795000000,XAUUSDm,1');
  assert.equal(lines[1], 'STYLE,#FF0000,#FF0000,SOLID,2,0,1,1', 'default: red solid lines, width 2');
  assert.equal(lines[2], 'LQ-buy-12.05,buy-side,11.9,12.2,0.69,НЕ ПРОВЕРЕНА,Повторный минимум - смена роли');
  assert.equal(lines[3], 'END');
  assert.equal(encodeSnapshot('XAUUSD', []).split('\r\n')[0], 'G3P2,' + Math.floor(Date.now() / 1000) + ',XAUUSD,0');
  const noState = encodeSnapshot('XAUUSD', [{ ...zone, state: undefined }]);
  assert.ok(noState.includes(',НАЙДЕНА,Уровень\r\n'), 'missing state and label fall back to what the panel shows');
});

test('the MT5 chart reads the same Russian labels as the panel', () => {
  const rows = encodeSnapshot('XAUUSD', [
    { ...zone, id: 'L1', label: 'Prior day high', state: 'TESTED' },
    { ...zone, id: 'L2', label: 'Asia low', state: 'SWEPT' },
    { ...zone, id: 'L3', label: 'Value area high' }
  ]).split('\r\n').slice(2, 5);
  assert.ok(rows[0].endsWith(',ПРОВЕРЕНА,Максимум прошлого дня'), 'a source label must reach MT5 translated');
  assert.ok(rows[1].endsWith(',ПРОБИТА,Минимум азиатской сессии'));
  assert.ok(rows[2].endsWith(',НЕ ПРОВЕРЕНА,Верх зоны стоимости'));
  assert.ok(!rows.some(row => /Prior day|Asia|Value area/.test(row)), 'no English label leaks onto the MT5 chart');
});

test('snapshot carries the drawing style from the app settings', () => {
  const style = { buyColor: '#00aaff', sellColor: '#ff8800', lineStyle: 'dash', lineWidth: 4, fill: true, showLabels: false, showStrength: false };
  assert.equal(encodeSnapshot('XAUUSD', [zone], 0, style).split('\r\n')[1], 'STYLE,#00AAFF,#FF8800,DASH,1,1,0,0', 'dashed lines are width 1 in MT5');
  assert.equal(normalizeStyle({ buyColor: 'red', lineStyle: 'wavy', lineWidth: 99 }).buyColor, '#FF0000');
  assert.equal(normalizeStyle({ lineStyle: 'wavy' }).lineStyle, 'solid');
  assert.equal(normalizeStyle({ lineWidth: 99 }).lineWidth, 2);
  assert.ok(!encodeSnapshot('XAUUSD', [{ ...zone, label: 'a,b\r\nEND' }]).includes('a,b'), 'labels cannot break the CSV');
});

test('snapshot path rejects traversal and non-gold symbols', () => {
  assert.throws(() => snapshotPath(commonRoot, 'EURUSD'), /Invalid/);
  assert.throws(() => snapshotPath(commonRoot, 'XAUUSD..evil'), /Invalid/);
  assert.throws(() => snapshotPath('relative', 'XAUUSD'), /Invalid/);
  assert.ok(snapshotPath(commonRoot, 'XAUUSDm').endsWith(join('Files', 'GOLD3PO', 'XAUUSDm.csv')));
});

test('publishSnapshot writes atomically into the common files folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'g3p-snap-'));
  try {
    await publishSnapshot(dir, 'XAUUSD.', [zone]);
    const text = await readFile(join(dir, 'Files', 'GOLD3PO', 'XAUUSD..csv'), 'utf8');
    assert.ok(text.startsWith('G3P2,'));
    assert.ok(text.includes('buy-side'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function fakeWorker(responses) {
  return () => ({
    stop() {},
    async request(op, payload = {}) {
      const value = responses[op];
      if (typeof value === 'function') return value(payload);
      if (!value) throw new Error('unexpected op ' + op);
      if (op === 'connect') return {
        terminalPath: 'C:\\MT5\\terminal64.exe',
        accountLogin: '12345',
        server: 'RoboForex-Demo',
        ...value
      };
      return value;
    }
  });
}

function fakeApi({ zones = [zone], licenseValid = () => true, failFirstLive = false, zonesVisible = true } = {}) {
  const calls = [];
  let liveFailures = failFirstLive ? 1 : 0;
  const request = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (path === '/v1/license/status') return { ok: licenseValid(), status: licenseValid() ? 200 : 402, json: async () => ({ valid: licenseValid() }) };
    if (path === '/v1/chart/zones') return { ok: true, status: 200, json: async () => ({ zones, zonesVisible, style: { buyColor: '#FF0000', sellColor: '#FF0000', lineStyle: 'solid', lineWidth: 3, fill: false, showLabels: true, showStrength: true } }) };
    if (path.startsWith('/v1/ingest/mt5/')) {
      if (path.endsWith('live-batch') && liveFailures > 0) {
        liveFailures--;
        return { ok: false, status: 409, json: async () => ({ lastAcceptedSequence: 9999999999999 }) };
      }
      return { ok: true, status: 202, json: async () => ({ accepted: 1 }) };
    }
    throw new Error('unexpected route ' + path);
  };
  return { request, calls };
}

const tick = { timestamp: new Date(Date.now() - 60000).toISOString(), bid: 2648, ask: 2648.2, last: 2648.1, tickVolume: 1, realVolume: 0, flags: 0 };

test('session connects, ingests, publishes zones and clears them on disconnect', async () => {
  const published = [];
  const api = fakeApi();
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't',
    makeWorker: fakeWorker({
      connect: { ok: true, symbol: 'XAUUSDm', commonDataPath: 'C:\\Common', dataPath: 'C:\\Data', boundary: Math.floor(Date.now() / 1000) },
      backfill: { ok: true, ticks: [tick] },
      poll: { ok: true, ticks: [tick] }
    }),
    request: api.request,
    publish: async (common, symbol, zones, style) => { published.push({ symbol, count: zones.length, width: style?.lineWidth }); }
  });
  const state = await session.connect();
  assert.equal(state.state, 'online');
  assert.equal(state.symbol, 'XAUUSDM');
  assert.match(state.feedId, /^[a-f0-9]{32}$/i, 'the account/symbol session has a stable feed identity');
  await new Promise(resolve => setTimeout(resolve, 2600));
  assert.ok(api.calls.some(c => c.path === '/v1/ingest/mt5/history'), 'history must be ingested');
  assert.ok(api.calls.some(c => c.path === '/v1/ingest/mt5/live-batch'), 'live ticks must be ingested');
  const tickBatches = api.calls.filter(c => c.path.endsWith('/history') || c.path.endsWith('/live-batch'));
  assert.ok(tickBatches.every(c => c.body.feedId === state.feedId), 'history and live data carry the same isolated feed identity');
  assert.ok(tickBatches.every(c => c.body.ticks.every(t => t.feedId === state.feedId)), 'each tick carries the feed identity too');
  assert.ok(api.calls.filter(c => c.path === '/v1/chart/zones').every(c => new URL(c.url).searchParams.get('feedId') === state.feedId), 'zones are calculated for the connected account only');
  assert.ok(published.some(p => p.symbol === 'XAUUSDM' && p.count === 1), 'zones must be published for the canonical broker symbol');
  assert.ok(published.some(p => p.count === 1 && p.width === 3), 'the drawing style from settings must reach the snapshot');
  const zoneCalls = api.calls.filter(c => c.path === '/v1/chart/zones');
  assert.ok(zoneCalls.length && zoneCalls.every(c => !/intervalMs/.test(c.url)), 'timeframe comes from settings, not a hard-coded 15m');
  const offline = await session.disconnect();
  assert.equal(offline.state, 'offline');
  assert.ok(published.at(-1).count === 0, 'disconnect must clear the indicator snapshot');
});

test('the broker tick size from MT5 travels with every tick batch', async () => {
  const cases = [
    [{ spec: { tickSize: 0.01, digits: 2 } }, { tickSize: 0.01 }, { tickSize: 0.01 }],
    // Without a usable tick size every batch says so explicitly (null), so the server drops an old broker's grid.
    [{ specUnavailable: 'symbol_info_failed' }, null, { tickSize: null, tickSizeIssue: 'symbol_info_failed' }],
    [{}, null, { tickSize: null, tickSizeIssue: 'not_reported' }],
    [{ spec: { tickSize: 0 } }, null, { tickSize: null, tickSizeIssue: 'not_reported' }]
  ];
  for (const [reported, expected, status] of cases) {
    const api = fakeApi();
    const session = createMt5Session({
      workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't',
      makeWorker: fakeWorker({
        connect: { ok: true, symbol: 'XAUUSDm', commonDataPath: 'C:\\Common', dataPath: 'C:\\Data', ...reported },
        history: { ok: true, ticks: [tick] },
        poll: { ok: true, ticks: [tick] }
      }),
      request: api.request,
      publish: async () => {}
    });
    const online = await session.connect();
    for (const [key, value] of Object.entries(status)) assert.equal(online[key], value, key + ' in the status for ' + JSON.stringify(reported));
    await new Promise(resolve => setTimeout(resolve, 300));
    await session.disconnect();
    const batches = api.calls.filter(call => call.path.endsWith('/history') || call.path.endsWith('/live-batch'));
    assert.ok(batches.length >= 1, 'ticks must be sent');
    for (const batch of batches) assert.deepEqual(batch.body.spec, expected, 'spec sent with ' + JSON.stringify(reported));
  }
});

test('session recovers from a live sequence collision', async () => {
  const api = fakeApi({ failFirstLive: true });
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't',
    makeWorker: fakeWorker({
      connect: { ok: true, symbol: 'XAUUSD', commonDataPath: 'C:\\Common', dataPath: 'C:\\Data' },
      history: { ok: true, ticks: [] },
      poll: { ok: true, ticks: [tick] }
    }),
    request: api.request,
    publish: async () => {}
  });
  await session.connect();
  await new Promise(resolve => setTimeout(resolve, 2600));
  const liveCalls = api.calls.filter(c => c.path === '/v1/ingest/mt5/live-batch');
  assert.ok(liveCalls.length >= 2, 'a 409 must trigger a resequenced resend');
  assert.ok(liveCalls.at(-1).body.ticks[0].sequence > 9999999999999, 'resent ticks must be resequenced above the server cursor');
  assert.equal(session.state().state, 'online');
  await session.disconnect();
});

test('a transient live ingest failure is retried without losing the tick or disconnecting MT5', async () => {
  const api = fakeApi();
  let failed = false;
  const request = async (url, init = {}) => {
    if (new URL(url).pathname.endsWith('/live-batch') && !failed) {
      failed = true;
      return { ok: false, status: 503, json: async () => ({}) };
    }
    return api.request(url, init);
  };
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't',
    makeWorker: fakeWorker({
      connect: { ok: true, symbol: 'XAUUSD', commonDataPath: 'C:\\Common', dataPath: 'C:\\Data' },
      history: { ok: true, ticks: [] },
      poll: { ok: true, ticks: [tick] }
    }),
    request, publish: async () => {}, pollMs: 100, maxBackoffMs: 400
  });
  const connected = await session.connect({ terminalPath: 'C:\\MT5\\terminal64.exe', login: '1', password: 'p', server: 'S', symbol: 'XAUUSD' });
  assert.equal(connected.state, 'online');
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(session.state().state, 'online');
  assert.equal(failed, true);
  assert.ok(api.calls.some(call => call.path.endsWith('/live-batch')), 'the queued tick must eventually be resent');
  await session.disconnect();
});

test('session disconnects when the licence becomes invalid', async () => {
  let valid = true;
  const api = fakeApi({ licenseValid: () => valid });
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't',
    makeWorker: fakeWorker({
      connect: { ok: true, symbol: 'XAUUSD', commonDataPath: 'C:\\Common', dataPath: 'C:\\Data' },
      history: { ok: true, ticks: [] },
      poll: { ok: true, ticks: [] }
    }),
    request: api.request,
    publish: async () => {}
  });
  await session.connect();
  await new Promise(resolve => setTimeout(resolve, 2200));
  valid = false;
  await new Promise(resolve => setTimeout(resolve, 3400));
  const state = session.state();
  assert.equal(state.state, 'offline');
  assert.match(state.message, /лиценз/i);
});

test('history loads in bounded windows beside the live feed, newest first, and never holds it up', async () => {
  const api = fakeApi();
  const boundary = Math.floor(Date.now() / 1000);
  const asked = [];
  let polls = 0;
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't', pollMs: 20, historyHours: 2, backfillWindowSec: 1800,
    makeWorker: fakeWorker({
      connect: { ok: true, symbol: 'XAUUSD', commonDataPath: 'C:\\Common', dataPath: 'C:\\Data', boundary },
      backfill: ({ from, to }) => { asked.push({ from, to, afterPolls: polls }); return { ok: true, ticks: [tick] }; },
      poll: () => { polls += 1; return { ok: true, ticks: [tick] }; }
    }),
    request: api.request,
    publish: async () => {}
  });
  await session.connect();
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.ok(asked.length >= 4, 'every window of the history is read');
  assert.ok(asked[0].afterPolls >= 1, 'the first live poll runs before any history');
  assert.ok(asked.every((w, i) => i === 0 || w.to <= asked[i - 1].to), 'newest window first');
  assert.ok(asked.every(w => w.to - w.from <= 1800), 'each read is one bounded window');
  assert.ok(asked.every((w, i) => i === 0 || w.afterPolls > asked[i - 1].afterPolls), 'one window per live poll, never a burst');
  const firstLive = api.calls.findIndex(c => c.path === '/v1/ingest/mt5/live-batch');
  const firstHistory = api.calls.findIndex(c => c.path === '/v1/ingest/mt5/history');
  assert.ok(firstLive >= 0 && firstLive < firstHistory, 'live ticks reach the chart before the archive');
  assert.match(session.state().message, /Поток живой/);
  await session.disconnect();
});

test('a history window MT5 cannot read is skipped after retries and reported, while live keeps flowing', async () => {
  const api = fakeApi();
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't', pollMs: 20, historyHours: 1, backfillWindowSec: 3600,
    makeWorker: fakeWorker({
      connect: { ok: true, symbol: 'XAUUSD', commonDataPath: 'C:\\Common', dataPath: 'C:\\Data', boundary: Math.floor(Date.now() / 1000) },
      backfill: () => { throw new Error('MT5 could not read broker ticks for the history window.'); },
      poll: { ok: true, ticks: [tick] }
    }),
    request: api.request,
    publish: async () => {}
  });
  await session.connect();
  await new Promise(resolve => setTimeout(resolve, 500));
  const state = session.state();
  assert.equal(state.state, 'online', 'a broken history window never takes the session down');
  assert.match(state.message, /пропущено окон/);
  assert.doesNotMatch(state.message, /M15|M30|H1/, 'the status line must not hard-code a timeframe the settings can change');
  await session.disconnect();
});

test('refresh polls the live feed at once and reopens a closed bridge', async () => {
  const api = fakeApi();
  let polls = 0, connects = 0;
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't', pollMs: 60_000, historyHours: 0,
    makeWorker: fakeWorker({
      connect: () => { connects += 1; return { ok: true, symbol: 'XAUUSD', commonDataPath: 'C:\\Common', dataPath: 'C:\\Data', terminalPath: 'C:\\MT5\\terminal64.exe', accountLogin: '1', server: 'S' }; },
      poll: () => { polls += 1; return { ok: true, ticks: [tick] }; }
    }),
    request: api.request,
    publish: async () => {}
  });
  await session.connect();
  await new Promise(resolve => setTimeout(resolve, 50));
  const before = polls;
  await session.refresh();
  assert.equal(polls, before + 1, 'the refresh button reads MT5 now, not after the poll interval');
  await session.disconnect();
  const reopened = await session.refresh();
  assert.equal(connects, 2, 'a closed bridge is reopened by refresh');
  assert.equal(reopened.state, 'online');
  await session.disconnect();
});

test('connect attaches to the authenticated terminal without account credentials', async () => {
  let started = false;
  let connectPayload;
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't',
    makeWorker: () => {
      started = true;
      return {
        stop() {},
        async request(op, payload) {
          if (op === 'connect') {
            connectPayload = payload;
            return { ok: true, symbol: 'XAUUSD', terminalPath: 'C:\\MT5\\terminal64.exe',
              accountLogin: '12345', server: 'RoboForex-Demo', commonDataPath: 'C:\\Common',
              dataPath: 'C:\\Data', specUnavailable: 'not_reported' };
          }
          if (op === 'history') return { ok: true, ticks: [] };
          if (op === 'poll') return { ok: true, ticks: [] };
          throw new Error('unexpected op ' + op);
        }
      };
    },
    request: async () => ({ ok: true, status: 200, json: async () => ({ valid: true }) }),
    publish: async () => {}
  });
  const state = await session.connect();
  assert.equal(started, true);
  assert.deepEqual(connectPayload, {}, 'no login, password, server or account selector is sent to the connector');
  assert.equal(state.state, 'online');
  assert.equal(state.accountLabel, 'Счёт ···2345 · RoboForex-Demo');
  await session.disconnect();
});

test('a connector that is not on disk says so, and names the path', async () => {
  const session = createMt5Session({
    workerCommand: join('/definitely-missing', 'gold3po-mt5.exe'), workerArgs: [],
    apiOrigin: 'http://127.0.0.1:9', token: 't', publish: async () => {}
  });
  const state = await session.connect();
  assert.equal(state.state, 'offline');
  assert.match(state.message, /Модуль подключения MT5 не найден: .*gold3po-mt5\.exe/, 'the window must name the missing module');
  assert.match(state.message, /переустановите приложение/, 'and not send the user looking for a MetaTrader5 package to install');
  assert.doesNotMatch(state.message, /Установите официальный пакет/, 'the old message blamed the user for our packaging');
});

test('a failed poll is retried with backoff instead of ending the session', async () => {
  let failing = 2;
  const api = fakeApi();
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't', pollMs: 40, maxBackoffMs: 120, maxFailures: 5,
    makeWorker: fakeWorker({
      connect: { ok: true, symbol: 'XAUUSD', commonDataPath: 'C:\\Common', dataPath: 'C:\\Data' },
      history: { ok: true, ticks: [] },
      poll: () => { if (failing > 0) { failing--; throw new Error('Терминал MT5 отключён от брокера.'); } return { ok: true, ticks: [tick] }; }
    }),
    request: api.request,
    publish: async () => {}
  });
  await session.connect();
  await new Promise(resolve => setTimeout(resolve, 60));
  const during = session.state();
  assert.equal(during.state, 'reconnecting', 'a transient failure keeps the session and says it is retrying');
  assert.match(during.message, /Повтор 1 из 5/);
  await new Promise(resolve => setTimeout(resolve, 700));
  const after = session.state();
  assert.equal(after.state, 'online', 'the session recovers once polls succeed again');
  assert.equal(after.retries, 0);
  assert.ok(api.calls.some(c => c.path === '/v1/ingest/mt5/live-batch'), 'ticks flow again after recovery');
  await session.disconnect();
});

test('repeated poll failures end the session with the last reason', async () => {
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't', pollMs: 10, maxBackoffMs: 20, maxFailures: 3,
    makeWorker: fakeWorker({
      connect: { ok: true, symbol: 'XAUUSD', commonDataPath: 'C:\\Common', dataPath: 'C:\\Data' },
      history: { ok: true, ticks: [] },
      poll: () => { throw new Error('Терминал MT5 закрыт.'); }
    }),
    request: fakeApi().request,
    publish: async () => {}
  });
  await session.connect();
  await new Promise(resolve => setTimeout(resolve, 400));
  const state = session.state();
  assert.equal(state.state, 'offline');
  assert.match(state.message, /Терминал MT5 закрыт/);
});

test('no new ticks for a while marks the feed stale without disconnecting', async () => {
  let clock = 1_000_000;
  let first = true;
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't', pollMs: 20, staleAfterMs: 60_000, now: () => clock,
    makeWorker: fakeWorker({
      connect: { ok: true, symbol: 'XAUUSD', commonDataPath: 'C:\\Common', dataPath: 'C:\\Data' },
      history: { ok: true, ticks: [] },
      poll: () => { if (first) { first = false; return { ok: true, ticks: [tick] }; } return { ok: true, ticks: [] }; }
    }),
    request: fakeApi().request,
    publish: async () => {}
  });
  await session.connect();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(session.state().feed, 'live');
  clock += 61_000;
  await new Promise(resolve => setTimeout(resolve, 80));
  const state = session.state();
  assert.equal(state.state, 'online', 'a quiet market is not a disconnect');
  assert.equal(state.feed, 'stale');
  assert.match(state.message, /Нет новых тиков более 60 с/);
  await session.disconnect();
});

test('a connector process that has exited ends the session at once, without retries', async () => {
  let stopped = false;
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't', pollMs: 10, maxFailures: 5,
    makeWorker: () => ({
      stop() {}, stopped: () => stopped,
      async request(op) {
        if (op === 'connect') return { ok: true, symbol: 'XAUUSD', terminalPath: 'C:\\MT5\\terminal64.exe', commonDataPath: 'C:\\Common', dataPath: 'C:\\Data' };
        if (op === 'history') return { ok: true, ticks: [] };
        stopped = true;
        throw new Error('Модуль MT5 закрылся: crash');
      }
    }),
    request: fakeApi().request,
    publish: async () => {}
  });
  await session.connect();
  await new Promise(resolve => setTimeout(resolve, 60));
  const state = session.state();
  assert.equal(state.state, 'offline', 'a dead connector cannot answer a retry');
  assert.match(state.message, /Модуль MT5 закрылся/);
});

function licenceApi(answer) {
  const base = fakeApi();
  return async (url, init) => new URL(url).pathname === '/v1/license/status' ? answer() : base.request(url, init);
}

test('a licence check answering 200 with valid:false ends the session at once', async () => {
  let checks = 0;
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't', pollMs: 20, maxFailures: 5,
    makeWorker: fakeWorker({
      connect: { ok: true, symbol: 'XAUUSD', commonDataPath: 'C:\\Common', dataPath: 'C:\\Data' },
      history: { ok: true, ticks: [] },
      poll: { ok: true, ticks: [] }
    }),
    request: licenceApi(() => { checks++; return { ok: true, status: 200, json: async () => ({ valid: false }) }; }),
    publish: async () => {}
  });
  await session.connect();
  await new Promise(resolve => setTimeout(resolve, 200));
  const state = session.state();
  assert.ok(checks >= 1, 'the licence status endpoint was asked');
  assert.equal(state.state, 'offline', 'an answered invalid licence is not retried');
  assert.match(state.message, /Лицензия GOLD-3Po недействительна/);
});

test('an unreadable licence answer is a failed check, never treated as valid', async () => {
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't', pollMs: 20, maxBackoffMs: 40, maxFailures: 5,
    makeWorker: fakeWorker({
      connect: { ok: true, symbol: 'XAUUSD', commonDataPath: 'C:\\Common', dataPath: 'C:\\Data' },
      history: { ok: true, ticks: [] },
      poll: { ok: true, ticks: [] }
    }),
    request: licenceApi(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } })),
    publish: async () => {}
  });
  await session.connect();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.notEqual(session.state().state, 'online', 'an unreadable licence answer must not leave the session online');
  await new Promise(resolve => setTimeout(resolve, 600));
  const state = session.state();
  assert.equal(state.state, 'offline', 'after the retries it gives up');
  assert.match(state.message, /Не удалось проверить лицензию/);
});

test('the last retry says the next failure closes the connection', async () => {
  let failures = 4;
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't', pollMs: 10, maxBackoffMs: 20, maxFailures: 5,
    makeWorker: fakeWorker({
      connect: { ok: true, symbol: 'XAUUSD', commonDataPath: 'C:\\Common', dataPath: 'C:\\Data' },
      history: { ok: true, ticks: [] },
      poll: () => { if (failures-- > 0) throw new Error('Терминал MT5 недоступен.'); return new Promise(() => {}); }
    }),
    request: fakeApi().request,
    publish: async () => {}
  });
  await session.connect();
  await new Promise(resolve => setTimeout(resolve, 300));
  const state = session.state();
  assert.equal(state.state, 'reconnecting');
  assert.match(state.message, /Повтор 4 из 5.*последний: при новой ошибке соединение будет закрыто/);
  await session.disconnect();
});

test('live ticks the service could not take are resent after it recovers', async () => {
  let down = 2, n = 0;
  const received = [];
  const base = fakeApi();
  const request = async (url, init) => {
    if (new URL(url).pathname === '/v1/ingest/mt5/live-batch') {
      if (down > 0) { down--; return { ok: false, status: 500, json: async () => ({}) }; }
      for (const t of JSON.parse(init.body).ticks) received.push(t.timestamp);
      return { ok: true, status: 202, json: async () => ({ accepted: 1 }) };
    }
    return base.request(url, init);
  };
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't', pollMs: 15, maxBackoffMs: 30, maxFailures: 5,
    makeWorker: fakeWorker({
      connect: { ok: true, symbol: 'XAUUSD', commonDataPath: 'C:\\Common', dataPath: 'C:\\Data' },
      history: { ok: true, ticks: [] },
      poll: () => { n++; return n <= 4 ? { ok: true, ticks: [{ ...tick, timestamp: new Date(Date.UTC(2026, 0, 5, 10, 0, n)).toISOString() }] } : { ok: true, ticks: [] }; }
    }),
    request,
    publish: async () => {}
  });
  await session.connect();
  await new Promise(resolve => setTimeout(resolve, 600));
  const expected = [1, 2, 3, 4].map(s => new Date(Date.UTC(2026, 0, 5, 10, 0, s)).toISOString());
  assert.deepEqual(received, expected, 'every polled tick reaches the service once, in order, after the outage');
  assert.equal(session.state().state, 'online');
  await session.disconnect();
});

test('the resend queue is bounded and says how many ticks it had to drop', async () => {
  let down = 1, n = 0;
  const received = [];
  const base = fakeApi();
  const request = async (url, init) => {
    if (new URL(url).pathname === '/v1/ingest/mt5/live-batch') {
      if (down > 0) { down--; throw new Error('connect ECONNREFUSED'); }
      for (const t of JSON.parse(init.body).ticks) received.push(t.timestamp);
      return { ok: true, status: 202, json: async () => ({ accepted: 1 }) };
    }
    return base.request(url, init);
  };
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't', pollMs: 15, maxBackoffMs: 30, maxUnsent: 3,
    makeWorker: fakeWorker({
      connect: { ok: true, symbol: 'XAUUSD', commonDataPath: 'C:\\Common', dataPath: 'C:\\Data' },
      history: { ok: true, ticks: [] },
      poll: () => { n++; return n <= 2 ? { ok: true, ticks: [0, 1, 2].map(k => ({ ...tick, timestamp: new Date(Date.UTC(2026, 0, 5, 10, n, k)).toISOString() })) } : { ok: true, ticks: [] }; }
    }),
    request,
    publish: async () => {}
  });
  await session.connect();
  const messages = [];
  const watch = setInterval(() => messages.push(session.state().message), 3);
  await new Promise(resolve => setTimeout(resolve, 400));
  clearInterval(watch);
  assert.equal(received.length, 3, 'only the newest ticks up to the bound are kept');
  assert.equal(received.at(-1), new Date(Date.UTC(2026, 0, 5, 10, 2, 2)).toISOString(), 'the newest ticks win');
  const state = session.state();
  assert.equal(state.droppedTicks, 3, 'the session keeps the total');
  assert.ok(messages.some(message => /Потеряно тиков за время сбоя: 3/.test(message)), 'the recovery reports the loss');
  assert.doesNotMatch(state.message, /Потеряно/, 'once recovered, the line no longer repeats an old loss');
  await session.disconnect();
});

test('a 409 whose resend also fails keeps the batch for the next poll', async () => {
  let collisions = 1, n = 0;
  const received = [];
  const base = fakeApi();
  const request = async (url, init) => {
    if (new URL(url).pathname === '/v1/ingest/mt5/live-batch') {
      if (collisions > 0) { collisions--; return { ok: false, status: 409, json: async () => { throw new SyntaxError('bad body'); } }; }
      for (const t of JSON.parse(init.body).ticks) received.push(t.timestamp);
      return { ok: true, status: 202, json: async () => ({ accepted: 1 }) };
    }
    return base.request(url, init);
  };
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't', pollMs: 15, maxBackoffMs: 30,
    makeWorker: fakeWorker({
      connect: { ok: true, symbol: 'XAUUSD', commonDataPath: 'C:\\Common', dataPath: 'C:\\Data' },
      history: { ok: true, ticks: [] },
      poll: () => { n++; return n === 1 ? { ok: true, ticks: [{ ...tick, timestamp: new Date(Date.UTC(2026, 0, 5, 10, 0, 1)).toISOString() }] } : { ok: true, ticks: [] }; }
    }),
    request,
    publish: async () => {}
  });
  await session.connect();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(received, [new Date(Date.UTC(2026, 0, 5, 10, 0, 1)).toISOString()], 'the tick from the failed 409 round is sent on the next poll');
  await session.disconnect();
});

test('hiding zones clears MT5 immediately and restoring them republishes the same zones', async () => {
  const published = [];
  const api = fakeApi();
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't',
    makeWorker: fakeWorker({
      connect: { ok: true, symbol: 'XAUUSDm', commonDataPath: 'C:\\Common', dataPath: 'C:\\Data' },
      history: { ok: true, ticks: [tick] },
      poll: { ok: true, ticks: [tick] }
    }),
    request: api.request,
    publish: async (common, symbol, zones) => { published.push(zones.length); }
  });
  await session.connect();
  await new Promise(resolve => setTimeout(resolve, 2600));
  assert.ok(published.includes(1), 'the zone is drawn while it is switched on');

  const hidden = await session.setZonesVisible(false);
  assert.equal(hidden.ok, true);
  assert.equal(published.at(-1), 0, 'switching off writes an empty snapshot at once, without waiting for a poll');
  assert.equal(hidden.zoneCount, 0);

  const shown = await session.setZonesVisible(true);
  assert.equal(shown.ok, true);
  assert.equal(published.at(-1), 1, 'switching back on republishes the zones already in hand');
  assert.equal(shown.zoneCount, 1);
  await session.disconnect();
});

test('a hidden fleet stays empty on the next refresh instead of reappearing', async () => {
  const published = [];
  const api = fakeApi({ zonesVisible: false });
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't',
    makeWorker: fakeWorker({
      connect: { ok: true, symbol: 'XAUUSDm', commonDataPath: 'C:\\Common', dataPath: 'C:\\Data' },
      history: { ok: true, ticks: [tick] },
      poll: { ok: true, ticks: [tick] }
    }),
    request: api.request,
    publish: async (common, symbol, zones) => { published.push(zones.length); }
  });
  await session.connect();
  await new Promise(resolve => setTimeout(resolve, 2600));
  assert.ok(published.length > 0, 'the snapshot is still written on every refresh');
  assert.ok(published.every(count => count === 0), 'a zone must never be drawn while the switch is off: ' + published.join(','));
  await session.disconnect();
});

test('the same tick from two accounts on one server never collapses into one event', async () => {
  const eventIds = [];
  for (const accountLogin of ['68353333', '68533333']) {
    const api = fakeApi();
    const session = createMt5Session({
      workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't',
      makeWorker: fakeWorker({
        connect: { ok: true, symbol: 'XAUUSD', accountLogin, server: 'RoboForex-Pro', commonDataPath: 'C:\\Common', dataPath: 'C:\\Data' },
        history: { ok: true, ticks: [] },
        poll: { ok: true, ticks: [tick] }
      }),
      request: api.request,
      publish: async () => {}
    });
    await session.connect();
    await new Promise(resolve => setTimeout(resolve, 2600));
    const batch = api.calls.find(call => call.path === '/v1/ingest/mt5/live-batch');
    eventIds.push(batch?.body.ticks[0]?.eventId);
    await session.disconnect();
  }
  assert.equal(eventIds.length, 2);
  assert.ok(eventIds[0] && eventIds[1], 'both accounts must produce a live batch');
  assert.notEqual(eventIds[0], eventIds[1], 'two demo accounts ending in 3333 must not dedupe into a single event');
});

const connectReply = { ok: true, symbol: 'XAUUSD', terminalPath: 'C:\\MT5\\terminal64.exe', commonDataPath: 'C:\\Common', dataPath: 'C:\\Data' };
const waitFor = async (check, ms = 3000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (check()) return true; await new Promise(resolve => setTimeout(resolve, 10)); }
  return check();
};

test('a dead connector is replaced by a new one and the same feed carries on, keeping the zones on the chart', async () => {
  const workers = [];
  const published = [];
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't', pollMs: 10, maxFailures: 5, reconnectMs: 20, maxBackoffMs: 60,
    makeWorker: () => {
      const index = workers.length;
      let stopped = false;
      const worker = {
        index, connectPayload: null, stop() { stopped = true; }, stopped: () => stopped,
        async request(op, payload = {}) {
          if (op === 'connect') { worker.connectPayload = payload; return { ...connectReply, accountLogin: '12345', server: 'RoboForex-Demo' }; }
          if (op === 'history') return { ok: true, ticks: [] };
          if (index === 0) { stopped = true; throw new Error('MT5 не ответил вовремя.'); }
          return { ok: true, ticks: [{ ...tick, timestamp: new Date().toISOString() }] };
        }
      };
      workers.push(worker);
      return worker;
    },
    request: fakeApi().request,
    publish: async (common, symbol, zones) => { published.push(zones.length); }
  });
  const first = await session.connect();
  await waitFor(() => workers.length === 2);
  assert.equal(workers.length, 2, 'a second connector is started without a click');
  await waitFor(() => session.state().state === 'online' && session.state().feed === 'live');
  assert.equal(session.state().feedId, first.feedId, 'the same account keeps the same feed');
  assert.equal(workers[1].connectPayload.resumeFrom, undefined, 'no tick had arrived yet, so there is nothing to resume from');
  assert.ok(published.length > 0 && !published.includes(0), 'the zones are not wiped from the MT5 chart during the outage');
  await session.disconnect();
});

test('the reconnect resumes from the last delivered tick of the same feed', async () => {
  const workers = [];
  const stamp = new Date(Date.now() - 5000).toISOString();
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't', pollMs: 10, reconnectMs: 15, maxBackoffMs: 40,
    makeWorker: () => {
      const index = workers.length;
      let stopped = false;
      const worker = {
        connectPayload: null, stop() { stopped = true; }, stopped: () => stopped,
        async request(op, payload = {}) {
          if (op === 'connect') { worker.connectPayload = payload; return { ...connectReply, accountLogin: '12345', server: 'RoboForex-Demo' }; }
          if (op === 'history') return { ok: true, ticks: [] };
          if (index === 0 && !worker.sent) { worker.sent = true; return { ok: true, ticks: [{ ...tick, timestamp: stamp }] }; }
          if (index === 0) { stopped = true; throw new Error('Модуль MT5 закрылся.'); }
          return { ok: true, ticks: [] };
        }
      };
      workers.push(worker);
      return worker;
    },
    request: fakeApi().request,
    publish: async () => {}
  });
  await session.connect();
  await waitFor(() => workers.length === 2 && workers[1].connectPayload);
  assert.equal(workers[1].connectPayload.resumeFrom, Math.floor(Date.parse(stamp) / 1000));
  await session.disconnect();
});

test('MT5 not being open yet is retried until it is, instead of staying offline', async () => {
  let attempts = 0;
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't', pollMs: 10, reconnectMs: 15, maxBackoffMs: 30,
    makeWorker: () => ({
      stop() {}, stopped: () => false,
      async request(op) {
        if (op === 'connect') {
          attempts += 1;
          if (attempts < 3) throw new Error('Не найден запущенный MetaTrader 5.');
          return connectReply;
        }
        if (op === 'history') return { ok: true, ticks: [] };
        return { ok: true, ticks: [] };
      }
    }),
    request: fakeApi().request,
    publish: async () => {}
  });
  const first = await session.connect();
  assert.notEqual(first.state, 'online');
  await waitFor(() => session.state().state === 'online');
  assert.equal(session.state().state, 'online');
  assert.equal(attempts, 3);
  await session.disconnect();
});

test('an operator disconnect is final: nothing reconnects behind their back', async () => {
  let connects = 0;
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't', pollMs: 10, reconnectMs: 15,
    makeWorker: () => ({
      stop() {}, stopped: () => false,
      async request(op) {
        if (op === 'connect') { connects += 1; return connectReply; }
        return { ok: true, ticks: [] };
      }
    }),
    request: fakeApi().request,
    publish: async () => {}
  });
  await session.connect();
  await session.disconnect();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(connects, 1);
  assert.equal(session.state().state, 'offline');
});

test('an invalid licence ends the session for good even with reconnects enabled', async () => {
  let connects = 0;
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't', pollMs: 10, reconnectMs: 15,
    makeWorker: () => ({
      stop() {}, stopped: () => false,
      async request(op) {
        if (op === 'connect') { connects += 1; return connectReply; }
        return { ok: true, ticks: [] };
      }
    }),
    request: fakeApi({ licenseValid: () => false }).request,
    publish: async () => {}
  });
  await session.connect();
  await waitFor(() => session.state().state === 'offline');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(connects, 1);
  assert.equal(session.state().state, 'offline');
});

test('the broker M1 candles are loaded first and refreshed, so the chart never waits for ticks', async () => {
  const api = fakeApi();
  const asked = [];
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't', pollMs: 20, historyHours: 0, candleDays: 3, ratesRefreshMs: 50,
    makeWorker: fakeWorker({
      connect: { ok: true, symbol: 'XAUUSD', commonDataPath: commonRoot, dataPath: 'C:\\Data', boundary: Math.floor(Date.now() / 1000), clockOffsetMs: 7200000, clockOffsetReliable: true },
      rates: ({ from, to }) => { asked.push(to - from); return { ok: true, rates: [{ t: Date.now() - 120000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10, rv: 0 }] }; },
      poll: { ok: true, ticks: [] }
    }),
    request: api.request, publish: async () => {}
  });
  await session.connect();
  await new Promise(resolve => setTimeout(resolve, 400));
  const state = await session.disconnect();
  assert.ok(asked[0] >= 3 * 86400, 'the first read covers the configured candle days');
  assert.ok(asked.slice(1).some(span => span <= 3600), 'later reads only refresh the newest minutes');
  const sent = api.calls.filter(c => c.path === '/v1/ingest/mt5/rates');
  assert.ok(sent.length >= 2);
  assert.equal(sent[0].body.clockOffsetMs, 7200000, 'the broker clock shift travels with the candles');
  assert.equal(sent[0].body.clockOffsetReliable, true);
  assert.equal(state.state, 'offline');
});

test('the tick archive downloads on request, skips what the service already holds, and can be stopped', async () => {
  const calls = [];
  const base = fakeApi();
  const request = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === '/v1/ingest/mt5/coverage') {
      const body = JSON.parse(init.body);
      calls.push(body.windows.length);
      // Every other window is already in the local archive.
      return { ok: true, status: 200, json: async () => ({ covered: body.windows.map((_, i) => body.windows.length > 1 && i % 2 === 1) }) };
    }
    return base.request(url, init);
  };
  const reads = [];
  const session = createMt5Session({
    workerCommand: 'fake', workerArgs: [], apiOrigin: 'http://127.0.0.1:9', token: 't', pollMs: 20, historyHours: 0, backfillWindowSec: 3600, archiveBudgetMs: 5,
    makeWorker: fakeWorker({
      connect: { ok: true, symbol: 'XAUUSD', commonDataPath: commonRoot, dataPath: 'C:\\Data', boundary: Math.floor(Date.now() / 1000) },
      rates: { ok: true, rates: [] },
      backfill: async ({ from, to }) => { reads.push({ from, to }); await new Promise(r => setTimeout(r, 20)); return { ok: true, ticks: [tick] }; },
      poll: { ok: true, ticks: [] }
    }),
    request, publish: async () => {}
  });
  await session.connect();
  await assert.rejects(session.archive({ days: 30 }), /от 1 до 7/);
  const started = await session.archive({ days: 1 });
  assert.equal(started.archive.state, 'running');
  assert.equal(started.archive.total, 24);
  assert.equal(started.archive.already, 12, 'covered windows are not read again');
  await new Promise(resolve => setTimeout(resolve, 150));
  const midway = session.state().archive;
  assert.ok(midway.done > 12 && reads.length > 0);
  assert.ok(reads.every((r, i) => i === 0 || r.to <= reads[i - 1].to), 'newest first');
  const stopped = await session.archive({ stop: true });
  assert.equal(stopped.archive.state, 'stopped');
  const count = reads.length;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(reads.length, count, 'a stopped archive reads nothing more');
  assert.ok(base.calls.some(c => c.path === '/v1/ingest/mt5/history'), 'archive ticks are ingested as history');
  await session.disconnect();
});
