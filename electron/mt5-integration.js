import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const INTEGRATION_FILES = [
  { name: 'Gold3PoBridge.mq5', folder: 'Experts' },
  { name: 'Gold3PoLevels.mq5', folder: 'Indicators' }
];

async function existingFile(file) {
  try { return (await stat(file)).isFile(); }
  catch { return false; }
}

async function compileMql({ compiler, source, binary, execute }) {
  const log = source + '.compile.log';
  const before = await stat(binary).catch(() => null);
  const startedAt = Date.now();
  let executionError = '';
  try {
    await execute(compiler, ['/compile:' + source, '/log:' + log], {
      windowsHide: true, timeout: 90_000, maxBuffer: 2 * 1024 * 1024
    });
  } catch (error) {
    executionError = error?.message || 'MetaEditor завершился с ошибкой.';
  }
  const logText = await readFile(log, 'utf8').catch(() => '');
  await rm(log, { force: true }).catch(() => {});
  const after = await stat(binary).catch(() => null);
  const errorCount = logText.match(/\b(\d+)\s+errors?\b/i);
  const hasExplicitSuccess = /\b0\s+errors?\b/i.test(logText);
  const rebuilt = Boolean(after?.size && (!before || after.mtimeMs > before.mtimeMs));
  if (Number(errorCount?.[1] ?? 0) > 0) {
    return { compiled: false, message: 'MetaEditor сообщил об ошибках компиляции ' + path.basename(source) + '.' };
  }
  if (after?.size && (hasExplicitSuccess || rebuilt)) {
    return { compiled: true, message: path.basename(source) + ' скомпилирован.' };
  }
  return {
    compiled: false,
    message: executionError
      ? 'Не удалось подтвердить компиляцию ' + path.basename(source) + ': ' + executionError
      : 'Исходник ' + path.basename(source) + ' скопирован, но успешная компиляция не подтверждена.'
  };
}

/**
 * Repairs both GOLD-3Po MQL5 components in the already-connected terminal.
 * It never launches a new terminal or logs into/trades an account.
 */
export async function installMt5Integration({
  sourceDir, terminalPath, terminalDataPath, commonDataPath, token,
  execute = executeFile
} = {}) {
  if (typeof terminalPath !== 'string' || path.basename(terminalPath).toLowerCase() !== 'terminal64.exe') {
    throw new Error('Не подтверждён путь к уже открытому terminal64.exe.');
  }
  if (typeof terminalDataPath !== 'string' || !path.isAbsolute(terminalDataPath)) {
    throw new Error('MT5 не сообщил каталог данных терминала.');
  }
  if (typeof commonDataPath !== 'string' || !path.isAbsolute(commonDataPath)) {
    throw new Error('MT5 не сообщил общий каталог данных.');
  }
  if (typeof sourceDir !== 'string' || !path.isAbsolute(sourceDir)) {
    throw new Error('Не найден каталог MQL5-компонентов GOLD-3Po.');
  }

  const compilerCandidates = [
    path.join(path.dirname(terminalPath), 'metaeditor64.exe'),
    path.join(path.dirname(terminalPath), 'metaeditor.exe')
  ];
  const compiler = (await Promise.all(compilerCandidates.map(async file => (await existingFile(file)) ? file : null)))
    .find(Boolean) ?? null;

  const results = [];
  for (const item of INTEGRATION_FILES) {
    const source = path.join(sourceDir, item.name);
    if (!(await existingFile(source))) throw new Error('В установщике отсутствует ' + item.name + '.');
    const directory = path.join(terminalDataPath, 'MQL5', item.folder);
    const target = path.join(directory, item.name);
    const binary = target.replace(/\.mq5$/i, '.ex5');
    await mkdir(directory, { recursive: true });
    await copyFile(source, target);

    let compilation = { compiled: false, message: 'MetaEditor не найден рядом с этим терминалом; исходник скопирован.' };
    if (compiler) compilation = await compileMql({ compiler, source: target, binary, execute });
    results.push({ name: item.name, target, binary, ...compilation });
  }

  let tokenWritten = false;
  if (typeof token === 'string' && token.length >= 24) {
    const tokenDirectory = path.join(commonDataPath, 'Files', 'GOLD3PO');
    const tokenFile = path.join(tokenDirectory, 'bridge-token.txt');
    const temporary = tokenFile + '.tmp';
    await mkdir(tokenDirectory, { recursive: true });
    await writeFile(temporary, token + '\n', { encoding: 'ascii', mode: 0o600 });
    await rename(temporary, tokenFile);
    tokenWritten = true;
  }

  const compiled = results.filter(result => result.compiled).length;
  const copied = results.length;
  const details = results.map(result => result.message).join(' ');
  return {
    copied,
    compiled,
    tokenWritten,
    files: results,
    message: copied + ' MQL5-файла обновлено; скомпилировано ' + compiled + ' из ' + copied + '. ' +
      (tokenWritten ? 'Локальный токен моста передан через Common Files. ' : 'Токен моста пока не опубликован. ') + details
  };
}
