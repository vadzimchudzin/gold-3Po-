import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import { fileURLToPath } from 'node:url';
import { createMt5Session } from './mt5-session.js';
import { createUpdater } from './updater.js';
import { workerPath } from './mt5-runtime.js';
import { installMt5Integration } from './mt5-integration.js';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createMarketServer } from '../server.js';
import { createLicenseManager } from '../license.js';
import { createSetupStore } from '../setup-store.js';
import { createSettingsStore } from '../settings-store.js';
import { createPatternStore } from '../pattern-store.js';

app.setName('GOLD-3Po Market Lab');
if (process.platform === 'win32') app.setAppUserModelId('by.gold3po.marketlab');
const userDataPath = path.join(app.getPath('appData'), app.getName());
app.setPath('userData', userDataPath);

const isSmokeTest = process.argv.includes('--smoke-test');
const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'gold3po-icon.ico')
  : fileURLToPath(new URL('../assets/gold3po-icon.ico', import.meta.url));

let mainWindow = null;
let tray = null;
let marketServer = null;
let localOrigin = null;
let apiStartup = null;
let isClosingServer = false;
let isQuitting = false;
let quitReady = false;
let mt5;
let mt5ConnectTask = null;
let marketIngestToken;
let localApiPort = null;
const adapterDir = app.isPackaged ? path.join(process.resourcesPath, 'adapters', 'mt5') : fileURLToPath(new URL('../adapters/mt5/', import.meta.url));

function registerMt5Ipc() {
  mt5 = createMt5Session({
    workerCommand: app.isPackaged ? workerPath(process.resourcesPath) : 'py.exe',
    workerArgs: app.isPackaged ? [] : ['-3.10', path.join(adapterDir, 'mt5_connector.py')],
    apiOrigin: localOrigin,
    token: marketIngestToken
  });
  // Updates come from the published releases, so a fresh build reaches every workstation without a
  // manual reinstall. Nothing is downloaded until the operator asks for it.
  const updater = createUpdater({
    repo: 'vadzimchudzin/gold-3Po-',
    currentVersion: app.getVersion(),
    download: async target => {
      const response = await fetch(target.url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const file = path.join(app.getPath('temp'), target.name.replace(/[^\w.\- ]/g, '_'));
      await writeFile(file, Buffer.from(await response.arrayBuffer()));
      return file;
    },
    install: async file => {
      const { spawn } = await import('node:child_process');
      spawn(file, ['/S'], { detached: true, stdio: 'ignore' }).unref();
      isQuitting = true;
      setTimeout(() => app.quit(), 600);
    }
  });
  const handle = (name, callback) => ipcMain.handle(`mt5:${name}`, (event, value) => {
    const frame = event.senderFrame;
    if (isQuitting || event.sender !== mainWindow?.webContents || !frame || frame.parent || new URL(frame.url).origin !== localOrigin) {
      throw new Error('Запрос MT5 отклонён.');
    }
    return callback(value);
  });
  handle('state', () => mt5.state());
  handle('connect', () => connectAndRepairMt5());
  handle('disconnect', () => mt5.disconnect());
  handle('install-integration', () => repairMt5Integration());
  handle('zones-visible', visible => mt5.setZonesVisible(visible === true));
  const handleUpdate = (name, callback) => ipcMain.handle(`updates:${name}`, (event, value) => {
    const frame = event.senderFrame;
    if (isQuitting || event.sender !== mainWindow?.webContents || !frame || frame.parent || new URL(frame.url).origin !== localOrigin) {
      throw new Error('Запрос обновления отклонён.');
    }
    return callback(value);
  });
  handleUpdate('check', () => updater.check());
  handleUpdate('apply', () => updater.apply());
}

async function repairMt5Integration() {
  if (mt5.state().state !== 'online') throw new Error('Сначала подключите уже авторизованный терминал MT5.');
  const result = await installMt5Integration({
    sourceDir: adapterDir,
    terminalPath: mt5.terminalPath(),
    terminalDataPath: mt5.terminalDataPath(),
    commonDataPath: mt5.commonDataPath(),
    token: marketIngestToken
  });
  mt5.setIntegrationMessage(result.message);
  return result;
}

async function connectAndRepairMt5() {
  if (mt5ConnectTask) return mt5ConnectTask;
  mt5ConnectTask = (async () => {
    if (isQuitting) throw new Error('Приложение завершает работу.');
    const response = await fetch(`${localOrigin}/v1/license/status`, { signal: AbortSignal.timeout(5000) });
    const licence = response.ok ? await response.json() : null;
    if (!licence?.valid) {
      mt5.setIntegrationMessage('Сначала активируйте лицензию GOLD-3Po. Подключение к MT5 не выполнялось.');
      return mt5.state();
    }
    const connected = await mt5.connect();
    if (connected.state !== 'online') return connected;
    try {
      await repairMt5Integration();
    } catch (error) {
      mt5.setIntegrationMessage('MT5 подключён, но автообновление MQL5-компонентов не завершено: ' + (error?.message || String(error)));
    }
    return mt5.state();
  })();
  try { return await mt5ConnectTask; }
  finally { mt5ConnectTask = null; }
}

function logError(error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(message + '\n');
}

async function readOrCreateSettings(userDataPath) {
  const settingsPath = path.join(userDataPath, 'settings.json');

  try {
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    if (typeof settings.marketIngestToken !== 'string' || settings.marketIngestToken.length < 24) {
      throw new Error('The local settings file does not contain a valid market ingestion token.');
    }
    return settings;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;

    const settings = {
      marketIngestToken: randomBytes(32).toString('hex'),
      port: 8787,
      createdAt: new Date().toISOString()
    };
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    return settings;
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function startLocalApi() {
  const settings = await readOrCreateSettings(userDataPath);
  marketIngestToken = settings.marketIngestToken;
  const port = Number(settings.port || 8787);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('The local API port in settings.json must be between 1024 and 65535.');
  }

  const storagePath = path.join(userDataPath, 'market-events.jsonl');
  // Licence state lives beside the market archive in userData so it survives
  // app updates and is never written inside the read-only asar package.
  const license = createLicenseManager({
    licenseFile: path.join(userDataPath, 'license.json'),
    stateFile: path.join(userDataPath, 'license-state.json')
  });
  const setupStore = createSetupStore({ file: path.join(userDataPath, 'setups.json') });
  // Zone and MT5 drawing preferences; a separate file so the app's own settings.json (token, port) is never overwritten.
  const settingsStore = createSettingsStore({ file: path.join(userDataPath, 'zone-settings.json') });
  // Pattern memory: closed setups the strategy produced, kept beside the setups library.
  const patternStore = createPatternStore({ file: path.join(userDataPath, 'patterns.json') });
  marketServer = createMarketServer({
    token: settings.marketIngestToken,
    storageFile: storagePath,
    license,
    setupStore,
    settingsStore,
    patternStore
  }).server;

  const address = await listen(marketServer, port);
  localApiPort = address.port;
  localOrigin = `http://127.0.0.1:${address.port}`;
  return localOrigin;
}

async function stopLocalApi() {
  if (!marketServer?.listening || isClosingServer) return;
  isClosingServer = true;

  const server = marketServer;
  await new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });

  marketServer = null;
  isClosingServer = false;
}

function restoreMainWindow() {
  if (isSmokeTest || isQuitting) return;

  if (!mainWindow || mainWindow.isDestroyed()) {
    if (localOrigin) void createMainWindow().catch(handleStartupFailure);
    return;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  try {
    const icon = nativeImage.createFromPath(appIconPath);
    if (icon.isEmpty()) throw new Error('GOLD-3Po icon asset could not be loaded.');
    const menu = Menu.buildFromTemplate([
      { label: 'Open', click: restoreMainWindow },
      { label: 'Exit', click: () => app.quit() }
    ]);
    tray = new Tray(icon);
    tray.setToolTip(app.getName());
    tray.setContextMenu(menu);
    tray.on('double-click', restoreMainWindow);
  } catch (error) {
    // Keep ordinary window behavior if the desktop cannot provide a tray.
    tray?.destroy();
    tray = null;
    logError(error);
  }
}

const SPLASH_MIN_MS = 2200;
let splashWindow = null;

function showSplash() {
  const splash = new BrowserWindow({
    width: 480,
    height: 560,
    frame: false,
    resizable: false,
    movable: true,
    transparent: false,
    backgroundColor: '#050505',
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    icon: appIconPath,
    title: 'GOLD-3Po',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  splash.once('ready-to-show', () => splash.show());
  splash.on('closed', () => { if (splashWindow === splash) splashWindow = null; });
  splash.loadFile(fileURLToPath(new URL('./splash.html', import.meta.url))).catch(logError);
  splashWindow = splash;
  return Date.now();
}

function closeSplash(startedAt) {
  const splash = splashWindow;
  if (!splash || splash.isDestroyed()) return;
  const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - startedAt));
  setTimeout(() => { if (!splash.isDestroyed()) splash.close(); }, wait);
}

function createMainWindow(splashStartedAt) {
  const window = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1040,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#101010',
    title: 'GOLD-3Po Market Lab',
    icon: appIconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url))
    }
  });

  mainWindow = window;
  let showOnReady = true;

  const hideToTray = () => {
    if (!tray || isQuitting) return false;
    showOnReady = false;
    window.hide();
    return true;
  };

  window.on('minimize', hideToTray);
  window.on('close', event => {
    if (hideToTray()) event.preventDefault();
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.protocol === 'https:') void shell.openExternal(url);
    } catch {
      // Reject malformed or unsupported external URLs.
    }
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      if (new URL(targetUrl).origin !== localOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });

  window.once('ready-to-show', () => {
    if (showOnReady && !isQuitting) window.show();
    closeSplash(splashStartedAt);
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  return window.loadURL(localOrigin);
}

async function runSmokeTest() {
  const healthResponse = await fetch(`${localOrigin}/health`, { signal: AbortSignal.timeout(10000) });
  if (!healthResponse.ok) throw new Error(`Health endpoint returned HTTP ${healthResponse.status}.`);

  const health = await healthResponse.json();
  if (health.status !== 'ok' || health.ingestConfigured !== true) {
    throw new Error('The local market API did not report a configured healthy state.');
  }

  const pageResponse = await fetch(localOrigin, { signal: AbortSignal.timeout(10000) });
  if (!pageResponse.ok) throw new Error(`Application page returned HTTP ${pageResponse.status}.`);

  const html = await pageResponse.text();
  if (!html.includes('priceChart') || !html.includes('market-client.js')) {
    throw new Error('The packaged application HTML is missing required workspace elements.');
  }

  for (const asset of ['/app.js', '/market-client.js', '/research-client.js', '/license-client.js', '/setups-client.js', '/mt5-client.js', '/mt5-status.js', '/footprint-candle.js', '/styles.css']) {
    const response = await fetch(localOrigin + asset, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Application asset ${asset} returned HTTP ${response.status}.`);
  }

  const appIcon = nativeImage.createFromPath(appIconPath);
  if (appIcon.isEmpty()) throw new Error('The packaged C-3PO application icon could not be loaded.');

  const licenseResponse = await fetch(`${localOrigin}/v1/license/status`, { signal: AbortSignal.timeout(10000) });
  if (!licenseResponse.ok) throw new Error(`Licence status endpoint returned HTTP ${licenseResponse.status}.`);
  const licenseStatus = await licenseResponse.json();
  if (typeof licenseStatus.machineId !== 'string' || !licenseStatus.machineId) {
    throw new Error('The licence endpoint did not report a machine ID.');
  }

  process.stdout.write('GOLD3PO_ELECTRON_SMOKE_OK\n');
  await stopLocalApi();
  app.exit(0);
}

async function bootstrap() {
  if (isQuitting) return;

  apiStartup = startLocalApi();
  try {
    await apiStartup;
  } finally {
    apiStartup = null;
  }
  if (isQuitting) return;

  if (isSmokeTest) {
    await runSmokeTest();
    return;
  }

  const splashStartedAt = showSplash();
  registerMt5Ipc();
  createTray();
  await createMainWindow(splashStartedAt);
  // On every launch, attach only to the already-authorized running terminal and repair
  // the MQL5 files there. The MT5 account itself is never logged into or switched.
  void connectAndRepairMt5().catch(error => mt5?.setIntegrationMessage('Автоподключение MT5: ' + (error?.message || String(error))));
}

function handleStartupFailure(error) {
  logError(error);
  if (isSmokeTest) {
    app.exit(1);
    return;
  }

  const reason = error?.code === 'EADDRINUSE'
    ? 'Local port 8787 is already in use. Close the other application using it and restart GOLD-3Po.'
    : (error instanceof Error ? error.message : String(error));

  dialog.showErrorBox(
    'GOLD-3Po Market Lab',
    'The application could not start its local market service.\n\n' + reason
  );
  app.exit(1);
}

function launch() {
  // Chromium needs this directory to acquire its process singleton on first run.
  mkdirSync(userDataPath, { recursive: true });
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.on('second-instance', restoreMainWindow);
  app.on('activate', restoreMainWindow);
  app.on('window-all-closed', () => {
    if (!tray && process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', event => {
    if (quitReady) return;
    event.preventDefault();
    if (isQuitting) return;
    isQuitting = true;

    // If Exit arrives during startup, close the API once its listen attempt settles.
    void Promise.resolve(apiStartup).catch(() => {})
      .then(() => mt5?.disconnect('Приложение завершает работу.').catch(() => {}))
      .then(stopLocalApi).catch(logError).finally(() => {
        quitReady = true;
        app.quit();
      });
  });

  app.on('will-quit', () => {
    tray?.destroy();
    tray = null;
  });

  app.whenReady().then(bootstrap).catch(error => {
    if (!isQuitting) handleStartupFailure(error);
  });
}

try {
  launch();
} catch (error) {
  handleStartupFailure(error);
}
