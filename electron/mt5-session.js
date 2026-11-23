import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { publishSnapshot } from './mt5-snapshot.js';

const LIVE_POLL_INTERVAL_MS = 450;
const MAX_RETRY_DELAY_MS = 10_000;

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

export function createMt5Session({ workerCommand, workerArgs, apiOrigin, token, makeWorker = startWorker, request = fetch, publish = publishSnapshot }) {
  let session = null;
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
      const identity = createHash('sha256').update(JSON.stringify([owner.server, owner.symbol, timestamp, bid, ask, last, tickVolume, realVolume, flags])).digest('hex');
      if (unique.has(identity)) continue;
      unique.add(identity);
      records.push({ timestamp, bid, ask, last, tickVolume, realVolume, flags, eventId: `MT5-${identity}`, sequence: ++owner.sequence });
    }
    for (let i = 0; i < records.length && session === owner; i += 1000) {
      const route = historical ? 'history' : 'live-batch';
      const send = () => fetchApi(`/v1/ingest/mt5/${route}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'mt5', symbol: owner.symbol, ticks: records.slice(i, i + 1000) })
      });
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
    }
    return records.length;
  }

  async function refreshLicense(owner) {
    if (session !== owner || Date.now() - owner.licenseAt < 4500) return;
    const response = await fetchApi('/v1/license/status');
    if (!response.ok) throw new Error('Не удалось проверить лицензию.');
    owner.licenseAt = Date.now();
    if (!(await response.json()).valid) await disconnect('Лицензия GOLD-3Po недействительна.');
  }

  async function refreshLevels(owner) {
    if (session !== owner) return;
    // Zone snapshots are throttled separately from the live tick poll and licence heartbeat.
    if (owner.cachedZones && Date.now() - owner.levelAt < 4500) return;
    if (!owner.cachedZones || Date.now() - owner.levelAt >= 4500) {
      const response = await fetchApi('/v1/chart/zones?' + new URLSearchParams({ symbol: owner.symbol }));
      if (response.status === 402) { await disconnect('Лицензия GOLD-3Po недействительна.'); return; }
      if (!response.ok) throw new Error(`Не удалось рассчитать уровни (HTTP ${response.status}).`);
      const body = await response.json();
      owner.cachedZones = body.zones;
      owner.cachedStyle = body.style;
    }
    if (session !== owner) return;
    owner.levelWrite = publish(owner.commonDataPath, owner.symbol, owner.cachedZones, owner.cachedStyle);
    await owner.levelWrite;
    owner.levelAt = Date.now();
    owner.dirty = false;
    set(owner, { zoneCount: owner.cachedZones.length });
  }

  async function poll(owner) {
    let delay = LIVE_POLL_INTERVAL_MS;
    try {
      const result = await owner.worker.request('poll');
      if (session !== owner) return;
      if (Array.isArray(result.ticks) && result.ticks.length) owner.pendingTicks.push(...result.ticks);
      if (owner.pendingTicks.length > 0) {
        const batch = owner.pendingTicks.splice(0, 1000);
        try {
          const count = await ingest(owner, batch, false);
          if (count) {
            owner.dirty = true;
            owner.lastTick = batch.at(-1)?.timestamp || owner.lastTick;
          }
        } catch (error) {
          // MT5 has advanced its native cursor. Keep failed batches locally until
          // the loop can deliver them; this prevents silent holes in live candles.
          owner.pendingTicks.unshift(...batch);
          throw error;
        }
      }
      await refreshLicense(owner);
      if (session !== owner) return;
      await refreshLevels(owner);
      owner.failures = 0;
      const online = !owner.lastTick ? 'Вход подтверждён. Ожидаем котировки.' : 'MT5 синхронизирован. График и футпринт получают одну ленту тиков.';
      set(owner, { state: 'online', lastTick: owner.lastTick ?? null, message: owner.historyNote ? `${online} ${owner.historyNote}` : online, queuedTicks: owner.pendingTicks.length });
    } catch (error) {
      if (session === owner) {
        owner.failures = (owner.failures || 0) + 1;
        delay = Math.min(MAX_RETRY_DELAY_MS, LIVE_POLL_INTERVAL_MS * (2 ** Math.min(owner.failures, 5)));
        set(owner, { state: 'online', message: `Временный сбой MT5/API: ${error.message}. Повтор через ${Math.ceil(delay/1000)} с; очередь тиков сохранена.`, queuedTicks: owner.pendingTicks.length });
      }
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

  async function disconnect(message = 'MT5 отключён.') {
    const owner = session;
    session = null;
    if (owner) {
      clearTimeout(owner.timer);
      owner.worker.stop();
      await owner.levelWrite?.catch(() => {});
      if (owner.commonDataPath) await publish(owner.commonDataPath, owner.symbol, [], owner.cachedStyle).catch(() => {});
    }
    if (!session) status = { state: 'offline', symbol: owner?.symbol, message };
    return state();
  }

  async function connect({ terminalPath, login, password, server, symbol } = {}) {
    if (session) throw new Error('Сначала отключите текущее соединение.');
    if (!workerCommand) throw new Error('Модуль MT5 не установлен.');
    if (typeof terminalPath !== 'string' || !/terminal64\.exe$/i.test(terminalPath) || terminalPath.length > 1024 ||
      typeof login !== 'string' || !/^\d{1,15}$/.test(login) || Number(login) < 1 ||
      typeof password !== 'string' || !password || password.length > 256 || typeof server !== 'string' || !server.trim() || server.length > 128 ||
      typeof symbol !== 'string' || !/^(?:XAUUSD|GOLD)[A-Z0-9._#+-]{0,20}$/i.test(symbol) || symbol.includes('..')) {
      throw new Error('Заполните путь к terminal64.exe, номер счёта, пароль, сервер и точное имя символа золота.');
    }
    const worker = makeWorker(workerCommand, workerArgs);
    const owner = { worker, server: server.trim(), symbol: symbol.toUpperCase(), sequence: Date.now() * 1000, levelAt: 0, licenseAt: 0, dirty: true, pendingTicks: [], failures: 0 };
    session = owner;
    status = { state: 'connecting', symbol: owner.symbol, message: 'Подключение к терминалу MT5…' };
    try {
      const result = await worker.request('connect', { terminalPath, login, password, server: owner.server, symbol }, 80_000);
      if (session !== owner) return state();
      if (result.symbol?.toUpperCase() !== owner.symbol || !result.commonDataPath || !result.dataPath) throw new Error('MT5 не подтвердил инструмент или папку данных.');
      owner.commonDataPath = result.commonDataPath;
      owner.dataPath = result.dataPath;
      status = { state: 'online', symbol: owner.symbol, message: 'Вход подтверждён. Загружаются котировки…', zoneCount: 0 };
      void seed(owner);
      return state();
    } catch (error) {
      if (session === owner) await disconnect(error.message);
      return state();
    }
  }

  return { connect, disconnect, state, terminalDataPath: () => session?.dataPath };
}
