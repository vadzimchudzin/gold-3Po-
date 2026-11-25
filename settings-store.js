import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULT_ZONE_OPTIONS, validateZoneOptions } from './market-engine.js';
import { DEFAULT_FOOTPRINT_OPTIONS, validateFootprintOptions } from './footprint-engine.js';

// App preferences: how zones are found and how the MT5 indicator draws them.
// Kept apart from setups (which are versioned research conditions) so a colour change never creates a setup version.

export const LINE_STYLES = ['solid', 'dash', 'dot', 'dashdot', 'dashdotdot'];
export const TIMEFRAMES = [1, 5, 15, 30, 60, 240];

export const DEFAULT_SETTINGS = Object.freeze({
  zones: { ...DEFAULT_ZONE_OPTIONS, timeframeMinutes: 15 },
  footprint: { ...DEFAULT_FOOTPRINT_OPTIONS, autoStep: true },
  mt5: {
    buyColor: '#FF0000',   // zones above price (resistance / buy-side liquidity)
    sellColor: '#FF0000',  // zones below price (support / sell-side liquidity)
    lineStyle: 'solid',
    lineWidth: 2,
    fill: false,           // shade the zone body as a rectangle behind the candles
    showLabels: true,
    showStrength: true,
    zonesVisible: true    // false publishes an empty snapshot, which clears every zone in MT5 at once
  },
  ui: { theme: 'glass-dark' }
});

const clone = value => JSON.parse(JSON.stringify(value));
const HEX = /^#[0-9A-F]{6}$/;

function section(name, input, defaults) {
  if (input === undefined) return { ...defaults };
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(input)) if (!(key in defaults)) throw new TypeError(`Unknown ${name} setting: ${key}`);
  return { ...defaults, ...input };
}

export function validateSettings(input = {}, base = DEFAULT_SETTINGS) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError('Settings must be an object');
  for (const key of Object.keys(input)) if (!['zones', 'footprint', 'mt5', 'ui'].includes(key)) throw new TypeError(`Unknown settings section: ${key}`);

  const f = section('footprint', input.footprint, base.footprint);
  const footprint = validateFootprintOptions(f);

  const z = section('zones', input.zones, base.zones);
  const { timeframeMinutes, ...zoneOptions } = z;
  const tf = Number(timeframeMinutes);
  if (!TIMEFRAMES.includes(tf)) throw new TypeError(`timeframeMinutes must be one of ${TIMEFRAMES.join(', ')}`);
  const zones = { ...validateZoneOptions(zoneOptions), timeframeMinutes: tf };

  const m = section('mt5', input.mt5, base.mt5);
  const mt5 = { ...m };
  for (const key of ['buyColor', 'sellColor']) {
    mt5[key] = String(m[key]).toUpperCase();
    if (!HEX.test(mt5[key])) throw new TypeError(`${key} must be a #RRGGBB colour`);
  }
  if (!LINE_STYLES.includes(m.lineStyle)) throw new TypeError(`lineStyle must be one of ${LINE_STYLES.join(', ')}`);
  mt5.lineWidth = Number(m.lineWidth);
  if (!Number.isInteger(mt5.lineWidth) || mt5.lineWidth < 1 || mt5.lineWidth > 5) throw new TypeError('lineWidth must be an integer 1..5');
  // MT5 renders dashed and dotted lines only at width 1, so a non-solid style always stores width 1.
  if (mt5.lineStyle !== 'solid') mt5.lineWidth = 1;
  for (const key of ['fill', 'showLabels', 'showStrength', 'zonesVisible']) if (typeof m[key] !== 'boolean') throw new TypeError(`${key} must be true or false`);

  const u = section('ui', input.ui, base.ui);
  if (!['glass-dark', 'glass-light'].includes(u.theme)) throw new TypeError('theme must be glass-dark or glass-light');
  return { zones, footprint, mt5, ui: { theme: u.theme } };
}

export function createSettingsStore({ file = './data/settings.json' } = {}) {
  let state = clone(DEFAULT_SETTINGS);
  let loaded = null;

  function load() {
    if (!loaded) loaded = (async () => {
      if (!file) return;
      try { state = validateSettings(JSON.parse(await readFile(file, 'utf8'))); }
      catch { state = clone(DEFAULT_SETTINGS); } // missing or hand-broken file: start from defaults
    })();
    return loaded;
  }

  async function persist() {
    if (!file) return;
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await rename(tmp, file);
  }

  return {
    async get() { await load(); return clone(state); },
    // Partial update: only the sections and keys sent are changed, the rest keep their current values.
    async update(patch) {
      await load();
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new TypeError('Settings must be an object');
      const merged = {};
      for (const key of Object.keys(patch)) {
        if (!['zones', 'footprint', 'mt5', 'ui'].includes(key)) throw new TypeError(`Unknown settings section: ${key}`);
        if (typeof patch[key] !== 'object' || patch[key] === null || Array.isArray(patch[key])) throw new TypeError(`${key} must be an object`);
        merged[key] = { ...state[key], ...patch[key] };
      }
      state = validateSettings(merged, state);
      await persist();
      return clone(state);
    },
    async reset() { await load(); state = clone(DEFAULT_SETTINGS); await persist(); return clone(state); }
  };
}
