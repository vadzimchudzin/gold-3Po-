import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketAnalysis, normalizeTick, detectLiquidityZones, validateZoneOptions, DEFAULT_ZONE_OPTIONS } from './market-engine.js';

const tick=(timestamp,last,aggressorSide='unknown',sequence=1)=>({timestamp,bid:last-0.1,ask:last+0.1,last,tickVolume:99,realVolume:5,aggressorSide,sequence,source:'mt5',symbol:'XAUUSD'});
test('normalizer does not mistake repeated OTC quote volume for executed volume',()=>{
  const t=normalizeTick(tick('2026-11-17T10:01:00.000Z',2650));
  assert.equal(t.volume,1);
  assert.equal(t.direction,'unknown');
});
test('explicit aggressor trades aggregate into one candle and price ladder',()=>{
  const out=buildMarketAnalysis([
    tick('2026-11-17T10:01:00.000Z',2650,'buy'),
    tick('2026-11-17T10:02:00.000Z',2650,'buy'),
    tick('2026-11-17T10:03:00.000Z',2649.9,'sell')
  ]);
  assert.equal(out.bars.length,1);
  assert.equal(out.bars[0].tickCount,3);
  assert.equal(out.bars[0].ask,10);
  assert.equal(out.bars[0].bid,5);
  assert.equal(out.bars[0].delta,5);
  assert.equal(out.bars[0].levels.length,2);
});
test('unclassified OTC ticks remain unknown rather than fabricated bid/ask volume',()=>{
  const out=buildMarketAnalysis([tick('2026-11-17T10:01:00.000Z',2650),tick('2026-11-17T10:02:00.000Z',2650.2)]);
  assert.equal(out.bars[0].bid,0);
  assert.equal(out.bars[0].ask,0);
  assert.equal(out.bars[0].unknown,2);
  assert.equal(out.sideClassification,'explicit_mt5_tick_flags; otherwise_price_against_quote');
});
test('timeframe aggregation separates bars and orders ticks chronologically',()=>{
  const out=buildMarketAnalysis([
    tick('2026-11-17T10:16:00.000Z',2651),
    tick('2026-11-17T10:01:00.000Z',2649)
  ],{intervalMs:15*60_000});
  assert.equal(out.bars.length,2);
  assert.equal(out.bars[0].o,2649);
  assert.equal(out.bars[1].c,2651);
  assert.equal(out.intervalMs,15*60_000);
  assert.equal(out.timeframeMinutes,15);
  const five=buildMarketAnalysis([tick('2026-11-17T10:01:00.000Z',2649),tick('2026-11-17T10:10:00.000Z',2651)],{intervalMs:5*60_000});
  const fifteen=buildMarketAnalysis([tick('2026-11-17T10:01:00.000Z',2649),tick('2026-11-17T10:10:00.000Z',2651)],{intervalMs:15*60_000});
  assert.equal(five.timeframeMinutes,5);
  assert.equal(five.bars.length,2,'5m groups should split ticks at 10:10 into a new bar');
  assert.equal(fifteen.bars.length,1,'15m groups should keep both ticks in the 10:00 bar');
});
test('analysis metadata and aggregation use the selected timeframe', () => {
  const ticks = [
    tick('2026-11-17T10:01:00.000Z', 2649),
    tick('2026-11-17T10:10:00.000Z', 2651)
  ];
  const five = buildMarketAnalysis(ticks, { intervalMs: 5 * 60_000 });
  const fifteen = buildMarketAnalysis(ticks, { intervalMs: 15 * 60_000 });
  assert.equal(five.intervalMs, 5 * 60_000);
  assert.equal(five.timeframeMinutes, 5);
  assert.equal(five.bars.length, 2);
  assert.equal(fifteen.timeframeMinutes, 15);
  assert.equal(fifteen.bars.length, 1);
});
test('analysis validates its inputs',()=>{
 assert.throws(()=>buildMarketAnalysis([], {priceStep:0}),/Invalid analysis input/);
 assert.throws(()=>buildMarketAnalysis([], {footprintStep:0}),/Invalid analysis input/);
});

test('a finer footprint grid changes footprint rows only, not exhaustion or zones',()=>{
 // A one-sided bar 0.4 wide: within 5 x 0.1 it is exhaustion; that must not depend on the broker tick.
 const events=[];let seq=1;
 for(let i=0;i<5;i++)events.push({source:'mt5',symbol:'XAUUSD',timestamp:new Date(Date.UTC(2026,0,5,10,1,i)).toISOString(),sequence:seq++,bid:2648+i*0.1-0.05,ask:2648+i*0.1+0.05,last:+(2648+i*0.1).toFixed(2),tickVolume:3,realVolume:0,flags:32,aggressorSide:'buy'});
 const coarse=buildMarketAnalysis(events);
 const fine=buildMarketAnalysis(events,{footprintStep:0.01});
 assert.equal(coarse.bars[0].exhaustion,true,'the fixture is an exhaustion bar on the 0.1 analysis grid');
 assert.equal(fine.bars[0].exhaustion,true,'a 0.01 broker tick must not switch exhaustion off');
 assert.deepEqual(fine.zones,coarse.zones,'zone geometry follows the analysis grid');
 // The rows really move to the finer grid: an off-0.1 trade keeps its own row instead of rounding.
 const offGrid=[...events,{...events[4],sequence:seq++,timestamp:new Date(Date.UTC(2026,0,5,10,1,6)).toISOString(),last:2648.43,bid:2648.38,ask:2648.48}];
 assert.ok(buildMarketAnalysis(offGrid,{footprintStep:0.01}).bars[0].levels.some(row=>Math.abs(row.price-2648.43)<1e-6),'the 0.01 footprint grid keeps 2648.43 as its own row');
 assert.ok(!buildMarketAnalysis(offGrid).bars[0].levels.some(row=>Math.abs(row.price-2648.43)<1e-6),'the default grid rounds it to 0.1');
});

test('the session profile follows the footprint options, including the row size',()=>{
 const events=[];let seq=1;
 for(let i=0;i<120;i++){const p=2648+(i%23)*0.1;const n=i%7===0?9:1;for(let k=0;k<n;k++)events.push({source:'mt5',symbol:'XAUUSD',timestamp:new Date(Date.UTC(2026,0,5,10,i,k)).toISOString(),sequence:seq++,bid:+(p-0.1).toFixed(2),ask:+(p+0.1).toFixed(2),last:+p.toFixed(2),tickVolume:1,realVolume:0});}
 const fine=buildMarketAnalysis(events,{footprintOptions:{ticksPerRow:1}});
 const coarse=buildMarketAnalysis(events,{footprintOptions:{ticksPerRow:5}});
 const onHalfGrid=price=>Math.abs(price*2-Math.round(price*2))<1e-6;
 assert.ok(fine.profile.current.levels.some(row=>!onHalfGrid(row.price)),'the fixture trades between half points at source precision');
 assert.ok(coarse.profile.current.levels.every(row=>onHalfGrid(row.price)),'the profile rows sit on the same 0.5 grid as the grouped ladder');
 const narrow=buildMarketAnalysis(events,{footprintOptions:{valueAreaShare:0.5}}).profile.current.valueArea;
 const wide=buildMarketAnalysis(events,{footprintOptions:{valueAreaShare:0.95}}).profile.current.valueArea;
 assert.ok(narrow.share>=0.5&&narrow.share<0.7,'a 50% setting covers at least half the volume and stops short of the 70% default, got '+narrow.share);
 assert.ok(wide.share>=0.95,'a 95% setting covers at least 95% of the volume, got '+wide.share);
 assert.ok(wide.rows>narrow.rows,'the wider share spans more rows: '+narrow.rows+' at 50% vs '+wide.rows+' at 95%');
});

test('analysis calculates cumulative delta and leaves absorption unavailable without aggressor data',()=>{
 const out=buildMarketAnalysis([
  tick('2026-11-17T10:01:00.000Z',2650,'buy'),
  tick('2026-11-17T10:02:00.000Z',2650,'sell'),
  tick('2026-11-17T10:03:00.000Z',2650,'buy')
 ]);
 assert.equal(out.bars[0].cumulativeDelta,5);
 assert.equal(out.bars[0].absorption,false);
 assert.ok(Array.isArray(out.bars[0].stackedImbalances));
 assert.ok(Array.isArray(out.bars[0].sweeps));
});

test('liquidity detector groups repeated swing highs into buy-side pools',()=>{
 const highs=[9,10,12,10,9,10,12.1,10,9,10],bars=highs.map((h,i)=>({h,l:h-2,o:h-1,c:h-1}));
 const zones=detectLiquidityZones(bars,0.1);
 assert.ok(zones.some(z=>z.side==='buy'));
 assert.ok(zones.some(z=>z.side==='buy'&&z.high>12&&z.low<12.1));
 assert.ok(zones.every(z=>/^LQ-(buy|sell)-\d+\.\d{2}$/.test(z.id)),'zone ids must be price-stable');
});

test('liquidity detector ignores flat bars and the forming candle',()=>{
 const flat=Array.from({length:8},()=>({h:100,l:100,o:100,c:100}));
 assert.deepEqual(detectLiquidityZones(flat,0.1),[]);
 // A swing high confirmed only by the newest (forming) bar must not create a zone yet.
 const highs=[9,10,12,10,9,10,12.1,10,9],bars=highs.map(h=>({h,l:h-2,o:h-1,c:h-1}));
 const zones=detectLiquidityZones(bars,0.1);
 assert.ok(!zones.some(z=>z.side==='buy'&&z.touches>=2),'forming bar must not confirm the 12.1 pivot into a repeated-highs pool');
});

test('liquidity detector drops zones broken by a close through the far edge',()=>{
 const mk=h=>({h,l:h-2,o:h-1,c:h-1});
 const base=[9,10,12,10,9,10,12.1,10,9,10].map(mk);
 assert.ok(detectLiquidityZones(base,0.1).some(z=>z.side==='buy'));
 const broken=[...base,{h:13,l:11,o:11.5,c:12.8},{h:13.2,l:12.5,o:12.8,c:13}];
 assert.ok(!detectLiquidityZones(broken,0.1).some(z=>z.side==='buy'&&z.high<12.5),'close above the zone must consume it');
});

test('maxZones caps the number of displayed zones',()=>{
 const highs=[9,10,12,10,9,10,12.1,10,9,10,14,12,11,12,14.1,12,11,12];
 const bars=highs.map(h=>({h,l:h-2,o:h-1,c:h-1}));
 const all=detectLiquidityZones(bars,0.1,20);
 const capped=detectLiquidityZones(bars,0.1,1);
 assert.ok(all.length>=2,'fixture should produce several zones');
 assert.equal(capped.length,1);
 assert.equal(capped[0].id,all[0].id,'cap must keep the strongest zone');
 assert.deepEqual(detectLiquidityZones(bars,0.1,99),detectLiquidityZones(bars,0.1,8),'invalid cap falls back to 8');
});

test('licensed COMEX trades contribute reported exchange size and aggressor side',()=>{
 const out=buildMarketAnalysis([
  {type:'trade',source:'comex',symbol:'GCZ6',timestamp:'2026-11-17T10:01:00.000Z',price:2650,size:4,aggressorSide:'buy'},
  {type:'trade',source:'comex',symbol:'GCZ6',timestamp:'2026-11-17T10:02:00.000Z',price:2650,size:2,aggressorSide:'sell'}
 ]);
 assert.equal(out.bars[0].ask,4);
 assert.equal(out.bars[0].bid,2);
 assert.equal(out.bars[0].volume,6);
 assert.equal(out.volumeKind,'exchange_trade_size');
 assert.equal(out.sideClassification,'licensed_vendor_aggressor_side; unknown_when_unavailable');
});

// Deterministic gold-like 15m series: ~$2650, ATR a few dollars, ranging swings plus noise.
function goldBars(n=240,scale=1,seed=7){
 let x=seed;const rnd=()=>((x=(x*1103515245+12345)%2147483648)/2147483648);
 const out=[];let p=2650;
 for(let i=0;i<n;i++){const o=p;p+=Math.sin(i/9)*2.2+Math.sin(i/31)*1.4+(rnd()-.5)*3;const c=p;const h=Math.max(o,c)+rnd()*1.8,l=Math.min(o,c)-rnd()*1.8;
  out.push({time:new Date(Date.UTC(2026,0,1)+i*900000).toISOString(),o:o*scale,h:h*scale,l:l*scale,c:c*scale,volume:5+Math.round(rnd()*20)});}
 return out;
}

test('zone finder returns 3..7 ranked reaction zones on realistic gold data',()=>{
 const bars=goldBars(),last=bars.at(-1).c;
 const zones=detectLiquidityZones(bars,0.1);
 assert.ok(zones.length>=3&&zones.length<=7,`expected 3..7 zones, got ${zones.length}`);
 assert.ok(zones.some(z=>z.low>last)&&zones.some(z=>z.high<last),'there must be levels above and below price');
 for(let i=1;i<zones.length;i++)assert.ok(zones[i-1].strength>=zones[i].strength,'zones are ranked by strength');
 for(const z of zones){
  assert.ok(z.strength>=0.05&&z.strength<=0.98);assert.ok(z.high>z.low);
  assert.ok(z.distanceAtr<=DEFAULT_ZONE_OPTIONS.maxDistanceAtr);
  for(const v of Object.values(z.factors))assert.ok(v>=0&&v<=1,'every factor is normalised');
 }
 assert.equal(new Set(zones.map(z=>z.id)).size,zones.length,'ids are unique');
 // Zones never overlap each other: a level is drawn once.
 const sorted=[...zones].sort((a,b)=>a.low-b.low);
 for(let i=1;i<sorted.length;i++)assert.ok(sorted[i].low>=sorted[i-1].high-1e-9,'zones must not overlap');
});

test('zone count follows the min/max settings',()=>{
 const bars=goldBars();
 assert.ok(detectLiquidityZones(bars,0.1,{maxZones:3}).length<=3);
 assert.ok(detectLiquidityZones(bars,0.1,{minZones:5,maxZones:5}).length===5);
 // A straight trend has almost no swings: the finder still offers the range extreme / volume node.
 const trend=Array.from({length:40},(_,i)=>({o:2600+i*2,h:2601.5+i*2,l:2599.5+i*2,c:2601+i*2,volume:10}));
 const tz=detectLiquidityZones(trend,0.1,{minZones:3,maxZones:7});
 assert.ok(tz.length>=2,'fallback levels must appear on a one-way trend');
 assert.ok(tz.every(z=>z.high<trend.at(-1).c||z.low>trend.at(-1).c||z.state==='NEAR PRICE'));
});

test('zone geometry is volatility-relative (same zones at any price scale)',()=>{
 const a=detectLiquidityZones(goldBars(240,1),0.0001),b=detectLiquidityZones(goldBars(240,10),0.0001);
 assert.equal(a.length,b.length);
 a.forEach((z,i)=>{assert.ok(Math.abs(b[i].low/10-z.low)<1e-3*z.low);assert.equal(b[i].touches,z.touches);});
});

test('every zone carries measured reaction evidence, not only chart geometry', () => {
 const zones=detectLiquidityZones(goldBars(),0.1);
 assert.ok(zones.length>=3);
 for(const z of zones){
  assert.ok(z.reactions,'zone must expose measured reactions');
  for(const key of ['touches','respected','broken','neutral'])assert.ok(Number.isInteger(z.reactions[key]),key+' must be a count');
  assert.equal(z.reactions.touches,z.reactions.respected+z.reactions.broken+z.reactions.neutral);
  assert.ok(z.reactions.rate>=0&&z.reactions.rate<=1,'measured rate is a probability');
  assert.ok(z.factors.measured>=0&&z.factors.measured<=1,'measured factor stays normalised');
  assert.ok(Math.abs(z.factors.measured-z.reactions.rate)<=0.01,'the measured factor mirrors the measured rate');
 }
});

test('zone settings are validated',()=>{
 assert.deepEqual(validateZoneOptions({}),{...DEFAULT_ZONE_OPTIONS});
 assert.throws(()=>validateZoneOptions({maxZones:0}),/maxZones/);
 assert.throws(()=>validateZoneOptions({clusterAtr:9}),/clusterAtr/);
 assert.throws(()=>validateZoneOptions({pivotWidth:1.5}),/pivotWidth/);
 assert.equal(validateZoneOptions({minZones:9,maxZones:4}).minZones,4,'min never exceeds max');
 assert.throws(()=>validateZoneOptions({atrPeriod:1}),/atrPeriod/);
 assert.throws(()=>validateZoneOptions({reactionBars:200}),/reactionBars/);
 assert.throws(()=>validateZoneOptions({maxDistanceAtr:0}),/maxDistanceAtr/);
 assert.equal(validateZoneOptions({useSessions:false}).useSessions,false,'a source switched off survives validation');
 assert.throws(()=>validateZoneOptions({useVolume:5}),/useVolume must be a boolean/);
 assert.throws(()=>validateZoneOptions({useWeek:'нет'}),/useWeek must be a boolean/);
});

test('switching the volume source off removes its levels from the zones',()=>{
 const bars=[];
 let p=2650;
 for(let i=0;i<480;i++){const o=p;p+=Math.sin(i/7)*1.6+Math.sin(i/29)*1.1;const h=Math.max(o,p)+0.6,l=Math.min(o,p)-0.6;bars.push({time:new Date(Date.UTC(2026,0,5)+i*900000).toISOString(),o,h,l,c:p,volume:8+(i%7)});}
 const withVolume=detectLiquidityZones(bars,0.1,{minZones:3,maxZones:7});
 const withoutVolume=detectLiquidityZones(bars,0.1,{minZones:3,maxZones:7,useVolume:false});
 const volumeish=z=>/^(Volume|Value area)/.test(z.label)||z.sources.some(s=>/^(Volume|Value area)/.test(s));
 assert.ok(withVolume.some(volumeish),'with the source on, the profile labels its levels');
 assert.ok(!withoutVolume.some(volumeish),'with the source off, no volume level is drawn');
 assert.ok(withoutVolume.length>=3,'the other sources still fill the zone count');
});

test('a broken level flips sides once and is dropped when price chops through it',()=>{
 const mk=(h,c=h-1)=>({h,l:h-2,o:h-1,c});
 const base=[9,10,12,10,9,10,12.1,10,9,10].map(h=>mk(h));
 // Break up through the 12 highs and hold above: the level now sits below price as support.
 const flipped=[...base,{h:13,l:11.5,o:11.6,c:12.9},{h:13.4,l:12.6,o:12.9,c:13.2},{h:13.5,l:12.8,o:13.2,c:13.3},{h:13.6,l:12.9,o:13.3,c:13.4}];
 const f=detectLiquidityZones(flipped,0.1).find(z=>z.low<12.1&&z.high>12);
 assert.ok(f,'flipped level must be kept');assert.equal(f.side,'sell');assert.equal(f.state,'FLIPPED');
 // Then back down through it and up again: two more crosses = chop, the level is gone.
 const chop=[...flipped,{h:13.4,l:10.5,o:13.3,c:10.8},{h:11,l:10.2,o:10.8,c:10.5},{h:13.2,l:10.4,o:10.5,c:13},{h:13.4,l:12.7,o:13,c:13.2},{h:13.5,l:12.9,o:13.2,c:13.3}];
 assert.ok(!detectLiquidityZones(chop,0.1).some(z=>z.low<12.1&&z.high>12&&z.touches>=2),'a chopped level is not a reaction zone');
});

test('an empty side of price still gets one reference level',()=>{
 // Range, then a straight rally with no pullback: there are no swing lows left near price.
 const bars=[];let p=2600;
 for(let i=0;i<60;i++){const o=p;p=2600+Math.sin(i/3)*6;bars.push({o,h:Math.max(o,p)+1,l:Math.min(o,p)-1,c:p,volume:10});}
 for(let i=0;i<25;i++){const o=p;p+=3;bars.push({o,h:p+0.8,l:o-0.8,c:p,volume:10});}
 const last=bars.at(-1).c,zones=detectLiquidityZones(bars,0.1,{minZones:1,maxZones:7});
 assert.ok(zones.some(z=>z.high<last),'a level below price is offered');
 assert.ok(zones.some(z=>z.low>last),'a level above price is offered');
});

test('a print at the ask counts as buying when the broker ships no aggressor flag',()=>{
  const t=normalizeTick({timestamp:'2026-11-17T10:01:00.000Z',bid:2649.9,ask:2650.1,last:2650.1,tickVolume:2,source:'mt5',symbol:'XAUUSD'});
  assert.equal(t.direction,'buy');
});
test('a print at the bid counts as selling when the broker ships no aggressor flag',()=>{
  const t=normalizeTick({timestamp:'2026-11-17T10:01:00.000Z',bid:2649.9,ask:2650.1,last:2649.9,tickVolume:2,source:'mt5',symbol:'XAUUSD'});
  assert.equal(t.direction,'sell');
});
test('a print inside the spread stays unclassified instead of being guessed',()=>{
  const t=normalizeTick({timestamp:'2026-11-17T10:01:00.000Z',bid:2649.9,ask:2650.1,last:2650,tickVolume:2,source:'mt5',symbol:'XAUUSD'});
  assert.equal(t.direction,'unknown');
});
test('an explicit broker flag wins over the price rule',()=>{
  const t=normalizeTick({timestamp:'2026-11-17T10:01:00.000Z',bid:2649.9,ask:2650.1,last:2650.1,tickVolume:2,aggressorSide:'sell',source:'mt5',symbol:'XAUUSD'});
  assert.equal(t.direction,'sell');
});
test('inferred sides land in the footprint instead of the unknown bucket',()=>{
  const out=buildMarketAnalysis([
    {timestamp:'2026-11-17T10:01:00.000Z',bid:2650,ask:2650.2,last:2650.2,tickVolume:3,source:'mt5',symbol:'XAUUSD'},
    {timestamp:'2026-11-17T10:02:00.000Z',bid:2650,ask:2650.2,last:2650,tickVolume:5,source:'mt5',symbol:'XAUUSD'}
  ]);
  assert.equal(out.bars[0].unknown,0,'nothing is left without a side');
  assert.ok(out.bars[0].ask>0&&out.bars[0].bid>0,'both sides get volume');
  assert.ok(out.bars[0].delta<0,'more selling than buying');
});

test('a limited build ignores ticks that could only feed bars the limit drops', () => {
  const events = [];
  for (let i = 0; i < 40 * 20; i += 1) {
    const price = 3600 + Math.sin(i / 40) * 3;
    events.push({ source: 'mt5', symbol: 'XAUUSD', feedId: 'f'.repeat(32), timestamp: new Date(Date.parse('2026-11-20T00:00:00Z') + i * 60_000).toISOString(), bid: price - 0.1, ask: price + 0.1, last: price, volume: 1, seq: i });
  }
  const full = buildMarketAnalysis(events, { intervalMs: 60_000, priceStep: 0.1, limit: 12 });
  // The oldest 600 ticks can only produce bars the limit drops, so dropping them must change nothing.
  const trimmed = buildMarketAnalysis(events.slice(-240), { intervalMs: 60_000, priceStep: 0.1, limit: 12 });
  assert.deepEqual(trimmed.bars, full.bars);
  assert.deepEqual(trimmed.zones, full.zones);
});
