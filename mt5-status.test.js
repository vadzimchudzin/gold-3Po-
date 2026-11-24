import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tickSizeNote } from './mt5-status.js';

test('the MT5 panel states the broker tick size or why it is missing', () => {
  assert.equal(tickSizeNote({ tickSize: 0.01 }), ' Шаг цены брокера: 0.01.');
  assert.match(tickSizeNote({ tickSize: null, tickSizeIssue: 'symbol_info_failed' }), /неизвестен \(запрос спецификации инструмента не выполнен\), футпринт строится с шагом 0\.1/);
  assert.match(tickSizeNote({ tickSize: null, tickSizeIssue: 'not_reported' }), /терминал не сообщил шаг цены/);
  // An unknown code is not echoed raw into the panel.
  assert.match(tickSizeNote({ tickSizeIssue: '<b>x</b>' }), /причина не указана/);
  assert.equal(tickSizeNote({}), '', 'nothing to say before MT5 reports either');
});

test('the MT5 panel renders the tick size note and the module is served and packaged', async () => {
  const client = await readFile(new URL('./mt5-client.js', import.meta.url), 'utf8');
  assert.match(client, /import \{ tickSizeNote \} from '\.\/mt5-status\.js'/);
  assert.match(client, /connected \? tickSizeNote\(status\)/, 'the connected status line includes the note');
  const server = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(server, /'\/mt5-status\.js': \['mt5-status\.js'/, 'the browser can load the module');
  const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.build.files.includes('mt5-status.js'), 'the desktop build ships the module');
  // The packaged-app smoke test fetches every module the panel loads, this one included.
  const main = await readFile(new URL('./electron/main.js', import.meta.url), 'utf8');
  const smokeAssets = main.match(/for \(const asset of \[([^\]]*)\]\)/);
  assert.ok(smokeAssets, 'the packaged-app smoke test asset list must exist');
  assert.match(smokeAssets[1], /'\/mt5-status\.js'/, 'the smoke test must fetch /mt5-status.js');
});
