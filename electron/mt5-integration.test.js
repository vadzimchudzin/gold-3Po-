import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { installMt5Integration } from './mt5-integration.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'g3p-mt5-integration-'));
  const sourceDir = path.join(root, 'sources');
  const installDir = path.join(root, 'terminal');
  const terminalDataPath = path.join(root, 'terminal-data');
  const commonDataPath = path.join(root, 'common-data');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await writeFile(path.join(sourceDir, 'Gold3PoBridge.mq5'), '#property version "2.20"\n');
  await writeFile(path.join(sourceDir, 'Gold3PoLevels.mq5'), '#property indicator_chart_window\n');
  const terminalPath = path.join(installDir, 'terminal64.exe');
  await writeFile(terminalPath, 'terminal');
  return { root, sourceDir, terminalPath, terminalDataPath, commonDataPath };
}

test('repairs and compiles the bridge and indicator and writes the shared local token', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(path.dirname(f.terminalPath), 'metaeditor64.exe'), 'compiler');
    const execute = async (_compiler, args) => {
      const source = args[0].slice('/compile:'.length);
      const binary = source.replace(/\.mq5$/i, '.ex5');
      const log = args[1].slice('/log:'.length);
      await writeFile(binary, 'compiled-ex5');
      await writeFile(log, '0 errors, 0 warnings');
    };
    const result = await installMt5Integration({ ...f, token: 'a'.repeat(64), execute });
    assert.equal(result.copied, 2);
    assert.equal(result.compiled, 2);
    assert.equal(result.tokenWritten, true);
    assert.ok(result.files.every(item => item.compiled));
    assert.ok((await readFile(path.join(f.terminalDataPath, 'MQL5', 'Experts', 'Gold3PoBridge.mq5'), 'utf8')).includes('2.20'));
    assert.ok((await stat(path.join(f.terminalDataPath, 'MQL5', 'Experts', 'Gold3PoBridge.ex5'))).size > 0);
    assert.equal(await readFile(path.join(f.commonDataPath, 'Files', 'GOLD3PO', 'bridge-token.txt'), 'ascii'), 'a'.repeat(64) + '\n');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('copies both sources but reports that MetaEditor is unavailable', async () => {
  const f = await fixture();
  try {
    const result = await installMt5Integration({ ...f, token: 'b'.repeat(64) });
    assert.equal(result.copied, 2);
    assert.equal(result.compiled, 0);
    assert.ok(result.files.every(item => !item.compiled));
    assert.equal(await readFile(path.join(f.terminalDataPath, 'MQL5', 'Experts', 'Gold3PoBridge.mq5'), 'utf8'), '#property version "2.20"\n');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('rejects an unconfirmed terminal path rather than modifying an arbitrary folder', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      installMt5Integration({ ...f, terminalPath: path.join(path.dirname(f.terminalPath), 'other.exe') }),
      /terminal64\.exe/
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('reports a MetaEditor compile failure instead of claiming the bridge was built', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(path.dirname(f.terminalPath), 'metaeditor64.exe'), 'compiler');
    const execute = async (_compiler, args) => {
      const log = args[1].slice('/log:'.length);
      await writeFile(log, '1 errors, 0 warnings');
    };
    const result = await installMt5Integration({ ...f, token: 'c'.repeat(64), execute });
    assert.equal(result.compiled, 0);
    assert.ok(result.files.every(item => !item.compiled));
    assert.match(result.message, /ошибках компиляции/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
