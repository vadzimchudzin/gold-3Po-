import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

async function installMqlAsset({ source, terminalPath, terminalDataPath, folder, name, kind }) {
  const dir = path.join(terminalDataPath, 'MQL5', folder);
  const target = path.join(dir, name + '.mq5');
  const binary = path.join(dir, name + '.ex5');
  const backup = binary + '.gold3po-backup';
  await mkdir(dir, { recursive: true });
  await copyFile(source, target);

  // Recover a backup left by an interrupted previous patch. Only the exact GOLD-3Po
  // binary is touched; account profiles, charts, history and third-party EAs are outside this path.
  let previous = await stat(binary).catch(() => null);
  const abandonedBackup = await stat(backup).catch(() => null);
  if (!previous?.isFile() && abandonedBackup?.isFile()) {
    await rename(backup, binary);
    previous = await stat(binary).catch(() => null);
  } else if (abandonedBackup?.isFile()) {
    await rm(backup, { force: true });
  }

  const compiler = path.join(path.dirname(terminalPath), 'metaeditor64.exe');
  if (!(await stat(compiler).catch(() => null))?.isFile()) {
    return { name, status: 'source-copied', message: `${name}.mq5 скопирован; MetaEditor не найден для автоматической компиляции.` };
  }

  if (previous?.isFile()) await rename(binary, backup);
  await rm(target + '.log', { force: true });
  let output = '';
  let compileError = null;
  try {
    const result = await execute(compiler, [`/compile:${target}`], { windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 });
    output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  } catch (error) {
    compileError = error;
    output = [error?.stdout, error?.stderr, error?.message].filter(Boolean).join('\n');
  }
  const report = await readFile(target + '.log', 'utf8').catch(() => '');
  const hasErrors = /\b[1-9]\d*\s+errors?\b/i.test(report + '\n' + output);
  const compiled = await stat(binary).catch(() => null);
  if (compiled?.isFile() && compiled.size > 0 && !hasErrors) {
    await rm(backup, { force: true });
    return { name, status: 'compiled', message: `${name}.mq5 установлен и скомпилирован в MQL5\\${folder}.` };
  }

  await rm(binary, { force: true });
  if (previous?.isFile()) await rename(backup, binary).catch(() => {});
  const hint = hasErrors ? 'MetaEditor сообщил об ошибках компиляции.' : compileError ? 'MetaEditor не подтвердил успешную компиляцию.' : 'EX5-файл не создан.';
  return { name, status: 'compile-warning', message: `${name}.mq5 скопирован; ${hint} ${kind} можно скомпилировать в MetaEditor клавишей F7.` };
}

/** Idempotent patch of only the two GOLD-3Po-owned MQL5 assets. */
export async function installIndicator({ source, bridgeSource, terminalPath, terminalDataPath }) {
  if (!source || !bridgeSource || !terminalPath || !terminalDataPath) throw new Error('Для автопатча нужны оба исходника GOLD-3Po и выбранный каталог данных MT5.');
  const results = await Promise.all([
    installMqlAsset({ source: bridgeSource, terminalPath, terminalDataPath, folder: 'Experts', name: 'Gold3PoBridge', kind: 'советник-мост' }),
    installMqlAsset({ source, terminalPath, terminalDataPath, folder: 'Indicators', name: 'Gold3PoLevels', kind: 'индикатор уровней' })
  ]);
  const compiled = results.filter(item => item.status === 'compiled').length;
  const warning = results.filter(item => item.status !== 'compiled');
  return `Автопатч MT5 завершён: Gold3PoBridge (Experts) и Gold3PoLevels (Indicators); скомпилировано ${compiled}/2. ${warning.map(item => item.message).join(' ')}`;
}
