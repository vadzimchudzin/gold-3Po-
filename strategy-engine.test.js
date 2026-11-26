import test from 'node:test';
import assert from 'node:assert/strict';
import { averageTrueRange, generateSignals } from './strategy-engine.js';

const bars = Array.from({length:40},(_,i)=>({
  time:new Date(Date.UTC(2026,0,1,0,i*15)).toISOString(),o:100+i*.02,h:100.5+i*.02,l:99.5+i*.02,c:100.1+i*.02,
  bid:20,ask:20,unknown:0,delta:0,sweeps:[],stackedImbalances:[]
}));
bars[20]={...bars[20],o:100.2,h:100.6,l:99.4,c:100.55, sweeps:[{side:'sell-side',level:99.5,reclaimed:true}],stackedImbalances:[{side:'buy',prices:[100,100.1,100.2]}],ask:30,bid:10,unknown:0,delta:20};

test('ATR is computed only from bars available at the requested index',()=>{
  assert.ok(averageTrueRange(bars,20,14)>0);
  assert.equal(averageTrueRange(bars,100,14),null);
});
test('liquidity sweep creates a scored long signal with explicit evidence',()=>{
  const signals=generateSignals(bars);
  assert.equal(signals.length,1);
  assert.equal(signals[0].side,'long');
  assert.ok(signals[0].technicalScore>=0.55);
  assert.ok(signals[0].evidence.includes('Снятие ликвидности и возврат'));
  assert.equal(signals[0].probability,null);
});
test('extended strategy conditions support imbalance/absorption triggers, candle geometry, trend and cooldown', () => {
  const base = Date.parse('2026-11-20T08:00:00Z');
  const bars = Array.from({ length: 25 }, (_, i) => ({
    time: new Date(base + i * 900_000).toISOString(),
    o: 3600 + i * 0.5, h: 3601 + i * 0.5, l: 3599.5 + i * 0.5, c: 3600.4 + i * 0.5,
    bid: 20, ask: 35, unknown: 0, delta: 15, volume: 55
  }));
  // Bar 22: bullish stacked imbalance + long lower rejection wick + uptrend
  bars[22] = {
    time: new Date(base + 22 * 900_000).toISOString(),
    o: 3612, h: 3613.5, l: 3608, c: 3613.2,
    bid: 10, ask: 60, unknown: 0, delta: 50, volume: 70,
    stackedImbalances: [{ side: 'buy', prices: [3611.5, 3611.6, 3611.7] }],
    absorbedLevels: [{ price: 3608.2, multiple: 3 }]
  };
  bars[23] = { ...bars[22], time: new Date(base + 23 * 900_000).toISOString() };
  // Imbalance trigger + with-trend + wick ratio + cooldown
  const sigs = generateSignals(bars, {
    entryMode: 'imbalance', trendFilter: 'with', trendPeriod: 10,
    minWickRatio: 0.4, minDeltaRatio: 0.5, cooldownBars: 3, minScore: 0.5
  });
  assert.equal(sigs.length, 1, 'cooldown must suppress the adjacent bar 23');
  assert.equal(sigs[0].index, 22);
  assert.equal(sigs[0].side, 'long');
  // Counter-trend filter must reject the uptrend long
  const counter = generateSignals(bars, { entryMode: 'imbalance', trendFilter: 'counter', trendPeriod: 10, minScore: 0.5 });
  assert.equal(counter.length, 0);
  // Absorption trigger works without sweeps
  const abs = generateSignals(bars, { entryMode: 'absorption', requireAbsorption: true, minScore: 0.5 });
  assert.ok(abs.length >= 1 && abs[0].side === 'long');
});
