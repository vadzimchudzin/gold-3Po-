import { tickSizeNote } from './mt5-status.js';
const $ = id => document.getElementById(id);
const bridge = window.goldMt5;
let symbol = 'XAUUSD';
let feedId = null;
export const marketSymbol = () => symbol;
export const marketFeedId = () => feedId;
export const hasMt5Bridge = () => Boolean(bridge);

const dialog = $('mt5Dialog');
const detail = $('mt5Detail');
let busy = false;

function render(status) {
  const connected = status.state === 'online';
  const nextFeedId = typeof status.feedId === 'string' ? status.feedId : null;
  if (nextFeedId !== feedId) {
    feedId = nextFeedId;
    window.dispatchEvent(new CustomEvent('mt5-feed-change', { detail: feedId }));
  }
  if (connected && status.symbol && status.symbol !== symbol) {
    symbol = status.symbol;
    if ($('marketSymbol')) $('marketSymbol').textContent = symbol;
    window.dispatchEvent(new CustomEvent('mt5-symbol-change'));
  }
  const tick = status.lastTick ? new Date(status.lastTick).toLocaleString() : '';
  const lines = [
    status.message,
    status.accountLabel,
    tick ? 'Последний тик: ' + tick + '.' : '',
    connected ? tickSizeNote(status) : '',
    status.integrationMessage || ''
  ].filter(Boolean);
  if (detail) detail.textContent = lines.join(' ');
  const pending = status.state === 'connecting' || status.state === 'reconnecting';
  const label = connected
    ? 'MT5 · ' + status.symbol + (status.feed === 'stale' ? ' · нет тиков' : '')
    : status.state === 'reconnecting' ? 'MT5 · переподключение…'
    : status.state === 'connecting' ? 'MT5 · поиск…' : 'Подключить MT5';
  $('mt5Open').textContent = label;
  $('mt5Open').dataset.state = status.state;
  $('mt5Connect').disabled = !bridge || busy || connected || pending;
  $('mt5Disconnect').disabled = !bridge || busy || (!connected && !pending);
  $('mt5InstallIntegration').disabled = !bridge || busy || !connected;
}

const unavailable = {
  state: 'offline',
  message: 'Автоподключение MT5 доступно только в настольной версии GOLD-3Po для Windows.'
};

async function refresh() {
  if (!bridge) { render(unavailable); return; }
  if (!busy) render(await bridge.state());
}

function report(error) {
  if (detail) detail.textContent = error?.message || 'Не удалось выполнить операцию MT5.';
}

async function connect() {
  if (!bridge || busy) return;
  busy = true;
  render({ state: 'connecting', message: 'Ищем уже авторизованный терминал MetaTrader 5…' });
  try {
    const state = await bridge.connect();
    busy = false;
    render(state);
  } catch (error) {
    busy = false;
    try { await refresh(); } catch { /* keep the operation error visible */ }
    report(error);
  }
}

async function installIntegration() {
  if (!bridge || busy) return;
  busy = true;
  render({ ...(await bridge.state()), message: 'Обновляем мост и индикатор в каталоге MT5…' });
  try {
    const result = await bridge.installIntegration();
    busy = false;
    await refresh();
    if (detail) detail.textContent = result.message;
  } catch (error) {
    busy = false;
    try { await refresh(); } catch { /* preserve the operation error */ }
    report(error);
  }
}

if (dialog) {
  $('mt5Open').addEventListener('click', () => {
    dialog.showModal();
    void refresh().catch(report);
  });
  $('mt5Close').addEventListener('click', () => dialog.close());
  $('mt5Connect').addEventListener('click', () => void connect());
  $('mt5Disconnect').addEventListener('click', async () => {
    if (!bridge || busy) return;
    try { render(await bridge.disconnect()); }
    catch (error) { report(error); }
  });
  $('mt5InstallIntegration').addEventListener('click', () => void installIntegration());
  void refresh().catch(report);
  if (bridge) window.setInterval(() => void refresh().catch(report), 2500);
}
