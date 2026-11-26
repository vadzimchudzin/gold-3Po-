import { createAlertEngine, normalizeAlerts } from './alert-engine.js';

// Alerts: price levels, zone touches and new signals of the active strategy profile. They are checked
// on every live tick in this window and ring with a Windows notification, a sound and a line in the log.
// Kept on this computer (localStorage), like the window layout.
const $ = id => document.getElementById(id);
const STORE = 'gold3po-alerts';
const engine = createAlertEngine();
let state = load();
let zones = [];
let audio = null;
const log = [];

function load() { try { return normalizeAlerts(JSON.parse(localStorage.getItem(STORE) || 'null')); } catch { return normalizeAlerts(null); } }
function save() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch {} window.dispatchEvent(new CustomEvent('gold3po-alerts-changed')); }
const price2 = value => Number(value).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clock = ms => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const escape = text => String(text).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
function toast(message) { const node = $('toast'); if (!node) return; node.textContent = message; node.classList.add('visible'); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('visible'), 4000); }

function beep() {
  if (!state.rules.sound) return;
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const start = audio.currentTime;
    for (const [offset, freq] of [[0, 880], [0.16, 1175]]) {
      const osc = audio.createOscillator(), gain = audio.createGain();
      osc.frequency.value = freq; osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.18, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.14);
      osc.connect(gain).connect(audio.destination);
      osc.start(start + offset); osc.stop(start + offset + 0.15);
    }
  } catch { /* no audio device: the notification and the log still show it */ }
}

function describe(event) {
  if (event.kind === 'price') return { title: `XAUUSD ${event.direction === 'up' ? 'поднялся до' : 'опустился до'} ${price2(event.price)}`, body: event.note || 'Ценовой алерт сработал.' };
  if (event.kind === 'zone') return { title: `Цена в зоне ${price2(event.zone.low)} — ${price2(event.zone.high)}`, body: `Сила зоны ${Math.round(event.zone.strength * 100)}%. ${event.zone.side === 'buy' ? 'Зона выше цены — подход снизу.' : 'Зона ниже цены — подход сверху.'}` };
  const s = event.signal;
  return { title: `Сигнал ${s.side === 'long' ? 'ЛОНГ' : 'ШОРТ'} от ${price2(s.level)}`, body: `Оценка ${Math.round(s.technicalScore * 100)}/100. ${(s.evidence || []).slice(0, 2).join(' · ')}` };
}

function fire(events) {
  if (!events.length) return;
  for (const event of events) {
    const { title, body } = describe(event);
    log.unshift({ at: Date.now(), title });
    toast('🔔 ' + title);
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification('GOLD-3Po · ' + title, { body, tag: event.kind + ':' + event.id, silent: true }); } catch {}
    }
  }
  log.splice(6);
  beep();
  renderLog();
  if (events.some(e => e.kind === 'price')) { save(); renderList(); }
}

function renderList() {
  const node = $('alertList');
  if (!node) return;
  if (!state.alerts.length) { node.innerHTML = '<div class="alert-empty">Ценовых алертов нет.</div>'; return; }
  const sorted = [...state.alerts].sort((a, b) => b.price - a.price);
  node.innerHTML = sorted.map(a => `<div class="alert-row ${a.active ? '' : 'is-done'}" data-id="${escape(a.id)}"><b>${price2(a.price)}</b><span>${escape(a.note || (a.active ? 'ждёт пересечения' : ''))}${a.active ? '' : ' · сработал ' + clock(a.triggeredAt)}</span>${a.active ? '' : '<button type="button" data-act="rearm" title="Включить снова">↺</button>'}<button type="button" data-act="remove" title="Удалить алерт" aria-label="Удалить алерт">×</button></div>`).join('');
}
function renderLog() { const node = $('alertLog'); if (node) node.textContent = log.length ? log.map(item => `${clock(item.at)} · ${item.title}`).join('\n') : 'Сработавшие алерты появятся здесь.'; }
function renderRules() {
  if ($('alertZones')) $('alertZones').checked = state.rules.zones;
  if ($('alertSignals')) $('alertSignals').checked = state.rules.signals;
  if ($('alertSound')) $('alertSound').checked = state.rules.sound;
  if ($('alertZoneStrength')) $('alertZoneStrength').value = String(Math.round(state.rules.zoneMinStrength * 100));
  if ($('alertZoneStrengthValue')) $('alertZoneStrengthValue').textContent = Math.round(state.rules.zoneMinStrength * 100) + '%';
  renderPermission();
}
function renderPermission() {
  const button = $('enableAlerts');
  if (!button) return;
  const granted = 'Notification' in window && Notification.permission === 'granted';
  button.textContent = granted ? 'Уведомления включены' : 'Разрешить уведомления';
  button.disabled = granted || !('Notification' in window);
}

function add(price, note = '') {
  const value = Number(price);
  if (!(value > 0)) { toast('Укажите цену алерта.'); return false; }
  if (state.alerts.length >= 50) { toast('Не больше 50 алертов — удалите лишние.'); return false; }
  state.alerts.push({ id: 'A-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), price: Number(value.toFixed(5)), note: String(note).slice(0, 80), active: true, createdAt: Date.now(), triggeredAt: null });
  save(); renderList();
  toast(`Алерт на ${price2(value)} добавлен.`);
  return true;
}

$('addAlert')?.addEventListener('click', () => { if (add($('alertPrice')?.value, $('alertNote')?.value || '')) { $('alertPrice').value = ''; $('alertNote').value = ''; } });
$('alertPrice')?.addEventListener('keydown', e => { if (e.key === 'Enter') $('addAlert')?.click(); });
$('alertFromChart')?.addEventListener('click', () => { window.dispatchEvent(new CustomEvent('gold3po-alert-pick', { detail: { on: true } })); document.querySelector('.price-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
$('alertList')?.addEventListener('click', e => {
  const button = e.target.closest('button[data-act]'), row = e.target.closest('[data-id]');
  if (!button || !row) return;
  const alert = state.alerts.find(a => a.id === row.dataset.id);
  if (!alert) return;
  if (button.dataset.act === 'remove') state.alerts = state.alerts.filter(a => a !== alert);
  else { alert.active = true; alert.triggeredAt = null; }
  save(); renderList();
});
for (const [id, key] of [['alertZones', 'zones'], ['alertSignals', 'signals'], ['alertSound', 'sound']]) $(id)?.addEventListener('change', e => { state.rules[key] = e.target.checked; save(); });
$('alertZoneStrength')?.addEventListener('input', e => { state.rules.zoneMinStrength = Number(e.target.value) / 100; renderRules(); save(); });
$('enableAlerts')?.addEventListener('click', async () => {
  if (!('Notification' in window)) return;
  try { await Notification.requestPermission(); } catch {}
  renderPermission();
  try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); await audio.resume(); } catch {}
});

window.addEventListener('gold3po-alert-add', e => add(e.detail?.price, e.detail?.note || ''));
window.addEventListener('gold3po-alert-remove', e => { state.alerts = state.alerts.filter(a => a.id !== e.detail?.id); save(); renderList(); });
window.addEventListener('market-analysis', e => { zones = Array.isArray(e.detail?.zones) ? e.detail.zones : []; });
window.addEventListener('market-tick', e => { const p = Number(e.detail?.last); if (p > 0) fire(engine.onPrice(p, { alerts: state.alerts, zones, rules: state.rules })); });
window.addEventListener('gold3po-signals', e => fire(engine.onSignals((e.detail?.signals || []).filter(s => s.closed), state.rules)));
for (const name of ['gold3po-timeframe', 'mt5-feed-change', 'mt5-symbol-change', 'setups-changed']) window.addEventListener(name, () => engine.reset());

// The chart draws the active price alerts as lines.
window.gold3poAlerts = Object.freeze({ list: () => state.alerts.map(a => ({ ...a })), add, remove: id => window.dispatchEvent(new CustomEvent('gold3po-alert-remove', { detail: { id } })) });
renderList(); renderRules(); renderLog();
