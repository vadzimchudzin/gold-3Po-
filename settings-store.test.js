import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsStore, validateSettings, DEFAULT_SETTINGS } from './settings-store.js';

test('defaults draw red solid zone lines and look for 3..7 zones', () => {
  const s = validateSettings({});
  assert.equal(s.mt5.buyColor, '#FF0000');
  assert.equal(s.mt5.sellColor, '#FF0000');
  assert.equal(s.mt5.lineStyle, 'solid');
  assert.equal(s.zones.minZones, 3);
  assert.equal(s.zones.maxZones, 7);
  assert.deepEqual(s, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
});

test('a settings file from a build with strong-only zones and auto footprint rows still loads', () => {
  const s = validateSettings({ zones: { strongOnly: true, maxZones: 5 }, footprint: { autoStep: true, ticksPerRow: 1, imbalanceRatio: 4 } });
  assert.equal(s.zones.maxZones, 5, 'the other zone settings survive');
  assert.equal('strongOnly' in s.zones, false);
  assert.equal('autoStep' in s.footprint, false);
  assert.equal(s.footprint.ticksPerRow, DEFAULT_SETTINGS.footprint.ticksPerRow, 'auto becomes the fixed default row');
  assert.equal(s.footprint.imbalanceRatio, 4);
  const manual = validateSettings({ footprint: { autoStep: false, ticksPerRow: 5 } });
  assert.equal(manual.footprint.ticksPerRow, 5, 'a manual row size is kept');
});

test('settings persist across restarts and a broken file falls back to defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'g3p-settings-'));
  try {
    const file = join(dir, 'settings.json');
    await createSettingsStore({ file }).update({ mt5: { buyColor: '#ff8800', showLabels: false }, zones: { pivotWidth: 3 } });
    const again = await createSettingsStore({ file }).get();
    assert.equal(again.mt5.buyColor, '#FF8800');
    assert.equal(again.mt5.showLabels, false);
    assert.equal(again.zones.pivotWidth, 3);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).zones.pivotWidth, 3);
    await writeFile(file, '{not json');
    assert.equal((await createSettingsStore({ file }).get()).mt5.buyColor, '#FF0000');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('zone sources and measurement windows persist, so the switches reach the engine', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'g3p-settings-'));
  try {
    const file = join(dir, 'settings.json');
    await createSettingsStore({ file }).update({
      zones: { atrPeriod: 21, reactionBars: 10, useVolume: false, useSessions: false, useWeek: false }
    });
    const saved = (await createSettingsStore({ file }).get()).zones;
    assert.equal(saved.atrPeriod, 21);
    assert.equal(saved.reactionBars, 10);
    assert.equal(saved.useVolume, false);
    assert.equal(saved.useSessions, false);
    assert.equal(saved.useWeek, false);
    assert.equal(saved.usePriorDay, true, 'untouched sources keep their default');
    assert.equal(saved.useHigherTf, true);
    const onDisk = JSON.parse(await readFile(file, 'utf8')).zones;
    assert.equal(onDisk.useVolume, false, 'the switch is written to disk, not only returned');
    assert.equal(onDisk.reactionBars, 10);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('footprint thresholds persist and reach the engine', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'g3p-settings-'));
  try {
    const file = join(dir, 'settings.json');
    await createSettingsStore({ file }).update({ footprint: { imbalanceRatio: 2, valueAreaShare: 0.8 } });
    const saved = (await createSettingsStore({ file }).get()).footprint;
    assert.equal(saved.imbalanceRatio, 2);
    assert.equal(saved.valueAreaShare, 0.8);
    assert.equal(saved.imbalanceLevels, 3, 'untouched footprint keys keep their default');
    assert.equal(saved.minLevelVolume, 3);
    const onDisk = JSON.parse(await readFile(file, 'utf8')).footprint;
    assert.equal(onDisk.imbalanceRatio, 2, 'the ratio is written, not only returned');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid settings are rejected', () => {
  assert.throws(() => validateSettings({ mt5: { lineWidth: 9 } }), /lineWidth/);
  assert.throws(() => validateSettings({ mt5: { lineStyle: 'wavy' } }), /lineStyle/);
  assert.throws(() => validateSettings({ mt5: { fill: 'yes' } }), /fill/);
  assert.throws(() => validateSettings({ mt5: { zonesVisible: 'нет' } }), /zonesVisible/);
  assert.throws(() => validateSettings({ ui: { theme: 'neon' } }), /theme/);
  assert.throws(() => validateSettings({ zones: { clusterAtr: 0 } }), /clusterAtr/);
  assert.throws(() => validateSettings({ zones: { atrPeriod: 1 } }), /atrPeriod/);
  assert.throws(() => validateSettings({ zones: { reactionBars: 0 } }), /reactionBars/);
  assert.throws(() => validateSettings({ zones: { useVolume: 'да' } }), /useVolume/);
  assert.throws(() => validateSettings({ footprint: { imbalanceRatio: 1 } }), /imbalanceRatio/);
  assert.throws(() => validateSettings({ footprint: { valueAreaShare: 1.2 } }), /valueAreaShare/);
});

test('zones are drawn in MT5 until the switch is turned off, and the choice survives a restart', async () => {
  assert.equal(validateSettings({}).mt5.zonesVisible, true, 'zones are visible by default');
  const dir = await mkdtemp(join(tmpdir(), 'g3p-settings-zones-'));
  const file = join(dir, 'settings.json');
  try {
    await createSettingsStore({ file }).update({ mt5: { zonesVisible: false } });
    assert.equal((await createSettingsStore({ file }).get()).mt5.zonesVisible, false, 'hidden zones stay hidden after a restart');
    await createSettingsStore({ file }).update({ mt5: { zonesVisible: true } });
    assert.equal((await createSettingsStore({ file }).get()).mt5.zonesVisible, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the look defaults to glass, can be switched to terminal, and old files without it still load', () => {
  assert.equal(DEFAULT_SETTINGS.ui.style, 'glass');
  assert.equal(validateSettings({ ui: { style: 'terminal' } }).ui.style, 'terminal');
  assert.equal(validateSettings({ ui: { theme: 'glass-light', timeDisplay: 'utc', showComex: true, showSignals: true } }).ui.style, 'glass');
  assert.throws(() => validateSettings({ ui: { style: 'neon' } }), /style/);
});
