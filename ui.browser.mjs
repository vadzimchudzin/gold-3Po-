import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { chromium } from 'playwright';

const token = 'browser-test-token-which-is-long-enough';
const browserFeedId = 'a'.repeat(32);
const isolatedDataFile = '/tmp/gold-3po-browser-' + process.pid + '.jsonl';
const isolatedSetupsFile = '/tmp/gold-3po-browser-setups-' + process.pid + '.json';
const isolatedSettingsFile = '/tmp/gold-3po-browser-settings-' + process.pid + '.json';
// Use an ephemeral port: a real installed GOLD-3Po may already own 8787.
const server = spawn(process.execPath, ['server.js'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '0', MARKET_INGEST_TOKEN: token, MARKET_DATA_FILE: isolatedDataFile, SETUPS_FILE: isolatedSetupsFile, SETTINGS_FILE: isolatedSettingsFile, LICENSE_REQUIRED: '0' }, stdio: ['ignore', 'pipe', 'ignore'] });
let base = '';
let browser;
try {
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    const chunk = server.stdout.read();
    if (chunk) {
      const match = chunk.toString().match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) base = 'http://127.0.0.1:' + match[1];
    }
    if (base) {
      try { const r = await fetch(base + '/health'); if (r.ok) ready = true; } catch {}
    }
    if (!ready) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'market server did not start');
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  // First verify a normal browser without the Electron preload: no demo prices and no credential form.
  const offlinePage = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  await offlinePage.goto(base, { waitUntil: 'domcontentloaded' });
  await offlinePage.waitForSelector('#chartEmpty:not([hidden])', { timeout: 5000 });
  assert.equal(await offlinePage.locator('.candle').count(), 0, 'browser without MT5 must not show demo candles');
  await offlinePage.locator('#mt5Open').click();
  await offlinePage.waitForSelector('#mt5Dialog[open]');
  assert.ok(await offlinePage.locator('#mt5Connect').isDisabled(), 'connect must be disabled without the desktop bridge');
  assert.match(await offlinePage.locator('#mt5Detail').innerText(), /настольной версии/, 'browser mode explains that MT5 discovery runs in the desktop app');
  assert.equal(await offlinePage.locator('#mt5Terminal, #mt5Password, #mt5Form').count(), 0, 'no credentials or manual terminal path may be requested');
  await offlinePage.close();

  // Main browser scenario: emulate the Electron preload state so the real account feed can be exercised.
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  await page.addInitScript(feedId => {
    window.goldMt5 = {
      state: async () => ({ state: 'online', feed: 'online', symbol: 'XAUUSD', feedId, message: 'Тестовое подключение MT5.' }),
      connect: async () => ({ state: 'online', feed: 'online', symbol: 'XAUUSD', feedId }),
      disconnect: async () => ({ state: 'offline', symbol: 'XAUUSD', message: 'Тестовое отключение.' }),
      installIntegration: async () => ({ message: 'Тестовая интеграция.' })
    };
  }, browserFeedId);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });

  // Data is empty until the selected account's broker ticks are ingested.
  await page.waitForSelector('#chartEmpty:not([hidden])', { timeout: 5000 });
  assert.equal(await page.locator('.candle').count(), 0, 'никаких демо-свечей до прихода данных брокера');
  assert.equal(await page.locator('.zone-row').count(), 0, 'никаких демо-зон до прихода данных брокера');
  assert.match(await page.locator('#zoneList').innerText(), /Зон пока нет/);
  assert.match(await page.locator('#chartStatus').innerText(), /ПОДКЛЮЧИТЕ MT5/);

  const reset = await page.locator('#resetView').boundingBox();
  const workspace = await page.locator('#layoutButton').boundingBox();
  assert.ok(Math.abs(reset.y - workspace.y) < 1, 'top action buttons must align vertically');
  assert.equal(reset.height, workspace.height, 'top action buttons must have equal height');

  const historyTicks = Array.from({length:30},(_,i)=>{const at=new Date(Date.now()-(30-i)*86400000);at.setUTCHours(10,0,0,0);return {timestamp:at.toISOString(),sequence:i+1,bid:2640+i*.1,ask:2640.2+i*.1,last:2640.1+i*.1,tickVolume:1,realVolume:0,flags:0};});
  const historyResponse=await fetch(base+'/v1/ingest/mt5/history',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({source:'mt5',symbol:'XAUUSD',feedId:browserFeedId,ticks:historyTicks})});
  assert.equal(historyResponse.status,202,'30-day broker history fixture should be accepted');
  const now = new Date().toISOString();
  const mt5 = { source:'mt5', symbol:'XAUUSD', timestamp:now, sequence:Date.now(), bid:2648.2, ask:2648.4, last:2648.3, tickVolume:1, realVolume:0 };
  const comex = { source:'comex', symbol:'GCZ6', timestamp:now, sequence:Date.now(), tradeId:'browser-check-'+Date.now(), price:2650.1, size:2, aggressorSide:'buy' };
  for (const [path, event] of [['/v1/ingest/mt5/tick',{...mt5,feedId:browserFeedId}],['/v1/ingest/comex/trade',comex]]) {
    const response = await fetch(base + path, { method:'POST', headers:{ authorization:'Bearer '+token, 'content-type':'application/json' }, body:JSON.stringify(event) });
    assert.equal(response.status,202, 'feed event should be accepted');
  }
  await page.waitForFunction(() => document.querySelector('#mt5Status')?.textContent.startsWith('ОНЛАЙН'), null, { timeout:5000 });
  await page.waitForFunction(() => document.querySelector('#comexStatus')?.textContent.startsWith('ОНЛАЙН'), null, { timeout:5000 });
  await page.waitForFunction(() => document.querySelector('#chartStatus')?.textContent.startsWith('ОНЛАЙН'), null, { timeout:5000 });
  assert.ok(await page.locator('.candle').count() >= 30, 'live chart should render the ingested 30-day broker history');
  assert.equal(await page.locator('#chartEmpty').isHidden(), true, 'empty state must disappear once broker data arrives');
  assert.ok(await page.locator('.zone-row').count() > 0, 'liquidity zones should appear once broker history arrives');
  await page.waitForSelector('.footprint-source-status', { timeout:5000 });
  const dataProvenance = await page.evaluate(() => ({
    status: document.querySelector('.footprint-source-status')?.innerText || '',
    headers: [...document.querySelectorAll('#footprintGrid .bar-head')].map(node => ({
      ticks: Number(node.dataset.sourceTicks),
      levels: Number(node.dataset.sourceLevels)
    }))
  }));
  assert.match(dataProvenance.status, /MT5 OTC.*ТИКОВАЯ АКТИВНОСТЬ.*НЕ БИРЖЕВОЙ ОБЪЁМ/, 'OTC data must not be represented as exchange trade volume');
  assert.match(dataProvenance.status, /РЕДКИЕ ДАННЫЕ/, 'sparse source history must be called out instead of looking like a complete footprint');
  assert.match(dataProvenance.status, /не интерполируются/, 'missing price levels must never be filled from OHLC');
  assert.ok(dataProvenance.headers.length > 0 && dataProvenance.headers.every(item => item.levels >= 0 && item.ticks >= 0), 'each candle header must expose the number of actual source ticks and price levels');
  const chartWidthBeforeZoom=await page.locator('#priceChart').evaluate(el=>el.getBoundingClientRect().width);
  await page.locator('#chartZoomIn').click();
  const chartWidthAfterZoom=await page.locator('#priceChart').evaluate(el=>el.getBoundingClientRect().width);
  assert.ok(chartWidthAfterZoom>chartWidthBeforeZoom,'X zoom must enlarge candle spacing and chart width');
  await page.locator('#chartZoomReset').click();
  const priceTagBeforeZoom=await page.locator('.last-price-tag').getAttribute('y');
  await page.locator('#chartPriceZoomIn').click();
  const priceTagAfterZoom=await page.locator('.last-price-tag').getAttribute('y');
  assert.notEqual(priceTagAfterZoom,priceTagBeforeZoom,'Y zoom must change the price projection');
  await page.locator('#chartPriceZoomReset').click();
  await page.locator('#chartZoomReset').click();
  const zoneTally = await page.evaluate(() => {
    const num = t => Number((t || '').replace(/[^\d]/g, ''));
    return {
      rows: document.querySelectorAll('.zone-row').length,
      badge: num(document.querySelector('#zoneCount').textContent),
      above: num(document.querySelector('#aboveZones').textContent),
      below: num(document.querySelector('#belowZones').textContent)
    };
  });
  assert.equal(zoneTally.badge, zoneTally.rows, 'the zone badge must match the rows listed');
  assert.equal(zoneTally.above + zoneTally.below, zoneTally.rows, 'above-price plus below-price must account for every listed zone');
  const zoneText = await page.locator('#zoneList').innerText();
  assert.ok(/[А-Яа-яЁё]/.test(zoneText), 'zone rows must be captioned in Russian, not engine tokens');
  assert.ok(!/Swing high|Prior day|Value area|UNTESTED|TESTED|SWEPT/.test(zoneText), 'no English label or state may reach the panel');

  await page.locator('.zone-row').first().click();
  assert.equal(await page.locator('.zone-row.selected').count(), 1, 'zone click should select one zone');
  assert.equal(await page.locator('.selected-zone').count(), 1, 'selected zone should highlight on chart');
  await page.locator('#zonesToggle').click();
  assert.equal(await page.locator('rect.zone-buy, rect.zone-sell').count(), 0, 'zone toggle should hide overlays');
  await page.locator('#zonesToggle').click();

  // The history has no aggressor side: Delta mode must not paint those rows as buying or selling.
  await page.locator('#footprintModes [data-mode="delta"]').click();
  assert.equal(await page.locator('.foot-cell.delta-positive, .foot-cell.delta-negative').count(), 0, 'rows without a known side carry no delta colour');
  await page.locator('#footprintModes [data-mode="volume"]').click();
  assert.ok(await page.locator('.volume-cell').count() > 0, 'Volume mode should render volume cells');
  // Delta %, buy and sell: each mode really switches what the cells show. The history above has no
  // aggressor side, so the side modes are rightly empty there; a few classified live ticks give them data.
  await page.evaluate(() => {
    const tick = (last, side, volume) => window.dispatchEvent(new CustomEvent('market-tick', { detail: { timestamp: new Date().toISOString(), last, aggressorSide: side, tickVolume: volume, realVolume: 0 } }));
    tick(2648.5, 'buy', 9); tick(2648.5, 'sell', 3); tick(2648.6, 'sell', 7); tick(2648.6, 'buy', 2);
  });
  await page.waitForTimeout(500);
  await page.locator('#resetView').click();
  await page.waitForTimeout(300);
  const cellTexts = () => page.evaluate(() => [...document.querySelectorAll('#footprintGrid .foot-cell')].map(node => node.textContent.replace(/[◆\s\u00a0]/g, '')).filter(Boolean));
  await page.locator('#footprintModes [data-mode="delta"]').click();
  const deltaTexts = await cellTexts();
  assert.ok(deltaTexts.includes('+6') && deltaTexts.includes('-5'), 'Delta mode shows each classified row as ask minus bid: ' + deltaTexts.join(' '));
  assert.ok(await page.locator('.foot-cell.delta-positive').count() > 0 && await page.locator('.foot-cell.delta-negative').count() > 0, 'Delta mode colours buying and selling rows');
  await page.locator('#footprintModes [data-mode="deltaPct"]').click();
  const pctTexts = await cellTexts();
  assert.ok(pctTexts.includes('+50%') && pctTexts.includes('-56%') && pctTexts.every(text => /^[+-]?\d+%$/.test(text)), 'Delta % mode shows each row as a share of its sided volume: ' + pctTexts.slice(0, 8).join(' '));
  assert.ok(await page.locator('#footprintModes [data-mode="deltaPct"].selected').count() === 1, 'the Delta % button is marked selected');
  await page.locator('#footprintModes [data-mode="buy"]').click();
  const buyTexts = await cellTexts();
  await page.locator('#footprintModes [data-mode="sell"]').click();
  const sellTexts = await cellTexts();
  assert.ok(buyTexts.includes('9') && buyTexts.includes('2') && sellTexts.includes('3') && sellTexts.includes('7'), 'buy shows the ask side and sell the bid side: ' + buyTexts.join(' ') + ' / ' + sellTexts.join(' '));
  assert.notDeepEqual(buyTexts, sellTexts, 'buy and sell modes show different sides of the rows');
  await page.locator('#footprintModes [data-mode="bidask"]').click();
  const clusterRender = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.foot-cell.bidask:not(.empty-level)')];
    const values = side => cells.flatMap(cell => [...cell.querySelectorAll('.foot-side[data-side="' + side + '"]')])
      .filter(node => Number(node.textContent.trim()) > 0);
    const bid = values('bid'), ask = values('ask');
    return {
      cells: cells.length,
      bid: bid.length,
      ask: ask.length,
      bidHeat: bid.some(node => Number(node.style.getPropertyValue('--side-intensity')) > 0),
      askHeat: ask.some(node => Number(node.style.getPropertyValue('--side-intensity')) > 0)
    };
  });
  assert.ok(clusterRender.cells > 0, 'traded price rows render as footprint clusters');
  assert.ok(clusterRender.bid > 0 && clusterRender.ask > 0, 'each cluster keeps separate Bid and Ask values');
  assert.ok(clusterRender.bidHeat && clusterRender.askHeat, 'Bid and Ask heatmaps use independent volume intensity');
  await page.locator('#numbersToggle').click();
  assert.ok(await page.locator('.foot-cell:not(.empty-level)').first().innerText().then(v => v.trim()).then(v => v === ''), 'number toggle should hide cell values');
  await page.locator('#numbersToggle').click();

  // Footprint math: POC, value area, session profile, delta row and the markers are on screen.
  assert.ok(await page.locator('.foot-poc').count() > 0, 'every drawn bar must mark its point of control');
  assert.ok(await page.locator('.foot-cell.foot-va').count() > 0, 'the value area must be shaded');
  assert.ok(await page.locator('.foot-profile:not(.empty)').count() > 0, 'the session profile column must carry volume');
  assert.equal(await page.locator('.foot-profile b').count() > 0, true, 'the profile labels VAH / VAL / POC');
  assert.equal(await page.locator('.foot-delta').count(), await page.locator('.bar-head').count(), 'one delta cell per bar');
  assert.equal(await page.locator('.foot-cell.foot-forming').count() > 0, true, 'the forming bar is marked');
  assert.ok(!/Swing high|Prior day|Value area/.test(await page.locator('#footprintGrid').innerText()), 'no engine token leaks into the footprint');
  // The ladder reads as one continuous grid: cells sit edge to edge with hairline separators, not as
  // individually bordered and rounded tiles floating apart.
  const ladder = await page.evaluate(() => {
    const cell = document.querySelector('.foot-cell');
    const row = cell.closest('.foot-row');
    const style = getComputedStyle(cell);
    return { gap: getComputedStyle(row).columnGap, radius: style.borderTopLeftRadius, border: style.borderTopWidth };
  });
  assert.equal(ladder.gap, '0px', 'footprint cells must sit edge to edge, got a ' + ladder.gap + ' gap between them');
  assert.equal(ladder.radius, '0px', 'footprint cells must not carry rounded tile corners');
  assert.ok(parseFloat(ladder.border) <= 1, 'footprint cells may only carry a hairline separator');

  // Real time: a streamed tick lands in the forming bar between refetches, without a reload.
  // The price is outside the fixture range, so a new price row proves the tick was applied.
  const formingVolume = () => page.evaluate(() => [...document.querySelectorAll('.foot-cell.foot-forming')]
    .reduce((sum, cell) => sum + cell.innerText.split(/\s+/).reduce((n, part) => n + (Number(part) || 0), 0), 0));
  const beforeTick = await formingVolume();
  // Same 15m bucket as the last streamed tick above, so no new candle is created.
  const liveTick = { source: 'mt5', symbol: 'XAUUSD', timestamp: new Date().toISOString(), sequence: Date.now(), bid: 2649.1, ask: 2649.3, last: 2649.2, tickVolume: 9, realVolume: 0, flags: 32 };
  const liveResponse = await fetch(base + '/v1/ingest/mt5/tick', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({...liveTick,feedId:browserFeedId}) });
  assert.equal(liveResponse.status, 202, 'a live tick must be accepted');
  await page.waitForFunction(before => [...document.querySelectorAll('.foot-cell.foot-forming')]
    .reduce((sum, cell) => sum + cell.innerText.split(/\s+/).reduce((n, part) => n + (Number(part) || 0), 0), 0) > before, beforeTick, { timeout: 5000 });
  assert.ok(await formingVolume() >= beforeTick + 9, 'the forming bar must absorb the tick volume immediately');
  assert.ok(await page.locator('.foot-cell.foot-forming').count() > 0, 'the forming column survives the tick');

  const firstCell = page.locator('.foot-cell:not(.empty-level)').first();
  const firstIndex = Number(await firstCell.getAttribute('data-index'));
  await firstCell.click();
  assert.match(await page.locator('#selectedBar').innerText(), new RegExp('#'+String(firstIndex+1).padStart(3,'0')));
  await page.locator('.candle[data-index="2"]').click();
  assert.match(await page.locator('#selectedBar').innerText(), /#003/);
  const sideSplit = await page.evaluate(() => ({
    bid: document.querySelector('#bidVolume').textContent,
    ask: document.querySelector('#askVolume').textContent,
    unknown: document.querySelector('#unknownVolume').textContent,
    total: document.querySelector('#totalVolume').textContent
  }));
  assert.equal(Number(sideSplit.bid) + Number(sideSplit.ask) + Number(sideSplit.unknown), Number(sideSplit.total), 'the inspector must account for every tick, including the ones without an aggressor side');
  assert.notEqual(sideSplit.unknown, '—', 'ticks the broker did not classify must be shown, not silently dropped');

  const totalBars = Number((await page.locator('#barCount').innerText()).replace(/[^\d]/g, ''));
  await page.locator('#resetView').click();
  assert.match(await page.locator('#selectedBar').innerText(), new RegExp('#'+String(totalBars).padStart(3,'0')), 'reset should select the newest candle');
  assert.equal(await page.locator('.zone-row.selected').count(), 0, 'reset should clear zone selection');

  await page.locator('#layoutButton').click();
  assert.ok(await page.locator('#workspace').evaluate(el => el.classList.contains('trading-layout')), 'split TradingView layout must activate');
  assert.ok(await page.locator('#chartPanelResizer').isVisible(), 'split layout must expose the chart/footprint divider');
  for (const id of ['#footZoomXOut', '#footZoomXIn', '#footZoomYOut', '#footZoomYIn']) {
    assert.ok(await page.locator(id).isVisible(), 'footprint zoom control must be visible: ' + id);
  }
  const footprintCell = page.locator('#footprintGrid .foot-cell').first();
  const widthBefore = await footprintCell.evaluate(el => el.getBoundingClientRect().width);
  const heightBefore = await footprintCell.evaluate(el => el.getBoundingClientRect().height);
  // Wait for the re-render instead of measuring straight after the click: on a loaded CI runner the
  // live tick that re-renders the grid can land between the click and the read.
  { const grew = () => page.waitForFunction(
    before => document.querySelector('#footprintGrid .foot-cell')?.getBoundingClientRect().width > before,
    widthBefore, { timeout: 4000 }
  );
    await page.locator('#footZoomXIn').click();
    await grew();
    const widthAfter = await footprintCell.evaluate(el => el.getBoundingClientRect().width);
    assert.ok(widthAfter > widthBefore, 'X+ must widen footprint columns');
  }
  { const grew = () => page.waitForFunction(
    before => document.querySelector('#footprintGrid .foot-cell')?.getBoundingClientRect().height > before,
    heightBefore, { timeout: 4000 }
  );
    await page.locator('#footZoomYIn').click();
    await grew();
    const heightAfter = await footprintCell.evaluate(el => el.getBoundingClientRect().height);
    assert.ok(heightAfter > heightBefore, 'Y+ must increase footprint price-row height');
  }
  await page.locator('#footZoomXReset').click();
  await page.locator('#footZoomYReset').click();
  await page.locator('#layoutButton').click();
  assert.ok(!(await page.locator('#workspace').evaluate(el => el.classList.contains('trading-layout'))), 'layout toggle restores stacked workspace');

  await page.locator('#loadReplay').click();
  await page.waitForFunction(() => document.querySelector('#replaySlider') && !document.querySelector('#replaySlider').disabled, null, { timeout:5000 });
  assert.ok(await page.locator('.candle').count() >= 30, 'replay must load the selected historical range');
  await page.locator('#replaySlider').evaluate(el=>{el.value='1';el.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.match(await page.locator('#selectedBar').innerText(), /#002/, 'replay slider must move the selected candle and footprint');
  await page.locator('#playReplay').click();
  await page.waitForTimeout(250);
  await page.locator('#pauseReplay').click();
  await page.locator('#liveView').click();
  await page.waitForFunction(() => document.querySelector('#chartStatus')?.textContent.startsWith('ОНЛАЙН'), null, { timeout:5000 });
  await page.locator('#runBacktest').click();
  await page.waitForFunction(() => document.querySelector('#backtestSummary')?.textContent.includes('сделок'), null, { timeout:5000 });
  await page.locator('#calculateRisk').click();
  await page.waitForFunction(() => document.querySelector('#riskResult')?.textContent.includes('ПЛАН ПРОХОДИТ ПРОВЕРКУ'), null, { timeout:5000 });
  assert.match(await page.locator('#riskChecks').innerText(), /ОК/);

  // Pattern memory: the module is wired and answers its honest state, never an invented win rate.
  assert.ok(await page.locator('#patternResult').count() === 1, 'the pattern memory panel must exist');
  assert.ok(await page.locator('#findAnalogues').count() === 1, 'the analogue search button must exist');
  await page.locator('#findAnalogues').click();
  await page.waitForTimeout(900);
  assert.match(await page.locator('#patternResult').innerText(), /аналог|снятия ликвидности|Память|порог|винрейт/i, 'the panel must report its state, not stay blank');

  // The two dormant footprint settings now have controls, and each one moves the screen. A synthetic
  // forming bar is built tick by tick through the same market-tick path the SSE feed uses: three
  // consecutive ask-heavy rows over light bids make a stack, and one dominant row pins the value area.
  await page.evaluate(() => {
    const tick = (last, side, volume) => window.dispatchEvent(new CustomEvent('market-tick', { detail: { timestamp: new Date().toISOString(), last, aggressorSide: side, tickVolume: volume, realVolume: 0 } }));
    tick(2649.30, 'buy', 25);
    tick(2649.20, 'buy', 25); tick(2649.20, 'sell', 5);
    tick(2649.10, 'buy', 200); tick(2649.10, 'sell', 5);
    tick(2649.00, 'sell', 5);
  });
  await page.waitForTimeout(600);
  // The footprint window follows the selected bar: reset to the newest so the forming column is in view.
  await page.locator('#resetView').click();
  await page.waitForTimeout(400);
  await page.locator('.foot-cell.foot-forming').first().click();
  await page.waitForTimeout(300);
  let verdict = await page.locator('#flowVerdict').innerText();
  assert.match(verdict, /стеков/, 'the default settings must mark the stack in the forming bar');
  const formingImbalanceCells = () => page.evaluate(() => {
    const forming = document.querySelector('.foot-cell.foot-forming');
    const idx = forming?.getAttribute('data-index');
    return idx === null ? -1 : document.querySelectorAll(`.foot-cell[data-index="${idx}"].imbalance-buy, .foot-cell[data-index="${idx}"].imbalance-sell`).length;
  });
  const imbalancesBefore = await formingImbalanceCells();
  assert.ok(imbalancesBefore >= 3, 'the synthetic bar must mark at least three imbalance cells, got ' + imbalancesBefore);

  await page.locator('#openSettings').click();
  await page.waitForSelector('#settingsDialog[open]');
  await page.locator('#settingsTabs button[data-tab="footprint"]').click();
  // Slider 1: stack length. Raising it dissolves the stack but keeps the single imbalances.
  await page.locator('#setImbalanceLevels').evaluate(el => { el.value = '10'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForFunction(() => document.querySelector('#settingsStatus')?.textContent === 'Сохранено', null, { timeout: 5000 });
  await page.waitForTimeout(400);
  verdict = await page.locator('#flowVerdict').innerText();
  assert.ok(!/стеков/.test(verdict), 'raising the stack-length setting must dissolve the stack in the forming bar');
  // Slider 2: minimum level volume. Raising it strips the thin imbalanced rows as noise.
  await page.locator('#setMinLevelVolume').evaluate(el => { el.value = '30'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForFunction(() => document.querySelector('#settingsStatus')?.textContent === 'Сохранено', null, { timeout: 5000 });
  await page.waitForTimeout(400);
  const imbalancesAfter = await formingImbalanceCells();
  assert.ok(imbalancesAfter < imbalancesBefore, 'raising the minimum level volume must remove imbalance marks: ' + imbalancesAfter + ' after vs ' + imbalancesBefore + ' before');
  const savedFootprint = await (await fetch(base + '/v1/settings')).json();
  assert.equal(savedFootprint.footprint.imbalanceLevels, 10, 'the stack-length setting must be saved');
  assert.equal(savedFootprint.footprint.minLevelVolume, 30, 'the min-level setting must be saved');
  // Row size: grouping five source steps per row must shrink the ladder, be saved, and come back at 1.
  const ladderRows = () => page.evaluate(() => document.querySelectorAll('#footprintGrid .foot-row:not(.foot-head):not(.foot-deltas):not(.foot-times)').length);
  const rowsFine = await ladderRows();
  // Hold back the analysis refetch so only the browser's own footprint path can regroup the rows.
  await page.route('**/v1/market/analysis**', route => route.abort());
  await page.locator('#setTicksPerRow').evaluate(el => { el.value = '5'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForFunction(() => document.querySelector('#settingsStatus')?.textContent === 'Сохранено', null, { timeout: 5000 });
  await page.waitForTimeout(800);
  const rowsCoarse = await ladderRows();
  assert.ok(rowsCoarse < rowsFine, 'five steps per row must draw fewer ladder rows: ' + rowsCoarse + ' vs ' + rowsFine);
  const ladderPrices = await page.evaluate(() => [...document.querySelectorAll('#footprintGrid .foot-row:not(.foot-head):not(.foot-deltas):not(.foot-times) .price-level')]
    .map(node => Number(node.textContent.replace(/[\s\u00a0]/g, '').replace(',', '.'))));
  // Every label must parse: an empty or garbled label is a failure, not a row to skip.
  assert.equal(ladderPrices.length, rowsCoarse, 'every ladder row must carry a price label');
  assert.ok(ladderPrices.length > 0 && ladderPrices.every(Number.isFinite), 'every ladder price must be a number, got ' + ladderPrices.join(', '));
  const offGrid = ladderPrices.filter(price => Math.abs(price * 2 - Math.round(price * 2)) > 1e-6);
  assert.deepEqual(offGrid, [], 'grouped ladder rows must sit on the 0.5 grid, found ' + offGrid.join(', '));
  await page.unroute('**/v1/market/analysis**');
  assert.equal((await (await fetch(base + '/v1/settings')).json()).footprint.ticksPerRow, 5, 'the row size must be saved');
  await page.locator('#setTicksPerRow').evaluate(el => { el.value = '1'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForFunction(() => document.querySelector('#settingsStatus')?.textContent === 'Сохранено', null, { timeout: 5000 });
  await page.waitForTimeout(2500);
  assert.equal(await ladderRows(), rowsFine, 'returning to one step per row restores the source precision');
  // The value-area share: at the default 70% the dominant row alone covers it (a one-row area);
  // at 95% the area must widen past the point of control. The forming bar is recomputed locally
  // by the live-tick path, so this checks exactly the code that used to ignore the setting.
  const vaRange = async () => {
    const text = await page.locator('#valueAreaRange').innerText();
    const match = text.match(/([\d\s,\u00a0]+?)\s*—\s*([\d\s,\u00a0]+?)\s*·/);
    if (!match) return null;
    const num = v => Number(v.replace(/[\s\u00a0]/g, '').replace(',', '.'));
    return { low: num(match[1]), high: num(match[2]), text };
  };
  const vaNarrow = await vaRange();
  assert.ok(vaNarrow, 'the inspector must show the forming bar value area: ' + (vaNarrow ? '' : await page.locator('#valueAreaRange').innerText()));
  assert.equal(vaNarrow.high, vaNarrow.low, 'at the default 70% share the dominant row alone is the value area');
  await page.locator('#setValueAreaShare').evaluate(el => { el.value = '95'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForFunction(() => document.querySelector('#settingsStatus')?.textContent === 'Сохранено', null, { timeout: 5000 });
  await page.waitForTimeout(400);
  const vaWide = await vaRange();
  assert.ok(vaWide.high > vaWide.low, 'at 95% the forming bar value area must widen beyond the point of control: ' + vaWide.text);
  // Restore the defaults so the later sections (setup library, dense 4K history) start from them.
  await page.locator('#settingsReset').click();
  await page.waitForFunction(() => document.querySelector('#settingsStatus')?.textContent === 'Настройки сброшены', null, { timeout: 5000 });
  // Back to the zones pane: the next settings section expects the dialog's default tab.
  await page.locator('#settingsTabs button[data-tab="zones"]').click();
  await page.locator('#settingsClose').click();
  await page.waitForTimeout(300);

  // Vespera-style setup library: save, apply and verify the active conditions propagate.
  await page.locator('#setupName').fill('Browser strict');
  await page.locator('#condStacked').check();
  await page.locator('#saveSetup').click();
  await page.waitForFunction(() => document.querySelector('#setupStatus')?.textContent.includes('Сохранено: Browser strict'), null, { timeout:5000 });
  await page.locator('#setupSelect').selectOption({ index: 1 });
  await page.locator('#applySetup').click();
  await page.waitForFunction(() => document.querySelector('#setupStatus')?.textContent.includes('Применено'), null, { timeout:5000 });
  const setupsState = await (await fetch(base + '/v1/setups')).json();
  assert.ok(setupsState.activeId, 'a setup must be active after Apply');
  assert.equal(setupsState.activeDefinition.strategy.requireStacked, true, 'applied conditions must persist server-side');
  assert.match(await page.locator('#licenseStatus').innerText(), /НЕ ТРЕБУЕТСЯ/, 'licence row must reflect the CI dev mode');

  // The emulated Electron bridge is connected: the dialog must expose status and automatic repair, never credentials.
  await page.locator('#mt5Open').click();
  await page.waitForSelector('#mt5Dialog[open]');
  assert.equal(await page.locator('#mt5Open').getAttribute('data-state'), 'online');
  assert.ok(await page.locator('#mt5InstallIntegration').count() === 1, 'the auto-repair action must exist');
  assert.equal(await page.locator('#mt5Terminal, #mt5Password, #mt5Form').count(), 0, 'no account credentials or manual terminal path may be requested');
  assert.ok(await page.locator('#mt5Connect').isDisabled(), 'connect is disabled for an already connected account');
  await page.locator('#mt5Close').click();

  // Settings sheet: zone finder + MT5 drawing style are saved server-side and reach the zones endpoint.
  await page.locator('#openSettings').click();
  await page.waitForSelector('#settingsDialog[open]');
  await page.locator('#setMaxZones').evaluate(el=>{el.value='4';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.locator('#setReactionBars').evaluate(el=>{el.value='10';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.locator('#setSrcVolume').click();
  await page.locator('#settingsTabs button[data-tab="mt5"]').click();
  await page.locator('#setLineStyle button[data-value="dash"]').click();
  await page.locator('#setSellColor').evaluate(el=>{el.value='#00ff00';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.waitForFunction(() => document.querySelector('#settingsStatus')?.textContent === 'Сохранено', null, { timeout:5000 });
  assert.ok(await page.locator('#setLineWidth').isDisabled(), 'dashed lines lock the width to 1 (MT5 limitation)');
  await page.locator('#settingsDone').click();
  const savedSettings = await (await fetch(base + '/v1/settings')).json();
  assert.equal(savedSettings.zones.maxZones, 4);
  assert.equal(savedSettings.zones.reactionBars, 10, 'the reaction window comes from the sheet');
  assert.equal(savedSettings.zones.useVolume, false, 'a switched-off source must reach the store');
  assert.equal(savedSettings.zones.useSessions, true, 'untouched sources keep their default');
  assert.equal(savedSettings.mt5.lineStyle, 'dash');
  assert.equal(savedSettings.mt5.lineWidth, 1);
  assert.equal(savedSettings.mt5.sellColor, '#00FF00');
  const zonesForMt5 = await (await fetch(base + '/v1/chart/zones?symbol=XAUUSD')).json();
  assert.ok(zonesForMt5.zones.length <= 4, 'zone count setting must limit the MT5 payload');
  assert.ok(!zonesForMt5.zones.some(z => /^(Volume|Value area)/.test(z.label) || (z.sources||[]).some(s => /^(Volume|Value area)/.test(s))), 'the volume profile is off, so no volume level may be drawn');
  assert.equal(zonesForMt5.style.lineStyle, 'dash', 'MT5 payload must carry the drawing style');
  await page.locator('#railNav .rail-item[data-go="settings"]').click();
  await page.waitForSelector('#settingsDialog[open]');
  await page.locator('#settingsReset').click();
  await page.waitForFunction(() => document.querySelector('#settingsStatus')?.textContent === 'Настройки сброшены', null, { timeout:5000 });
  assert.equal((await (await fetch(base + '/v1/settings')).json()).mt5.sellColor, '#FF0000', 'reset restores red lines');
  assert.equal((await (await fetch(base + '/v1/settings')).json()).zones.useVolume, true, 'reset turns the volume source back on');
  await page.locator('#settingsClose').click();

  await mkdir('artifacts', { recursive:true });
  await page.screenshot({ path:'artifacts/market-lab-desktop.png', fullPage:true });
  await page.setViewportSize({ width:390, height:844 });
  await page.waitForTimeout(250);
  const mobile = await page.evaluate(() => ({ width:innerWidth, scrollWidth:document.documentElement.scrollWidth, chart:document.querySelector('.price-panel')?.getBoundingClientRect().width, footprint:document.querySelector('.footprint-wrap')?.getBoundingClientRect().width }));
  assert.ok(mobile.scrollWidth <= mobile.width, 'mobile page must not overflow horizontally');
  assert.ok(mobile.chart > 0 && mobile.footprint > 0, 'chart and footprint must remain visible on mobile');
  await page.screenshot({ path:'artifacts/market-lab-mobile.png', fullPage:true });
  await page.locator('#openSettings').click();
  await page.waitForSelector('#settingsDialog[open]');
  await page.locator('#settingsTabs button[data-tab="zones"]').click();
  const tabs = await page.evaluate(() => [...document.querySelectorAll('#settingsTabs button')].map(b => {
    const r = b.getBoundingClientRect();
    return { top: Math.round(r.top), width: Math.round(r.width), scroll: b.scrollWidth };
  }));
  assert.equal(new Set(tabs.map(t => t.top)).size, 1, 'settings tabs must stay on one row on a phone');
  assert.ok(tabs.every(t => t.width >= t.scroll - 1), 'no settings tab may clip its own label');
  const tabStrip = await page.evaluate(() => { const el = document.querySelector('#settingsTabs'); return { scroll: el.scrollWidth, client: el.clientWidth }; });
  assert.ok(tabStrip.scroll <= tabStrip.client + 1, 'all four settings tabs must be reachable without horizontal scrolling on a phone');
  assert.ok(await page.locator('#settingsTabs button[data-tab="zones"]').evaluate(el => el.classList.contains('on')), 'the active tab must be the zone pane');
  assert.ok(!(await page.locator('#settingsTabs button[data-tab="mt5"]').evaluate(el => el.classList.contains('on'))), 'only one tab is active');
  const sheet = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#settingsDialog .settings-pane[data-pane="zones"] .row')];
    return {
      overflow: document.documentElement.scrollWidth - innerWidth,
      rows: rows.length,
      visible: rows.filter(row => row.getBoundingClientRect().height > 0).length,
      toggles: document.querySelectorAll('#settingsDialog .settings-pane[data-pane="zones"] .toggle').length,
      right: Math.max(...rows.map(row => row.getBoundingClientRect().right)),
      sliders: [...document.querySelectorAll('#settingsDialog .settings-pane[data-pane="zones"] input[type="range"]')].filter(el => el.getBoundingClientRect().width > 0).length
    };
  });
  assert.ok(sheet.overflow <= 0, 'the settings sheet must not overflow a phone width');
  assert.ok(sheet.right > 0 && sheet.right <= 390, 'every source row must fit inside the phone viewport');
  assert.equal(sheet.visible, sheet.rows, 'the zone pane is the one on screen');
  assert.equal(sheet.toggles, 5, 'all five level sources are switchable');
  assert.ok(sheet.sliders >= 7, 'every numeric zone option has a slider');
  await page.screenshot({ path:'artifacts/settings-mobile.png' });
  await page.locator('#settingsTabs button[data-tab="mt5"]').click();
  await page.waitForTimeout(120);
  const bridge = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - innerWidth,
    paneText: document.querySelector('#settingsDialog .settings-pane[data-pane="mt5"]')?.innerText || '',
    hasTokenField: Boolean(document.querySelector('#bridgeToken, #bridgeCopy, #bridgeBlock'))
  }));
  assert.ok(bridge.overflow <= 0, 'the MT5 pane must not overflow a phone width');
  assert.match(bridge.paneText, /токен передаёт через Common Files/i, 'the settings must explain automatic local token hand-off');
  assert.equal(bridge.hasTokenField, false, 'the renderer must not expose the private bridge token');
  await page.locator('#settingsTabs button[data-tab="zones"]').click();
  await page.locator('#settingsClose').click();
  await page.waitForTimeout(150);
  // Плотная история: на 4K панель должна вмещать серию, а не растягивать её в ленту.
  // Three trades per 15-minute bar create OHLC bodies in both directions plus a traded
  // extreme outside each body, so both candle edges and wick rows are exercised.
  const denseTicks = Array.from({ length: 1800 }, (_, n) => {
    const i = Math.floor(n / 3), tickInBar = n % 3;
    const at = new Date(Date.now() - (600 - i) * 15 * 60000 + tickInBar * 15000);
    const basePrice = 2650 + Math.sin(i / 9) * 4 + i * 0.02;
    const close = basePrice + (i % 2 ? -0.3 : 0.3);
    const extreme = basePrice + (i % 2 ? -0.5 : 0.5);
    const px = tickInBar === 0 ? basePrice : tickInBar === 1 ? extreme : close;
    return { timestamp: at.toISOString(), sequence: 100000 + n, bid: +(px - 0.1).toFixed(2), ask: +(px + 0.1).toFixed(2), last: +px.toFixed(2), tickVolume: 1, realVolume: 0, flags: 0 };
  });
  // History ingestion is intentionally capped at 1,000 ticks per request; send the 1,200-tick
  // fixture as bounded batches so the browser test exercises the real ingestion contract.
  for (let offset = 0; offset < denseTicks.length; offset += 1000) {
    const denseResponse = await fetch(base + '/v1/ingest/mt5/history', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ source: 'mt5', symbol: 'XAUUSD', feedId: browserFeedId, ticks: denseTicks.slice(offset, offset + 1000) }) });
    assert.equal(denseResponse.status, 202, 'dense history fixture batch should be accepted');
  }
  await page.setViewportSize({ width: 3840, height: 2160 });
  await page.waitForFunction(() => document.querySelectorAll('.candle').length >= 600, null, { timeout: 8000 });
  await page.waitForTimeout(400);
  const wide = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - innerWidth,
    wrap: document.querySelector('.price-chart-wrap')?.clientWidth || 0,
    chart: document.querySelector('#priceChart')?.getBoundingClientRect().width || 0,
    content: document.querySelector('.main-content')?.getBoundingClientRect().width || 0,
    bars: document.querySelectorAll('.candle').length
  }));
  assert.ok(wide.overflow <= 0, '4K must not overflow horizontally');
  assert.ok(wide.content > 2000, '4K workspace must use the extra width instead of a 1680px strip');
  assert.ok(wide.chart >= wide.wrap * 0.85, 'chart must fill the panel on wide screens');
  assert.ok(wide.chart <= wide.wrap * 1.05, 'dense history must be compressed into the 4K panel instead of a multi-screen scroll strip');
  assert.ok(wide.chart / wide.bars >= 2, 'bars never get thinner than the 4K pitch');
  await page.screenshot({ path:'artifacts/market-lab-4k.png', fullPage:true });

  // The live forming bar uses the broker tick size the server built the bars on, not a fixed 0.1:
  // once MT5 reports 0.01, a streamed tick at 2700.43 keeps its own row instead of rounding to 2700.40.
  await page.setViewportSize({ width: 1440, height: 1100 });
  const specTick = { timestamp: new Date().toISOString(), sequence: Date.now(), bid: 2700.42, ask: 2700.44, last: 2700.41, tickVolume: 1, realVolume: 0, flags: 0 };
  const specResponse = await fetch(base + '/v1/ingest/mt5/live-batch', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ source: 'mt5', symbol: 'XAUUSD', feedId: browserFeedId, spec: { tickSize: 0.01 }, ticks: [specTick] }) });
  assert.equal(specResponse.status, 202, 'a live batch with the broker tick size is accepted');
  await page.waitForFunction(() => document.querySelectorAll('#footprintGrid .price-level').length && [...document.querySelectorAll('#footprintGrid .price-level')].some(node => /2[\s\u00a0]?700,41/.test(node.textContent)), null, { timeout: 8000 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('market-tick', { detail: { timestamp: new Date().toISOString(), last: 2700.43, aggressorSide: 'buy', tickVolume: 2, realVolume: 0 } })));
  await page.waitForTimeout(600);
  const liveRows = await page.evaluate(() => [...document.querySelectorAll('#footprintGrid .price-level')].map(node => node.textContent.replace(/[\s\u00a0]/g, '')));
  assert.ok(liveRows.includes('2700,43'), 'the forming bar must keep 2700.43 on the broker 0.01 grid, rows: ' + liveRows.join(' '));
  assert.ok(!liveRows.includes('2700,40'), 'the live tick must not be rounded onto the 0.1 grid');

  // Each footprint column reads as its candle: body rows between open and close, wick rows inside the
  // high-low range only, blank rows beyond it, and the body edge coloured by the bar's direction.
  await page.locator('#resetView').click();
  await page.waitForTimeout(500);
  const candles = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('#footprintGrid .foot-cell')];
    const forming = cells.filter(cell => cell.classList.contains('foot-forming'));
    const first = document.querySelector('#footprintGrid .foot-row:not(.foot-head):not(.foot-deltas):not(.foot-times) .foot-cell');
    
    return {
      body: cells.filter(cell => cell.classList.contains('candle-body')).length,
      wick: cells.filter(cell => cell.classList.contains('candle-wick')).length,
      out: cells.filter(cell => cell.classList.contains('candle-out')).length,
      up: cells.filter(cell => cell.classList.contains('candle-body') && cell.classList.contains('candle-up')).length,
      down: cells.filter(cell => cell.classList.contains('candle-body') && cell.classList.contains('candle-down')).length,
      formingBody: forming.filter(cell => cell.classList.contains('candle-body')).length,

    };
  });
  // The fixtures are nearly flat bars, so the body/wick/blank split itself is unit tested in
  // footprint-candle.test.js; here it is enough that the drawn ladder carries the parts.
  assert.ok(candles.body > 0 && candles.out > 0, 'the ladder marks body rows and blank rows: ' + JSON.stringify(candles));
  assert.ok(candles.up > 0, 'body edges follow the up-bar direction');
  assert.ok(candles.down > 0, 'body edges follow the down-bar direction');
  assert.ok(candles.wick > 0, 'traded rows outside candle bodies are rendered as wicks');
  assert.equal(candles.formingBody > 0, true, 'the forming column has a body too');

  assert.deepEqual(pageErrors, [], 'browser must not emit uncaught JavaScript errors');
  process.stdout.write('Browser checks passed: empty state, chart, footprint (POC, value area, profile, delta row, live tick), zones, replay, backtest, risk planner, setup library, settings, live MT5/COMEX status and mobile overflow.\n');
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
  await rm(isolatedDataFile,{force:true});
  await rm(isolatedSetupsFile,{force:true});
  await rm(isolatedSettingsFile,{force:true});
}
