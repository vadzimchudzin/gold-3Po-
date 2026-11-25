import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const files = pkg.build.files;

async function localImports(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const src = await readFile(new URL('./' + file, import.meta.url), 'utf8');
  for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]\.\/([^'"]+)['"]/g)) await localImports(m[1], seen);
  return seen;
}

test('every module the installed app loads is packaged', async () => {
  const needed = new Set([...await localImports('server.js')]);
  for (const m of html.matchAll(/<script[^>]+src="\.\/([^"]+)"/g)) for (const f of await localImports(m[1])) needed.add(f);
  for (const f of needed) assert.ok(files.includes(f), `${f} is loaded but missing from build.files`);
});

test('every page asset is served by the local server and packaged', async () => {
  const server = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="\.\/([^"#?]+)"/g)].map(m => m[1])
    .concat([...css.matchAll(/url\(["']?\.\/([^"')]+)["']?\)/g)].map(m => m[1]));
  for (const a of new Set(assets)) {
    await access(new URL('./' + a, import.meta.url));
    assert.ok(server.includes(`'/${a}'`), `${a} is referenced by the page but not served`);
    assert.ok(files.includes(a), `${a} is referenced by the page but not packaged`);
  }
});

test('every module the browser imports is served, not only packaged', async () => {
  const server = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const client = new Set([...await localImports('app.js')]);
  for (const m of html.matchAll(/<script[^>]+src="\.\/([^"]+)"/g)) for (const f of await localImports(m[1])) client.add(f);
  for (const f of client) {
    assert.ok(server.includes(`'/${f}'`), `${f} is imported by the page but missing from server.js STATIC_FILES`);
    assert.ok(files.includes(f), `${f} is imported by the page but missing from build.files`);
  }
});

test('the desktop app stores zone/MT5 settings in userData, apart from its own settings.json', async () => {
  const main = await readFile(new URL('./electron/main.js', import.meta.url), 'utf8');
  assert.match(main, /createSettingsStore\(\{ file: path\.join\(userDataPath, 'zone-settings\.json'\) \}\)/);
  assert.match(main, /createMarketServer\(\{[\s\S]*settingsStore[\s\S]*\}\)/);
});

test('the packaged app looks for the MT5 connector where the build really puts it', async () => {
  const main = await readFile(new URL('./electron/main.js', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('./.github/workflows/electron-windows.yml', import.meta.url), 'utf8');
  const { WORKER_LAYOUTS } = await import('./electron/mt5-runtime.js');
  assert.match(main, /workerCommand: app\.isPackaged \? workerPath\(process\.resourcesPath\) : 'py\.exe'/,
    'the packaged worker path must come from mt5-runtime.js, not from a hand-written string');
  const name = workflow.match(/--name\s+(\S+)/)?.[1];
  const dist = workflow.match(/--distpath\s+(\S+)/)?.[1];
  assert.ok(name && dist, 'the workflow must build the connector with --name and --distpath');
  const copied = pkg.build.extraResources.find(r => r.from === dist);
  assert.ok(copied, `extraResources must copy ${dist} into the installer`);
  const onedir = /--onedir\b/.test(workflow);
  const expected = [...copied.to.split('/'), ...(onedir ? [name, name + '.exe'] : [name + '.exe'])];
  assert.ok(WORKER_LAYOUTS.some(parts => parts.join('/') === expected.join('/')),
    `the app does not look for ${expected.join('/')}, so the installed build cannot start the connector`);
  assert.ok(workflow.includes(`resources\\mt5-runtime\\${onedir ? name + '\\' : ''}${name}.exe`),
    'the CI smoke test must check the connector landed in the installed application');
});

test('the installer removes every older GOLD-3Po before it installs', async () => {
  const { readFile } = await import('node:fs/promises');
  const nsh = await readFile(new URL('./build/installer.nsh', import.meta.url), 'utf8');
  assert.match(nsh, /!macro customInit/);
  assert.match(nsh, /taskkill[^\n]*GOLD-3Po Market Lab\.exe/);
  assert.match(nsh, /taskkill[^\n]*gold3po-mt5\.exe/);
  assert.match(nsh, /UninstallString/);
  for (const root of ['HKCU', 'HKLM']) assert.match(nsh, new RegExp('Gold3PoRemoveRegistered ' + root));
});
