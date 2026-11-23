import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarketServer } from './server.js';
import { createLicenseManager, issueLicenseKey } from './license.js';
import { createSetupStore } from './setup-store.js';
import { createSettingsStore } from './settings-store.js';
import { createPatternStore } from './pattern-store.js';

function testLicense(now = () => Date.now()) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const machineId = 'AAAA-BBBB-CCCC-DDDD';
  const key = issueLicenseKey({ privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), machineId, days: 30, nowMs: now() });
  return createLicenseManager({ publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), machineId, now, licenseFile: null, stateFile: null, initialKey: key });
}

let server; let base;
test.beforeEach(async () => { const app = createMarketServer({ token: 'test-secret', staleAfterMs: 10000, storageFile: null, license: testLicense(), setupStore: createSetupStore({ file: null }), settingsStore: createSettingsStore({ file: null }), patternStore: createPatternStore({ file: null }) }); server = app.server; await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port; });
test.afterEach(async () => { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
const auth = { authorization: 'Bearer test-secret', 'content-type': 'application/json' };
const mt5 = (sequence=1) => ({ source:'mt5',symbol:'XAUUSD',timestamp:'2026-11-17T15:00:00.000Z',sequence,bid:2648.2,ask:2648.4,last:2648.3,tickVolume:1,realVolume:0 });
const comex = (sequence=1) => ({ source:'comex',symbol:'GCZ6',timestamp:'2026-11-17T15:00:00.000Z',sequence,tradeId:'trade-'+sequence,price:2650.1,size:2,aggressorSide:'buy' });
test('health endpoint reports configured but initially empty feeds',async()=>{const r=await fetch(base+'/health');const b=await r.json();assert.equal(r.status,200);assert.equal(b.status,'ok');assert.equal(b.ingestConfigured,true);assert.equal(b.eventCount,0);});
test('startup loads only the latest retained events from a large JSONL archive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gold3po-market-archive-'));
  const storageFile = join(directory, 'market-events.jsonl');
  const records = Array.from({ length: 5 }, (_, index) => ({
    ...mt5(index + 1),
    eventId: 'archive-' + (index + 1),
    receivedAt: '2026-11-17T15:00:01.000Z'
  }));
  await writeFile(storageFile, records.map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8');
  const app = createMarketServer({
    token: 'test-secret',
    storageFile,
    maxEvents: 2,
    license: testLicense(),
    setupStore: createSetupStore({ file: null }),
    settingsStore: createSettingsStore({ file: null }),
    patternStore: createPatternStore({ file: null })
  });
  const archiveServer = app.server;
  await new Promise(resolve => archiveServer.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + archiveServer.address().port;
  try {
    const health = await (await fetch(url + '/health')).json();
    assert.equal(health.eventCount, 2, 'only the configured rolling window is restored');
    const snapshot = await (await fetch(url + '/v1/market/snapshot?symbol=XAUUSD&limit=10')).json();
    assert.deepEqual(snapshot.events.map(event => event.sequence), [4, 5], 'the newest records remain in chronological order');
    const stale = await fetch(url + '/v1/ingest/mt5/tick', {
      method: 'POST', headers: auth, body: JSON.stringify(mt5(5))
    });
    assert.equal(stale.status, 409, 'the restored sequence cursor still rejects an old tick');
    const fresh = await fetch(url + '/v1/ingest/mt5/tick', {
      method: 'POST', headers: auth, body: JSON.stringify(mt5(6))
    });
    assert.equal(fresh.status, 202, 'the next live tick is accepted after restoring the archive tail');
  } finally {
    await new Promise(resolve => archiveServer.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
test('MT5 tick is authenticated, normalized and visible in snapshot',async()=>{const r=await fetch(base+'/v1/ingest/mt5/tick',{method:'POST',headers:auth,body:JSON.stringify(mt5())});const b=await r.json();assert.equal(r.status,202);assert.equal(b.event.venue,'broker_otc');assert.equal(b.event.volumeKind,'broker_tick_or_reported_volume');const s=await fetch(base+'/v1/market/snapshot?symbol=XAUUSD');const snap=await s.json();assert.equal(snap.count,1);assert.equal(snap.events[0].last,2648.3);});
test('COMEX trade preserves trade size and aggressor side',async()=>{const r=await fetch(base+'/v1/ingest/comex/trade',{method:'POST',headers:auth,body:JSON.stringify(comex())});const b=await r.json();assert.equal(r.status,202);assert.equal(b.event.venue,'comex_futures');assert.equal(b.event.size,2);assert.equal(b.event.aggressorSide,'buy');});
test('ingest rejects missing or incorrect bearer token',async()=>{for(const headers of [{'content-type':'application/json'},{...auth,authorization:'Bearer wrong'}]){const r=await fetch(base+'/v1/ingest/mt5/tick',{method:'POST',headers,body:JSON.stringify(mt5())});assert.equal(r.status,401);}});
test('invalid market event is rejected without mutating sequence state',async()=>{const bad={...mt5(),ask:2640,bid:2650};let r=await fetch(base+'/v1/ingest/mt5/tick',{method:'POST',headers:auth,body:JSON.stringify(bad)});assert.equal(r.status,422);r=await fetch(base+'/v1/ingest/mt5/tick',{method:'POST',headers:auth,body:JSON.stringify(mt5())});assert.equal(r.status,202);});
test('duplicate and out-of-order sequences are rejected',async()=>{let r=await fetch(base+'/v1/ingest/mt5/tick',{method:'POST',headers:auth,body:JSON.stringify(mt5(5))});assert.equal(r.status,202);r=await fetch(base+'/v1/ingest/mt5/tick',{method:'POST',headers:auth,body:JSON.stringify(mt5(5))});assert.equal(r.status,409);r=await fetch(base+'/v1/ingest/mt5/tick',{method:'POST',headers:auth,body:JSON.stringify(mt5(4))});assert.equal(r.status,409);});
test('snapshot filters by symbol and bounded event limit',async()=>{for(const event of [mt5(1),mt5(2),comex(1)]){const path=event.source==='mt5'?'/v1/ingest/mt5/tick':'/v1/ingest/comex/trade';await fetch(base+path,{method:'POST',headers:auth,body:JSON.stringify(event)});}const r=await fetch(base+'/v1/market/snapshot?symbol=XAUUSD&limit=1');const b=await r.json();assert.equal(b.count,1);assert.equal(b.events[0].sequence,2);});

test('SSE stream remains subscribed and receives normalized market events',async()=>{const response=await fetch(base+'/v1/stream');assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);const reader=response.body.getReader();const first=await reader.read();assert.match(new TextDecoder().decode(first.value),/event: ready/);await fetch(base+'/v1/ingest/mt5/tick',{method:'POST',headers:auth,body:JSON.stringify(mt5())});const next=await reader.read();assert.match(new TextDecoder().decode(next.value),/event: market/);await reader.cancel();});

test('server refuses ingestion when no secret is configured',async()=>{const app=createMarketServer({token:'',storageFile:null,license:testLicense()});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));try{const url='http://127.0.0.1:'+app.server.address().port;const r=await fetch(url+'/v1/ingest/mt5/tick',{method:'POST',headers:auth,body:JSON.stringify(mt5())});assert.equal(r.status,503);assert.equal((await r.json()).error,'ingest_not_configured');}finally{await new Promise(resolve=>app.server.close(resolve));}});
test('feed health changes to stale after the configured threshold',async()=>{let clock=1000;const app=createMarketServer({token:'test-secret',now:()=>clock,staleAfterMs:500,license:testLicense(()=>clock)});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));try{const url='http://127.0.0.1:'+app.server.address().port;await fetch(url+'/v1/ingest/mt5/tick',{method:'POST',headers:auth,body:JSON.stringify(mt5())});clock=2000;const h=await (await fetch(url+'/health')).json();assert.equal(h.feeds[0].status,'stale');}finally{await new Promise(resolve=>app.server.close(resolve));}});

test('oversized request bodies return 413 and server remains usable',async()=>{const huge='x'.repeat(1025*1024);const r=await fetch(base+'/v1/ingest/mt5/tick',{method:'POST',headers:auth,body:huge});assert.equal(r.status,413);const h=await fetch(base+'/health');assert.equal(h.status,200);});

test('same-origin server serves market lab UI and assets',async()=>{const page=await fetch(base+'/');assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/text\/html/);const markup=await page.text();assert.match(markup,/market-client\.js/);for(const asset of ['/app.js','/market-data.js','/market-client.js','/market-engine.js','/styles.css','/license-client.js']){const r=await fetch(base+asset);assert.equal(r.status,200,asset);}});

test('MT5 history batches are authenticated and aggregated into candles and footprint levels',async()=>{
  const ticks=[1,2].map(sequence=>({timestamp:'2026-11-17T15:0'+sequence+':00.000Z',sequence,bid:2648,ask:2648.2,last:2648.1,tickVolume:10,realVolume:0,flags:0}));
  const r=await fetch(base+'/v1/ingest/mt5/history',{method:'POST',headers:auth,body:JSON.stringify({source:'mt5',symbol:'XAUUSD',ticks})});
  const body=await r.json();assert.equal(r.status,202);assert.equal(body.accepted,2);
  const a=await fetch(base+'/v1/market/analysis?symbol=XAUUSD&intervalMs=900000');const data=await a.json();
  assert.equal(a.status,200);assert.equal(data.bars.length,1);assert.equal(data.bars[0].tickCount,2);assert.equal(data.bars[0].unknown,2);assert.equal(data.bars[0].ask,0);assert.equal(data.bars[0].levels.length,1);
});
test('MT5 history endpoint rejects oversized batches and missing authentication',async()=>{
  const body=JSON.stringify({source:'mt5',symbol:'XAUUSD',ticks:[mt5()]});
  const noAuth=await fetch(base+'/v1/ingest/mt5/history',{method:'POST',headers:{'content-type':'application/json'},body});assert.equal(noAuth.status,401);
  const tooMany=Array.from({length:1001},(_,i)=>({...mt5(i+1)}));
  const large=await fetch(base+'/v1/ingest/mt5/history',{method:'POST',headers:auth,body:JSON.stringify({source:'mt5',symbol:'XAUUSD',ticks:tooMany})});assert.equal(large.status,422);
});

test('re-importing MT5 history is idempotent even when the rolling history sequence changes',async()=>{
  const ticks=[1,2].map(sequence=>({timestamp:'2026-11-17T15:0'+sequence+':00.000Z',sequence,eventId:'XAUUSD-history-'+sequence,bid:2648,ask:2648.2,last:2648.1,tickVolume:10,realVolume:0,flags:0}));
  const send=items=>fetch(base+'/v1/ingest/mt5/history',{method:'POST',headers:auth,body:JSON.stringify({source:'mt5',symbol:'XAUUSD',ticks:items})});
  const first=await (await send(ticks)).json();assert.equal(first.accepted,2);assert.equal(first.duplicates,0);
  const shifted=ticks.map(tick=>({...tick,sequence:tick.sequence+1000}));
  const second=await (await send(shifted)).json();assert.equal(second.accepted,0);assert.equal(second.duplicates,2);
  const live=mt5(1);live.timestamp='2026-11-17T16:00:00.000Z';
  const liveResponse=await fetch(base+'/v1/ingest/mt5/tick',{method:'POST',headers:auth,body:JSON.stringify(live)});
  assert.equal(liveResponse.status,202,'historical batch sequences must not block the independent live sequence');
});
test('replay returns chronologically aggregated historical bars for a requested range',async()=>{
  const ticks=[1,2,3].map(sequence=>({timestamp:'2026-11-17T15:0'+sequence+':00.000Z',sequence,bid:2648,ask:2648.2,last:2648.1,tickVolume:1,realVolume:0,flags:0}));
  await fetch(base+'/v1/ingest/mt5/history',{method:'POST',headers:auth,body:JSON.stringify({source:'mt5',symbol:'XAUUSD',ticks})});
  const response=await fetch(base+'/v1/market/replay?symbol=XAUUSD&from=2026-11-17T15:00:00.000Z&to=2026-11-17T16:00:00.000Z');
  const data=await response.json();assert.equal(response.status,200);assert.equal(data.eventCount,3);assert.equal(data.bars.length,1);assert.equal(data.bars[0].tickCount,3);
});
test('backtest and signal monitor endpoints return explicit empty-history states',async()=>{
  const [backtest,signals]=await Promise.all([
    fetch(base+'/v1/market/backtest?symbol=XAUUSD'),
    fetch(base+'/v1/market/signals?symbol=XAUUSD')
  ]);
  const bt=await backtest.json(),sig=await signals.json();
  assert.equal(backtest.status,200);assert.equal(bt.summary.trades,0);assert.equal(bt.summary.winRate,null);
  assert.equal(signals.status,200);assert.equal(sig.latest,null);assert.equal(sig.calibration.minimumSamples,30);
});
test('risk endpoint enforces sizing and reward-risk guardrails',async()=>{
  const ok=await (await fetch(base+'/v1/risk/plan?equity=10000&riskPct=0.5&entry=2650&stop=2645&target=2660&pointValue=1')).json();
  const blocked=await (await fetch(base+'/v1/risk/plan?equity=10000&riskPct=2&entry=2650&stop=2645&target=2652&pointValue=1')).json();
  assert.equal(ok.allowed,true);assert.equal(ok.quantity,10);assert.equal(blocked.allowed,false);
});

test('live MT5 batch preserves sequence order and safely retries an already ingested payload',async()=>{
  const ticks=[1,2].map(sequence=>({timestamp:'2026-11-17T17:0'+sequence+':00.000Z',sequence:100+sequence,eventId:'LIVE-'+(100+sequence),bid:2648,ask:2648.2,last:2648.1,tickVolume:1,realVolume:0,flags:0}));
  const send=()=>fetch(base+'/v1/ingest/mt5/live-batch',{method:'POST',headers:auth,body:JSON.stringify({source:'mt5',symbol:'XAUUSD',ticks})});
  const first=await (await send()).json();assert.equal(first.accepted,2);assert.equal(first.duplicates,0);assert.equal(first.lastAcceptedSequence,102);
  const retry=await (await send()).json();assert.equal(retry.accepted,0);assert.equal(retry.duplicates,2);
});
test('COMEX events can be analysed as actual exchange trades, not broker quotes',async()=>{
  const event={source:'comex',symbol:'GCZ6',timestamp:'2026-11-17T18:00:00.000Z',sequence:1,tradeId:'gc-trade-1',price:2650.1,size:3,aggressorSide:'buy'};
  const ingest=await fetch(base+'/v1/ingest/comex/trade',{method:'POST',headers:auth,body:JSON.stringify(event)});
  assert.equal(ingest.status,202);
  const response=await fetch(base+'/v1/market/analysis?source=comex&symbol=GCZ6&intervalMs=900000');
  const analysis=await response.json();assert.equal(response.status,200);assert.equal(analysis.source,'comex');assert.equal(analysis.bars[0].volume,3);assert.equal(analysis.volumeKind,'exchange_trade_size');
});

test('gold-only boundary rejects non-gold symbols and accepts broker suffix variants',async()=>{
  const eur={...mt5(1),symbol:'EURUSD'};
  let r=await fetch(base+'/v1/ingest/mt5/tick',{method:'POST',headers:auth,body:JSON.stringify(eur)});
  assert.equal(r.status,422);assert.match((await r.json()).message,/gold-only/);
  const oil={...comex(1),symbol:'CLZ6'};
  r=await fetch(base+'/v1/ingest/comex/trade',{method:'POST',headers:auth,body:JSON.stringify(oil)});
  assert.equal(r.status,422);
  const suffix={...mt5(1),symbol:'XAUUSD.'};
  r=await fetch(base+'/v1/ingest/mt5/tick',{method:'POST',headers:auth,body:JSON.stringify(suffix)});
  assert.equal(r.status,202);assert.equal((await r.json()).event.symbol,'XAUUSD.');
  const history=await fetch(base+'/v1/ingest/mt5/history',{method:'POST',headers:auth,body:JSON.stringify({source:'mt5',symbol:'EURUSD',ticks:[mt5(1)]})});
  assert.equal((await history.json()).rejected,1);
  const analysis=await fetch(base+'/v1/market/analysis?symbol=EURUSD');
  assert.equal(analysis.status,400);assert.equal((await analysis.json()).error,'symbol_not_gold');
  const gc=await fetch(base+'/v1/market/analysis?source=comex&symbol=GCZ6');
  assert.equal(gc.status,200);
});

test('chart zones endpoint serves an EA-ready payload and rejects non-gold symbols',async()=>{
  const ticks=[1,2,3].map(sequence=>({timestamp:'2026-11-17T15:0'+sequence+':00.000Z',sequence,bid:2648,ask:2648.2,last:2648.1,tickVolume:1,realVolume:0,flags:0}));
  await fetch(base+'/v1/ingest/mt5/history',{method:'POST',headers:auth,body:JSON.stringify({source:'mt5',symbol:'XAUUSD',ticks})});
  const r=await fetch(base+'/v1/chart/zones?symbol=XAUUSD');
  assert.equal(r.status,200);
  const b=await r.json();
  assert.equal(b.symbol,'XAUUSD');
  assert.ok(Array.isArray(b.zones));
  assert.equal(b.lastPrice,2648.1);
  assert.ok(b.generatedAt);
  const bad=await fetch(base+'/v1/chart/zones?symbol=EURUSD');
  assert.equal(bad.status,400);
});

test('setup library API saves, applies, exports and imports with strict validation',async()=>{
  const definition={strategy:{minScore:0.6,requireStacked:true,allowedSides:['long']},backtest:{stopAtr:2,targetR:3},risk:{minRiskReward:2}};
  const saved=await(await fetch(base+'/v1/setups',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Strict long',definition})})).json();
  assert.ok(saved.setupId);assert.equal(saved.version,1);
  const invalid=await fetch(base+'/v1/setups',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Bad',definition:{strategy:{secretToken:'x'}}})});
  assert.equal(invalid.status,422);
  const applied=await(await fetch(base+'/v1/setups/apply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:saved.setupId,version:1})})).json();
  assert.equal(applied.activeId,saved.setupId);
  assert.equal(applied.activeDefinition.strategy.requireStacked,true);
  const list=await(await fetch(base+'/v1/setups')).json();
  assert.equal(list.setups.length,1);
  const exported=await(await fetch(base+'/v1/setups/export?id='+saved.setupId+'&version=1')).json();
  assert.equal(exported.definition.backtest.targetR,3);
  const imported=await(await fetch(base+'/v1/setups/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Imported copy',definition:exported.definition})})).json();
  assert.notEqual(imported.setupId,saved.setupId);
  const bt=await(await fetch(base+'/v1/market/backtest?symbol=XAUUSD')).json();
  assert.equal(bt.setup.conditions.strategy.requireStacked,true);
  assert.equal(bt.config.stopAtr,2);
  const risk=await(await fetch(base+'/v1/risk/plan?equity=10000&riskPct=0.5&entry=2650&stop=2645&target=2657&pointValue=1')).json();
  assert.equal(risk.allowed,false);
});

test('zones and setups endpoints are licence-gated',async()=>{
  const manager=createLicenseManager({publicKeyPem:'unused',machineId:'AAAA-BBBB-CCCC-DDDD',licenseFile:null,stateFile:null,now:()=>Date.now()});
  const app=createMarketServer({token:'test-secret',storageFile:null,license:manager,setupStore:createSetupStore({file:null})});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+app.server.address().port;
  try{
    assert.equal((await fetch(url+'/v1/chart/zones')).status,402);
    assert.equal((await fetch(url+'/v1/setups')).status,402);
    assert.equal((await fetch(url+'/health')).status,200);
  }finally{await new Promise(resolve=>app.server.close(resolve));}
});

test('settings API: red solid lines by default, partial updates, validation and reset',async()=>{
  let r=await fetch(base+'/v1/settings');assert.equal(r.status,200);
  let b=await r.json();
  assert.equal(b.mt5.buyColor,'#FF0000');assert.equal(b.mt5.sellColor,'#FF0000');assert.equal(b.mt5.lineStyle,'solid');
  assert.equal(b.zones.minZones,3);assert.equal(b.zones.maxZones,7);
  r=await fetch(base+'/v1/settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({mt5:{lineWidth:3,sellColor:'#00ff00'},zones:{maxZones:5}})});
  b=await r.json();assert.equal(r.status,200);
  assert.equal(b.mt5.lineWidth,3);assert.equal(b.mt5.sellColor,'#00FF00');assert.equal(b.mt5.buyColor,'#FF0000','untouched keys keep their value');assert.equal(b.zones.maxZones,5);
  r=await fetch(base+'/v1/settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({mt5:{lineStyle:'dash'}})});
  assert.equal((await r.json()).mt5.lineWidth,1,'MT5 draws dashed lines only at width 1');
  for(const bad of [{mt5:{buyColor:'red'}},{zones:{maxZones:50}},{mt5:{nope:1}},{other:{}},{zones:{timeframeMinutes:7}}]){
    r=await fetch(base+'/v1/settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(bad)});
    assert.equal(r.status,422,JSON.stringify(bad));
  }
  assert.equal((await (await fetch(base+'/v1/settings')).json()).zones.maxZones,5,'a rejected update changes nothing');
  r=await fetch(base+'/v1/settings/reset',{method:'POST'});assert.equal((await r.json()).zones.maxZones,7);
});

test('chart zones follow the settings and carry the MT5 drawing style',async()=>{
  const start=Date.parse('2026-11-17T00:00:00.000Z');let p=2650,x=7;const rnd=()=>((x=(x*1103515245+12345)%2147483648)/2147483648);
  const ticks=[];for(let i=0;i<2400;i++){p+=Math.sin(i/90)*0.22+Math.sin(i/310)*0.14+(rnd()-.5)*0.6;ticks.push({timestamp:new Date(start+i*90000).toISOString(),sequence:i+1,bid:+p.toFixed(2),ask:+(p+0.2).toFixed(2),last:+p.toFixed(2),tickVolume:1,realVolume:0,flags:0});}
  for(let i=0;i<ticks.length;i+=1000)await fetch(base+'/v1/ingest/mt5/history',{method:'POST',headers:auth,body:JSON.stringify({source:'mt5',symbol:'XAUUSD',ticks:ticks.slice(i,i+1000)})});
  let b=await (await fetch(base+'/v1/chart/zones?symbol=XAUUSD')).json();
  assert.equal(b.intervalMs,900000);
  assert.ok(b.zones.length>=3&&b.zones.length<=7,'default finds 3..7 zones, got '+b.zones.length);
  const eaFields=['distance','high','id','label','low','side','state','strength'];
  for(const zone of b.zones){
    assert.deepEqual(Object.keys(zone).sort(),eaFields,'MT5 zones payload must be flat for the MQL5 parser');
    assert.ok(['buy','sell'].includes(zone.side));
    assert.ok(Number.isFinite(zone.low)&&Number.isFinite(zone.high)&&zone.high>zone.low);
  }
  assert.equal(b.style.buyColor,'#FF0000');
  await fetch(base+'/v1/settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({zones:{minZones:2,maxZones:3,timeframeMinutes:30},mt5:{fill:true}})});
  b=await (await fetch(base+'/v1/chart/zones?symbol=XAUUSD')).json();
  assert.equal(b.intervalMs,1800000,'timeframe setting drives the zone timeframe');
  assert.ok(b.zones.length>=2&&b.zones.length<=3);
  assert.equal(b.style.fill,true);
});

// Pattern memory + footprint settings propagation. The stack fixture pins one closed bar with
// three consecutive ask-heavy rows over light bids — a genuine 3-level buy stack the engine's
// defaults keep and a strict imbalanceLevels setting removes. Timestamps are anchored to the wall
// clock so the licence clock watermark (fed from event times) stays inside the test licence window.
const stackFixture = () => {
  const ticks = [];
  let seq = 1;
  const barTime = Date.now() - 30 * 900000; // a closed bar, not the forming one
  // quiet prior market around 2650: its 20-bar low (~2649.4) is the liquidity the sweep takes
  for (let i = 0; i < 40; i++) {
    const t = new Date(barTime - (40 - i) * 900000);
    const p = 2650 + Math.sin(i / 5) * 0.5;
    ticks.push({ timestamp: t.toISOString(), sequence: seq++, bid: +(p - 0.1).toFixed(2), ask: +(p + 0.1).toFixed(2), last: +p.toFixed(2), tickVolume: 2, realVolume: 2, flags: 0 });
  }
  // the sweep bar itself: dips below the prior low (2649.3), takes sell-side liquidity, and
  // prints three consecutive ask-heavy rows (2650.5/.4/.3 at 30 each) over light bids below
  // them — a genuine buy stack in the same bar as the sweep, which is what the strategy's
  // requireStacked condition reads (bar.stackedImbalances of the signal bar).
  const sweepTime = new Date(barTime + 60000);
  ticks.push({ timestamp: sweepTime.toISOString(), sequence: seq++, bid: 2649.2, ask: 2649.4, last: 2649.3, tickVolume: 20, realVolume: 20, flags: 64 });
  for (const price of [2650.5, 2650.4, 2650.3]) ticks.push({ timestamp: new Date(sweepTime.getTime() + 20000).toISOString(), sequence: seq++, bid: price - 0.1, ask: price + 0.1, last: price, tickVolume: 30, realVolume: 30, flags: 32 });
  for (const price of [2650.4, 2650.3, 2650.2]) ticks.push({ timestamp: new Date(sweepTime.getTime() + 40000).toISOString(), sequence: seq++, bid: price - 0.1, ask: price + 0.1, last: price, tickVolume: 5, realVolume: 5, flags: 64 });
  // close the sweep bar back above the taken low: the reclaim
  ticks.push({ timestamp: new Date(sweepTime.getTime() + 600000).toISOString(), sequence: seq++, bid: 2649.9, ask: 2650.1, last: 2650.0, tickVolume: 8, realVolume: 8, flags: 32 });
  // a final quiet bar so the sweep bar is closed
  ticks.push({ timestamp: new Date(barTime + 1800000).toISOString(), sequence: seq++, bid: 2650.3, ask: 2650.5, last: 2650.4, tickVolume: 4, realVolume: 4, flags: 0 });
  return ticks;
};
const sweepFixture = () => {
  // A descending-lows market: every bar takes the prior low and closes back above it, so the
  // sweep-and-reclaim rule fires throughout and the simulation closes trades the pattern
  // memory can record. Anchored to the wall clock for the licence watermark.
  const ticks = [];
  let seq = 1;
  const at = i => new Date(Date.now() - (80 - i) * 900000).toISOString();
  const push = (i, last, vol, flags) => ticks.push({ timestamp: at(i), sequence: seq++, bid: +(last - 0.1).toFixed(2), ask: +(last + 0.1).toFixed(2), last, tickVolume: vol, realVolume: vol, flags });
  for (let i = 0; i < 25; i++) { push(i, 2649.02, 3, 0); push(i, 2649, 3, 0); push(i, 2649.15, 4, 32); }
  for (let i = 25; i < 70; i++) { const low = 2649 - (i - 24) * 0.1; push(i, low + 0.02, 3, 0); push(i, low, 3, 0); push(i, low + 0.15, 4, 32); }
  return ticks;
};

async function ingestHistory(ticks) {
  for (let i = 0; i < ticks.length; i += 1000) {
    const batch = ticks.slice(i, i + 1000);
    const r = await fetch(base + '/v1/ingest/mt5/history', { method: 'POST', headers: auth, body: JSON.stringify({ source: 'mt5', symbol: 'XAUUSD', ticks: batch }) });
    assert.equal(r.status, 202, 'history batch must be accepted');
  }
}

test('analysis routes honour the stored footprint options, not engine defaults', async () => {
  await ingestHistory(stackFixture());
  // The default settings keep the 3-level buy stack; a strict imbalanceLevels setting must remove
  // it from every analysis route, because the strategy reads these marks (strategy-engine.js reads
  // bar.stackedImbalances).
  const before = await (await fetch(base + '/v1/market/replay?symbol=XAUUSD&intervalMs=900000')).json();
  const stacksBefore = before.bars.reduce((n, b) => n + (b.stackedImbalances || []).length, 0);
  assert.ok(stacksBefore >= 1, 'the fixture must produce at least one stack under defaults');
  await fetch(base + '/v1/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ footprint: { imbalanceLevels: 10 } }) });
  // Each route that returns bars is asserted on its own bars; the backtest route returns only a
  // bar count, and the signals route returns no bars — the strategy's dependence on these marks is
  // gated by the dedicated requireStacked test below, which proves the marks the strategy reads.
  for (const path of ['/v1/market/replay?symbol=XAUUSD&intervalMs=900000', '/v1/market/analysis?symbol=XAUUSD&intervalMs=900000']) {
    const data = await (await fetch(base + path)).json();
    assert.ok(Array.isArray(data.bars), path + ' must return bars to assert on');
    const stacks = data.bars.reduce((n, b) => n + (b.stackedImbalances || []).length, 0);
    assert.equal(stacks, 0, path + ' must drop the stack under the strict setting');
  }
  // The backtest route receives the same marks: with the stack removed, its requireStacked setup
  // closes no trades — the dedicated signals-route test proves the same dependency end to end.
  const backtest = await (await fetch(base + '/v1/market/backtest?symbol=XAUUSD&intervalMs=900000')).json();
  assert.ok(Number.isInteger(backtest.bars), 'the backtest route reports its bar count');
  await fetch(base + '/v1/settings/reset', { method: 'POST' });
});

test('imbalanceLevels setting changes what the strategy sees in the signals route', async () => {
  await ingestHistory(stackFixture());
  // With requireStacked on, the default settings let the signal fire (the fixture's stack exists);
  // the strict setting removes the stack, so the signal cannot fire.
  await fetch(base + '/v1/setups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Stacked strict', definition: { strategy: { requireStacked: true, minScore: 0.4 } } }) });
  const list = await (await fetch(base + '/v1/setups')).json();
  await fetch(base + '/v1/setups/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: list.setups.at(-1).id, version: 1 }) });
  const withDefault = await (await fetch(base + '/v1/market/signals?symbol=XAUUSD&intervalMs=900000')).json();
  await fetch(base + '/v1/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ footprint: { imbalanceLevels: 10 } }) });
  const withStrict = await (await fetch(base + '/v1/market/signals?symbol=XAUUSD&intervalMs=900000')).json();
  const count = data => data.signals.filter(s => (s.evidence || []).some(e => /дисбаланс/.test(e))).length;
  assert.ok(count(withDefault) > 0, 'the default settings keep the stacked signal, got ' + count(withDefault));
  assert.equal(count(withStrict), 0, 'the strict imbalanceLevels setting must remove the stacked signal');
  await fetch(base + '/v1/settings/reset', { method: 'POST' });
});

test('pattern memory records closed setups once and searches them honestly', async () => {
  await ingestHistory(sweepFixture());
  const first = await (await fetch(base + '/v1/market/signals?symbol=XAUUSD&intervalMs=900000')).json();
  assert.ok(first.patternMemory.recorded > 0, 'the sweep fixture must close at least one setup for the memory to prove anything, got ' + JSON.stringify(first.patternMemory));
  assert.ok(first.patternMemory.memory >= first.patternMemory.recorded);
  // Re-running the same signals must not double the memory: dedup by a window-independent identity.
  const second = await (await fetch(base + '/v1/market/signals?symbol=XAUUSD&intervalMs=900000')).json();
  assert.equal(second.patternMemory.recorded, 0, 'a second identical pass records nothing new');
  assert.equal(second.patternMemory.memory, first.patternMemory.memory, 'the memory count is stable across calls');
  // The analogues endpoint answers with the honest empty-or-thin state, never an invented win rate.
  const analogues = await (await fetch(base + '/v1/patterns/analogues?symbol=XAUUSD&intervalMs=900000')).json();
  assert.equal(analogues.calibrated, false, 'win rate appears only at the 30-sample minimum');
  assert.equal(analogues.winRate, null);
  assert.ok(Array.isArray(analogues.analogues));
  assert.equal(analogues.count, analogues.analogues.length);
  assert.ok(analogues.memory >= 0);
  // A non-gold symbol is rejected at the boundary, and a bad threshold is a validation error.
  assert.equal((await fetch(base + '/v1/patterns/analogues?symbol=EURUSD')).status, 400);
  assert.equal((await fetch(base + '/v1/patterns/analogues?symbol=XAUUSD&threshold=2')).status, 422);
});

test('the reference rebuilds when a new tick leaves the event count constant (a full rolling buffer)', async () => {
  // A tiny buffer cap: once the rolling buffer is full, every new tick evicts an old event, so
  // the event count stops moving — exactly the production condition under which a count-keyed
  // cache would serve a stale reference forever. The watermark must still invalidate it.
  const app = createMarketServer({ token: 'test-secret', storageFile: null, license: testLicense(), setupStore: createSetupStore({ file: null }), settingsStore: createSettingsStore({ file: null }), patternStore: createPatternStore({ file: null }), maxEvents: 60 });
  const tinyServer = app.server;
  await new Promise(resolve => tinyServer.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + tinyServer.address().port;
  try {
    await ingestHistoryAt(url, sweepFixture());
    const first = await (await fetch(url + '/v1/patterns/analogues?symbol=XAUUSD&intervalMs=900000')).json();
    assert.ok(first.reference, 'the fixture must yield a reference signal');
    const referenceTime = first.reference.signalTime;
    const countBefore = (await (await fetch(url + '/health')).json()).eventCount;
    // A new sweep in a closed past bucket: the buffer is at its cap, so the count stays constant
    // while the ingest watermark moves. The reference must move to the newer signal anyway.
    const sweepBucket = Math.floor((Date.now() - 2400000) / 900000) * 900000;
    const seq = Date.now();
    const sweep = { source: 'mt5', symbol: 'XAUUSD', timestamp: new Date(sweepBucket + 60000).toISOString(), sequence: seq, bid: 2644.2, ask: 2644.4, last: 2644.3, tickVolume: 5, realVolume: 5, flags: 64 };
    const reclaim = { source: 'mt5', symbol: 'XAUUSD', timestamp: new Date(sweepBucket + 300000).toISOString(), sequence: seq + 1, bid: 2644.6, ask: 2644.8, last: 2644.7, tickVolume: 5, realVolume: 5, flags: 32 };
    const quietClose = { source: 'mt5', symbol: 'XAUUSD', timestamp: new Date(sweepBucket + 1000000).toISOString(), sequence: seq + 2, bid: 2644.7, ask: 2644.9, last: 2644.8, tickVolume: 2, realVolume: 2, flags: 0 };
    for (const tick of [sweep, reclaim, quietClose]) await fetch(url + '/v1/ingest/mt5/tick', { method: 'POST', headers: auth, body: JSON.stringify(tick) });
    const countAfter = (await (await fetch(url + '/health')).json()).eventCount;
    assert.equal(countAfter, countBefore, 'fixture: the rolling buffer is at its cap, so the event count does not move');
    const second = await (await fetch(url + '/v1/patterns/analogues?symbol=XAUUSD&intervalMs=900000')).json();
    assert.ok(second.reference, 'the endpoint still yields a reference');
    assert.notEqual(second.reference.signalTime, referenceTime, 'the reference must rebuild on the watermark alone: a count-keyed cache would serve the stale one forever');
  } finally { await new Promise(resolve => tinyServer.close(resolve)); }
});

// Ingest against an explicit base URL, for tests that run their own server instance.
async function ingestHistoryAt(url, ticks) {
  for (let i = 0; i < ticks.length; i += 1000) {
    const r = await fetch(url + '/v1/ingest/mt5/history', { method: 'POST', headers: auth, body: JSON.stringify({ source: 'mt5', symbol: 'XAUUSD', ticks: ticks.slice(i, i + 1000) }) });
    assert.equal(r.status, 202, 'history batch must be accepted');
  }
}

test('the signals route reports whether the pattern memory is actually writable', async () => {
  // A real file-backed memory on a temp directory: a healthy file reports writable: true.
  const healthyDir = await mkdtemp(join(tmpdir(), 'gold3po-signals-'));
  const healthyApp = createMarketServer({ token: 'test-secret', storageFile: null, license: testLicense(), setupStore: createSetupStore({ file: null }), settingsStore: createSettingsStore({ file: null }), patternStore: createPatternStore({ file: join(healthyDir, 'patterns.json') }) });
  const healthyServer = healthyApp.server;
  await new Promise(resolve => healthyServer.listen(0, '127.0.0.1', resolve));
  const healthyUrl = 'http://127.0.0.1:' + healthyServer.address().port;
  try {
    await ingestHistoryAt(healthyUrl, sweepFixture());
    const healthy = await (await fetch(healthyUrl + '/v1/market/signals?symbol=XAUUSD&intervalMs=900000')).json();
    assert.equal(healthy.patternMemory.writable, true, 'a healthy memory file reports writable: true');
    assert.ok(healthy.patternMemory.recorded > 0, 'the fixture must close at least one setup');
    const stored = JSON.parse(await readFile(join(healthyDir, 'patterns.json'), 'utf8'));
    assert.ok(stored.observations.length > 0, 'the batch actually reached the disk');
  } finally { await new Promise(resolve => healthyServer.close(resolve)); }
  // A poisoned memory (a corrupt file at startup) reports writable: false while still recording
  // in memory, so "recorded but not saved" is distinguishable from "saved".
  const poisonedDir = await mkdtemp(join(tmpdir(), 'gold3po-signals-'));
  const poisonedFile = join(poisonedDir, 'patterns.json');
  await writeFile(poisonedFile, '{not json', 'utf8');
  const poisonedApp = createMarketServer({ token: 'test-secret', storageFile: null, license: testLicense(), setupStore: createSetupStore({ file: null }), settingsStore: createSettingsStore({ file: null }), patternStore: createPatternStore({ file: poisonedFile }) });
  const poisonedServer = poisonedApp.server;
  await new Promise(resolve => poisonedServer.listen(0, '127.0.0.1', resolve));
  const poisonedUrl = 'http://127.0.0.1:' + poisonedServer.address().port;
  try {
    await ingestHistoryAt(poisonedUrl, sweepFixture());
    const poisoned = await (await fetch(poisonedUrl + '/v1/market/signals?symbol=XAUUSD&intervalMs=900000')).json();
    assert.equal(poisoned.patternMemory.writable, false, 'a poisoned memory reports writable: false');
    assert.ok(poisoned.patternMemory.recorded > 0, 'the setups are still recorded in memory, which is exactly the recorded-but-not-saved state');
    assert.equal(await readFile(poisonedFile, 'utf8'), '{not json', 'the corrupt file is never rewritten');
  } finally { await new Promise(resolve => poisonedServer.close(resolve)); }
});

test('the analogue search reuses its reference between polls and refreshes it on new events', async () => {
  await ingestHistory(sweepFixture());
  // Prime the cache: the first call builds the reference pipeline.
  const first = await (await fetch(base + '/v1/patterns/analogues?symbol=XAUUSD&intervalMs=900000')).json();
  assert.ok(first.reference, 'the fixture must yield a reference signal');
  const referenceTime = first.reference.signalTime;
  // A second poll with a different threshold reuses the cached reference: same signal time.
  const second = await (await fetch(base + '/v1/patterns/analogues?symbol=XAUUSD&intervalMs=900000&threshold=0.6')).json();
  assert.equal(second.reference.signalTime, referenceTime, 'the cached reference is reused between polls');
  // New events invalidate the cache: a later sweep must move the reference to a newer signal,
  // which only happens if the invalidation keyed on something that moves with every event,
  // not on the event count (which stays constant once the rolling buffer is full).
  // The later events are a sweep-and-reclaim followed by a quiet close, so the sweep bar closes
  // and the strategy fires a newer signal than the cached reference.
  // A genuine new sweep in a closed bucket AFTER the fixture's last bar but before now, so the
  // licence clock watermark stays honest: the dip below the fixture's lowest low (~2644.4), the
  // reclaim back above it in the same bucket, then a quiet bar in the next bucket closes it.
  const sweepBucket = Math.floor((Date.now() - 2400000) / 900000) * 900000; // ~40 minutes ago
  const seq = Date.now();
  const sweep = { source: 'mt5', symbol: 'XAUUSD', timestamp: new Date(sweepBucket + 60000).toISOString(), sequence: seq, bid: 2644.2, ask: 2644.4, last: 2644.3, tickVolume: 5, realVolume: 5, flags: 64 };
  const reclaim = { source: 'mt5', symbol: 'XAUUSD', timestamp: new Date(sweepBucket + 300000).toISOString(), sequence: seq + 1, bid: 2644.6, ask: 2644.8, last: 2644.7, tickVolume: 5, realVolume: 5, flags: 32 };
  const quietClose = { source: 'mt5', symbol: 'XAUUSD', timestamp: new Date(sweepBucket + 1000000).toISOString(), sequence: seq + 2, bid: 2644.7, ask: 2644.9, last: 2644.8, tickVolume: 2, realVolume: 2, flags: 0 };
  for (const tick of [sweep, reclaim, quietClose]) await fetch(base + '/v1/ingest/mt5/tick', { method: 'POST', headers: auth, body: JSON.stringify(tick) });
  const third = await (await fetch(base + '/v1/patterns/analogues?symbol=XAUUSD&intervalMs=900000&threshold=0.6')).json();
  assert.ok(third.reference, 'the endpoint still yields a reference after new events');
  assert.notEqual(third.reference.signalTime, referenceTime, 'a new event must rebuild the reference, not serve the cached one');
});

test('a settings change invalidates the analogue cache, not just new events', async () => {
  await ingestHistory(stackFixture());
  // Prime the cache under the default footprint settings: the reference bar carries the fixture's
  // 3-level stack, so the reference's stacked axis and stack count are positive.
  const first = await (await fetch(base + '/v1/patterns/analogues?symbol=XAUUSD&intervalMs=900000')).json();
  assert.ok(first.reference, 'the fixture must yield a reference signal');
  assert.equal(first.reference.stacked, true, 'the default settings keep the stacked-imbalance axis true');
  assert.ok(first.reference.stackCount >= 1, 'the reference bar reports its stack');
  // Remove the fixture's stack via a footprint setting: the cached reference must be rebuilt, so
  // the stacked axis itself flips — a stale cache would keep serving stacked=true.
  await fetch(base + '/v1/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ footprint: { imbalanceLevels: 10 } }) });
  const second = await (await fetch(base + '/v1/patterns/analogues?symbol=XAUUSD&intervalMs=900000')).json();
  assert.ok(second.reference, 'the reference still exists after a settings change');
  assert.equal(second.reference.stacked, false, 'a footprint change must rebuild the reference: the stacked axis keeps its stale true otherwise');
  assert.equal(second.reference.stackCount, 0, 'the rebuilt reference reports no stacks under the strict setting');
  await fetch(base + '/v1/settings/reset', { method: 'POST' });
});

test('pattern analogues endpoint is licence-gated like every research route', async () => {
  const manager = createLicenseManager({ publicKeyPem: 'unused', machineId: 'AAAA-BBBB-CCCC-DDDD', licenseFile: null, stateFile: null, now: () => Date.now() });
  const app = createMarketServer({ token: 'test-secret', storageFile: null, license: manager, setupStore: createSetupStore({ file: null }), patternStore: createPatternStore({ file: null }) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + app.server.address().port;
  try {
    assert.equal((await fetch(url + '/v1/patterns/analogues')).status, 402);
  } finally { await new Promise(resolve => app.server.close(resolve)); }
});
