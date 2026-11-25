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
  reconnectMs = 0, licenseCheckMs = 0 }) {
  let session = null;
  // `wanted` is the operator's intent: set by connect(), cleared only by disconnect(). While it is set
  // and the bridge is down for any other reason (terminal restarted, MT5 not open yet, a slow read
  // that killed the worker), the session reopens itself instead of staying dead until a manual click.
  let wanted = false, retryTimer = null, retryCount = 0;
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
      const stale = owner.lastTickAt !== undefined && now() - owner.lastTickAt > staleAfterMs;
      const online = stale ? `Нет новых тиков более ${Math.round(staleAfterMs / 1000)} с: рынок закрыт или терминал не получает котировки.`
        : !owner.lastTick ? 'Вход подтверждён. Ожидаем котировки.' : 'Вход подтверждён. Уровни обновляются по таймфрейму из настроек.';
      // The loss is reported once, for the outage that just ended; droppedTicks keeps the session total.
      const lost = owner.droppedThisOutage ? ` Потеряно тиков за время сбоя: ${owner.droppedThisOutage}.` : '';
      if (!owner.unsent?.length) owner.droppedThisOutage = 0;
      set(owner, { state: 'online', feed: stale ? 'stale' : 'live', retries: 0, droppedTicks: owner.droppedTicks || 0, lastTick: owner.lastTick ?? null, message: (owner.historyNote ? `${online} ${owner.historyNote}` : online) + lost });
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

  async function seed(owner) {
    try {
      const history = await owner.worker.request('history', {}, 60_000);
      if (session !== owner) return;
      await ingest(owner, history.ticks, true);
      if (history.truncated) owner.historyNote = 'История MT5 неполная: терминал отдал не весь поток тиков за 8 часов.';
    } catch (error) { set(owner, { message: `История MT5 недоступна: ${error.message}` }); }
    if (session === owner) void poll(owner);
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
      let result = await worker.request('connect', Number.isSafeInteger(resumeFrom) ? { resumeFrom } : {}, 80_000);
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
        result = await worker.request('connect', {}, 80_000);
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
      if (resumed) void poll(owner);
      else void seed(owner);
      return state();
    } catch (error) {
      if (session === owner) {
        await release(error.message);
        scheduleRetry(error.message, carry);
      }
      return state();
    }
  }

  function setIntegrationMessage(message) {
    status = { ...status, integrationMessage: typeof message === 'string' ? message.slice(0, 600) : '' };
    return state();
  }

  return {
    connect, disconnect, state, setIntegrationMessage, setZonesVisible,
    terminalPath: () => session?.terminalPath,
    terminalDataPath: () => session?.dataPath,
    commonDataPath: () => session?.commonDataPath
  };
}
