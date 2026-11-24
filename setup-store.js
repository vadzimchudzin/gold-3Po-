import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateStrategyConditions, DEFAULT_STRATEGY_CONDITIONS } from './strategy-engine.js';

// Vespera-style setup library: named setups, append-only immutable versions,
// strict definition validation (unknown fields are rejected), JSON import/export.
// A setup never contains tokens, keys or personal data — only research conditions.

export const DEFAULT_BACKTEST_CONDITIONS = {
  stopAtr: 1.5,
  targetR: 2,
  maxBars: 20,
  riskPct: 0.5,
  maxRiskPct: 1,
  pointValue: 1,
  feePerUnit: 0,
  slippage: 0,
  breakevenR: 0,
  trailingAtr: 0
};

export const DEFAULT_RISK_CONDITIONS = {
  maxRiskPct: 1,
  minRiskReward: 1.5
};

export const DEFAULT_DEFINITION = {
  strategy: { ...DEFAULT_STRATEGY_CONDITIONS },
  backtest: { ...DEFAULT_BACKTEST_CONDITIONS },
  risk: { ...DEFAULT_RISK_CONDITIONS }
};

const finite = Number.isFinite;

export function validateDefinition(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError('Setup definition must be an object');
  for (const key of Object.keys(input)) if (!['strategy', 'backtest', 'risk'].includes(key)) throw new TypeError(`Unknown setup section: ${key}`);
  const strategy = validateStrategyConditions(input.strategy || {});
  const backtest = { ...DEFAULT_BACKTEST_CONDITIONS, ...(input.backtest || {}) };
  for (const key of Object.keys(input.backtest || {})) if (!(key in DEFAULT_BACKTEST_CONDITIONS)) throw new TypeError(`Unknown backtest condition: ${key}`);
  if (!finite(backtest.stopAtr) || backtest.stopAtr <= 0 || backtest.stopAtr > 20) throw new TypeError('stopAtr must be in (0, 20]');
  if (!finite(backtest.targetR) || backtest.targetR <= 0 || backtest.targetR > 50) throw new TypeError('targetR must be in (0, 50]');
  if (!Number.isInteger(backtest.maxBars) || backtest.maxBars < 1 || backtest.maxBars > 500) throw new TypeError('maxBars must be an integer 1..500');
  if (!finite(backtest.riskPct) || backtest.riskPct <= 0 || backtest.riskPct > 1) throw new TypeError('riskPct must be in (0, 1]');
  if (!finite(backtest.maxRiskPct) || backtest.maxRiskPct <= 0 || backtest.maxRiskPct > 1) throw new TypeError('maxRiskPct must be in (0, 1]');
  if (backtest.riskPct > backtest.maxRiskPct) throw new TypeError('riskPct must not exceed maxRiskPct');
  if (!finite(backtest.pointValue) || backtest.pointValue <= 0) throw new TypeError('pointValue must be positive');
  if (!finite(backtest.feePerUnit) || backtest.feePerUnit < 0) throw new TypeError('feePerUnit must be non-negative');
  if (!finite(backtest.slippage) || backtest.slippage < 0) throw new TypeError('slippage must be non-negative');
  if (!finite(backtest.breakevenR) || backtest.breakevenR < 0 || backtest.breakevenR > 10) throw new TypeError('breakevenR must be between 0 and 10');
  if (!finite(backtest.trailingAtr) || backtest.trailingAtr < 0 || backtest.trailingAtr > 20) throw new TypeError('trailingAtr must be between 0 and 20');
  const risk = { ...DEFAULT_RISK_CONDITIONS, ...(input.risk || {}) };
  for (const key of Object.keys(input.risk || {})) if (!(key in DEFAULT_RISK_CONDITIONS)) throw new TypeError(`Unknown risk condition: ${key}`);
  if (!finite(risk.maxRiskPct) || risk.maxRiskPct <= 0 || risk.maxRiskPct > 1) throw new TypeError('risk.maxRiskPct must be in (0, 1]');
  if (!finite(risk.minRiskReward) || risk.minRiskReward <= 0 || risk.minRiskReward > 50) throw new TypeError('risk.minRiskReward must be in (0, 50]');
  return { strategy, backtest, risk };
}

export function definitionFingerprint(definition) {
  const canonical = JSON.stringify({ strategy: definition.strategy, backtest: definition.backtest, risk: definition.risk });
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
    return version ? version.definition : DEFAULT_DEFINITION;
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
    return { name: setup.name, version: found.version, fingerprint: found.fingerprint, definition: found.definition };
  }

  async function importSetup(name, definition) {
    // Import always creates a new setup identity; it never modifies history or applies itself.
    const result = await save(name, definition);
    return result;
  }

  async function list() { await load(); return publicState(); }
  async function activeDefinition() { await load(); return activeDefinitionSync(); }

  return { save, apply, exportDefinition, importSetup, list, activeDefinition };
}
