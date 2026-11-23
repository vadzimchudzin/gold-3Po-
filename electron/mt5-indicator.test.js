import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installIndicator } from './mt5-indicator.js';

test('autopatch installs only the GOLD-3Po MQL5 assets when MetaEditor is absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gold3po-mt5-patch-'));
  try {
    const data = path.join(root, 'terminal-data');
    const experts = path.join(data, 'MQL5', 'Experts');
    const indicators = path.join(data, 'MQL5', 'Indicators');
    await mkdir(experts, { recursive: true });
    await mkdir(indicators, { recursive: true });
    await writeFile(path.join(experts, 'UserStrategy.mq5'), 'user expert');
    await writeFile(path.join(indicators, 'ThirdParty.mq5'), 'third party indicator');

    const bridgeSource = path.join(root, 'Gold3PoBridge.mq5');
    const levelsSource = path.join(root, 'Gold3PoLevels.mq5');
    const terminalPath = path.join(root, 'terminal64.exe');
    await writeFile(bridgeSource, 'gold3po bridge source');
    await writeFile(levelsSource, 'gold3po levels source');
    await writeFile(terminalPath, 'placeholder terminal');

    const result = await installIndicator({
      source: levelsSource,
      bridgeSource,
      terminalPath,
      terminalDataPath: data
    });

    assert.match(result, /Gold3PoBridge/);
    assert.match(result, /Gold3PoLevels/);
    assert.match(result, /0\/2/);
    assert.equal(await readFile(path.join(experts, 'Gold3PoBridge.mq5'), 'utf8'), 'gold3po bridge source');
    assert.equal(await readFile(path.join(indicators, 'Gold3PoLevels.mq5'), 'utf8'), 'gold3po levels source');
    assert.equal(await readFile(path.join(experts, 'UserStrategy.mq5'), 'utf8'), 'user expert');
    assert.equal(await readFile(path.join(indicators, 'ThirdParty.mq5'), 'utf8'), 'third party indicator');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
