import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
test('all static action buttons are wired or explicitly delegated',()=>{const buttons=[...html.matchAll(/<button\b([^>]*)>/g)].map(m=>m[1]);for(const attrs of buttons){const hasId=/\bid=/.test(attrs),delegated=/\bdata-(mode|go|tab|value|color|preset|tf)=/.test(attrs);assert.ok(hasId||delegated,'Unwired static button: '+attrs);}});
test('every direct control ID exists in markup and has an action handler',()=>{for(const id of ['resetView','layoutButton','zonesToggle','numbersToggle','footprintModes']){assert.ok(html.includes('id="'+id+'"'),'Missing '+id);assert.ok(app.includes("$('#"+id+"')"),'No handler/query for '+id);}});
test('inactive placeholder navigation and timeframe controls are absent',()=>{assert.doesNotMatch(html,/rail-button|id="timeframes"|id="notifications"|id="settings"/);assert.doesNotMatch(app,/\$\('#timeframes'\)/);});
test('chart and footprint targets exist before the module initializes',()=>{for(const id of ['priceChart','footprintGrid','zoneList','selectedBar','selectedDelta','bidVolume','askVolume','totalVolume','unknownVolume','imbalance','toast'])assert.ok(html.includes('id="'+id+'"'),'Missing UI target '+id);});

test('liquidity zone rows are wired to selection and workspace reset clears selection',()=>{assert.ok(app.includes('selectedZone = selectedZone === n.dataset.zone ? null : n.dataset.zone'));assert.ok(app.includes('renderZones(); renderChart();'));assert.match(app,/selectedZone = null/);});

test('live feed status client uses same-origin health and SSE endpoints',async()=>{const client=await readFile(new URL('./market-client.js',import.meta.url),'utf8');assert.match(html,/id="apiStatus"/);assert.match(html,/id="mt5Status"/);assert.match(html,/id="comexStatus"/);assert.match(client,/fetch\('\/health'/);assert.match(client,/new EventSource\('\/v1\/stream'/);assert.match(client,/window\.setInterval\(refreshHealth,\s*5000\)/);});

test('strategy signals, alerts and the tick history are wired; backtests are gone',async()=>{
 const strategy=await readFile(new URL('./strategy-client.js',import.meta.url),'utf8');
 const alerts=await readFile(new URL('./alerts-client.js',import.meta.url),'utf8');
 const archive=await readFile(new URL('./archive-client.js',import.meta.url),'utf8');
 for(const id of ['signalMonitor','signalList','alertPrice','alertList','alertLog','archiveDays','archiveStatus','candlesInfo','comexPrice','comexBasis','alertMode','signalsToggle','comexToggle'])assert.ok(html.includes('id="'+id+'"'),'Missing target '+id);
 for(const id of ['addAlert','alertFromChart','enableAlerts','alertZoneStrength'])assert.ok(alerts.includes("$('"+id+"')?.addEventListener"),'Alert control has no handler: '+id);
 for(const id of ['alertZones','alertSignals','alertSound'])assert.ok(alerts.includes("['"+id+"', "),'Alert rule has no handler: '+id);
 for(const id of ['archiveStart','archiveStop'])assert.ok(archive.includes("$('"+id+"')?.addEventListener"),'Archive control has no handler: '+id);
 for(const id of ['alertMode','signalsToggle','comexToggle'])assert.ok(app.includes("'#"+id+"'"),'Chart control has no handler: '+id);
 assert.match(strategy,/\/v1\/market\/signals/);
 assert.match(archive,/bridge\.archive\(/);
 for(const gone of ['replayFrom','runBacktest','calculateRisk','findAnalogues','backtestSummary','riskResult'])assert.ok(!html.includes('id="'+gone+'"'),'Backtest/replay control must be gone: '+gone);
 assert.doesNotMatch(html,/бэктест/i);
});

test('Vesper palette is applied consistently',()=>{
  for (const color of ['#101010','#161616','#1c1c1c','#ffc799','#99ffe4','#ff8080']) assert.ok(styles.includes(color),'Missing Vesper palette color '+color);
  assert.match(html,/theme-color" content="#101010"/);
});

test('licence gate and setup library controls are wired',async()=>{
  const licenseClient=await readFile(new URL('./license-client.js',import.meta.url),'utf8');
  const setupsClient=await readFile(new URL('./strategy-client.js',import.meta.url),'utf8');
  for(const id of ['licenseGate','licenseMachineId','licenseKeyInput','activateLicense','copyMachineId','licenseStatus'])assert.ok(html.includes('id="'+id+'"'),'Missing licence target '+id);
  for(const id of ['activateLicense','copyMachineId'])assert.ok(licenseClient.includes("$('#"+id+"')?.addEventListener")||licenseClient.includes("document.querySelector('#"+id+"')?.addEventListener"),'Licence control has no handler: '+id);
  assert.match(licenseClient,/\/v1\/license\/status/);
  assert.match(licenseClient,/\/v1\/license\/activate/);
  for(const id of ['setupSelect','setupName','saveSetup','applySetup','exportSetup','importSetup','importSetupFile','setupStatus','condMinScore','condRejection','condStacked'])assert.ok(html.includes('id="'+id+'"'),'Missing setup target '+id);
  for(const id of ['saveSetup','applySetup','deleteSetup','exportSetup','importSetup','importSetupFile'])assert.ok(setupsClient.includes("$('"+id+"')?.addEventListener"),'Setup control has no handler: '+id);
  assert.match(setupsClient,/\/v1\/setups/);
  assert.match(html,/strategy-client\.js/);
});

test('MT5 auto-connect uses the already-authorized terminal without a credential form',async()=>{
  const mt5Client=await readFile(new URL('./mt5-client.js',import.meta.url),'utf8');
  const preload=await readFile(new URL('./electron/preload.cjs',import.meta.url),'utf8');
  const main=await readFile(new URL('./electron/main.js',import.meta.url),'utf8');
  for(const id of ['mt5Open','mt5Dialog','mt5Close','mt5Connect','mt5Disconnect','mt5InstallIntegration','mt5Detail','marketSymbol'])assert.ok(html.includes('id="'+id+'"'),'Missing MT5 target '+id);
  for(const id of ['mt5Form','mt5Terminal','mt5Browse','mt5Password'])assert.ok(!html.includes('id="'+id+'"'),'Credential/manual terminal control must be absent: '+id);
  for(const id of ['mt5Open','mt5Close','mt5Disconnect','mt5InstallIntegration'])assert.ok(mt5Client.includes("$('"+id+"').addEventListener"),'MT5 control has no handler: '+id);
  assert.match(mt5Client,/bridge\.connect\(\)/);
  assert.match(mt5Client,/bridge\.installIntegration\(\)/);
  for(const channel of ['mt5:state','mt5:connect','mt5:disconnect','mt5:install-integration']){
    assert.ok(preload.includes(channel),'Preload missing '+channel);
  }
  assert.doesNotMatch(preload,/login|password|ingestToken|mt5:bridge/);
  assert.ok(main.includes("handle('state'")&&main.includes("handle('connect'")&&main.includes("handle('install-integration'"),'Main must expose state/connect/repair handlers');
  assert.match(main,/connectAndRepairMt5\(\)/);
  assert.match(main,/installMt5Integration/);
  assert.match(main,/sandbox: true/);
  assert.match(main,/preload:/);
  assert.match(main,/new URL\(frame\.url\)\.origin !== localOrigin/);
  assert.match(html,/mt5-client\.js/);
});
test('settings sheet controls exist and are handled by settings-client',async()=>{
  const client=await readFile(new URL('./settings-client.js', import.meta.url),'utf8');
  for(const id of ['settingsDialog','openSettings','settingsClose','settingsDone','settingsReset','settingsTabs','settingsStatus','setMinZones','setMaxZones','setTimeframe','setPivotWidth','setClusterAtr','setZoneWidthAtr','setMaxDistanceAtr','setAtrPeriod','setBuyColor','setSellColor','setLineStyle','setLineWidth','setFill','setLabels','setStrength','setTheme','stylePreview','railNav']){
    assert.ok(html.includes('id="'+id+'"'),'missing #'+id);
    assert.ok(client.includes("'"+id+"'"),'settings-client does not handle #'+id);
  }
  for(const go of [...html.matchAll(/data-go="([^"]+)"/g)].map(m=>m[1]))assert.ok(client.includes("'"+go+"'")||client.includes(go+':'),'rail target not handled: '+go);
  assert.match(client,/closest\('button\[data-tab\]'\)/);assert.match(client,/closest\('button\[data-value\]'\)/);
  assert.ok(html.indexOf('settings-client.js')<html.indexOf('market-client.js'),'settings must load before the market client reads the timeframe');
});

test('EA bridge token is kept out of renderer IPC and handed to MT5 automatically',async()=>{
  const main=await readFile(new URL('./electron/main.js', import.meta.url),'utf8');
  const preload=await readFile(new URL('./electron/preload.cjs', import.meta.url),'utf8');
  const integration=await readFile(new URL('./electron/mt5-integration.js', import.meta.url),'utf8');
  const bridge=await readFile(new URL('./adapters/mt5/Gold3PoBridge.mq5', import.meta.url),'utf8');
  const settings=await readFile(new URL('./settings-client.js', import.meta.url),'utf8');
  assert.doesNotMatch(preload,/ingestToken|mt5:bridge|bridge:\s*\(/,'the renderer must not receive the private ingest token');
  assert.doesNotMatch(main,/handle\('bridge'/,'there is no token IPC endpoint');
  assert.match(integration,/bridge-token\.txt/,'the desktop main process writes the token to MT5 Common Files');
  assert.match(integration,/commonDataPath/);
  assert.match(bridge,/FILE_COMMON/,'the EA reads the bridge token from Common Files');
  assert.match(html,/локальный токен передаёт через Common Files/i);
  assert.doesNotMatch(settings,/clipboard|bridgeCopy|bridgeToken/);
});

test('live quote strip displays BID, ASK and spread only for the active MT5 account',async()=>{
 const client=await readFile(new URL('./market-client.js',import.meta.url),'utf8');
 const quote=await readFile(new URL('./quote-display.js',import.meta.url),'utf8');
 for(const id of ['bidPrice','askPrice','spreadPrice','referencePrice','feedConflict'])assert.ok(html.includes('id="'+id+'"'),'Missing live quote target '+id);
 assert.ok(client.includes("window.addEventListener('market-tick'"));
 assert.ok(client.includes('function activeFeedId(){return feedOverride||displayedFeedId||marketFeedId()||null;}'),'the strip, the stream and the chart agree on the feed on screen');
 assert.ok(client.includes("(tick.feedId||null)!==(shownFeedId||null)"),'streamed ticks follow the displayed feed');
 assert.ok(client.includes('function activeFeedId()'),'one definition of the feed on screen');
 // The strip and the reference price share one ordering gate and one formatter, so a replayed or
 // late frame cannot move a quote backwards and every field prints the same decimals.
 assert.match(client,/paintQuote\(quotes\.accept\(tick\)\)/);
 for(const field of ['quote.bid','quote.ask','quote.spread'])assert.ok(client.includes(field),'Quote strip does not print '+field);
 assert.ok(quote.includes('spread: ask - bid'),'The spread must be the ask minus the bid');
 assert.match(quote,/stamp < lastTime/,'A late tick must be rejected');
});

test('the MT5 zone switch is in the sheet and reaches the terminal instantly', async () => {
  const read = path => readFile(new URL(path, import.meta.url), 'utf8');
  const [html, client, preload, main] = await Promise.all([
    read('./index.html'), read('./settings-client.js'), read('./electron/preload.cjs'), read('./electron/main.js')
  ]);
  assert.ok(html.includes('id="setZonesVisible"'), 'the sheet has the switch');
  assert.ok(client.includes("setZonesVisible: 'zonesVisible'"), 'the switch is wired to the setting');
  assert.ok(client.includes('goldMt5?.setZonesVisible?.(next)'), 'flipping it calls the terminal, not only the service');
  assert.ok(preload.includes("invoke('mt5:zones-visible'"), 'the renderer exposes it');
  assert.ok(main.includes("handle('zones-visible'"), 'the main process handles it');
});

test('an update offer appears in the bar and only installs on a click', async () => {
  const read = path => readFile(new URL(path, import.meta.url), 'utf8');
  const [html, client, preload, main, server] = await Promise.all([
    read('./index.html'), read('./updates-client.js'), read('./electron/preload.cjs'),
    read('./electron/main.js'), read('./server.js')
  ]);
  assert.ok(html.includes('id="updateBadge"') && html.includes('hidden'), 'the badge starts hidden, so a current install never shows it');
  assert.ok(html.includes('updates-client.js'), 'the renderer loads the update client');
  assert.ok(server.includes("'/updates-client.js'"), 'the local server serves it');
  assert.ok(client.includes('setTimeout(check'), 'the check runs once per launch, off the first paint');
  assert.ok(!client.includes('apply();\n') || client.includes("addEventListener('click'"), 'installing is click-driven');
  assert.ok(preload.includes("invoke('updates:check'") && preload.includes("invoke('updates:apply'"), 'both actions are bridged');
  assert.ok(main.includes("handleUpdate('check'") && main.includes("handleUpdate('apply'"), 'the main process answers them');
  assert.ok(main.includes("spawn(file, ['/S', `/D=${installDir}`]"), 'the installer runs silently, into the folder this copy runs from');
  assert.ok(main.includes('currentVersion: BUILD.tag || app.getVersion()'), 'the update is compared against the build tag, not the three-part package version');
});

test('the chart has timeframe buttons and both panels have a refresh button',async()=>{
  const settingsClient=await readFile(new URL('./settings-client.js',import.meta.url),'utf8');
  for(const tf of [1,5,15,30,60,240])assert.ok(html.includes('data-tf="'+tf+'"'),'Missing timeframe button '+tf);
  for(const id of ['chartRefresh','footRefresh'])assert.ok(html.includes('id="'+id+'"')&&app.includes("'"+id+"'"),'Refresh button not wired: '+id);
  assert.match(settingsClient,/button\[data-tf\]/);
  const client=await readFile(new URL('./market-client.js',import.meta.url),'utf8');
  assert.match(client,/window\.gold3poRefresh=/);
  assert.match(client,/\/v1\/quote\?/);
});

test('view state, archive depth and the desktop window survive a restart',async()=>{
  const app=await readFile(new URL('./app.js', import.meta.url),'utf8');
  const archive=await readFile(new URL('./archive-client.js', import.meta.url),'utf8');
  const main=await readFile(new URL('./electron/main.js', import.meta.url),'utf8');
  assert.match(app,/localStorage\.setItem\(VIEW_KEY/,'toggles, footprint mode and zoom are saved');
  assert.match(app,/restoreViewState\(\);/,'and restored on load');
  assert.match(app,/addEventListener\('pagehide', saveViewState\)/,'and written once more when the page goes away');
  assert.match(archive,/gold3po-archive-days/,'the tick-history depth is remembered');
  assert.match(main,/window-state\.json/,'the window size and position are remembered');
  assert.match(main,/getNormalBounds\(\)/); assert.match(main,/isMaximized\(\)/);
  assert.match(main,/flushStorageData\(\)/,'localStorage is flushed to disk before hiding or exiting');
});
