import { barDelta, totalVolume } from './market-data.js';
import { footprintOf, footprintCell, applyTickToBar, emptyBar, tickVolume as footprintTickVolume, DEFAULT_FOOTPRINT_OPTIONS, createTickClassifier } from './footprint-engine.js';
import { zoneLabelRu, zoneStateRu } from './zone-labels.js';
import { candlePart } from './footprint-candle.js';
import { deltaSeries, formatDelta } from './delta-pane.js';
import { bucketStart } from './rate-store.js';
import { clamp, createViewport, barX, indexAt, visibleRange, panTime, zoomTime, followNewBars, resetTime, autoPriceRange, priceRangeOf, panPrice, scalePrice, resetPrice, niceStep } from './chart-view.js';

// The workspace: a price chart and a footprint drawn on canvas, only the bars on screen, at most once
// per animation frame. Both use the same TradingView gestures: drag to pan (time and price), wheel to
// zoom time around the cursor, drag the price axis to stretch it, drag the time axis to squeeze bars,
// double click to fit again.

const $ = s => document.querySelector(s);
const chart = $('#priceChart'), grid = $('#footprintGrid'), zoneList = $('#zoneList'), toast = $('#toast'), chartEmpty = $('#chartEmpty');
let bars = [], zones = [], selected = -1, selectedZone = null, showZones = true, showNumbers = true, mode = 'bidask', live = false, toastTimer;
let signals = [], comexLevels = [], alertPick = false;
let analysisMeta = null;
const fmt = (v, d = 2) => Number(v).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
// Candle times as the trader chose: the broker's server time (as MT5 shows it), UTC, or local time.
// Every label is formatted as UTC after this shift, so one rule serves all three.
const uiSetting = (key, fallback) => { const v = window.gold3poSettings?.ui?.[key]; return v === undefined ? fallback : v; };
function timeShift(ms = Date.now()) {
  const mode = uiSetting('timeDisplay', 'broker');
  if (mode === 'utc') return 0;
  if (mode === 'local') return -new Date(ms).getTimezoneOffset() * 60000;
  return Number(analysisMeta?.clockOffsetMs) || 0;
}
const toMs = value => typeof value === 'number' ? value : value instanceof Date ? value.getTime() : Date.parse(value);
const timeLabel = (value, options = {}) => { const ms = toMs(value); return Number.isFinite(ms) ? new Date(ms + timeShift(ms)).toLocaleString('en-GB', { ...options, timeZone: 'UTC' }) : String(value); };
window.gold3poFormatTime = ms => timeLabel(ms, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
function timeZoneCaption() { const mode = uiSetting('timeDisplay', 'broker'); return mode === 'utc' ? 'UTC' : mode === 'local' ? 'МЕСТНОЕ ВРЕМЯ' : 'ВРЕМЯ MT5'; }
const zonesWord = n => { const tens = n % 100, ones = n % 10; if (ones === 1 && tens !== 11) return n + ' зона'; if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return n + ' зоны'; return n + ' зон'; };
const barsWord = n => { const tens = n % 100, ones = n % 10; if (ones === 1 && tens !== 11) return n + ' СВЕЧА'; if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return n + ' СВЕЧИ'; return n + ' СВЕЧЕЙ'; };
const zoneStateText = state => zoneStateRu(state);
const zoneLabelText = label => zoneLabelRu(label);
const near = (a, b, t = 1e-6) => Math.abs(Number(a) - Number(b)) < t;
function notify(s) { toast.textContent = s; toast.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('visible'), 2100); }
function setEmptyState(empty) { if (chartEmpty) chartEmpty.hidden = !empty; }
const footprintOptions = () => window.gold3poSettings?.footprint && Object.keys(window.gold3poSettings.footprint).length ? window.gold3poSettings.footprint : DEFAULT_FOOTPRINT_OPTIONS;
const footprintStep = () => { const step = Number(analysisMeta?.footprintStep); return Number.isFinite(step) && step > 0 && step <= 100 ? step : 0.1; };
// The grid the service built the ladders on.
function serviceRowStep() {
  const row = Number(analysisMeta?.rowStep);
  return Number.isFinite(row) && row > 0 && row <= 1000 ? row : footprintStep();
}
// The row the settings ask for. A coarser multiple of the service grid is grouped here at once; a finer
// one cannot be rebuilt from grouped rows, so it waits for the service to send the finer ladders.
function rowStep() {
  const have = serviceRowStep();
  const wanted = Number((footprintStep() * Math.max(1, Number(footprintOptions().ticksPerRow) || 1)).toFixed(8));
  const factor = wanted / have;
  return factor > 1 && Math.abs(factor - Math.round(factor)) < 1e-6 ? wanted : have;
}
const digitsFor = step => clamp(Math.ceil(-Math.log10(step) - 1e-9), 2, 6);

// Colours come from the theme, so the light and dark glass themes both read correctly.
let palette = null;
function colors() {
  if (palette) return palette;
  const css = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (css.getPropertyValue(name) || '').trim() || fallback;
  palette = { comex: v('--comex', '#b69cff'), alert: v('--alert', '#ffb347'), up: v('--cyan', '#99ffe4'), down: v('--red', '#ff8080'), gold: v('--gold', '#ffc799'), text: v('--text', '#ffffff'), muted: v('--muted', '#a0a0a0'), muted2: v('--muted-2', '#7e7e7e'), line: v('--line', 'rgba(165,180,210,.12)'), panel: v('--panel-solid', '#161616'), mono: v('--mono', 'monospace').replace(/['"]/g, '') };
  return palette;
}
new MutationObserver(() => { palette = null; requestDraw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
function rgba(color, alpha) {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) { const n = parseInt(hex[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`; }
  const rgb = /^rgba?\(([^)]+)\)/i.exec(color);
  if (rgb) { const [r, g, b] = rgb[1].split(',').map(x => parseFloat(x)); return `rgba(${r},${g},${b},${alpha})`; }
  return color;
}

// Canvas sized to its box at the device pixel ratio; drawing uses CSS pixels.
function prepare(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width)), height = Math.max(1, Math.round(rect.height));
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

// ---------------------------------------------------------------- frame scheduling
let frame = 0;
const dirty = { chart: false, foot: false };
function requestDraw(which = 'both') {
  if (which !== 'foot') dirty.chart = true;
  if (which !== 'chart') dirty.foot = true;
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (dirty.chart) { dirty.chart = false; drawChart(); }
    if (dirty.foot) { dirty.foot = false; drawFootprint(); }
  });
}
const renderChart = () => requestDraw('chart');
const renderFootprint = () => requestDraw('foot');
const stats = { candles: 0, zones: 0, cells: 0, chartDraws: 0, footDraws: 0 };
// What the last frame drew, for the browser test and diagnostics (the canvas itself has no DOM to inspect).
const scene = { chart: { candles: [], zones: [], lastPriceY: null }, foot: { columns: [], axis: [], profile: 0 } };

// ---------------------------------------------------------------- price chart
const CH = { axis: 76, time: 24, delta: 74, gap: 8, top: 10 };
const chartView = createViewport({ barSpacing: 9, minSpacing: 1.5, maxSpacing: 60, rightOffset: 5 });
let chartHover = null, chartGeom = null;

function chartLayout(width, height) {
  const plotW = Math.max(40, width - CH.axis);
  const priceBottom = height - CH.time - CH.delta - CH.gap;
  return { plotW, width, height, priceTop: CH.top, priceBottom, deltaTop: priceBottom + CH.gap, deltaBottom: height - CH.time, timeTop: height - CH.time };
}

function drawChart() {
  stats.chartDraws += 1;
  const { ctx, width, height } = prepare(chart);
  const c = colors();
  if (!bars.length) { chartGeom = null; setEmptyState(true); updateChartZoomControls(); return; }
  setEmptyState(false);
  const L = chartLayout(width, height);
  const n = bars.length;
  const { from, to } = visibleRange(chartView, n, L.plotW);
  const auto = autoPriceRange(bars, from, to, { margin: 0.07 }) || { min: bars.at(-1).c - 1, max: bars.at(-1).c + 1 };
  const range = priceRangeOf(chartView, auto);
  const span = Math.max(1e-9, range.max - range.min);
  const y = p => L.priceTop + (range.max - p) / span * (L.priceBottom - L.priceTop);
  const x = i => barX(chartView, i, n, L.plotW);
  chartGeom = { L, range, from, to, n, y };
  ctx.font = `10px ${c.mono}`;
  ctx.textBaseline = 'middle';

  // Grid and price axis.
  const step = niceStep(span, L.priceBottom - L.priceTop, 46);
  const priceDigits = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  ctx.strokeStyle = c.line; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let p = Math.ceil(range.min / step) * step; p <= range.max; p += step) { const py = Math.round(y(p)) + 0.5; ctx.moveTo(0, py); ctx.lineTo(L.plotW, py); }
  ctx.stroke();

  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, L.plotW, L.priceBottom); ctx.clip();
  if (selected >= from && selected <= to) { ctx.fillStyle = rgba(c.gold, 0.07); ctx.fillRect(x(selected) - chartView.barSpacing / 2, L.priceTop, chartView.barSpacing, L.priceBottom - L.priceTop); }

  // Zones: from the candle that formed them to the right edge, strength sets the shade.
  stats.zones = 0;
  scene.chart = { candles: [], zones: [], lastPriceY: null };
  const offscreen = [];
  if (showZones) for (const z of zones) {
    const top = y(z.high), bottom = y(z.low);
    if (bottom < L.priceTop || top > L.priceBottom) { offscreen.push(z); continue; }
    const formed = z.formedAt ? bars.findIndex(b => b.time === z.formedAt) : -1;
    const x0 = clamp(formed >= 0 ? x(formed) : 0, 0, L.plotW);
    const tone = z.side === 'buy' ? c.up : c.down;
    const strong = selectedZone === z.id;
    ctx.fillStyle = rgba(tone, (strong ? 0.2 : 0.07) + 0.16 * (Number(z.strength) || 0));
    ctx.fillRect(x0, top, L.plotW - x0, Math.max(2, bottom - top));
    ctx.strokeStyle = rgba(tone, strong ? 0.95 : 0.65); ctx.lineWidth = strong ? 1.5 : 1;
    ctx.setLineDash(strong ? [] : [4, 3]);
    ctx.beginPath(); ctx.moveTo(x0, Math.round(top) + 0.5); ctx.lineTo(L.plotW, Math.round(top) + 0.5); ctx.moveTo(x0, Math.round(bottom) + 0.5); ctx.lineTo(L.plotW, Math.round(bottom) + 0.5); ctx.stroke();
    ctx.setLineDash([]);
    if (L.plotW - x0 > 90) {
      ctx.fillStyle = rgba(tone, 0.95);
      ctx.textAlign = 'left';
      ctx.fillText(`${zoneLabelText(z.label)} · ${Math.round((Number(z.strength) || 0) * 100)}%`, x0 + 6, Math.max(L.priceTop + 7, top - 7));
    }
    stats.zones += 1;
    scene.chart.zones.push({ id: z.id, side: z.side, selected: strong });
  }

  // COMEX session levels, converted to spot by the basis.
  scene.chart.comex = 0; scene.chart.alerts = 0; scene.chart.signals = 0;
  const axisTags = [];
  if (uiSetting('showComex', true)) for (const level of comexLevels) {
    if (!Number.isFinite(level.spotPrice)) continue;
    const ly2 = Math.round(y(level.spotPrice)) + 0.5;
    if (ly2 < L.priceTop || ly2 > L.priceBottom) continue;
    ctx.strokeStyle = rgba(c.comex, level.key === 'poc' ? 0.9 : 0.55); ctx.lineWidth = level.key === 'poc' ? 1.4 : 1; ctx.setLineDash(level.key === 'poc' ? [6, 3] : [2, 4]);
    ctx.beginPath(); ctx.moveTo(0, ly2); ctx.lineTo(L.plotW, ly2); ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
    ctx.fillStyle = rgba(c.comex, 0.95); ctx.textAlign = 'right';
    ctx.fillText(level.label, L.plotW - 6, ly2 - 7);
    scene.chart.comex += 1;
  }
  // Price alerts.
  for (const alert of (window.gold3poAlerts?.list() || [])) {
    if (!alert.active) continue;
    const ay = Math.round(y(alert.price)) + 0.5;
    if (ay < L.priceTop || ay > L.priceBottom) continue;
    ctx.strokeStyle = rgba(c.alert, 0.85); ctx.setLineDash([1, 3]);
    ctx.beginPath(); ctx.moveTo(0, ay); ctx.lineTo(L.plotW, ay); ctx.stroke(); ctx.setLineDash([]);
    axisTags.push([ay, '🔔 ' + fmt(alert.price, 2), c.alert]);
    scene.chart.alerts += 1;
  }

  // Candles.
  const bodyW = Math.max(1, Math.min(chartView.barSpacing * 0.72, 24));
  stats.candles = 0;
  for (let i = from; i <= to; i++) {
    const b = bars[i], cx = Math.round(x(i)) + 0.5, up = b.c >= b.o, tone = up ? c.up : c.down;
    ctx.strokeStyle = tone; ctx.fillStyle = tone; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, y(b.h)); ctx.lineTo(cx, y(b.l)); ctx.stroke();
    if (bodyW >= 2) {
      const top = Math.min(y(b.o), y(b.c)), h = Math.max(1, Math.abs(y(b.o) - y(b.c)));
      ctx.fillRect(Math.round(cx - bodyW / 2), top, Math.round(bodyW), h);
      if (i === selected) { ctx.strokeStyle = c.gold; ctx.strokeRect(Math.round(cx - bodyW / 2) - 0.5, top - 0.5, Math.round(bodyW) + 1, h + 1); }
    }
    stats.candles += 1;
    scene.chart.candles.push(i);
  }

  // Strategy signals: a triangle under the candle for a long, over it for a short.
  if (uiSetting('showSignals', true) && signals.length) {
    const byTime = new Map(); for (let i = from; i <= to; i++) byTime.set(bars[i].timeMs, i);
    const size = clamp(chartView.barSpacing * 0.45, 4, 8);
    for (const signal of signals) {
      const i = byTime.get(signal.timeMs);
      if (i === undefined) continue;
      const b = bars[i], sx = x(i), long = signal.side === 'long';
      const sy = long ? y(b.l) + 6 + size : y(b.h) - 6 - size;
      ctx.fillStyle = rgba(long ? c.up : c.down, signal.closed ? 0.95 : 0.5);
      ctx.beginPath();
      if (long) { ctx.moveTo(sx, sy - size); ctx.lineTo(sx - size, sy + size * 0.6); ctx.lineTo(sx + size, sy + size * 0.6); }
      else { ctx.moveTo(sx, sy + size); ctx.lineTo(sx - size, sy - size * 0.6); ctx.lineTo(sx + size, sy - size * 0.6); }
      ctx.closePath(); ctx.fill();
      scene.chart.signals += 1;
    }
  }

  // Last price line.
  const last = bars.at(-1), ly = Math.round(y(last.c)) + 0.5;
  scene.chart.lastPriceY = ly;
  ctx.strokeStyle = rgba(c.gold, 0.75); ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(L.plotW, ly); ctx.stroke(); ctx.setLineDash([]);

  // Crosshair.
  if (chartHover && !chartDrag && chartHover.x < L.plotW && chartHover.y < L.priceBottom) {
    ctx.strokeStyle = rgba(c.muted, 0.55); ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(Math.round(chartHover.x) + 0.5, 0); ctx.lineTo(Math.round(chartHover.x) + 0.5, L.deltaBottom);
    ctx.moveTo(0, Math.round(chartHover.y) + 0.5); ctx.lineTo(L.plotW, Math.round(chartHover.y) + 0.5); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.restore();

  // Price axis labels, zone markers beyond the screen, last price tag, crosshair tag.
  ctx.textAlign = 'left'; ctx.fillStyle = c.muted;
  for (let p = Math.ceil(range.min / step) * step; p <= range.max; p += step) { const py = y(p); if (py > L.priceTop + 6 && py < L.priceBottom - 6) ctx.fillText(fmt(p, priceDigits), L.plotW + 8, py); }
  for (const z of offscreen) {
    const above = y(z.low) < L.priceTop, ty = above ? L.priceTop + 8 : L.priceBottom - 8;
    ctx.fillStyle = rgba(z.side === 'buy' ? c.up : c.down, 0.9);
    ctx.fillText((above ? '▲ ' : '▼ ') + fmt((z.low + z.high) / 2, 2), L.plotW + 6, ty);
  }
  const tag = (py, text, bg, fg) => { ctx.fillStyle = bg; ctx.fillRect(L.plotW + 1, py - 9, CH.axis - 2, 18); ctx.fillStyle = fg; ctx.fillText(text, L.plotW + 6, py); };
  for (const [ty, text, tone] of axisTags) tag(ty, text, rgba(tone, 0.9), '#101010');
  if (ly > L.priceTop && ly < L.priceBottom) tag(ly, fmt(last.c, 2), c.gold, '#101010');
  if (alertPick && chartHover && chartHover.x < L.plotW && chartHover.y < L.priceBottom) {
    ctx.strokeStyle = rgba(c.alert, 0.9); ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(0, Math.round(chartHover.y) + 0.5); ctx.lineTo(L.plotW, Math.round(chartHover.y) + 0.5); ctx.stroke(); ctx.setLineDash([]);
  }
  if (chartHover && !chartDrag && chartHover.x < L.plotW && chartHover.y < L.priceBottom) tag(chartHover.y, fmt(range.max - (chartHover.y - L.priceTop) / (L.priceBottom - L.priceTop) * span, 2), rgba(c.muted, 0.85), '#101010');

  drawDeltaPane(ctx, L, from, to, x, c);
  drawTimeAxis(ctx, L, from, to, x, c);
  drawLegend(ctx, L, c);
  updateChartZoomControls();
}

function drawDeltaPane(ctx, L, from, to, x, c) {
  const series = deltaSeries(bars);
  if (!series.length || to < from) return;
  let lo = Infinity, hi = -Infinity;
  for (let i = from; i <= to; i++) { lo = Math.min(lo, series[i].cumulative); hi = Math.max(hi, series[i].cumulative); }
  lo = Math.min(lo, 0); hi = Math.max(hi, 0);
  const span = Math.max(1, hi - lo), top = L.deltaTop + 16, bottom = L.deltaBottom - 4;
  const y = v => top + (hi - v) / span * (bottom - top);
  ctx.strokeStyle = c.line; ctx.beginPath(); ctx.moveTo(0, L.deltaTop + 0.5); ctx.lineTo(L.width, L.deltaTop + 0.5); ctx.stroke();
  ctx.save(); ctx.beginPath(); ctx.rect(0, L.deltaTop, L.plotW, L.deltaBottom - L.deltaTop); ctx.clip();
  const zero = Math.round(y(0)) + 0.5;
  ctx.strokeStyle = rgba(c.muted, 0.35); ctx.beginPath(); ctx.moveTo(0, zero); ctx.lineTo(L.plotW, zero); ctx.stroke();
  const current = series.at(-1).cumulative, tone = current < 0 ? c.down : c.up;
  ctx.beginPath();
  for (let i = from; i <= to; i++) { const px = x(i), py = y(series[i].cumulative); if (i === from) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
  ctx.strokeStyle = tone; ctx.lineWidth = 1.4; ctx.stroke();
  ctx.lineTo(x(to), zero); ctx.lineTo(x(from), zero); ctx.closePath();
  ctx.fillStyle = rgba(tone, 0.12); ctx.fill();
  ctx.lineWidth = 1;
  ctx.restore();
  ctx.fillStyle = c.muted; ctx.textAlign = 'left';
  const lastDelta = series.at(-1).delta;
  ctx.fillText(`CVD · ${lastDelta >= 0 ? '+' : '−'}${Math.abs(Math.round(lastDelta))} за бар`, 6, L.deltaTop + 9);
  ctx.fillStyle = tone; ctx.fillText(formatDelta(current), L.plotW + 6, L.deltaTop + 9);
}

function drawTimeAxis(ctx, L, from, to, x, c) {
  ctx.strokeStyle = c.line; ctx.beginPath(); ctx.moveTo(0, L.timeTop + 0.5); ctx.lineTo(L.width, L.timeTop + 0.5); ctx.stroke();
  // Labels on round times (every 15 min, hour, 4 h, day…), at least ~90 px apart; a new day shows its date.
  const tfMinutes = Math.max(1, (analysisMeta?.intervalMs || 900000) / 60000);
  const labelMinutes = [1, 5, 15, 30, 60, 120, 240, 480, 720, 1440, 2880, 10080].find(m => m >= tfMinutes && m / tfMinutes * chartView.barSpacing >= 90) || 10080;
  ctx.fillStyle = c.muted; ctx.textAlign = 'center';
  for (let i = from; i <= to; i++) {
    const ms = bars[i].timeMs ?? Date.parse(bars[i].time);
    const shown = ms + timeShift(ms);
    const minutes = Math.round(shown / 60000);
    if (minutes % labelMinutes !== 0) continue;
    const px = x(i);
    if (px < 20 || px > L.plotW - 20) continue;
    const d = new Date(shown);
    const midnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
    ctx.fillStyle = midnight ? c.text : c.muted;
    ctx.fillText(midnight || labelMinutes >= 1440 ? timeLabel(ms, { day: '2-digit', month: '2-digit' }) : timeLabel(ms, { hour: '2-digit', minute: '2-digit' }), px, L.timeTop + 12);
  }
  if (chartHover && !chartDrag && chartHover.x < L.plotW && chartGeom) {
    const i = clamp(indexAt(chartView, chartHover.x, chartGeom.n, L.plotW), 0, chartGeom.n - 1);
    const text = timeLabel(bars[i].time, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    const w = ctx.measureText(text).width + 12, px = clamp(x(i), w / 2, L.plotW - w / 2);
    ctx.fillStyle = rgba(c.muted, 0.85); ctx.fillRect(px - w / 2, L.timeTop + 2, w, CH.time - 4);
    ctx.fillStyle = '#101010'; ctx.fillText(text, px, L.timeTop + 12);
  }
  ctx.textAlign = 'left';
}

function drawLegend(ctx, L, c) {
  const i = chartHover && chartGeom && chartHover.x < L.plotW ? clamp(indexAt(chartView, chartHover.x, chartGeom.n, L.plotW), 0, chartGeom.n - 1) : (selected >= 0 ? selected : bars.length - 1);
  const b = bars[i];
  if (!b) return;
  const tone = b.c >= b.o ? c.up : c.down;
  const parts = [['О', b.o], ['М', b.h], ['Н', b.l], ['З', b.c]];
  ctx.textAlign = 'left';
  let px = 8;
  ctx.fillStyle = c.muted; const t = timeLabel(b.time, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }); ctx.fillText(t, px, L.priceTop + 4); px += ctx.measureText(t).width + 10;
  for (const [k, v] of parts) { ctx.fillStyle = c.muted; ctx.fillText(k, px, L.priceTop + 4); px += ctx.measureText(k).width + 3; ctx.fillStyle = tone; const s = fmt(v, 2); ctx.fillText(s, px, L.priceTop + 4); px += ctx.measureText(s).width + 9; }
  const d = (b.unknown || 0) > 0 && !(b.bid || b.ask) ? null : (b.delta ?? barDelta(b));
  if (d !== null) { ctx.fillStyle = d >= 0 ? c.up : c.down; ctx.fillText('Δ ' + (d > 0 ? '+' : '') + fmt(d, 0), px, L.priceTop + 4); }
}

function updateChartZoomControls() {
  const horizontal = $('#chartZoomReset'), vertical = $('#chartPriceZoomReset');
  if (horizontal) horizontal.textContent = Math.round(chartView.barSpacing / chartView.defaultSpacing * 100) + '%';
  if (vertical) vertical.textContent = chartView.priceAuto ? 'Y авто' : 'Y';
}

// Gestures on the price chart.
let chartDrag = null;
function chartZone(event) {
  const rect = chart.getBoundingClientRect();
  const px = event.clientX - rect.left, py = event.clientY - rect.top;
  const L = chartLayout(rect.width, rect.height);
  const area = px >= L.plotW ? (py < L.priceBottom ? 'price-axis' : 'none') : py >= L.timeTop ? 'time-axis' : 'plot';
  return { px, py, L, area };
}
chart.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !bars.length) return;
  const at = chartZone(event);
  chart.setPointerCapture(event.pointerId);
  const range = chartGeom?.range || { min: 0, max: 1 };
  chartDrag = { ...at, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false, vertical: false, range };
  chart.classList.add(at.area === 'price-axis' ? 'is-scaling-price' : at.area === 'time-axis' ? 'is-scaling-time' : 'is-dragging');
});
chart.addEventListener('pointermove', event => {
  if (!chartDrag) {
    const at = chartZone(event);
    chartHover = at.area === 'plot' ? { x: at.px, y: at.py } : null;
    chart.style.cursor = at.area === 'price-axis' ? 'ns-resize' : at.area === 'time-axis' ? 'ew-resize' : alertPick ? 'copy' : 'crosshair';
    requestDraw('chart');
    return;
  }
  const dx = event.clientX - chartDrag.lastX, dy = event.clientY - chartDrag.lastY;
  chartDrag.lastX = event.clientX; chartDrag.lastY = event.clientY;
  if (Math.abs(event.clientX - chartDrag.startX) > 3 || Math.abs(event.clientY - chartDrag.startY) > 3) chartDrag.moved = true;
  if (!chartDrag.moved) return;
  const L = chartDrag.L, n = bars.length, range = chartGeom?.range || chartDrag.range;
  if (chartDrag.area === 'price-axis') scalePrice(chartView, Math.exp(dy / 160), range);
  else if (chartDrag.area === 'time-axis') zoomTime(chartView, Math.exp(-dx / 120), L.plotW, n, L.plotW);
  else {
    panTime(chartView, dx, n, L.plotW);
    // Price follows the drag once it is clearly vertical, as in TradingView.
    if (Math.abs(event.clientY - chartDrag.startY) > 6) chartDrag.vertical = true;
    if (chartDrag.vertical && dy) panPrice(chartView, dy, L.priceBottom - L.priceTop, range);
  }
  requestDraw('chart');
});
function endChartDrag(event) {
  if (!chartDrag) return;
  const drag = chartDrag;
  chartDrag = null;
  chart.classList.remove('is-dragging', 'is-scaling-price', 'is-scaling-time');
  if (!drag.moved && drag.area === 'plot' && event?.type === 'pointerup' && alertPick && chartGeom) {
    const { range, L } = chartGeom;
    const price = range.max - (drag.py - L.priceTop) / (L.priceBottom - L.priceTop) * (range.max - range.min);
    window.dispatchEvent(new CustomEvent('gold3po-alert-add', { detail: { price: Number(price.toFixed(2)) } }));
    setAlertPick(false);
  } else if (!drag.moved && drag.area === 'plot' && event?.type === 'pointerup') {
    const i = indexAt(chartView, drag.px, bars.length, drag.L.plotW);
    if (i >= 0 && i < bars.length) select(i, { from: 'chart' });
  }
  requestDraw('chart');
}
chart.addEventListener('pointerup', endChartDrag);
chart.addEventListener('pointercancel', endChartDrag);
chart.addEventListener('pointerleave', () => { if (!chartDrag) { chartHover = null; requestDraw('chart'); } });
chart.addEventListener('dblclick', event => {
  const at = chartZone(event);
  if (at.area === 'price-axis') resetPrice(chartView);
  else if (at.area === 'time-axis') resetTime(chartView);
  else { resetPrice(chartView); resetTime(chartView); }
  requestDraw('chart');
});
chart.addEventListener('wheel', event => {
  if (!bars.length) return;
  event.preventDefault();
  const at = chartZone(event);
  const n = bars.length;
  if (at.area === 'price-axis') scalePrice(chartView, Math.exp(event.deltaY / 400), chartGeom?.range || { min: 0, max: 1 });
  else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) panTime(chartView, -(event.deltaX || event.deltaY), n, at.L.plotW);
  else zoomTime(chartView, Math.exp(-event.deltaY / 500), at.px, n, at.L.plotW);
  requestDraw('chart');
}, { passive: false });
$('#chartZoomOut')?.addEventListener('click', () => { zoomTime(chartView, 1 / 1.25, chartGeom?.L.plotW ?? 600, bars.length, chartGeom?.L.plotW ?? 600); requestDraw('chart'); });
$('#chartZoomIn')?.addEventListener('click', () => { zoomTime(chartView, 1.25, chartGeom?.L.plotW ?? 600, bars.length, chartGeom?.L.plotW ?? 600); requestDraw('chart'); });
$('#chartZoomReset')?.addEventListener('click', () => { resetTime(chartView); requestDraw('chart'); });
$('#chartPriceZoomOut')?.addEventListener('click', () => { scalePrice(chartView, 1.2, chartGeom?.range || { min: 0, max: 1 }); requestDraw('chart'); });
$('#chartPriceZoomIn')?.addEventListener('click', () => { scalePrice(chartView, 1 / 1.2, chartGeom?.range || { min: 0, max: 1 }); requestDraw('chart'); });
$('#chartPriceZoomReset')?.addEventListener('click', () => { resetPrice(chartView); requestDraw('chart'); });

// ---------------------------------------------------------------- footprint
const FP = { axis: 66, profile: 92, head: 22, foot: 22 };
const footView = createViewport({ barSpacing: 64, minSpacing: 6, maxSpacing: 240, rightOffset: 1 });
let footRowH = 16, footCenter = null, footHover = null, footGeom = null, footDrag = null, levelsAsked = 0;
const footCanvas = document.createElement('canvas');
footCanvas.className = 'footprint-canvas';
footCanvas.setAttribute('role', 'img');
footCanvas.setAttribute('aria-label', 'Футпринт: бид, аск и объём по ценам для каждой свечи');
const footStatus = document.createElement('div');
footStatus.className = 'footprint-source-status';
footStatus.setAttribute('role', 'status');
const footTip = document.createElement('div');
footTip.className = 'footprint-tip';
footTip.hidden = true;
grid.replaceChildren(footStatus, footCanvas, footTip);

// A bar's footprint marks: from the server when it sent them, else computed from its ladder.
function barFootprint(b) {
  if (!Array.isArray(b?.levels)) return b;
  const have = serviceRowStep(), factor = Math.round(rowStep() / have);
  if (factor > 1) {
    const key = factor + '|' + JSON.stringify(footprintOptions());
    if (b._grouped?.key !== key || b._grouped.levels !== b.levels || b._grouped.c !== b.c) {
      Object.defineProperty(b, '_grouped', { value: { key, levels: b.levels, c: b.c, foot: footprintOf(b.levels, { ...footprintOptions(), ticksPerRow: factor, h: b.h, l: b.l, c: b.c, priceStep: have }) }, configurable: true, writable: true, enumerable: false });
    }
    return { ...b, ...b._grouped.foot };
  }
  if (b.poc !== undefined && b.valueArea !== undefined) return b;
  return { ...b, ...footprintOf(b.levels, { ...footprintOptions(), ticksPerRow: 1, h: b.h, l: b.l, c: b.c, priceStep: have }) };
}

function footLayout(width, height) {
  const plotW = Math.max(60, width - FP.axis - FP.profile);
  return { width, height, plotW, top: FP.head, bottom: height - FP.foot, axisX: plotW, profileX: plotW + FP.axis };
}

function footPriceGeometry(L, from, to) {
  const stepPx = footRowH, row = rowStep();
  const perPrice = stepPx / row;
  let center = footCenter;
  if (footView.priceAuto || !Number.isFinite(center)) {
    const auto = autoPriceRange(bars, from, to, { margin: 0 });
    const lastVisible = to === bars.length - 1;
    if (!auto) center = bars.at(-1)?.c ?? 0;
    else if ((auto.max - auto.min) * perPrice <= L.bottom - L.top - stepPx * 2 || !lastVisible) center = (auto.max + auto.min) / 2;
    else center = bars.at(-1).c;
  }
  const midY = (L.top + L.bottom) / 2;
  return { row, perPrice, center, y: p => midY - (p - center) * perPrice, priceAt: py => center + (midY - py) / perPrice };
}

function drawFootprint() {
  stats.footDraws += 1;
  const { ctx, width, height } = prepare(footCanvas);
  const c = colors();
  stats.cells = 0;
  scene.foot = { columns: [], axis: [], profile: 0 };
  if (!bars.length) {
    footGeom = null;
    footStatus.textContent = 'Тики брокера ещё не поступили. Подключите MT5, чтобы построить футпринт.';
    footStatus.className = 'footprint-source-status is-sparse';
    updateFootprintZoomControls();
    return;
  }
  const L = footLayout(width, height);
  const n = bars.length;
  const { from, to } = visibleRange(footView, n, L.plotW);
  const G = footPriceGeometry(L, from, to);
  const x = i => barX(footView, i, n, L.plotW);
  footGeom = { L, G, from, to, n };
  const colW = footView.barSpacing, cellW = Math.max(2, colW - 2);
  const digits = digitsFor(G.row);
  const feet = [];
  let scale = 1, bidScale = 1, askScale = 1, trimmed = 0, sparse = 0, ticks = 0, clusters = 0, noTicks = 0;
  for (let i = from; i <= to; i++) {
    const f = barFootprint(bars[i]);
    feet.push(f);
    if (!Array.isArray(f.levels)) { trimmed += 1; continue; }
    if (!f.levels.length && !(f.tickCount > 0)) { noTicks += 1; continue; }
    if (f.levels.length < 3) sparse += 1;
    ticks += Number(f.tickCount) || 0; clusters += f.levels.length;
    for (const r of f.levels) { const t = (r.bid || 0) + (r.ask || 0) + (r.unknown || 0); if (t > scale) scale = t; if ((r.bid || 0) > bidScale) bidScale = r.bid; if ((r.ask || 0) > askScale) askScale = r.ask; }
  }
  // Ladders older than the ones the service sent: ask for them once the trader scrolls there.
  if (trimmed && Date.now() - levelsAsked > 2500) { levelsAsked = Date.now(); window.gold3poRequestAnalysis?.(); }
  const exchange = String(analysisMeta?.volumeKind || '').includes('exchange_trade_size');
  footStatus.textContent = (exchange ? 'ИСТОЧНИК · БИРЖЕВЫЕ СДЕЛКИ' : 'ИСТОЧНИК · MT5 OTC / ТИКОВАЯ АКТИВНОСТЬ, НЕ БИРЖЕВОЙ ОБЪЁМ') + ' · ШАГ ' + fmt(G.row, digits) + ' · '
    + 'ценовые уровни не интерполируются из OHLC · '
    + (sparse ? `РЕДКИЕ ДАННЫЕ · ${sparse}/${feet.length} свечей имеют менее 3 ценовых уровней` : `ПЛОТНОСТЬ · ${ticks} тиков / ${clusters} кластеров`)
    + (trimmed ? ` · загружаются уровни ещё ${trimmed} свечей` : '')
    + (noTicks ? ` · БЕЗ ТИКОВ · ${noTicks} свечей только из MT5 — скачайте историю тиков в блоке «История для футпринта»` : '');
  footStatus.className = 'footprint-source-status ' + (sparse || noTicks ? 'is-sparse' : 'is-dense');

  ctx.font = `${clamp(Math.round(footRowH * 0.62), 8, 12)}px ${c.mono}`;
  ctx.textBaseline = 'middle';
  ctx.save(); ctx.beginPath(); ctx.rect(0, L.top, L.plotW, L.bottom - L.top); ctx.clip();
  const showText = showNumbers && footRowH >= 10;
  for (let k = 0; k < feet.length; k++) {
    const i = from + k, f = feet[k], cx = x(i), x0 = cx - colW / 2 + 1;
    if (i === selected) { ctx.fillStyle = rgba(c.gold, 0.06); ctx.fillRect(x0 - 1, L.top, colW, L.bottom - L.top); }
    // The candle the column came from, as a thin strip on its left edge.
    const up = f.c >= f.o, tone = up ? c.up : c.down, stripX = Math.round(x0) + 0.5;
    ctx.strokeStyle = rgba(tone, 0.8); ctx.beginPath(); ctx.moveTo(stripX, G.y(f.h)); ctx.lineTo(stripX, G.y(f.l)); ctx.stroke();
    ctx.fillStyle = tone; ctx.fillRect(stripX - 1.5, Math.min(G.y(f.o), G.y(f.c)), 3, Math.max(1, Math.abs(G.y(f.o) - G.y(f.c))));
    const column = { index: i, forming: i === n - 1 && live, up, x: cx, width: colW, cells: [], delta: null };
    scene.foot.columns.push(column);
    if (!Array.isArray(f.levels)) continue;
    if (!f.levels.length && !(f.tickCount > 0)) {
      column.noTicks = true;
      if (colW >= 34) { ctx.save(); ctx.font = `9px ${c.mono}`; ctx.fillStyle = rgba(c.muted, 0.7); ctx.textAlign = 'center'; ctx.fillText('нет тиков', cx, G.y((f.h + f.l) / 2)); ctx.restore(); }
      continue;
    }
    const va = f.valueArea, imb = new Map((f.imbalances || []).map(m => [Number(m.price).toFixed(8), m.side]));
    const stacked = new Set((f.stackedImbalances || []).flatMap(s => (s.prices || []).map(p => s.side + Number(p).toFixed(8))));
    const absorbed = new Set((f.absorbedLevels || []).map(a => Number(a.price).toFixed(8)));
    const cx0 = x0 + 4, cw = Math.max(1, cellW - 4), partStep = rowStep();
    for (const r of f.levels) {
      const total = (r.bid || 0) + (r.ask || 0) + (r.unknown || 0);
      if (total <= 0) continue;
      const cy = G.y(r.price), top = cy - footRowH / 2 + 0.5, h = Math.max(1, footRowH - 1);
      if (cy < L.top - footRowH || cy > L.bottom + footRowH) continue;
      const key = Number(r.price).toFixed(8);
      // Body rows sit on a tint of the candle colour, wick rows on a fainter one, so each column reads as its candle.
      const part = candlePart(f, r.price, partStep);
      const cellRecord = { price: r.price, y: cy, height: h, bid: r.bid || 0, ask: r.ask || 0, unknown: r.unknown || 0, part, text: '', tone: 'neutral', bidHeat: 0, askHeat: 0, imbalance: null, stacked: false, absorbed: false, poc: false, va: false };
      column.cells.push(cellRecord);
      if (va && r.price <= va.high + 1e-9 && r.price >= va.low - 1e-9) { cellRecord.va = true; ctx.fillStyle = rgba(c.gold, 0.06); ctx.fillRect(cx0, top, cw, h); }
      if (part !== 'out') { ctx.fillStyle = rgba(tone, part === 'body' ? 0.1 : 0.04); ctx.fillRect(cx0, top, cw, h); }
      if (mode === 'bidask') {
        const half = cw / 2;
        if (r.bid) { cellRecord.bidHeat = r.bid / bidScale; ctx.fillStyle = rgba(c.down, 0.1 + 0.72 * Math.pow(cellRecord.bidHeat, 0.6)); ctx.fillRect(cx0, top, half - 0.5, h); }
        if (r.ask) { cellRecord.askHeat = r.ask / askScale; ctx.fillStyle = rgba(c.up, 0.1 + 0.72 * Math.pow(cellRecord.askHeat, 0.6)); ctx.fillRect(cx0 + half + 0.5, top, half - 0.5, h); }
        if (r.unknown && !r.bid && !r.ask) { ctx.fillStyle = rgba(c.muted, 0.12 + 0.5 * Math.pow(r.unknown / scale, 0.6)); ctx.fillRect(cx0, top, cw, h); }
        if (showText && cw >= 30) {
          cellRecord.text = [r.bid ? Math.round(r.bid) : '', r.ask ? Math.round(r.ask) : '', r.unknown && !r.bid && !r.ask ? '? ' + Math.round(r.unknown) : ''].filter(v => v !== '').join(' ');
          const side = imb.get(key);
          ctx.fillStyle = side === 'sell' ? c.down : c.text; ctx.textAlign = 'right';
          if (r.bid) ctx.fillText(String(Math.round(r.bid)), cx0 + half - 3, cy);
          ctx.fillStyle = side === 'buy' ? c.up : c.text; ctx.textAlign = 'left';
          if (r.ask) ctx.fillText(String(Math.round(r.ask)), cx0 + half + 3, cy);
          if (r.unknown && !r.bid && !r.ask) { ctx.fillStyle = c.muted; ctx.textAlign = 'center'; ctx.fillText('? ' + Math.round(r.unknown), cx0 + half, cy); }
        }
      } else {
        const cell = footprintCell(r, mode);
        const magnitude = Math.abs(Number(cell.value) || 0) / (mode === 'deltaPct' ? 100 : scale);
        const tone2 = cell.tone === 'positive' ? c.up : cell.tone === 'negative' ? c.down : c.muted;
        cellRecord.tone = cell.tone || 'neutral';
        if (showText && cw >= 24 && cell.text) cellRecord.text = String(cell.text);
        ctx.fillStyle = rgba(tone2, 0.1 + 0.7 * Math.pow(clamp(magnitude, 0, 1), 0.6)); ctx.fillRect(cx0, top, cw, h);
        if (showText && cw >= 24 && cell.text) { ctx.fillStyle = c.text; ctx.textAlign = 'center'; ctx.fillText(cell.text, cx0 + cw / 2, cy); }
      }
      const side = imb.get(key);
      cellRecord.imbalance = side || null; cellRecord.stacked = Boolean(side && stacked.has(side + key)); cellRecord.absorbed = absorbed.has(key); cellRecord.poc = f.poc != null && near(f.poc, r.price);
      if (side) { ctx.fillStyle = side === 'buy' ? c.up : c.down; ctx.fillRect(side === 'buy' ? cx0 + cw - 2 : cx0, top, 2, h); }
      if (side && stacked.has(side + key)) { ctx.fillStyle = side === 'buy' ? c.up : c.down; ctx.fillRect(x0 + cellW - 1, top, 2, h); }
      if (absorbed.has(key)) { ctx.strokeStyle = rgba(c.text, 0.8); ctx.setLineDash([2, 2]); ctx.strokeRect(cx0 + 0.5, top + 0.5, cw - 1, h - 1); ctx.setLineDash([]); }
      if (f.poc != null && near(f.poc, r.price)) { ctx.strokeStyle = c.gold; ctx.lineWidth = 1.5; ctx.strokeRect(cx0 + 0.5, top + 0.5, cw - 1, h - 1); ctx.lineWidth = 1; }
      stats.cells += 1;
    }
    if (f.unfinishedHigh) { ctx.fillStyle = c.gold; ctx.fillRect(cx0, G.y(f.levels[0].price) - footRowH / 2 - 2, cw, 2); }
    if (f.unfinishedLow) { ctx.fillStyle = c.gold; ctx.fillRect(cx0, G.y(f.levels.at(-1).price) + footRowH / 2, cw, 2); }
    if (i === n - 1 && live) { ctx.strokeStyle = rgba(c.gold, 0.35); ctx.setLineDash([2, 3]); ctx.strokeRect(x0 + 0.5, L.top + 0.5, cellW - 1, L.bottom - L.top - 1); ctx.setLineDash([]); }
  }
  // Last price.
  const ly = Math.round(G.y(bars.at(-1).c)) + 0.5;
  ctx.strokeStyle = rgba(c.gold, 0.6); ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(L.plotW, ly); ctx.stroke(); ctx.setLineDash([]);
  ctx.restore();

  // Head (time) and foot (delta per candle) rows.
  ctx.font = `10px ${c.mono}`;
  ctx.fillStyle = c.muted; ctx.textAlign = 'center';
  const labelEvery = Math.max(1, Math.ceil(46 / colW));
  for (let k = 0; k < feet.length; k++) {
    const i = from + k, f = feet[k], px = x(i);
    if (px < 0 || px > L.plotW) continue;
    if (i % labelEvery === 0 || i === selected) { ctx.fillStyle = i === selected ? c.gold : c.muted; ctx.fillText(timeLabel(f.time, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }, 'toLocaleTimeString'), px, L.top / 2 + 1); }
    const d = (f.unknown || 0) > 0 && !(f.bid || f.ask) ? null : (f.delta ?? barDelta(f));
    if (scene.foot.columns[k]) scene.foot.columns[k].delta = d;
    if (colW >= 26 || i === selected) { ctx.fillStyle = d === null ? c.muted : d >= 0 ? c.up : c.down; ctx.fillText(d === null ? '—' : (d > 0 ? '+' : '') + fmt(d, 0), px, L.bottom + FP.foot / 2); }
  }
  ctx.strokeStyle = c.line; ctx.beginPath(); ctx.moveTo(0, L.top + 0.5); ctx.lineTo(L.width, L.top + 0.5); ctx.moveTo(0, L.bottom + 0.5); ctx.lineTo(L.width, L.bottom + 0.5); ctx.moveTo(L.axisX + 0.5, 0); ctx.lineTo(L.axisX + 0.5, L.height); ctx.stroke();

  // Price axis.
  ctx.textAlign = 'left';
  const every = Math.max(1, Math.ceil(16 / footRowH));
  const first = Math.ceil(G.priceAt(L.bottom) / G.row) * G.row;
  for (let k = 0, p = first; G.y(p) >= L.top; k++, p = first + k * G.row) {
    if (Math.round(p / G.row) % every !== 0) continue;
    const py = G.y(p);
    if (py > L.bottom - 4) continue;
    ctx.fillStyle = c.muted; ctx.fillText(fmt(p, digits), L.axisX + 6, py);
    scene.foot.axis.push(Number(p.toFixed(8)));
  }
  ctx.fillStyle = c.gold; ctx.fillRect(L.axisX + 1, ly - 8, FP.axis - 2, 16); ctx.fillStyle = '#101010'; ctx.fillText(fmt(bars.at(-1).c, digits), L.axisX + 6, ly);

  // Session volume profile beside the axis.
  const profile = analysisMeta?.profile?.current;
  if (profile?.levels?.length) {
    const max = Math.max(1, ...profile.levels.map(r => r.total || 0));
    const va = profile.valueArea;
    ctx.save(); ctx.beginPath(); ctx.rect(L.profileX, L.top, FP.profile, L.bottom - L.top); ctx.clip();
    for (const r of profile.levels) {
      const py = G.y(r.price);
      if (py < L.top - footRowH || py > L.bottom + footRowH) continue;
      const inVa = va && r.price <= va.high + 1e-9 && r.price >= va.low - 1e-9;
      const isPoc = profile.poc != null && near(profile.poc, r.price);
      ctx.fillStyle = isPoc ? c.gold : rgba(inVa ? c.gold : c.muted, inVa ? 0.45 : 0.28);
      ctx.fillRect(L.profileX + 4, py - Math.max(1, footRowH / 2 - 1), (FP.profile - 10) * (r.total || 0) / max, Math.max(1, footRowH - 2));
      if (r.total > 0) scene.foot.profile += 1;
    }
    ctx.restore();
    ctx.fillStyle = c.muted; ctx.textAlign = 'left'; ctx.fillText('ПРОФИЛЬ', L.profileX + 6, L.top / 2 + 1);
    ctx.fillText(fmt(profile.volume || 0, 0), L.profileX + 6, L.bottom + FP.foot / 2);
  }

  if (footHover && !footDrag) {
    ctx.strokeStyle = rgba(c.muted, 0.5); ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(0, Math.round(footHover.y) + 0.5); ctx.lineTo(L.plotW, Math.round(footHover.y) + 0.5); ctx.stroke(); ctx.setLineDash([]);
  }
  updateFootprintZoomControls();
}

function footAt(event) {
  const rect = footCanvas.getBoundingClientRect();
  const px = event.clientX - rect.left, py = event.clientY - rect.top;
  const L = footLayout(rect.width, rect.height);
  const area = px >= L.axisX ? 'price-axis' : py < L.top ? 'time-axis' : 'plot';
  return { px, py, L, area };
}
function footTooltip(at) {
  if (!footGeom || at.area !== 'plot') { footTip.hidden = true; return; }
  const i = indexAt(footView, at.px, bars.length, at.L.plotW);
  const b = bars[i];
  if (!b) { footTip.hidden = true; return; }
  const f = barFootprint(b), price = Math.round(footGeom.G.priceAt(at.py) / footGeom.G.row) * footGeom.G.row;
  const row = (f.levels || []).find(r => near(r.price, price, footGeom.G.row / 2));
  const marks = [];
  if (row && f.poc != null && near(f.poc, row.price)) marks.push('POC');
  if (row && f.valueArea && row.price <= f.valueArea.high + 1e-9 && row.price >= f.valueArea.low - 1e-9) marks.push('зона стоимости');
  const imb = row && (f.imbalances || []).find(m => near(m.price, row.price));
  if (imb) marks.push(imb.side === 'buy' ? 'имбаланс покупателей' : 'имбаланс продавцов');
  if (row && (f.absorbedLevels || []).some(a => near(a.price, row.price))) marks.push('поглощение');
  footTip.textContent = `${timeLabel(b.time, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} · ${fmt(price, digitsFor(footGeom.G.row))}`
    + (row ? ` · бид ${row.bid} · аск ${row.ask}${row.unknown ? ' · без стороны ' + row.unknown : ''}` : ' · сделок нет') + (marks.length ? ' · ' + marks.join(' · ') : '');
  footTip.hidden = false;
  footTip.style.left = Math.min(at.px + 14, at.L.width - 260) + 'px';
  footTip.style.top = (at.py + footStatus.offsetHeight + 14) + 'px';
}
footCanvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !bars.length) return;
  const at = footAt(event);
  footCanvas.setPointerCapture(event.pointerId);
  footDrag = { ...at, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false, vertical: false };
  footTip.hidden = true;
  footCanvas.classList.add('is-dragging');
});
footCanvas.addEventListener('pointermove', event => {
  const at = footAt(event);
  if (!footDrag) {
    footHover = at.area === 'plot' ? { x: at.px, y: at.py } : null;
    footCanvas.style.cursor = at.area === 'price-axis' ? 'ns-resize' : at.area === 'time-axis' ? 'ew-resize' : 'crosshair';
    footTooltip(at);
    requestDraw('foot');
    return;
  }
  const dx = event.clientX - footDrag.lastX, dy = event.clientY - footDrag.lastY;
  footDrag.lastX = event.clientX; footDrag.lastY = event.clientY;
  if (Math.abs(event.clientX - footDrag.startX) > 3 || Math.abs(event.clientY - footDrag.startY) > 3) footDrag.moved = true;
  if (!footDrag.moved) return;
  const L = footDrag.L;
  if (footDrag.area === 'price-axis') footRowH = clamp(footRowH * Math.exp(-dy / 140), 3, 48);
  else if (footDrag.area === 'time-axis') zoomTime(footView, Math.exp(dx / 140), L.plotW, bars.length, L.plotW);
  else {
    panTime(footView, dx, bars.length, L.plotW);
    if (Math.abs(event.clientY - footDrag.startY) > 6) footDrag.vertical = true;
    if (footDrag.vertical && dy && footGeom) { footView.priceAuto = false; footCenter = footGeom.G.center + dy / footGeom.G.perPrice; }
  }
  requestDraw('foot');
});
function endFootDrag(event) {
  if (!footDrag) return;
  const drag = footDrag;
  footDrag = null;
  footCanvas.classList.remove('is-dragging');
  if (!drag.moved && drag.area === 'plot' && event?.type === 'pointerup') {
    const i = indexAt(footView, drag.px, bars.length, drag.L.plotW);
    if (i >= 0 && i < bars.length) select(i, { from: 'foot' });
  }
  requestDraw('foot');
}
footCanvas.addEventListener('pointerup', endFootDrag);
footCanvas.addEventListener('pointercancel', endFootDrag);
footCanvas.addEventListener('pointerleave', () => { footTip.hidden = true; if (!footDrag) { footHover = null; requestDraw('foot'); } });
footCanvas.addEventListener('dblclick', event => {
  const at = footAt(event);
  if (at.area !== 'time-axis') { footView.priceAuto = true; footCenter = null; }
  if (at.area !== 'price-axis') resetTime(footView);
  requestDraw('foot');
});
footCanvas.addEventListener('wheel', event => {
  if (!bars.length) return;
  event.preventDefault();
  const at = footAt(event), factor = Math.exp(-event.deltaY / 500);
  if (at.area === 'price-axis' || event.ctrlKey || event.metaKey) footRowH = clamp(footRowH * factor, 3, 48);
  else if (event.altKey) { footRowH = clamp(footRowH * factor, 3, 48); zoomTime(footView, factor, at.px, bars.length, at.L.plotW); }
  else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) panTime(footView, -(event.deltaX || event.deltaY), bars.length, at.L.plotW);
  else zoomTime(footView, factor, at.px, bars.length, at.L.plotW);
  requestDraw('foot');
}, { passive: false });
function updateFootprintZoomControls() {
  const xLabel = $('#footZoomXReset'), yLabel = $('#footZoomYReset');
  if (xLabel) xLabel.textContent = 'X ' + Math.round(footView.barSpacing / footView.defaultSpacing * 100) + '%';
  if (yLabel) yLabel.textContent = 'Y ' + Math.round(footRowH / 16 * 100) + '%';
}
function fitFootprintOverview() {
  if (!bars.length || !footGeom) return;
  const L = footGeom.L;
  const count = Math.min(bars.length, 60);
  footView.barSpacing = clamp(L.plotW / (count + 1), footView.minSpacing, footView.maxSpacing);
  footView.rightOffset = 0.5;
  const { from, to } = visibleRange(footView, bars.length, L.plotW);
  const auto = autoPriceRange(bars, from, to, { margin: 0.02 });
  if (auto) footRowH = clamp((L.bottom - L.top) / Math.max(4, (auto.max - auto.min) / rowStep()), 3, 48);
  footView.priceAuto = true; footCenter = null;
  requestDraw('foot');
}
$('#footZoomXOut')?.addEventListener('click', () => { zoomTime(footView, 1 / 1.25, footGeom?.L.plotW ?? 600, bars.length, footGeom?.L.plotW ?? 600); requestDraw('foot'); });
$('#footZoomXIn')?.addEventListener('click', () => { zoomTime(footView, 1.25, footGeom?.L.plotW ?? 600, bars.length, footGeom?.L.plotW ?? 600); requestDraw('foot'); });
$('#footZoomXReset')?.addEventListener('click', () => { resetTime(footView); requestDraw('foot'); });
$('#footZoomYOut')?.addEventListener('click', () => { footRowH = clamp(footRowH / 1.25, 3, 48); requestDraw('foot'); });
$('#footZoomYIn')?.addEventListener('click', () => { footRowH = clamp(footRowH * 1.25, 3, 48); requestDraw('foot'); });
$('#footZoomYReset')?.addEventListener('click', () => { footRowH = 16; footView.priceAuto = true; footCenter = null; requestDraw('foot'); });
$('#footZoomFit')?.addEventListener('click', () => fitFootprintOverview());
// The market client sends ladders only for the candles the footprint can show, with a margin.
window.gold3poLevelsFrom = () => {
  if (!bars.length) return 0;
  const width = footGeom?.L.plotW ?? 900;
  const { from } = visibleRange(footView, bars.length, width);
  return bars[Math.max(0, from - 60)]?.timeMs ?? 0;
};

// ---------------------------------------------------------------- zones, inspector, selection
function renderZones() {
  const buyCount = zones.filter(z => z.side === 'buy').length, sellCount = zones.filter(z => z.side === 'sell').length;
  $('#zoneCount').textContent = String(zones.length).padStart(2, '0'); $('#aboveZones').textContent = zonesWord(buyCount); $('#belowZones').textContent = zonesWord(sellCount);
  if (!zones.length) { zoneList.innerHTML = '<div class="zone-empty">Зон пока нет. Они появятся, когда загрузится история брокера.</div>'; return; }
  zoneList.innerHTML = zones.map(z => { const src = Array.isArray(z.sources) ? z.sources.filter(Boolean) : []; const reaction = z.reactions?.touches ? `реакция ${z.reactions.respected}/${z.reactions.touches}` : 'касаний не было'; return `<button class="zone-row ${selectedZone === z.id ? 'selected' : ''}" data-zone="${z.id}" title="${src.map(zoneLabelText).join(', ')}"><span class="zone-side-dot ${z.side}"></span><span class="zone-info"><strong>${zoneLabelText(z.label)}</strong><small>${fmt(z.low)} — ${fmt(z.high)}</small><span class="zone-meter"><i class="${z.side}" style="width:${z.strength * 100}%"></i></span></span><span class="zone-right"><b>${z.distance || ''}</b><small>${zoneStateText(z.state)}</small><small class="zone-reaction">${reaction}${src.length ? ' · источников ' + src.length : ''}</small></span></button>`; }).join('');
  const zoneStats = $('#zoneStats');
  if (zoneStats) { const touches = zones.reduce((n, z) => n + (z.reactions?.touches || 0), 0), kept = zones.reduce((n, z) => n + (z.reactions?.respected || 0), 0); zoneStats.textContent = touches ? `История: ${kept} удержаний из ${touches} касаний · та же история, что и расчёт` : 'Проверять пока нечего: в истории нет касаний этих уровней'; }
  zoneList.querySelectorAll('button').forEach(n => n.addEventListener('click', () => { selectedZone = selectedZone === n.dataset.zone ? null : n.dataset.zone; showZoneOnChart(selectedZone); renderZones(); renderChart(); }));
}
// A zone picked in the list is brought into the price band if it is off screen.
function showZoneOnChart(id) {
  const z = zones.find(item => item.id === id);
  if (!z || !chartGeom) return;
  const { min, max } = chartGeom.range;
  if (z.low >= min && z.high <= max) return;
  const lo = Math.min(min, z.low), hi = Math.max(max, z.high), pad = (hi - lo) * 0.05;
  chartView.priceAuto = false; chartView.priceMin = lo - pad; chartView.priceMax = hi + pad;
}

function renderInspector() {
  const clear = () => { $('#selectedBar').textContent = '—'; $('#selectedDelta').textContent = '— Δ'; $('#selectedDelta').className = 'delta-chip'; for (const id of ['bidVolume', 'askVolume', 'totalVolume', 'unknownVolume', 'imbalance', 'pocPrice', 'valueAreaRange', 'absorbedInfo', 'unfinishedInfo']) { const n = $('#' + id); if (n) n.textContent = '—'; } const v = $('#flowVerdict'); if (v) { v.className = 'flow-verdict'; v.textContent = 'Выберите столбец футпринта: POC, зона стоимости и незакрытый аукцион считаются по тикам брокера.'; } };
  const raw = bars[selected]; if (!raw) { clear(); return; }
  const b = barFootprint(raw);
  const d = (b.unknown || 0) > 0 && !(b.bid || b.ask) ? null : (b.delta ?? barDelta(b)), bid = b.bid || 0, ask = b.ask || 0;
  $('#selectedBar').textContent = `#${String(selected + 1).padStart(3, '0')} · ${timeLabel(b.time, { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}`;
  $('#selectedDelta').textContent = d === null ? '— Δ' : `${d > 0 ? '+' : ''}${fmt(d, 0)} Δ`;
  $('#selectedDelta').className = `delta-chip ${d === null ? '' : d >= 0 ? 'positive-bg' : 'negative-bg'}`;
  $('#bidVolume').textContent = fmt(bid, 0);
  $('#askVolume').textContent = fmt(ask, 0);
  $('#totalVolume').textContent = fmt(b.volume ?? totalVolume(b), 0);
  $('#unknownVolume').textContent = (b.unknown || 0) > 0 ? fmt(b.unknown, 0) : '—';
  $('#imbalance').textContent = bid && ask ? `${(Math.max(bid, ask) / Math.min(bid, ask)).toFixed(2)}×` : '—';
  $('#pocPrice').textContent = b.poc != null ? fmt(b.poc) : '—';
  $('#valueAreaRange').textContent = b.valueArea ? `${fmt(b.valueArea.low)} — ${fmt(b.valueArea.high)} · ${Math.round(b.valueArea.share * 100)}%` : '—';
  const absorbed = b.absorbedLevels || [];
  $('#absorbedInfo').textContent = absorbed.length ? absorbed.map(item => `${fmt(item.price)} ×${item.multiple}`).join(' · ') : 'нет';
  const open = [b.unfinishedHigh ? 'верх' : null, b.unfinishedLow ? 'низ' : null].filter(Boolean);
  $('#unfinishedInfo').textContent = open.length ? 'не закрыт: ' + open.join(' и ') : 'закрыт';
  const divergence = analysisMeta?.divergence;
  const verdict = $('#flowVerdict');
  if (verdict) {
    const stackedCount = (b.stackedImbalances || []).length;
    const parts = [];
    if (b.poc != null) parts.push(`POC ${fmt(b.poc)}`);
    if (b.valueArea) parts.push(`зона стоимости ${fmt(b.valueArea.low)}–${fmt(b.valueArea.high)}`);
    parts.push(b.imbalances?.length ? `имбалансов ${b.imbalances.length}${stackedCount ? `, из них стеков ${stackedCount}` : ''}` : 'имбалансов нет');
    parts.push(absorbed.length ? `поглощение на ${absorbed.length === 1 ? 'уровне' : absorbed.length + ' уровнях'}` : 'поглощения нет');
    let text = `${parts.join(' · ')}.`;
    if (raw.coverage === 0) text = 'Тиков по этой свече нет: она взята из истории MT5 целиком. Скачайте историю тиков в блоке «История для футпринта», чтобы увидеть объём по ценам.';
    else if (Number.isFinite(raw.coverage) && raw.coverage < 0.9) text = `Тики есть примерно для ${Math.round(raw.coverage * 100)}% этой свечи — футпринт неполный. ` + text;
    if (divergence?.side) text += divergence.side === 'bearish' ? ' Цена растёт, кумулятивная дельта падает — покупатели не подтверждают движение.' : ' Цена падает, кумулятивная дельта растёт — продавцы не подтверждают движение.';
    verdict.className = `flow-verdict ${divergence?.side ? 'is-' + divergence.side : ''}`;
    verdict.textContent = text;
  }
}

// Bring bar i into a view that does not show it, centred.
function reveal(view, i, width) {
  if (!width || i < 0) return;
  const x = barX(view, i, bars.length, width);
  if (x >= view.barSpacing && x <= width - view.barSpacing) return;
  view.rightOffset = width / view.barSpacing / 2 - (bars.length - 1 - i) - 0.5;
}
function select(i, { from = null } = {}) {
  if (!Number.isInteger(i) || i < 0 || i >= bars.length) { selected = -1; renderInspector(); requestDraw(); return; }
  selected = i;
  if (from !== 'foot') reveal(footView, i, footGeom?.L.plotW);
  if (from !== 'chart') reveal(chartView, i, chartGeom?.L.plotW);
  renderInspector(); requestDraw();
}

$('#zonesToggle').addEventListener('click', e => { showZones = !showZones; e.currentTarget.setAttribute('aria-pressed', String(showZones)); e.currentTarget.classList.toggle('is-off', !showZones); renderChart(); notify(showZones ? 'Зоны ликвидности показаны' : 'Зоны ликвидности скрыты'); });
$('#numbersToggle').addEventListener('click', e => { showNumbers = !showNumbers; e.currentTarget.setAttribute('aria-pressed', String(showNumbers)); renderFootprint(); });
$('#footprintModes').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { mode = b.dataset.mode; $('#footprintModes').querySelectorAll('button').forEach(x => x.classList.toggle('selected', x === b)); renderFootprint(); }));
$('#resetView').addEventListener('click', () => {
  showZones = true; showNumbers = true; mode = 'bidask'; selectedZone = null; setAlertPick(false);
  resetTime(chartView); resetPrice(chartView); resetTime(footView); footView.priceAuto = true; footCenter = null; footRowH = 16;
  $('#zonesToggle').setAttribute('aria-pressed', 'true'); $('#numbersToggle').setAttribute('aria-pressed', 'true'); $('#zonesToggle').classList.remove('is-off');
  renderZones(); $('#footprintModes').querySelectorAll('button').forEach(b => b.classList.toggle('selected', b.dataset.mode === 'bidask'));
  select(bars.length - 1); notify('Вид сброшен');
});

// ---------------------------------------------------------------- layout
const workspace = $('#workspace'), layoutButton = $('#layoutButton'), panelResizer = $('#chartPanelResizer');
let layoutMode = 'stacked', splitRatio = 0.5, splitPointer = false;
try { layoutMode = localStorage.getItem('gold3po-layout') === 'split' ? 'split' : 'stacked'; splitRatio = clamp(Number(localStorage.getItem('gold3po-split') || 0.5), 0.32, 0.68); } catch {}
function applyWorkspaceLayout() {
  workspace.classList.toggle('trading-layout', layoutMode === 'split');
  workspace.style.setProperty('--chart-split', `${Math.round(splitRatio * 100)}%`);
  if (layoutButton) { const label = layoutButton.querySelector('span'); if (label) label.textContent = layoutMode === 'split' ? 'Окна: рядом' : 'Рабочая область'; layoutButton.setAttribute('aria-pressed', String(layoutMode === 'split')); }
  requestDraw();
}
layoutButton.addEventListener('click', () => {
  layoutMode = layoutMode === 'split' ? 'stacked' : 'split';
  try { localStorage.setItem('gold3po-layout', layoutMode); } catch {}
  applyWorkspaceLayout(); notify(layoutMode === 'split' ? 'График и футпринт размещены рядом' : 'График и футпринт расположены вертикально');
});
panelResizer?.addEventListener('pointerdown', event => { if (layoutMode !== 'split' || event.button !== 0) return; event.preventDefault(); splitPointer = true; panelResizer.setPointerCapture?.(event.pointerId); });
window.addEventListener('pointermove', event => {
  if (!splitPointer) return;
  const column = workspace.querySelector('.chart-column'), rect = column.getBoundingClientRect();
  if (rect.width <= 0) return;
  splitRatio = clamp((event.clientX - rect.left) / rect.width, 0.32, 0.68);
  workspace.style.setProperty('--chart-split', `${Math.round(splitRatio * 100)}%`);
});
const finishSplit = () => { if (!splitPointer) return; splitPointer = false; try { localStorage.setItem('gold3po-split', String(splitRatio)); } catch {} requestDraw(); };
window.addEventListener('pointerup', finishSplit); window.addEventListener('pointercancel', finishSplit);
panelResizer?.addEventListener('keydown', event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault(); splitRatio = clamp(splitRatio + (event.key === 'ArrowRight' ? 0.03 : -0.03), 0.32, 0.68);
  workspace.style.setProperty('--chart-split', `${Math.round(splitRatio * 100)}%`);
  try { localStorage.setItem('gold3po-split', String(splitRatio)); } catch {}
  requestDraw();
});
applyWorkspaceLayout();
if (typeof ResizeObserver !== 'undefined') {
  const observer = new ResizeObserver(() => requestDraw());
  observer.observe(chart); observer.observe(footCanvas);
} else window.addEventListener('resize', () => requestDraw());

// ---------------------------------------------------------------- live data
// Live ticks move the forming candle between window reloads. Each tick is kept until a reload proves
// the service has it (by sequence), then the reload is drawn and the newer ticks are applied on top,
// so the candle never steps back and never counts a tick twice.
let classifier = createTickClassifier();
let pendingTicks = [];
function applyLiveTick(event, { replay = false } = {}) {
  if (!bars.length || !event) return;
  const time = Date.parse(event.timestamp), interval = Number(analysisMeta?.intervalMs || window.gold3poIntervalMs?.() || 900000);
  const lastNum = Number(event.last);
  if (!Number.isFinite(time) || !(interval > 0) || !(lastNum > 0)) return;
  if (!replay && Number.isFinite(event.sequence)) { pendingTicks.push(event); if (pendingTicks.length > 5000) pendingTicks.splice(0, pendingTicks.length - 5000); }
  const start = bucketStart(time, interval, Number(analysisMeta?.clockOffsetMs) || 0);
  const previous = bars.at(-1);
  if (start < previous.timeMs) return; // a late tick for a closed candle: the next reload is authoritative
  if (start > previous.timeMs) {
    bars.push({ ...emptyBar(start, lastNum), time: new Date(start).toISOString(), levels: [], levelMap: new Map() });
    followNewBars(chartView, 1); followNewBars(footView, 1);
    if (selected === bars.length - 2) selected = bars.length - 1;
  }
  const bar = bars.at(-1);
  if (!bar.levelMap) bar.levelMap = new Map((Array.isArray(bar.levels) ? bar.levels : []).map(row => [Number(row.price).toFixed(8), { ...row }]));
  const side = classifier.classify({ last: lastNum, bid: Number(event.bid), ask: Number(event.ask), aggressorSide: event.aggressorSide, flags: event.flags });
  const step = serviceRowStep();
  const state = { levels: bar.levelMap, o: bar.o, h: bar.h, l: bar.l, c: bar.c, volume: bar.volume || 0, bid: bar.bid || 0, ask: bar.ask || 0, unknown: bar.unknown || 0, tickCount: bar.tickCount || 0 };
  applyTickToBar(state, { last: lastNum, volume: footprintTickVolume({ ...event, aggressorSide: side }), aggressorSide: side, flags: event.flags }, step);
  const foot = footprintOf(state.levels, { ...footprintOptions(), ticksPerRow: 1, priceStep: step, h: state.h, l: state.l, c: state.c });
  Object.assign(bar, { o: state.o, h: state.h, l: state.l, c: state.c, volume: state.volume, bid: state.bid, ask: state.ask, unknown: state.unknown, tickCount: state.tickCount,
    levels: foot.levels, delta: foot.delta, deltaRatio: foot.deltaRatio, poc: foot.poc, valueArea: foot.valueArea, imbalances: foot.imbalances,
    stackedImbalances: foot.stackedImbalances, absorbedLevels: foot.absorbedLevels, unfinishedHigh: foot.unfinishedHigh, unfinishedLow: foot.unfinishedLow, maxLevelVolume: foot.maxLevelVolume });
  bar.cumulativeDelta = (bars[bars.length - 2]?.cumulativeDelta || 0) + bar.delta;
  if (!replay) { requestDraw(); if (selected === bars.length - 1) renderInspector(); }
}
window.addEventListener('market-tick', e => applyLiveTick(e.detail));
// Footprint settings changed: recompute the marks from the ladders already on screen.
window.addEventListener('gold3po-settings', () => { for (const b of bars) { if (Array.isArray(b.levels) && b.poc !== undefined) { delete b.poc; delete b.valueArea; delete b.imbalances; delete b.stackedImbalances; delete b.absorbedLevels; delete b.unfinishedHigh; delete b.unfinishedLow; delete b.deltaRatio; delete b.maxLevelVolume; } } requestDraw('foot'); renderInspector(); });

window.addEventListener('market-analysis', e => {
  const a = e.detail; if (!a?.bars?.length) return;
  const previousTime = bars[selected]?.timeMs, wasAtLatest = selected === bars.length - 1 || selected < 0;
  const previousLast = bars.at(-1)?.timeMs, timeframeChanged = analysisMeta && analysisMeta.intervalMs !== a.intervalMs;
  bars = a.bars;
  analysisMeta = a; live = true; zones = a.zones || [];
  classifier = createTickClassifier(a.tickRule || {});
  const seen = Number(a.lastQuote?.sequence);
  pendingTicks = Number.isFinite(seen) ? pendingTicks.filter(t => t.sequence > seen) : [];
  for (const tick of pendingTicks) applyLiveTick(tick, { replay: true });
  if (timeframeChanged || !previousLast) { resetTime(chartView); resetPrice(chartView); resetTime(footView); footView.priceAuto = true; footCenter = null; selectedZone = null; }
  else { const added = bars.filter(b => b.timeMs > previousLast).length; followNewBars(chartView, added); followNewBars(footView, added); }
  selected = wasAtLatest || timeframeChanged ? bars.length - 1 : Math.max(0, bars.findIndex(b => b.timeMs === previousTime));
  const tf = Number(a.timeframeMinutes || Number(a.intervalMs) / 60000);
  document.querySelectorAll('.timeframe-label').forEach(node => { if (Number.isFinite(tf) && tf > 0) { const caption = tf >= 60 ? (tf % 60 === 0 ? tf / 60 + 'ч' : tf + 'м') : tf + 'м'; node.textContent = caption + (node.classList.contains('footprint-timeframe') ? ' · ТФ ГРАФИКА' : a.candleSource === 'mt5_m1_rates' ? ' · СВЕЧИ MT5' : ' · ПО ТИКАМ'); } });
  const feedLive = a.feed?.status === 'online';
  const status = $('#chartStatus'); if (status) { status.textContent = (feedLive ? 'ОНЛАЙН · ' : 'ИСТОРИЯ · ') + barsWord(bars.length); status.className = feedLive ? 'ok' : 'warning'; }
  const signalSummary = $('#signalSummary');
  if (signalSummary) { const sweeps = bars.reduce((n, b) => n + (b.sweeps?.length || 0), 0), stacked = bars.reduce((n, b) => n + (b.stackedImbalances?.length || 0), 0), unfinished = bars.filter(b => b.unfinishedHigh || b.unfinishedLow).length, absorbed = bars.reduce((n, b) => n + ((b.absorbedLevels || []).length ? 1 : 0), 0); const naked = a.profile?.naked?.length || 0, div = a.divergence?.side; signalSummary.textContent = 'СНЯТИЯ ' + sweeps + ' · СТЕКИ ' + stacked + ' · ПОГЛОЩЕНИЕ УРОВНЕЙ ' + absorbed + ' · НЕЗАКРЫТЫЕ АУКЦИОНЫ ' + unfinished + (naked ? ' · ГОЛЫХ POC ' + naked : '') + (div ? (div === 'bearish' ? ' · ДИВЕРГЕНЦИЯ: МЕДВЕЖЬЯ' : ' · ДИВЕРГЕНЦИЯ: БЫЧЬЯ') : ''); }
  const range = $('#barCount'); if (range) range.textContent = barsWord(bars.length);
  renderTimeWindow();
  renderZones(); renderInspector(); requestDraw();
});
window.addEventListener('market-feed-clear', () => {
  bars = []; zones = []; signals = []; selected = -1; selectedZone = null; analysisMeta = null; live = false; pendingTicks = [];
  resetTime(chartView); resetPrice(chartView); resetTime(footView); footView.priceAuto = true; footCenter = null;
  const count = $('#barCount'); if (count) count.textContent = 'ОЖИДАНИЕ ИСТОРИИ';
  const range = $('#sessionRange'); if (range) range.textContent = 'Ожидание истории';
  const status = $('#chartStatus'); if (status) { status.textContent = 'ОЖИДАНИЕ ДАННЫХ · ПОДКЛЮЧИТЕ MT5'; status.className = 'warning'; }
  renderZones(); renderInspector(); requestDraw();
});
const initialStatus = $('#chartStatus'); if (initialStatus && !live) { initialStatus.textContent = 'ОЖИДАНИЕ ДАННЫХ · ПОДКЛЮЧИТЕ MT5'; initialStatus.className = 'warning'; }
renderZones(); renderInspector(); requestDraw();
for (const id of ['chartRefresh', 'footRefresh']) $('#' + id)?.addEventListener('click', async e => {
  const btn = e.currentTarget; btn.classList.remove('spin'); void btn.offsetWidth; btn.classList.add('spin'); btn.disabled = true;
  try { await window.gold3poRefresh?.(); notify('Данные перезагружены из MT5'); }
  catch { notify('Не удалось обновить: сервис недоступен'); }
  finally { btn.disabled = false; window.setTimeout(() => btn.classList.remove('spin'), 800); }
});

// Overlays: strategy signals, COMEX levels, price alerts.
function renderTimeWindow() {
  const label = $('#timeZoneLabel'); if (label) label.textContent = timeZoneCaption();
  const node = $('#sessionWindow'); if (!node || !bars.length) return;
  node.textContent = timeLabel(bars[0].timeMs ?? bars[0].time, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' — ' + timeLabel(bars.at(-1).timeMs ?? bars.at(-1).time, { hour: '2-digit', minute: '2-digit' });
}
function setAlertPick(on) {
  alertPick = Boolean(on);
  const button = $('#alertMode'); if (button) { button.setAttribute('aria-pressed', String(alertPick)); button.classList.toggle('is-active', alertPick); }
  chart.classList.toggle('is-picking', alertPick);
  if (alertPick) notify('Кликните по графику на нужной цене — алерт будет поставлен. Esc — отмена.');
  requestDraw('chart');
}
function syncOverlayButtons() {
  for (const [id, key] of [['#signalsToggle', 'showSignals'], ['#comexToggle', 'showComex']]) {
    const on = uiSetting(key, true) !== false, button = $(id);
    if (button) { button.setAttribute('aria-pressed', String(on)); button.classList.toggle('is-off', !on); }
  }
}
$('#alertMode')?.addEventListener('click', () => setAlertPick(!alertPick));
window.addEventListener('keydown', e => { if (e.key === 'Escape' && alertPick) setAlertPick(false); });
window.addEventListener('gold3po-alert-pick', e => setAlertPick(e.detail?.on !== false));
for (const [id, key, label] of [['#signalsToggle', 'showSignals', 'Сигналы стратегии'], ['#comexToggle', 'showComex', 'Уровни COMEX']]) $(id)?.addEventListener('click', () => {
  const next = uiSetting(key, true) === false;
  window.gold3poSetUi?.(key, next);
  syncOverlayButtons(); requestDraw('chart');
  notify(`${label} ${next ? 'показаны' : 'скрыты'}`);
});
window.addEventListener('gold3po-signals', e => { signals = Array.isArray(e.detail?.signals) ? e.detail.signals : []; requestDraw('chart'); });
window.addEventListener('gold3po-comex', e => { comexLevels = Array.isArray(e.detail?.levels) ? e.detail.levels : []; requestDraw('chart'); });
window.addEventListener('gold3po-alerts-changed', () => requestDraw('chart'));
window.addEventListener('gold3po-settings', () => { syncOverlayButtons(); renderTimeWindow(); requestDraw(); });
syncOverlayButtons();

// Read-only view of what is on screen, for the browser test and for diagnostics.
window.gold3poChart = Object.freeze({
  state: () => ({ bars: bars.length, last: bars.at(-1) ? { time: bars.at(-1).time, o: bars.at(-1).o, h: bars.at(-1).h, l: bars.at(-1).l, c: bars.at(-1).c, tickCount: bars.at(-1).tickCount, levels: Array.isArray(bars.at(-1).levels) ? bars.at(-1).levels.length : null, bid: bars.at(-1).bid, ask: bars.at(-1).ask } : null,
    selected, selectedZone, zones: zones.length, signals: signals.length, comexLevels: comexLevels.length, alertPick, clockOffsetMs: analysisMeta?.clockOffsetMs ?? null, candleSource: analysisMeta?.candleSource ?? null, showZones, showNumbers, mode, intervalMs: analysisMeta?.intervalMs ?? null, rowStep: bars.length ? rowStep() : null, chartView: { ...chartView }, footView: { ...footView }, footRowH, footGeometry: footGeom ? { top: footGeom.L.top, bottom: footGeom.L.bottom, plotW: footGeom.L.plotW, center: footGeom.G.center, perPrice: footGeom.G.perPrice } : null, stats: { ...stats }, pendingTicks: pendingTicks.length, empty: !bars.length }),
  scene: () => JSON.parse(JSON.stringify(scene)),
  // Page coordinates of a bar (and optionally a price) on either canvas, so a test clicks what a trader would.
  point: (where, index, price) => {
    const canvas = where === 'foot' ? footCanvas : chart, rect = canvas.getBoundingClientRect();
    if (where === 'foot') {
      if (!footGeom) return null;
      const px = barX(footView, index, bars.length, footGeom.L.plotW);
      const py = Number.isFinite(price) ? footGeom.G.y(price) : (footGeom.L.top + footGeom.L.bottom) / 2;
      return { x: rect.left + px, y: rect.top + py };
    }
    if (!chartGeom) return null;
    const px = barX(chartView, index, bars.length, chartGeom.L.plotW);
    const py = Number.isFinite(price) ? chartGeom.y(price) : (chartGeom.L.priceTop + chartGeom.L.priceBottom) / 2;
    return { x: rect.left + px, y: rect.top + py };
  }
});
