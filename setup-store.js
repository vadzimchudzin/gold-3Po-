import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateStrategyConditions, DEFAULT_STRATEGY_CONDITIONS } from './strategy-engine.js';
import { validateSettings } from './settings-store.js';

// Strategy profiles: named, append-only immutable versions, strict validation, JSON import/export.
// A profile is everything a trader tunes for their own way of reading the market: the signal
// conditions, and optionally the zone search and footprint settings that go with them. Applying a
// profile switches all of it at once. A profile never contains tokens, keys or personal data.
//
// Earlier builds also stored backtest and risk sections. Backtests are gone from the app; those
// sections are still accepted when an old file or export is read, and dropped.

export const DEFAULT_DEFINITION = {
  strategy: { ...DEFAULT_STRATEGY_CONDITIONS },
  zones: null,
  footprint: null
};

const LEGACY_SECTIONS = ['backtest', 'risk'];

export function validateDefinition(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError('Setup definition must be an object');
  for (const key of Object.keys(input)) if (!['strategy', 'zones', 'footprint', ...LEGACY_SECTIONS].includes(key)) throw new TypeError(`Unknown setup section: ${key}`);
  const strategy = validateStrategyConditions(input.strategy || {});
  const zones = input.zones === undefined || input.zones === null ? null : validateSettings({ zones: input.zones }).zones;
  const footprint = input.footprint === undefined || input.footprint === null ? null : validateSettings({ footprint: input.footprint }).footprint;
  return { strategy, zones, footprint };
}

const normalize = definition => ({ strategy: definition.strategy, zones: definition.zones ?? null, footprint: definition.footprint ?? null });

export function definitionFingerprint(definition) {
  const canonical = JSON.stringify({ strategy: definition.strategy, zones: definition.zones ?? null, footprint: definition.footprint ?? null });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function createSetupStore({ file = './data/setups.json', now = () => Date.now() } = {}) {
  let state = { setups: [], activeId: null, activeVersion: null };
  let loaded = false;

  async function load() {
    if (loaded) return;
    loaded = true;
    if (!file) return;
    try {
      const stored = JSON.parse(await readFile(file, 'utf8'));
      if (Array.isArray(stored.setups)) state = stored;
    } catch { /* fresh library */ }
  }

  async function persist() {
    if (!file) return;
    await mkdir(dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await rename(tmp, file);
  }

  function findSetup(id) { return state.setups.find(s => s.id === id) || null; }

  function publicState() {
    return {
      setups: state.setups.map(s => ({ id: s.id, name: s.name, createdAt: s.createdAt, versions: s.versions.map(v => ({ version: v.version, fingerprint: v.fingerprint, createdAt: v.createdAt })) })),
      activeId: state.activeId,
      activeVersion: state.activeVersion,
      activeDefinition: activeDefinitionSync()
    };
  }

  function activeDefinitionSync() {
    const setup = state.activeId ? findSetup(state.activeId) : null;
    const version = setup ? setup.versions.find(v => v.version === (state.activeVersion ?? setup.versions.at(-1).version)) : null;
    return version ? normalize(version.definition) : DEFAULT_DEFINITION;
  }

  async function save(name, definition) {
    await load();
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) throw new TypeError('Setup name must be 1..60 characters');
    const validated = validateDefinition(definition);
    const cleanName = name.trim();
    let setup = state.setups.find(s => s.name.toLowerCase() === cleanName.toLowerCase());
    const createdAt = new Date(now()).toISOString();
    if (!setup) {
      setup = { id: 'setup-' + randomBytes(5).toString('hex'), name: cleanName, createdAt, versions: [] };
      state.setups.push(setup);
    }
    const fingerprint = definitionFingerprint(validated);
    const identical = setup.versions.find(v => v.fingerprint === fingerprint);
    if (identical) return { setupId: setup.id, version: identical.version, fingerprint, deduplicated: true };
    const version = setup.versions.length + 1;
    setup.versions.push({ version, fingerprint, definition: validated, createdAt });
    await persist();
    return { setupId: setup.id, version, fingerprint, deduplicated: false };
  }

  async function apply(id, version = null) {
    await load();
    const setup = findSetup(id);
    if (!setup) throw Object.assign(new Error('Setup not found'), { status: 404 });
    const target = version === null ? setup.versions.at(-1).version : Number(version);
    if (!setup.versions.some(v => v.version === target)) throw Object.assign(new Error('Setup version not found'), { status: 404 });
    state.activeId = id;
    state.activeVersion = target;
    await persist();
    return publicState();
  }

  async function exportDefinition(id, version = null) {
    await load();
    const setup = findSetup(id);
    if (!setup) throw Object.assign(new Error('Setup not found'), { status: 404 });
    const target = version === null ? setup.versions.at(-1).version : Number(version);
    const found = setup.versions.find(v => v.version === target);
    if (!found) throw Object.assign(new Error('Setup version not found'), { status: 404 });
    return { name: setup.name, version: found.version, fingerprint: found.fingerprint, definition: normalize(found.definition) };
  }

  async function importSetup(name, definition) {
    // Import always creates a new setup identity; it never modifies history or applies itself.
    const result = await save(name, definition);
    return result;
  }

  async function remove(id) {
    await load();
    const index = state.setups.findIndex(s => s.id === id);
    if (index < 0) throw Object.assign(new Error('Setup not found'), { status: 404 });
    state.setups.splice(index, 1);
    if (state.activeId === id) { state.activeId = null; state.activeVersion = null; }
    await persist();
    return publicState();
  }

  // Back to the built-in conditions; the zone and footprint settings stay as they are.
  async function clearActive() {
    await load();
    state.activeId = null; state.activeVersion = null;
    await persist();
    return publicState();
  }

  async function list() { await load(); return publicState(); }
  async function activeDefinition() { await load(); return activeDefinitionSync(); }

  return { save, apply, remove, clearActive, exportDefinition, importSetup, list, activeDefinition };
}
