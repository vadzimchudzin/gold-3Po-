// Settings sheet (Vespera style): zone finder, MT5 drawing style and theme.
// Every change is saved to /v1/settings right away; the MT5 indicator picks it up on its next refresh.
const $ = id => document.getElementById(id);
const DEFAULTS = { zones: { minZones: 3, maxZones: 7, pivotWidth: 2, atrPeriod: 14, clusterAtr: 0.35, zoneWidthAtr: 0.15, maxDistanceAtr: 15, reactionBars: 6, timeframeMinutes: 15, usePriorDay: true, useSessions: true, useWeek: true, useHigherTf: true, useVolume: true, strongOnly: false },
  footprint: { imbalanceRatio: 3, imbalanceLevels: 3, minLevelVolume: 3, valueAreaShare: 0.7, absorptionMultiple: 2, ticksPerRow: 1, autoStep: true },
  mt5: { buyColor: '#FF0000', sellColor: '#FF0000', lineStyle: 'solid', lineWidth: 2, fill: false, fillStyle: 'gradient', fillOpacity: 0.22, glow: true, showLabels: true, showStrength: true, zonesVisible: true }, ui: { theme: 'glass-dark' } };
const ZONE_STYLE_PRESETS = {
  classic:  { buyColor: '#F45D5D', sellColor: '#2ED3A7', lineStyle: 'solid', lineWidth: 2, fill: true,  fillStyle: 'gradient', fillOpacity: 0.22, glow: true,  showLabels: true,  showStrength: true },
  neon:     { buyColor: '#FF4D8D', sellColor: '#00F5D4', lineStyle: 'solid', lineWidth: 2, fill: true,  fillStyle: 'solid',    fillOpacity: 0.26, glow: true,  showLabels: true,  showStrength: true },
  terminal: { buyColor: '#FFC799', sellColor: '#60A5FA', lineStyle: 'dash',  lineWidth: 1, fill: true,  fillStyle: 'stripe',   fillOpacity: 0.24, glow: true,  showLabels: true,  showStrength: false },
  minimal:  { buyColor: '#EF4444', sellColor: '#22C55E', lineStyle: 'dot',   lineWidth: 1, fill: false, fillStyle: 'outline',  fillOpacity: 0.10, glow: false, showLabels: false, showStrength: false }
};
const SWATCHES = ['#FF0000', '#FF4D4D', '#FF8800', '#FFC799', '#FFD60A', '#30D158', '#0A84FF', '#BF5AF2', '#FFFFFF'];
const TF_LABEL = { 5: '5м', 15: '15м', 30: '30м', 60: '1ч', 240: '4ч' };
const DASH = { solid: '', dash: '10 6', dot: '2 5', dashdot: '10 5 2 5' };

let settings = structuredClone(DEFAULTS);
let saveTimer = null, pending = {};
window.gold3poSettings = settings;
window.gold3poIntervalMs = () => (settings.zones.timeframeMinutes || 15) * 60000;

const theme = name => { document.documentElement.dataset.theme = name === 'glass-light' ? 'glass-light' : 'glass-dark';
  try { localStorage.setItem('gold3po-theme', document.documentElement.dataset.theme); } catch {} };
try { theme(localStorage.getItem('gold3po-theme') || 'glass-dark'); } catch {}

function status(text, kind = '') { const el = $('settingsStatus'); if (!el) return; el.textContent = text; el.dataset.kind = kind; }

function setSeg(id, value) { $(id)?.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.value === String(value))); }
function setToggle(id, on) { const el = $(id); if (!el) return; el.classList.toggle('on', !!on); el.setAttribute('aria-pressed', String(!!on)); }

function preview() {
  const svg = $('stylePreview'); if (!svg) return;
  const m = settings.mt5, w = m.lineStyle === 'solid' ? m.lineWidth : 1;
  const op = Number(m.fillOpacity ?? 0.22);
  const style = m.fillStyle || 'gradient';
  const defs = `<defs><linearGradient id="prevBuyGrad" x1="0" x2="1"><stop offset="0%" stop-color="${m.buyColor}" stop-opacity="${op}"/><stop offset="100%" stop-color="${m.buyColor}" stop-opacity="${(op * 0.25).toFixed(2)}"/></linearGradient><linearGradient id="prevSellGrad" x1="0" x2="1"><stop offset="0%" stop-color="${m.sellColor}" stop-opacity="${op}"/><stop offset="100%" stop-color="${m.sellColor}" stop-opacity="${(op * 0.25).toFixed(2)}"/></linearGradient><pattern id="prevStripe" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" stroke-width="1.5" stroke-opacity=".4"/></pattern></defs>`;
  const zone = (y1, y2, color, gradId, text) => {
    const showFill = style !== 'outline' && (m.fill || style === 'gradient' || style === 'stripe');
    const fillAttr = style === 'gradient' ? `url(#${gradId})` : color;
    const fillOp = style === 'gradient' ? 1 : op;
    return `${showFill ? `<rect x="0" y="${y1}" width="320" height="${y2 - y1}" fill="${fillAttr}" opacity="${fillOp}"/>` : ''}`
      + `${style === 'stripe' ? `<rect x="0" y="${y1}" width="320" height="${y2 - y1}" fill="url(#prevStripe)" opacity="${Math.min(1, op * 2)}"/>` : ''}`
      + `<line x1="0" x2="320" y1="${y1}" y2="${y1}" stroke="${color}" stroke-width="${w}" stroke-dasharray="${DASH[m.lineStyle]}"/>`
      + `<line x1="0" x2="320" y1="${y2}" y2="${y2}" stroke="${color}" stroke-width="${w}" stroke-dasharray="${DASH[m.lineStyle]}"/>`
      + (m.showLabels ? `<text x="314" y="${y1 - 4}" text-anchor="end" fill="${color}" font-size="9">${text}${m.showStrength ? ' | 72%' : ''}</text>` : '');
  };
  const candles = [[40, 46, 62], [70, 52, 70], [100, 44, 58], [130, 50, 66], [160, 40, 54], [190, 47, 60], [220, 42, 57], [250, 49, 63]]
    .map(([x, a, b], i) => `<line x1="${x}" x2="${x}" y1="${a - 6}" y2="${b + 6}" stroke="currentColor" opacity=".35"/><rect x="${x - 5}" y="${a}" width="10" height="${b - a}" rx="1.5" fill="${i % 2 ? 'var(--red)' : 'var(--cyan)'}" opacity=".75"/>`).join('');
  svg.innerHTML = defs + zone(18, 28, m.buyColor, 'prevBuyGrad', 'Повторный максимум · ПРОВЕРЕНА') + candles + zone(76, 86, m.sellColor, 'prevSellGrad', 'Повторный минимум · НЕ ПРОВЕРЕНА');
}

function render() {
  const z = settings.zones, m = settings.mt5;
  const set = (id, v) => { if ($(id)) $(id).value = String(v); };
  set('setMinZones', z.minZones); set('setMaxZones', z.maxZones); set('setPivotWidth', z.pivotWidth); set('setClusterAtr', z.clusterAtr);
  set('setZoneWidthAtr', z.zoneWidthAtr); set('setMaxDistanceAtr', z.maxDistanceAtr); set('setAtrPeriod', z.atrPeriod); set('setReactionBars', z.reactionBars);
  $('zoneCountValue') && ($('zoneCountValue').textContent = z.minZones === z.maxZones ? String(z.maxZones) : `${z.minZones}–${z.maxZones}`);
  $('pivotWidthValue') && ($('pivotWidthValue').textContent = `${z.pivotWidth} бар${z.pivotWidth === 1 ? '' : z.pivotWidth < 5 ? 'а' : 'ов'} с каждой стороны`);
  $('clusterAtrValue') && ($('clusterAtrValue').textContent = `${Number(z.clusterAtr).toFixed(2)} ATR`);
  $('zoneWidthAtrValue') && ($('zoneWidthAtrValue').textContent = `${Number(z.zoneWidthAtr).toFixed(2)} ATR`);
  $('maxDistanceAtrValue') && ($('maxDistanceAtrValue').textContent = `${z.maxDistanceAtr} ATR от цены`);
  $('atrPeriodValue') && ($('atrPeriodValue').textContent = String(z.atrPeriod));
  $('reactionBarsValue') && ($('reactionBarsValue').textContent = `${z.reactionBars} бар${z.reactionBars === 1 ? '' : z.reactionBars < 5 ? 'а' : 'ов'}`);
  const f = settings.footprint;
  set('setImbalanceRatio', f.imbalanceRatio); set('setValueAreaShare', Math.round(f.valueAreaShare * 100)); set('setAbsorptionMultiple', f.absorptionMultiple);
  set('setImbalanceLevels', f.imbalanceLevels); set('setMinLevelVolume', f.minLevelVolume); set('setTicksPerRow', f.ticksPerRow ?? 1);
  $('ticksPerRowValue') && ($('ticksPerRowValue').textContent = f.autoStep ? 'Авто (под масштаб)' : ((f.ticksPerRow ?? 1) === 1 ? 'точность источника' : `${f.ticksPerRow} шагов цены`));
  $('imbalanceRatioValue') && ($('imbalanceRatioValue').textContent = `${Math.round(f.imbalanceRatio * 100)}%`);
  $('valueAreaShareValue') && ($('valueAreaShareValue').textContent = `${Math.round(f.valueAreaShare * 100)}%`);
  $('absorptionMultipleValue') && ($('absorptionMultipleValue').textContent = `${Number(f.absorptionMultiple).toFixed(1)}× медианы`);
  $('imbalanceLevelsValue') && ($('imbalanceLevelsValue').textContent = `${f.imbalanceLevels} подряд`);
  $('minLevelVolumeValue') && ($('minLevelVolumeValue').textContent = `${f.minLevelVolume} ед. объёма`);
  setSeg('setTimeframe', z.timeframeMinutes);
  set('setBuyColor', m.buyColor.toLowerCase()); set('setSellColor', m.sellColor.toLowerCase());
  setSeg('setLineStyle', m.lineStyle);
  setSeg('setFillStyle', m.fillStyle || 'gradient');
  set('setFillOpacity', Math.round((m.fillOpacity ?? 0.22) * 100));
  $('fillOpacityValue') && ($('fillOpacityValue').textContent = `${Math.round((m.fillOpacity ?? 0.22) * 100)}%`);
  set('setLineWidth', m.lineWidth);
  if ($('setLineWidth')) $('setLineWidth').disabled = m.lineStyle !== 'solid';
  $('lineWidthValue') && ($('lineWidthValue').textContent = String(m.lineWidth));
  $('lineWidthNote') && ($('lineWidthNote').hidden = m.lineStyle === 'solid');
  document.querySelectorAll('.swatches').forEach(box => box.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.color === m[box.dataset.for === 'setBuyColor' ? 'buyColor' : 'sellColor'])));
  setToggle('setFill', m.fill); setToggle('setGlow', m.glow !== false); setToggle('setLabels', m.showLabels); setToggle('setStrength', m.showStrength); setToggle('setZonesVisible', m.zonesVisible !== false);
  setToggle('setSrcDay', z.usePriorDay); setToggle('setSrcSessions', z.useSessions); setToggle('setSrcWeek', z.useWeek); setToggle('setSrcTf', z.useHigherTf); setToggle('setSrcVolume', z.useVolume); setToggle('setStrongOnly', z.strongOnly);
  const strongBtn = $('strongZonesToggle');
  if (strongBtn) { strongBtn.setAttribute('aria-pressed', String(!!z.strongOnly)); strongBtn.classList.toggle('is-active', !!z.strongOnly); }
  const stepSel = $('footClusterStep');
  if (stepSel) stepSel.value = f.autoStep ? 'auto' : String(f.ticksPerRow ?? 1);
  setSeg('setTheme', settings.ui.theme);
  document.querySelectorAll('.timeframe-label').forEach(el => { const cap = TF_LABEL[z.timeframeMinutes] || (z.timeframeMinutes + 'м'); el.textContent = el.classList.contains('footprint-timeframe') ? `${cap} · ЕДИНЫЙ ТФ` : `${cap} · ТИКИ БРОКЕРА`; });
  preview();
}

function publish(changedZones) {
  window.gold3poSettings = settings;
  window.gold3poZoneStyle = () => ({ ...DEFAULTS.mt5, ...(settings.mt5 || {}) });
  window.dispatchEvent(new CustomEvent('gold3po-settings', { detail: { settings, zonesChanged: changedZones } }));
}

async function save() {
  const patch = pending; pending = {};
  // A new row size needs the broker's ticks at their own precision again, so it refetches like a zone change.
  const zonesChanged = !!patch.zones || !!(patch.footprint && ('ticksPerRow' in patch.footprint || 'autoStep' in patch.footprint));
  status('Сохранение…');
  try {
    const response = await fetch('/v1/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
    settings = body; render(); publish(zonesChanged);
    status('Сохранено', 'ok');
  } catch (error) {
    status(`Не сохранено: ${error.message}`, 'error');
    await load();
  }
}

// Apply locally at once (instant preview), save after a short pause so dragging a slider is one request.
function change(section, key, value) {
  settings = { ...settings, [section]: { ...settings[section], [key]: value } };
  // Keep min <= max while either slider is dragged.
  if (section === 'zones' && key === 'minZones' && value > settings.zones.maxZones) { settings.zones.maxZones = value; (pending.zones ||= {}).maxZones = value; }
  if (section === 'zones' && key === 'maxZones' && value < settings.zones.minZones) { settings.zones.minZones = value; (pending.zones ||= {}).minZones = value; }
  if (section === 'mt5' && key === 'lineStyle' && value !== 'solid') settings.mt5.lineWidth = 1;
  if (section === 'ui' && key === 'theme') theme(value);
  (pending[section] ||= {})[key] = value;
  render();
  if (section === 'mt5') publish(false);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 350);
}

async function load() {
  try {
    const response = await fetch('/v1/settings', { cache: 'no-store' });
    if (!response.ok) return false; // e.g. licence not active yet: keep defaults until it is
    settings = await response.json();
    theme(settings.ui?.theme);
    render(); publish(true);
    return true;
  } catch { return false; }
}

function bind() {
  const dialog = $('settingsDialog');
  if (!dialog) return;
  document.querySelectorAll('.swatches').forEach(box => {
    box.innerHTML = SWATCHES.map(c => `<button type="button" class="swatch" data-color="${c}" style="--swatch:${c}" title="${c}" aria-label="Цвет ${c}"></button>`).join('');
    box.addEventListener('click', e => { const b = e.target.closest('[data-color]'); if (b) change('mt5', box.dataset.for === 'setBuyColor' ? 'buyColor' : 'sellColor', b.dataset.color); });
  });
  const ranges = { setMinZones: 'minZones', setMaxZones: 'maxZones', setPivotWidth: 'pivotWidth', setClusterAtr: 'clusterAtr', setZoneWidthAtr: 'zoneWidthAtr', setMaxDistanceAtr: 'maxDistanceAtr', setAtrPeriod: 'atrPeriod', setReactionBars: 'reactionBars' };
  for (const [id, key] of Object.entries(ranges)) $(id)?.addEventListener('input', e => change('zones', key, Number(e.target.value)));
  const footprintRanges = { setImbalanceRatio: ['imbalanceRatio', Number], setAbsorptionMultiple: ['absorptionMultiple', Number], setValueAreaShare: ['valueAreaShare', v => Number(v) / 100], setImbalanceLevels: ['imbalanceLevels', Number], setMinLevelVolume: ['minLevelVolume', Number], setTicksPerRow: ['ticksPerRow', Number] };
  for (const [id, [key, cast]] of Object.entries(footprintRanges)) $(id)?.addEventListener('input', e => {
    if (key === 'ticksPerRow') { settings.footprint.autoStep = false; (pending.footprint ||= {}).autoStep = false; }
    change('footprint', key, cast(e.target.value));
  });
  $('setLineWidth')?.addEventListener('input', e => change('mt5', 'lineWidth', Number(e.target.value)));
  $('setFillOpacity')?.addEventListener('input', e => change('mt5', 'fillOpacity', Number(e.target.value) / 100));
  $('setBuyColor')?.addEventListener('input', e => change('mt5', 'buyColor', e.target.value.toUpperCase()));
  $('setSellColor')?.addEventListener('input', e => change('mt5', 'sellColor', e.target.value.toUpperCase()));
  const segs = { setTimeframe: ['zones', 'timeframeMinutes', Number], setLineStyle: ['mt5', 'lineStyle', String], setFillStyle: ['mt5', 'fillStyle', String], setTheme: ['ui', 'theme', String] };
  for (const [id, [section, key, cast]] of Object.entries(segs)) $(id)?.addEventListener('click', e => { const b = e.target.closest('button[data-value]'); if (b) change(section, key, cast(b.dataset.value)); });
  const toggles = { setFill: 'fill', setGlow: 'glow', setLabels: 'showLabels', setStrength: 'showStrength', setZonesVisible: 'zonesVisible' };
  $('zoneStylePresets')?.addEventListener('click', e => {
    const b = e.target.closest('button[data-preset]'); if (!b) return;
    const preset = ZONE_STYLE_PRESETS[b.dataset.preset]; if (!preset) return;
    settings = { ...settings, mt5: { ...settings.mt5, ...preset } };
    pending.mt5 = { ...(pending.mt5 || {}), ...preset };
    render(); publish(false);
    clearTimeout(saveTimer); saveTimer = setTimeout(save, 250);
  });
  for (const [id, key] of Object.entries(toggles)) $(id)?.addEventListener('click', () => {
    const next = !settings.mt5[key];
    change('mt5', key, next);
    // Hiding or restoring the zones in the terminal must not wait for the next zone poll.
    if (key === 'zonesVisible') void window.goldMt5?.setZonesVisible?.(next);
  });
  const zoneToggles = { setSrcDay: 'usePriorDay', setSrcSessions: 'useSessions', setSrcWeek: 'useWeek', setSrcTf: 'useHigherTf', setSrcVolume: 'useVolume', setStrongOnly: 'strongOnly' };
  for (const [id, key] of Object.entries(zoneToggles)) $(id)?.addEventListener('click', () => change('zones', key, !settings.zones[key]));
  $('strongZonesToggle')?.addEventListener('click', () => change('zones', 'strongOnly', !settings.zones.strongOnly));
  $('footClusterStep')?.addEventListener('change', e => {
    if (e.target.value === 'auto') {
      change('footprint', 'autoStep', true);
    } else {
      settings.footprint.autoStep = false;
      (pending.footprint ||= {}).autoStep = false;
      change('footprint', 'ticksPerRow', Number(e.target.value));
    }
  });
  $('settingsTabs')?.addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    $('settingsTabs').querySelectorAll('button').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); });
    dialog.querySelectorAll('.settings-pane').forEach(p => { p.hidden = p.dataset.pane !== b.dataset.tab; });
  });
  $('settingsReset')?.addEventListener('click', async () => {
    clearTimeout(saveTimer); pending = {};
    const response = await fetch('/v1/settings/reset', { method: 'POST' });
    if (response.ok) { settings = await response.json(); theme(settings.ui.theme); render(); publish(true); status('Настройки сброшены', 'ok'); }
    else status(`Не удалось сбросить (HTTP ${response.status})`, 'error');
  });
  const close = () => { if (saveTimer) { clearTimeout(saveTimer); save(); } dialog.close(); };
  $('settingsDone')?.addEventListener('click', close);
  $('settingsClose')?.addEventListener('click', close);
  dialog.addEventListener('click', e => { if (e.target === dialog) close(); });
  const open = async () => { status(''); render(); dialog.showModal(); if (!(await load())) status('Настройки доступны после активации лицензии', 'error'); };
  $('openSettings')?.addEventListener('click', open);

  // Navigation rail.
  const targets = { top: null, levels: '.levels-panel', footprint: '.footprint-panel', research: '.research-suite' };
  $('railNav')?.addEventListener('click', e => {
    const b = e.target.closest('.rail-item'); if (!b) return;
    const go = b.dataset.go;
    if (go === 'settings') return open();
    if (go === 'mt5') return $('mt5Open')?.click();
    $('railNav').querySelectorAll('.rail-item').forEach(x => x.classList.toggle('on', x === b));
    const el = targets[go] && document.querySelector(targets[go]);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); else window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

bind();
render();
load();
window.addEventListener('license-activated', load);
