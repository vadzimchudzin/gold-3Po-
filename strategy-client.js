import { marketSymbol, marketFeedId } from './mt5-client.js';

// Strategy profiles and the signals of the active one.
// A profile is saved as an immutable version: the conditions below and, when the box is ticked, the
// zone and footprint settings in use. Applying a profile switches all of it on the service at once.
const $ = id => document.getElementById(id);
const statusNode = $('setupStatus');
let library = null;
let deleteArmed = null;

const say = message => { if (statusNode) statusNode.textContent = message; };
const sideText = side => side === 'long' ? 'ЛОНГ' : side === 'short' ? 'ШОРТ' : String(side || '').toUpperCase();
const apiError = (data, fallback) => data?.error === 'license_required' ? 'нужна активная лицензия' : (data?.message || data?.error || fallback);
const intervalMs = () => Number(window.gold3poIntervalMs?.()) || 900000;
const timeText = ms => window.gold3poFormatTime ? window.gold3poFormatTime(ms) : new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const NUMBER_FIELDS = {
  condMinScore: ['minScore', 0.55], condAtrPeriod: ['atrPeriod', 14, true], condTrendPeriod: ['trendPeriod', 20, true],
  condCloseEdgeThreshold: ['closeEdgeThreshold', 0.65], condMinBodyRatio: ['minBodyRatio', 0], condMaxBodyRatio: ['maxBodyRatio', 1],
  condMinWickRatio: ['minWickRatio', 0], condMinVolume: ['minVolume', 0], condMinDeltaRatio: ['minDeltaRatio', 0],
  condMinAtr: ['minAtr', 0], condMaxAtr: ['maxAtr', 0], condCooldownBars: ['cooldownBars', 0, true],
  condWeightRejection: ['weightRejection', 0.15], condWeightCloseEdge: ['weightCloseEdge', 0.10],
  condWeightStacked: ['weightStacked', 0.15], condWeightDelta: ['weightDelta', 0.10]
};
const CHECK_FIELDS = { condRejection: 'requireRejection', condCloseEdge: 'requireCloseEdge', condStacked: 'requireStacked', condDelta: 'requireDeltaAgree',
  condAbsorption: 'requireAbsorption', condExhaustion: 'requireExhaustion', condUnfinished: 'requireUnfinished' };

function fillFields(definition) {
  const s = definition?.strategy || {};
  for (const [id, [key, fallback]] of Object.entries(NUMBER_FIELDS)) if ($(id)) $(id).value = String(s[key] ?? fallback);
  for (const [id, key] of Object.entries(CHECK_FIELDS)) if ($(id)) $(id).checked = Boolean(s[key]);
  if ($('condEntryMode')) $('condEntryMode').value = s.entryMode ?? 'sweep';
  if ($('condTrendFilter')) $('condTrendFilter').value = s.trendFilter ?? 'none';
  const sides = Array.isArray(s.allowedSides) ? s.allowedSides : ['long', 'short'];
  if ($('condSides')) $('condSides').value = sides.length === 2 ? 'both' : sides[0];
  if ($('condSessionFrom')) $('condSessionFrom').value = s.sessionHoursUTC ? String(s.sessionHoursUTC[0]) : '';
  if ($('condSessionTo')) $('condSessionTo').value = s.sessionHoursUTC ? String(s.sessionHoursUTC[1]) : '';
}

function collectDefinition() {
  const strategy = {};
  for (const [id, [key, fallback, integer]] of Object.entries(NUMBER_FIELDS)) {
    const value = Number($(id)?.value);
    strategy[key] = Number.isFinite(value) ? (integer ? Math.round(value) : value) : fallback;
  }
  for (const [id, key] of Object.entries(CHECK_FIELDS)) strategy[key] = Boolean($(id)?.checked);
  strategy.entryMode = $('condEntryMode')?.value || 'sweep';
  strategy.trendFilter = $('condTrendFilter')?.value || 'none';
  const sides = $('condSides')?.value || 'both';
  strategy.allowedSides = sides === 'both' ? ['long', 'short'] : [sides];
  const from = $('condSessionFrom')?.value ?? '', to = $('condSessionTo')?.value ?? '';
  strategy.sessionHoursUTC = from !== '' && to !== '' ? [Number(from), Number(to)] : null;
  const definition = { strategy };
  const current = window.gold3poSettings;
  if ($('setupWithSettings')?.checked && current?.zones && current?.footprint) { definition.zones = current.zones; definition.footprint = current.footprint; }
  return definition;
}

function renderLibrary() {
  const select = $('setupSelect');
  if (!select || !library) return;
  const previous = select.value;
  select.innerHTML = '';
  const builtIn = document.createElement('option');
  builtIn.value = '';
  builtIn.textContent = 'Встроенные условия';
  select.appendChild(builtIn);
  for (const setup of library.setups) {
    for (const version of [...setup.versions].reverse()) {
      const option = document.createElement('option');
      option.value = setup.id + '|' + version.version;
      option.textContent = setup.name + (setup.versions.length > 1 ? ' · версия ' + version.version : '') + (setup.id === library.activeId && version.version === library.activeVersion ? ' — активен' : '');
      select.appendChild(option);
    }
  }
  if (library.activeId) select.value = library.activeId + '|' + library.activeVersion;
  else if ([...select.options].some(o => o.value === previous)) select.value = previous;
  fillFields(library.activeDefinition);
  const active = library.setups.find(s => s.id === library.activeId);
  if ($('setupName') && active && !$('setupName').value) $('setupName').value = active.name;
  say(active ? `Активен профиль «${active.name}»${active.versions.length > 1 ? ', версия ' + library.activeVersion : ''}. Изменили условия — сохраните, появится новая версия.` : 'Работают встроенные условия. Настройте их под себя и сохраните как профиль.');
}

async function loadLibrary() {
  try {
    const response = await fetch('/v1/setups', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { say('Профили недоступны: ' + apiError(data, 'HTTP ' + response.status)); return; }
    library = data;
    renderLibrary();
  } catch (error) { say('Профили недоступны: ' + error.message); }
}

async function send(url, method, body) {
  const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiError(data, 'HTTP ' + response.status));
  return data;
}

const announce = () => window.dispatchEvent(new CustomEvent('setups-changed'));
const selected = () => { const value = $('setupSelect')?.value || ''; if (!value) return null; const [id, version] = value.split('|'); return { id, version: Number(version) }; };

$('setupSelect')?.addEventListener('change', async () => {
  const pick = selected();
  disarmDelete();
  if (!pick) { fillFields({ strategy: {} }); say('Встроенные условия. Нажмите «Применить», чтобы вернуться к ним.'); return; }
  try {
    const response = await fetch('/v1/setups/export?id=' + encodeURIComponent(pick.id) + '&version=' + pick.version, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(apiError(data, 'HTTP ' + response.status));
    fillFields(data.definition);
    if ($('setupName')) $('setupName').value = data.name;
    say(`Показан профиль «${data.name}»${data.definition.zones ? ' (с настройками зон и футпринта)' : ''}. Нажмите «Применить», чтобы включить его.`);
  } catch (error) { say('Не удалось открыть профиль: ' + error.message); }
});

$('saveSetup')?.addEventListener('click', async () => {
  const name = ($('setupName')?.value || '').trim();
  if (!name) { say('Введите название профиля.'); $('setupName')?.focus(); return; }
  try {
    const result = await send('/v1/setups', 'POST', { name, definition: collectDefinition() });
    await loadLibrary();
    say(result.deduplicated ? `Такие условия уже сохранены в «${name}».` : `Сохранено: «${name}»${result.version > 1 ? ', версия ' + result.version : ''}. Нажмите «Применить», чтобы включить.`);
    if (result.setupId && $('setupSelect')) $('setupSelect').value = result.setupId + '|' + result.version;
  } catch (error) { say('Не сохранено: ' + error.message); }
});

$('applySetup')?.addEventListener('click', async () => {
  const pick = selected();
  try {
    if (!pick) { await send('/v1/setups/clear', 'POST'); await loadLibrary(); say('Включены встроенные условия. Настройки зон и футпринта не изменились.'); announce(); return; }
    const applied = await send('/v1/setups/apply', 'POST', { id: pick.id, version: pick.version });
    if (applied.settings) window.dispatchEvent(new CustomEvent('gold3po-settings-replaced', { detail: applied.settings }));
    library = applied; renderLibrary();
    const active = applied.setups.find(s => s.id === applied.activeId);
    say(`Профиль «${active?.name || ''}» включён${applied.activeDefinition?.zones ? ' вместе с его зонами, футпринтом и таймфреймом' : ''}.`);
    announce();
  } catch (error) { say('Не применено: ' + error.message); }
});

function disarmDelete() { if (!deleteArmed) return; clearTimeout(deleteArmed); deleteArmed = null; if ($('deleteSetup')) $('deleteSetup').textContent = 'Удалить'; }
$('deleteSetup')?.addEventListener('click', async () => {
  const pick = selected();
  if (!pick) { say('Выберите профиль, который нужно удалить.'); return; }
  // A second click within a few seconds confirms: a deleted profile cannot be restored.
  if (!deleteArmed) { $('deleteSetup').textContent = 'Удалить навсегда?'; deleteArmed = setTimeout(disarmDelete, 4000); return; }
  disarmDelete();
  try {
    const name = library?.setups.find(s => s.id === pick.id)?.name || '';
    library = await send('/v1/setups?id=' + encodeURIComponent(pick.id), 'DELETE');
    if ($('setupName')) $('setupName').value = '';
    renderLibrary();
    say(`Профиль «${name}» удалён со всеми версиями.`);
    announce();
  } catch (error) { say('Не удалено: ' + error.message); }
});

$('exportSetup')?.addEventListener('click', async () => {
  const pick = selected();
  if (!pick) { say('Выберите профиль для экспорта.'); return; }
  try {
    const response = await fetch('/v1/setups/export?id=' + encodeURIComponent(pick.id) + '&version=' + pick.version, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(apiError(data, 'HTTP ' + response.status));
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    link.download = 'gold3po-profile-' + data.name.replace(/[^\wа-яё.-]+/gi, '-') + '-v' + data.version + '.json';
    link.click();
    URL.revokeObjectURL(link.href);
    say(`Профиль «${data.name}» сохранён в файл.`);
  } catch (error) { say('Не экспортировано: ' + error.message); }
});

$('importSetup')?.addEventListener('click', () => $('importSetupFile')?.click());
$('importSetupFile')?.addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const name = (parsed.name || file.name.replace(/\.json$/i, '')).slice(0, 60);
    await send('/v1/setups/import', 'POST', { name, definition: parsed.definition || parsed });
    await loadLibrary();
    say(`Профиль «${name}» импортирован. Выберите его и нажмите «Применить».`);
  } catch (error) { say('Импорт отклонён: ' + error.message); }
  event.target.value = '';
});

const BASE = { minScore: 0.55, atrPeriod: 14, entryMode: 'sweep', trendFilter: 'none', trendPeriod: 20, closeEdgeThreshold: 0.65, minBodyRatio: 0, maxBodyRatio: 1, minWickRatio: 0, minVolume: 0, minDeltaRatio: 0, minAtr: 0, maxAtr: 0, cooldownBars: 0, weightRejection: 0.15, weightCloseEdge: 0.10, weightStacked: 0.15, weightDelta: 0.10, requireRejection: false, requireCloseEdge: false, requireStacked: false, requireDeltaAgree: false, requireAbsorption: false, requireExhaustion: false, requireUnfinished: false, allowedSides: ['long', 'short'], sessionHoursUTC: null };
const PRESETS = {
  base: { name: 'Снятие ликвидности', strategy: { ...BASE } },
  pinbar: { name: 'Пин-бар + дельта', strategy: { ...BASE, minScore: 0.6, closeEdgeThreshold: 0.7, maxBodyRatio: 0.45, minWickRatio: 0.45, minDeltaRatio: 0.15, cooldownBars: 2, weightRejection: 0.2, weightCloseEdge: 0.15, weightStacked: 0.1, weightDelta: 0.15, requireRejection: true, requireCloseEdge: true, requireDeltaAgree: true, sessionHoursUTC: [7, 20] } },
  imbalance: { name: 'Стек имбалансов по тренду', strategy: { ...BASE, entryMode: 'imbalance', trendFilter: 'with', minBodyRatio: 0.35, minDeltaRatio: 0.25, cooldownBars: 3, weightRejection: 0.1, weightStacked: 0.25, weightDelta: 0.15, requireRejection: true, requireStacked: true, requireDeltaAgree: true } },
  absorption: { name: 'Поглощение против толпы', strategy: { ...BASE, entryMode: 'absorption', trendFilter: 'counter', closeEdgeThreshold: 0.6, minWickRatio: 0.25, cooldownBars: 2, requireAbsorption: true } }
};
$('setupPresets')?.addEventListener('click', event => {
  const button = event.target.closest('button[data-preset]');
  const preset = button && PRESETS[button.dataset.preset];
  if (!preset) return;
  fillFields(preset);
  if ($('setupName')) $('setupName').value = preset.name;
  say(`Шаблон «${preset.name}» подставлен. Подправьте условия под себя и нажмите «Сохранить».`);
});

// ---------------------------------------------------------------- signals of the active profile
let signalTimer = null, signalSerial = 0;
async function refreshSignals() {
  const serial = ++signalSerial, wanted = intervalMs();
  const params = new URLSearchParams({ symbol: marketSymbol(), intervalMs: String(wanted) });
  if (marketFeedId()) params.set('feedId', marketFeedId());
  try {
    const response = await fetch('/v1/market/signals?' + params, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (serial !== signalSerial || wanted !== intervalMs()) return;
    if (!response.ok) { $('signalMonitor').textContent = 'Сигналы недоступны: ' + apiError(data, 'HTTP ' + response.status); return; }
    const signals = Array.isArray(data.signals) ? data.signals : [];
    window.dispatchEvent(new CustomEvent('gold3po-signals', { detail: { signals, intervalMs: data.intervalMs } }));
    const profile = data.strategy ? `Профиль «${data.strategy.name}»` : 'Встроенные условия';
    const latest = data.latest;
    $('signalMonitor').textContent = latest
      ? `${sideText(latest.side)} от ${Number(latest.level).toFixed(2)} · ${timeText(latest.timeMs)} · оценка ${Math.round(latest.technicalScore * 100)}/100${latest.closed ? '' : ' · свеча ещё формируется'}`
      : `${profile}: на свечах графика сигналов нет.`;
    const list = $('signalList');
    if (list) list.innerHTML = signals.slice(-8).reverse().map(signal => `<div class="signal-row ${signal.side}"><b>${sideText(signal.side)}</b><span>${timeText(signal.timeMs)}</span><span>${Number(signal.level).toFixed(2)}</span><span>${Math.round(signal.technicalScore * 100)}</span><small>${(signal.evidence || []).slice(0, 3).join(' · ')}</small></div>`).join('');
    if ($('signalMeta')) $('signalMeta').textContent = `${profile} · сигналов на графике: ${signals.length}. Оценка — сумма весов выполненных условий, не вероятность. Не является торговой рекомендацией.`;
  } catch { /* the next chart reload retries */ }
}
const scheduleSignals = (delay = 1200) => { clearTimeout(signalTimer); signalTimer = setTimeout(refreshSignals, delay); };
window.addEventListener('market-analysis', () => scheduleSignals());
window.addEventListener('setups-changed', () => scheduleSignals(100));
window.addEventListener('gold3po-timeframe', () => scheduleSignals(600));
window.addEventListener('gold3po-settings', () => scheduleSignals(800));
window.addEventListener('mt5-feed-change', () => scheduleSignals(400));
window.addEventListener('license-activated', () => { loadLibrary(); scheduleSignals(400); });

loadLibrary();
scheduleSignals(400);
