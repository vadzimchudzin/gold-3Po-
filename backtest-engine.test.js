import test from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest } from './backtest-engine.js';

function fixture(){
 const bars=Array.from({length:45},(_,i)=>({time:new Date(Date.UTC(2026,0,1,0,i*15)).toISOString(),o:100,h:100.6,l:99.4,c:100.1,bid:10,ask:10,unknown:0,delta:0,sweeps:[],stackedImbalances:[]}));
 bars[20]={...bars[20],o:100.1,h:100.5,l:99.0,c:100.4,sweeps:[{side:'sell-side',level:99.5,reclaimed:true}]};
 bars[21]={...bars[21],o:100.4,h:101.3,l:100.2,c:101.1};
 return bars;
}
test('backtest enters after signal close and returns trades with conservative metrics',()=>{
 const result=runBacktest(fixture(),{targetR:1,stopAtr:1,initialEquity:10000,riskPct:.5});
 assert.ok(result.trades.length>=1);
 const trade=result.trades[0];
 assert.equal(trade.entryIndex,trade.signalIndex+1);
 assert.ok(trade.exitIndex>=trade.entryIndex);
 assert.ok(Number.isFinite(result.summary.finalEquity));
 assert.ok(Number.isFinite(result.summary.maxDrawdownPct));
 assert.ok(result.limitations.some(item=>item.includes('стоп и цель')));
});
test('the report carries the costs, averages and period the specification asks for',()=>{
 const bars=fixture();
 const result=runBacktest(bars,{targetR:1,stopAtr:1,slippage:0.05,feePerUnit:0.1,pointValue:1});
 const s=result.summary;
 assert.ok(s.trades>=1);
 assert.equal(s.bars,bars.length);
 assert.equal(s.periodStart,bars[0].time);
 assert.equal(s.periodEnd,bars.at(-1).time);
 const fees=result.trades.reduce((sum,t)=>sum+t.fees,0);
 assert.ok(Math.abs(s.totalFees-fees)<1e-9,'total fees must add up the per-trade fees');
 const slip=result.trades.reduce((sum,t)=>sum+2*0.05*t.quantity,0);
 assert.ok(Math.abs(s.slippageCost-slip)<1e-9,'slippage is charged on entry and exit');
 const wins=result.trades.filter(t=>t.netPnl>0),losses=result.trades.filter(t=>t.netPnl<0);
 assert.equal(s.avgWin,wins.length?wins.reduce((a,t)=>a+t.netPnl,0)/wins.length:null);
 assert.equal(s.avgLoss,losses.length?losses.reduce((a,t)=>a+t.netPnl,0)/losses.length:null);
});
test('backtest rejects risk settings above configured cap',()=>{
 assert.throws(()=>runBacktest(fixture(),{riskPct:2,maxRiskPct:1}),/Invalid backtest configuration/);
});

test('breakevenR moves the stop to entry once price reaches the configured R multiple', () => {
  const bars = [
    { time: '2026-11-20T08:00:00Z', o: 100, h: 102, l: 98, c: 101, bid: 10, ask: 30, unknown: 0, delta: 20, sweeps: [{ side: 'sell-side', level: 98 }] },
    // Entry at 101, atr = 4, stopAtr = 1 -> stopDistance = 4 -> initial stop = 97, target (3R) = 113.
    // Bar 1 rallies to 106 (+1.25R >= breakevenR=1) -> stop moves to entry (101) at bar close.
    { time: '2026-11-20T08:15:00Z', o: 101, h: 106, l: 100, c: 105 },
    // Bar 2 drops to 99: hits the breakeven stop at 101 instead of losing -1R at 97.
    { time: '2026-11-20T08:30:00Z', o: 105, h: 105, l: 99, c: 100 }
  ];
  const res = runBacktest(bars, { atrPeriod: 1, stopAtr: 1, targetR: 3, breakevenR: 1, minScore: 0.5 });
  assert.equal(res.trades.length, 1);
  assert.equal(res.trades[0].exitReason, 'stop');
  assert.equal(res.trades[0].exit, 101);
  assert.equal(res.trades[0].netR, 0);
});
