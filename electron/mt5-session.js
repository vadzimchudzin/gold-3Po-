import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { publishSnapshot } from './mt5-snapshot.js';

function startWorker(command, args) {
  let child;
  try { child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (error) { throw new Error(`Не удалось запустить модуль подключения MT5: ${error?.message || command}.`); }
  const lines = createInterface({ input: child.stdout });
  let stopped = false, current, id = 0, trouble = '';
  // The connector silences its own output, so anything here comes from the frozen bootloader: a missing library,
  // a broken build. Without it the window could only say «модуль закрылся» and leave the engineer guessing.
  child.stderr?.on('data', chunk => { trouble = (trouble + chunk).slice(-600); });
  function stop(message = 'Соединение с модулем MT5 закрыто.') {
    if (stopped) return;
    stopped = true;
    const pending = current;
    current = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    lines.close();
    child.kill();
  }
  child.once('error', error => stop(error?.code === 'ENOENT'
    ? `Модуль подключения MT5 не найден: ${command}. Эта сборка GOLD-3Po пришла без модуля — переустановите приложение.`
    : `Не удалось запустить модуль подключения MT5: ${error?.message || command}.`));
  child.once('exit', () => {
    const why = trouble.trim().split('\n').slice(-3).join(' ').trim();
    stop(why ? `Модуль MT5 закрылся: ${why}` : undefined);
  });
  child.stdin.on('error', () => stop());
  lines.on('line', line => {
    let result;
    try { result = JSON.parse(line); } catch { stop('Некорректный ответ модуля MT5.'); return; }
    if (!current || result.id !== current.id) return;
    const pending = current;
    current = null;
    clearTimeout(pending.timer);
    if (result.ok) pending.resolve(result);
    else pending.reject(new Error(result.message || 'Терминал MT5 не подтвердил запрос.'));
  });
  return {
    stop,
    stopped: () => stopped,
    request(op, values = {}, timeout = 25_000) {
      if (stopped || current) return Promise.reject(new Error('Модуль MT5 недоступен или занят.'));
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        current = { id: requestId, resolve, reject, timer: setTimeout(() => stop('MT5 не ответил вовремя. Проверьте терминал и подключение.'), timeout) };
        child.stdin.write(JSON.stringify({ id: requestId, op, ...values }) + '\n');
      });
    }
  };
}

export function createMt5Session({ workerCommand, workerArgs, apiOrigin, token, makeWorker = startWorker, request = fetch, publish = publishSnapshot,
  now = () => Date.now(), pollMs = 1800, maxFailures = 5, maxBackoffMs = 30_000, staleAfterMs = 120_000, maxUnsent = 20_000,
  reconnectMs = 0, licenseCheckMs = 0, historyHours = 2, backfillWindowSec = 30 * 60,
  candleDays = 10, ratesRefreshMs = 15_000, archiveBudgetMs = 600, maxArchiveDays = 7 }) {
  let session = null;
  // `wanted` is the operator's intent: set by connect(), cleared only by disconnect(). While it is set
  // and the bridge is down for any other reason (terminal restarted, MT5 not open yet, a slow read
  // that killed the worker), the session reopens itself instead of staying dead until a manual click.
  let wanted = false, retryTimer = null, retryCount = 0;
  // The broker's clock shift measured on a live market, reused when MT5 connects on a closed one.
  let knownClockOffsetMs = null;
  let status = { state: 'offline', message: 'MT5 не подключён.' };
  const fetchApi = (route, init = {}) => request(apiOrigin + route, { ...init, signal: AbortSignal.timeout(15_000) });
  const state = () => ({ ...status });
  function set(owner, fields) { if (session === owner) status = { ...status, ...fields }; }

  async function ingest(owner, ticks, historical) {
    if (!Array.isArray(ticks)) throw new Error('MT5 вернул некорректные котировки.');
    const records = [];
    const unique = new Set();
    for (const tick of ticks) {
      const { timestamp, bid, ask, last, tickVolume, realVolume, flags } = tick;
      if (Date.parse(timestamp) > Date.now() + 60_000) continue;
      const identity = createHash('sha256').update(JSON.stringify([owner.accountLogin, owner.server, owner.symbol, timestamp, bid, ask, last, tickVolume, realVolume, flags])).digest('hex');
      if (unique.has(identity)) continue;
      unique.add(identity);
      records.push({ feedId: owner.feedId, timestamp, bid, ask, last, tickVolume, realVolume, flags, eventId: `MT5-${identity}`, sequence: ++owner.sequence });
    }
    // Live ticks the local service did not accept are kept and sent first next time: the connector has
    // already moved past them, so dropping them would leave a hole. The service skips duplicates by
    // event id, so a resend is safe. The queue is bounded; the oldest ticks go first if it fills.
    if (!historical && owner.unsent?.length) {
      records.unshift(...owner.unsent);
      owner.unsent = [];
    }
    if (!historical && records.length > maxUnsent) {
      owner.droppedTicks = (owner.droppedTicks || 0) + records.length - maxUnsent;
      owner.droppedThisOutage = (owner.droppedThisOutage || 0) + records.length - maxUnsent;
      records.splice(0, records.length - maxUnsent);
    }
    for (let i = 0; i < records.length && session === owner; i += 1000) {
      const route = historical ? 'history' : 'live-batch';
      const send = () => fetchApi(`/v1/ingest/mt5/${route}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'mt5', symbol: owner.symbol, feedId: owner.feedId, spec: owner.spec ?? null, ticks: records.slice(i, i + 1000) })
      });
      // Any failure from here on (network, a 409 that cannot be resequenced, a rejected resend, an
      // unreadable answer) keeps this batch and the rest for the next poll instead of losing them.
      try {
        let response = await send();
        if (response.status === 409 && !historical) {
          const { lastAcceptedSequence } = await response.json();
          if (!Number.isSafeInteger(lastAcceptedSequence)) throw new Error('Не удалось синхронизировать поток котировок.');
          owner.sequence = Math.max(owner.sequence, lastAcceptedSequence);
          for (let j = i; j < records.length; j++) records[j].sequence = ++owner.sequence;
          response = await send();
        }
        if (!response.ok) throw new Error(`Локальный сервис отклонил котировки (HTTP ${response.status}).`);
        await response.json();
      } catch (error) {
        if (!historical) owner.unsent = records.slice(i);
        throw new Error(`MT5 ${route}: пакет из ${records.length-i} тиков сохранён в очереди для повторной отправки: ${error.message}`, { cause: error });
      }
    }
    return records.length;
  }

  const ingestHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  // The broker's M1 candles: the chart is drawn from them at once, exactly as the terminal draws it.
  // Ticks only add the footprint on top, so the window never waits for a tick archive.
  async function sendRates(owner, rates) {
    for (let i = 0; i < rates.length && session === owner; i += 5000) {
      const response = await fetchApi('/v1/ingest/mt5/rates', { method: 'POST', headers: ingestHeaders,
        body: JSON.stringify({ source: 'mt5', symbol: owner.symbol, feedId: owner.feedId, clockOffsetMs: owner.clockOffsetMs || 0,
          clockOffsetReliable: owner.clockOffsetReliable === true, rates: rates.slice(i, i + 5000) }) });
      if (!response.ok) throw new Error(`Локальный сервис не принял свечи (HTTP ${response.status}).`);
      await response.json();
    }
  }

  function terminalNow(owner) {
    const last = owner.lastTick ? Date.parse(owner.lastTick) : NaN;
    const base = Number.isFinite(last) ? Math.max(last, now() - 60_000) : now();
    return Math.floor((base + (owner.clockOffsetMs || 0)) / 1000);
  }

  async function ratesStep(owner) {
    const candles = owner.candles;
    if (!candles || session !== owner) return;
    const wantDays = Math.max(candleDays, owner.archive?.days || 0);
    const full = !candles.loaded || candles.days < wantDays;
    if (!full && now() - candles.at < ratesRefreshMs) return;
    if (candles.failures >= 3 && full && now() - candles.at < 60_000) return;
    const to = terminalNow(owner) + 120;
    const from = full ? to - wantDays * 86400 : to - 30 * 60;
    try {
      const result = await owner.worker.request('rates', { from, to }, 30_000);
      if (session !== owner) return;
      const rates = Array.isArray(result.rates) ? result.rates : [];
      if (rates.length) await sendRates(owner, rates);
      if (full) { candles.loaded = true; candles.days = wantDays; candles.count = rates.length; }
      candles.at = now();
      candles.failures = 0;
      candles.note = '';
    } catch (error) {
      if (owner.worker.stopped?.()) throw error;
      candles.failures += 1;
      candles.at = now();
      candles.note = `Свечи MT5 не загрузились (${error.message}). График строится по тикам.`;
    }
  }

  // Which tick windows the local service already holds completely, so a reconnect or a second archive
  // download does not read the same hours from MT5 again.
  async function coveredWindows(owner, windows) {
    if (!windows.length) return [];
    try {
      const offset = owner.clockOffsetMs || 0;
      const response = await fetchApi('/v1/ingest/mt5/coverage', { method: 'POST', headers: ingestHeaders,
        body: JSON.stringify({ source: 'mt5', symbol: owner.symbol, feedId: owner.feedId,
          windows: windows.map(w => ({ fromMs: w.from * 1000 - offset, toMs: w.to * 1000 - offset })) }) });
      if (!response.ok) return windows.map(() => false);
      const body = await response.json();
      return Array.isArray(body?.covered) ? windows.map((_, i) => body.covered[i] === true) : windows.map(() => false);
    } catch { return windows.map(() => false); }
  }

  function windowsBack(end, start) {
    const list = [];
    for (let to = end; to > start; to -= backfillWindowSec) list.push({ from: Math.max(start, to - backfillWindowSec), to, tries: 0 });
    return list;
  }

  // The tick archive: an explicit, quiet download of whole days of ticks for the footprint, newest
  // first, a little in every poll cycle, so the live feed never waits for it.
  async function archive(request = {}) {
    const owner = session;
    if (!owner || status.state !== 'online') throw new Error('Сначала подключите MT5.');
    if (request.stop) {
      if (owner.archive && owner.archive.state === 'running') { owner.archive.state = 'stopped'; owner.archive.pending = []; }
      publishArchive(owner);
      return state();
    }
    const days = Math.round(Number(request.days));
    if (!Number.isInteger(days) || days < 1 || days > maxArchiveDays) throw new Error(`Глубина архива — от 1 до ${maxArchiveDays} дней.`);
    const end = terminalNow(owner) + 1;
    const windows = windowsBack(end, end - days * 86400);
    const covered = await coveredWindows(owner, windows);
    if (session !== owner) return state();
    const pending = windows.filter((_, i) => !covered[i]);
    owner.archive = { state: pending.length ? 'running' : 'done', days, pending, total: windows.length, done: windows.length - pending.length,
      already: windows.length - pending.length, ticks: 0, skipped: 0, startedAt: now() };
    publishArchive(owner);
    return state();
  }

  function publishArchive(owner) {
    const a = owner.archive;
    set(owner, { archive: a ? { state: a.state, days: a.days, done: a.done, total: a.total, already: a.already, ticks: a.ticks, skipped: a.skipped } : null });
  }

  async function archiveStep(owner) {
    const plan = owner.archive;
    if (!plan || plan.state !== 'running' || session !== owner) return;
    const until = now() + archiveBudgetMs;
    while (plan.pending.length && plan.state === 'running' && session === owner && now() < until) {
      const window = plan.pending[0];
      try {
        const [covered] = await coveredWindows(owner, [window]);
        if (!covered) {
          const result = await owner.worker.request('backfill', { from: window.from, to: window.to }, 20_000);
          if (session !== owner || plan.state !== 'running') return;
          if (result.truncated && result.ticks?.length) {
            const first = Math.floor(Date.parse(result.ticks[0].timestamp) / 1000) + Math.round((owner.clockOffsetMs || 0) / 1000);
            if (first > window.from) plan.pending.splice(1, 0, { from: window.from, to: first, tries: 0 });
          }
          if (result.ticks?.length) plan.ticks += await ingest(owner, result.ticks, true);
        } else plan.already += 1;
        plan.pending.shift();
        plan.done += 1;
      } catch (error) {
        if (owner.worker.stopped?.()) throw error;
        window.tries += 1;
        if (window.tries >= 3) { plan.pending.shift(); plan.skipped += 1; plan.done += 1; }
        break;
      }
    }
    if (!plan.pending.length && plan.state === 'running') plan.state = 'done';
    publishArchive(owner);
  }

  async function refreshLevels(owner, changed) {
    if (session !== owner) return;
    // Refetch every ~4.5 s even without new ticks, so changed settings reach MT5 on a quiet market too.
    if (!owner.cachedZones || Date.now() - owner.levelAt >= 4500) {
      const response = await fetchApi('/v1/chart/zones?' + new URLSearchParams({ symbol: owner.symbol, feedId: owner.feedId }));
      if (response.status === 402) { await disconnect('Лицензия GOLD-3Po недействительна.'); return; }
      if (!response.ok) throw new Error(`Не удалось рассчитать уровни (HTTP ${response.status}).`);
      const body = await response.json();
      owner.cachedZones = body.zones;
      owner.cachedStyle = body.style;
      // A hidden fleet of zones is published as an empty snapshot, which clears the chart immediately.
      owner.zonesVisible = body.zonesVisible !== false;
    } else if (!changed) {
      if (licenseCheckMs && Date.now() - (owner.licenseAt || 0) < licenseCheckMs) return;
      owner.licenseAt = Date.now();
      const response = await fetchApi('/v1/license/status');
      // An answered "not valid" ends the session at once; only an unreachable service is retried.
      let body;
      try { body = await response.json(); }
      catch { throw new Error('Не удалось проверить лицензию: ответ сервиса не является JSON.'); }
      if (response.status === 402 || body?.valid === false) { await disconnect('Лицензия GOLD-3Po недействительна.'); return; }
      // An unreachable service, or an answer that cannot be read, is a failed check: it never counts as valid.
      if (!response.ok || body?.valid !== true) throw new Error('Не удалось проверить лицензию.');
    } else {
      return;
    }
    if (session !== owner) return;
    const drawn = owner.zonesVisible === false ? [] : owner.cachedZones;
    owner.levelWrite = publish(owner.commonDataPath, owner.symbol, drawn, owner.cachedStyle);
    await owner.levelWrite;
    owner.levelAt = Date.now();
    owner.dirty = false;
    set(owner, { zoneCount: drawn.length });
  }

  // A failed poll (terminal briefly gone, the local service restarting, HTTP 5xx) is retried with a
  // growing pause instead of ending the session; after `maxFailures` in a row the session gives up.
  // No new tick for `staleAfterMs` marks the feed stale in the status, without disconnecting.
  async function poll(owner) {
    let delay = pollMs;
    try {
      const result = await owner.worker.request('poll');
      if (session !== owner) return;
      const count = await ingest(owner, result.ticks, false);
      if (count) {
        owner.dirty = true;
        owner.lastTick = result.ticks.at(-1).timestamp;
        owner.lastTickAt = now();
      }
      await refreshLevels(owner, owner.dirty);
      owner.failures = 0;
      // Candles first: the chart is complete from the broker's M1 bars before any tick history.
      await ratesStep(owner);
      // Tick history is loaded beside the live feed: one bounded window per cycle, after the live
      // ticks, so the chart is live from the first second and the footprint fills in behind it.
      await backfillStep(owner);
      if (!owner.backfill?.pending.length) await archiveStep(owner);
      const stale = owner.lastTickAt !== undefined && now() - owner.lastTickAt > staleAfterMs;
      const online = stale ? `Нет новых тиков более ${Math.round(staleAfterMs / 1000)} с: рынок закрыт или терминал не получает котировки.`
        : !owner.lastTick ? 'Вход подтверждён. Ожидаем котировки.' : 'Вход подтверждён. Поток живой, уровни обновляются по таймфрейму из настроек.';
      const history = owner.backfill?.pending.length
        ? ` Тики для футпринта: ${owner.backfill.done} из ${owner.backfill.total} окон, поток не ждёт.` : '';
      const candleNote = owner.candles?.note ? ` ${owner.candles.note}` : '';
      // The loss is reported once, for the outage that just ended; droppedTicks keeps the session total.
      const lost = owner.droppedThisOutage ? ` Потеряно тиков за время сбоя: ${owner.droppedThisOutage}.` : '';
      if (!owner.unsent?.length) owner.droppedThisOutage = 0;
      set(owner, { state: 'online', feed: stale ? 'stale' : 'live', retries: 0, droppedTicks: owner.droppedTicks || 0, lastTick: owner.lastTick ?? null,
        history: owner.backfill ? { done: owner.backfill.done, total: owner.backfill.total, ticks: owner.backfill.ticks } : null,
        candles: owner.candles ? { loaded: owner.candles.loaded, days: owner.candles.days, count: owner.candles.count } : null,
        message: (owner.historyNote ? `${online} ${owner.historyNote}` : online) + history + candleNote + lost });
    } catch (error) {
      if (session !== owner) return;
      owner.failures = (owner.failures || 0) + 1;
      if (owner.failures >= maxFailures || owner.worker.stopped?.()) { await lose(owner, error.message); return; }
      delay = Math.min(pollMs * 2 ** owner.failures, maxBackoffMs);
      set(owner, { state: 'reconnecting', retries: owner.failures, message: `Связь прервалась (${error.message}). Повтор ${owner.failures} из ${maxFailures} через ${Math.round(delay / 1000)} с${owner.failures === maxFailures - 1 ? ', последний: при новой ошибке соединение будет закрыто' : ''}.` });
    } finally {
      if (session === owner) owner.timer = setTimeout(() => void poll(owner), delay);
    }
  }

  // The history buffer: windows of `backfillWindowSec` over the last `historyHours`, newest first, in
  // terminal seconds. Each poll cycle reads at most one, so a slow or failed read costs one window,
  // never the live feed. A window MT5 could not read is retried twice, then skipped and reported.
  function planBackfill(owner, boundary) {
    const end = Number.isSafeInteger(boundary) ? boundary : null;
    if (!end || !historyHours) { owner.backfill = null; return; }
    const pending = [];
    const start = Math.floor((end - historyHours * 3600) / 3600) * 3600;
    for (let to = end + 1; to > start; to -= backfillWindowSec) pending.push({ from: Math.max(start, to - backfillWindowSec), to, tries: 0 });
    owner.backfill = { pending, total: pending.length, done: 0, ticks: 0, skipped: 0 };
  }

  async function backfillStep(owner) {
    const plan = owner.backfill;
    if (!plan?.pending.length || session !== owner) return;
    const window = plan.pending[0];
    try {
      if (!window.checked) {
        window.checked = true;
        const [covered] = await coveredWindows(owner, [window]);
        if (covered) { plan.pending.shift(); plan.done += 1; return; }
      }
      const result = await owner.worker.request('backfill', { from: window.from, to: window.to }, 20_000);
      if (session !== owner) return;
      plan.pending.shift();
      // A window denser than one read: keep its older part for the next cycle.
      if (result.truncated && result.ticks?.length) {
        const first = Math.floor(Date.parse(result.ticks[0].timestamp) / 1000) + Math.round((owner.clockOffsetMs || 0) / 1000);
        if (first > window.from) plan.pending.unshift({ from: window.from, to: first, tries: 0 });
      }
      if (result.ticks?.length) plan.ticks += await ingest(owner, result.ticks, true);
      plan.done += 1;
    } catch (error) {
      if (owner.worker.stopped?.()) throw error;
      window.tries += 1;
      if (window.tries >= 3) { plan.pending.shift(); plan.skipped += 1; plan.done += 1; owner.historyNote = `История MT5: пропущено окон — ${plan.skipped} (${error.message}).`; }
    }
    if (!plan.pending.length && plan.skipped === 0) owner.historyNote = '';
  }

  // Turning zones off must be visible in the terminal right away, not on the next four-second poll:
  // write the snapshot now. Turning them back on republishes the zones already in hand.
  async function setZonesVisible(visible) {
    const owner = session;
    if (!owner) return { ok: false, zonesVisible: visible !== false };
    owner.zonesVisible = visible !== false;
    if (owner.commonDataPath) {
      const drawn = owner.zonesVisible ? (owner.cachedZones || []) : [];
      owner.levelWrite = publish(owner.commonDataPath, owner.symbol, drawn, owner.cachedStyle).catch(() => {});
      await owner.levelWrite;
      set(owner, { zoneCount: drawn.length });
    }
    return { ok: true, zonesVisible: owner.zonesVisible, zoneCount: owner.zonesVisible ? (owner.cachedZones?.length || 0) : 0 };
  }

  async function disconnect(message = 'MT5 отключён.') {
    wanted = false;
    stopRetry();
    return release(message);
  }

  async function release(message) {
    const owner = session;
    session = null;
    if (owner) {
      clearTimeout(owner.timer);
      owner.worker.stop();
      await owner.levelWrite?.catch(() => {});
      if (owner.commonDataPath) await publish(owner.commonDataPath, owner.symbol, [], owner.cachedStyle).catch(() => {});
      await fetchApi('/v1/ingest/mt5/spec/reset', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ source: 'mt5', symbol: owner.symbol, feedId: owner.feedId }) }).catch(() => {});
    }
    if (!session) status = { state: 'offline', symbol: owner?.symbol, message };
    return state();
  }

  function stopRetry() {
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleRetry(reason, carry) {
    if (!wanted || !reconnectMs || session || retryTimer) return;
    retryCount += 1;
    const delay = Math.min(reconnectMs * 2 ** Math.min(retryCount - 1, 5), maxBackoffMs);
    status = { ...status, state: 'reconnecting', feed: 'stale', retries: retryCount, message: `${reason} Переподключение через ${Math.round(delay / 1000)} с (попытка ${retryCount}).` };
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (wanted && !session) void open(carry);
    }, delay);
    retryTimer.unref?.();
  }

  // A lost bridge keeps the zones the terminal already draws and everything the next session needs to
  // continue the same feed: the unsent ticks, the sequence and the last tick time to resume from.
  async function lose(owner, message) {
    if (session !== owner) return;
    if (!reconnectMs || !wanted) { await disconnect(message); return; }
    session = null;
    clearTimeout(owner.timer);
    owner.worker.stop();
    await owner.levelWrite?.catch(() => {});
    const carry = { feedId: owner.feedId, unsent: owner.unsent || [], lastTick: owner.lastTick, droppedTicks: owner.droppedTicks || 0 };
    status = { ...status, state: 'reconnecting', feed: 'stale', message: `Связь с MT5 потеряна (${message}).` };
    scheduleRetry(`Связь с MT5 потеряна (${message}).`, carry);
  }

  async function connect() {
    if (session) throw new Error('Сначала отключите текущее соединение.');
    if (!workerCommand) throw new Error('Модуль MT5 не установлен.');
    wanted = true;
    stopRetry();
    retryCount = 0;
    return open(null);
  }

  async function open(carry) {
    if (session || !workerCommand) return state();
    const worker = makeWorker(workerCommand, workerArgs);
    const owner = { worker, symbol: 'XAUUSD', sequence: Date.now() * 1000, levelAt: 0, dirty: true };
    session = owner;
    status = { state: 'connecting', symbol: owner.symbol, message: carry ? 'Переподключение к MT5…' : 'Поиск уже авторизованного терминала MT5…' };
    try {
      const resumeFrom = carry?.lastTick ? Math.floor(Date.parse(carry.lastTick) / 1000) : null;
      const hint = Number.isSafeInteger(knownClockOffsetMs) ? { clockOffsetHint: knownClockOffsetMs } : {};
      let result = await worker.request('connect', Number.isSafeInteger(resumeFrom) ? { resumeFrom, ...hint } : hint, 80_000);
      if (session !== owner) return state();
      if (!result.symbol?.toUpperCase() || !result.commonDataPath || !result.dataPath || !result.terminalPath) {
        throw new Error('MT5 не подтвердил авторизованный терминал, инструмент или каталог данных.');
      }
      owner.symbol = result.symbol.toUpperCase();
      owner.server = result.server;
      owner.accountLogin = result.accountLogin;
      owner.feedId = createHash('sha256')
        .update([String(owner.server || '').trim().toLowerCase(), String(owner.accountLogin || '').trim(), owner.symbol].join('|'))
        .digest('hex').slice(0, 32);
      // Only the same account continues where the last session stopped. If MT5 now answers for another
      // account, the resume point belongs to a different feed: ask again from the terminal's own cursor.
      const resumed = Boolean(carry) && carry.feedId === owner.feedId;
      if (carry && !resumed && Number.isSafeInteger(Math.floor(Date.parse(carry.lastTick) / 1000))) {
        result = await worker.request('connect', hint, 80_000);
        if (session !== owner) return state();
      }
      if (resumed) {
        owner.unsent = carry.unsent;
        owner.droppedTicks = carry.droppedTicks;
        owner.lastTick = carry.lastTick;
        owner.lastTickAt = now();
      }
      owner.terminalPath = result.terminalPath;
      owner.commonDataPath = result.commonDataPath;
      owner.dataPath = result.dataPath;
      // The broker's tick size, when MT5 reported a usable one: the server builds footprint rows on it.
      // Without it the status says why, so a failing MT5 call is visible instead of silent 0.1 rows.
      const tickSize = Number(result.spec?.tickSize);
      if (Number.isFinite(tickSize) && tickSize > 0 && tickSize <= 100) owner.spec = { tickSize };
      const specNote = owner.spec ? {} : { tickSize: null, tickSizeIssue: typeof result.specUnavailable === 'string' ? result.specUnavailable.slice(0, 40) : 'not_reported' };
      // The whole session (history window and live cursor) is anchored to the terminal's last tick, so a
      // terminal that has not streamed for a while is said out loud instead of looking like a live feed.
      const tickAgeMs = Number(result.tickAgeMs);
      const staleTick = Number.isFinite(tickAgeMs) && result.lastTickAt && tickAgeMs > 5 * 60_000
        ? ` Внимание: последняя котировка в терминале — ${new Date(result.lastTickAt).toLocaleString()} (${Math.round(tickAgeMs / 60000)} мин назад), живого потока нет.`
        : '';
      status = {
        state: 'online', symbol: owner.symbol, feedId: owner.feedId,
        accountLabel: (owner.accountLogin ? 'Счёт ···' + String(owner.accountLogin).slice(-4) : 'Счёт MT5') + (owner.server ? ' · ' + owner.server : ''),
        message: 'Подключено к уже авторизованному MT5. Загружаются котировки…' + staleTick,
        terminalTickAt: result.lastTickAt ?? null, terminalTickAgeMs: Number.isFinite(tickAgeMs) ? tickAgeMs : null,
        zoneCount: 0, ...(owner.spec ? { tickSize: owner.spec.tickSize } : specNote)
      };
      retryCount = 0;
      owner.clockOffsetMs = Number(result.clockOffsetMs) || 0;
      owner.clockOffsetReliable = result.clockOffsetReliable === true;
      if (owner.clockOffsetReliable) knownClockOffsetMs = owner.clockOffsetMs;
      owner.candles = { loaded: false, days: 0, count: 0, at: 0, failures: 0, note: '' };
      planBackfill(owner, Number.isSafeInteger(result.boundary) ? result.boundary
        : (result.lastTickAt ? Math.floor((Date.parse(result.lastTickAt) + owner.clockOffsetMs) / 1000) : null));
      void poll(owner);
      return state();
    } catch (error) {
      if (session === owner) {
        await release(error.message);
        scheduleRetry(error.message, carry);
      }
      return state();
    }
  }

  // The refresh button: a live session polls and redraws the MT5 zones now; a lost or closed bridge is
  // reopened at once instead of waiting for the back-off timer.
  async function refresh() {
    const owner = session;
    if (owner && status.state === 'online') {
      clearTimeout(owner.timer);
      owner.levelAt = 0;
      owner.dirty = true;
      if (owner.candles) { owner.candles.at = 0; owner.candles.failures = 0; }
      await poll(owner);
      return state();
    }
    if (owner) return state();
    stopRetry();
    retryCount = 0;
    wanted = true;
    return open(null);
  }

  function setIntegrationMessage(message) {
    status = { ...status, integrationMessage: typeof message === 'string' ? message.slice(0, 600) : '' };
    return state();
  }

  return {
    connect, disconnect, refresh, archive, state, setIntegrationMessage, setZonesVisible,
    terminalPath: () => session?.terminalPath,
    terminalDataPath: () => session?.dataPath,
    commonDataPath: () => session?.commonDataPath
  };
}
