const finite = Number.isFinite;

export function averageTrueRange(bars, index, period = 14) {
  if (!Array.isArray(bars) || !Number.isInteger(index) || index < 0 || index >= bars.length || !Number.isInteger(period) || period < 1) return null;
  const start = Math.max(0, index - period + 1);
  const ranges = [];
  for (let i = start; i <= index; i++) {
    const bar = bars[i];
    if (![bar.h, bar.l, bar.c].every(finite)) return null;
    const previousClose = i > 0 ? bars[i - 1].c : bar.c;
    ranges.push(Math.max(bar.h - bar.l, Math.abs(bar.h - previousClose), Math.abs(bar.l - previousClose)));
  }
  return ranges.length ? ranges.reduce((sum, value) => sum + value, 0) / ranges.length : null;
}

export const ENTRY_MODES = ['sweep', 'imbalance', 'absorption', 'any'];
export const TREND_FILTERS = ['none', 'with', 'counter'];

export const DEFAULT_STRATEGY_CONDITIONS = {
  minScore: 0.55,
  atrPeriod: 14,
  requireRejection: false,
  requireCloseEdge: false,
  requireStacked: false,
  requireDeltaAgree: false,
  allowedSides: ['long', 'short'],
  sessionHoursUTC: null,
  minAtr: 0,
  maxZones: 8,
  // Extended strategy customizer: lets traders combine order-flow triggers, candle geometry,
  // trend alignment, volatility caps, cooldown and custom factor weights.
  entryMode: 'sweep',
  closeEdgeThreshold: 0.65,
  minBodyRatio: 0,
  maxBodyRatio: 1,
  minWickRatio: 0,
  minVolume: 0,
  minDeltaRatio: 0,
  maxAtr: 0,
  requireAbsorption: false,
  requireExhaustion: false,
  requireUnfinished: false,
  trendFilter: 'none',
  trendPeriod: 20,
  cooldownBars: 0,
  weightRejection: 0.15,
  weightCloseEdge: 0.10,
  weightStacked: 0.15,
  weightDelta: 0.10
};

export function validateStrategyConditions(input = {}) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError('Strategy conditions must be an object');
  const allowed = Object.keys(DEFAULT_STRATEGY_CONDITIONS);
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new TypeError(`Unknown strategy condition: ${key}`);
  const c = { ...DEFAULT_STRATEGY_CONDITIONS, ...input };
  if (!finite(c.minScore) || c.minScore < 0 || c.minScore > 1) throw new TypeError('minScore must be between 0 and 1');
  if (!Number.isInteger(c.atrPeriod) || c.atrPeriod < 1 || c.atrPeriod > 200) throw new TypeError('atrPeriod must be an integer 1..200');
  for (const key of ['requireRejection', 'requireCloseEdge', 'requireStacked', 'requireDeltaAgree', 'requireAbsorption', 'requireExhaustion', 'requireUnfinished']) {
    if (typeof c[key] !== 'boolean') throw new TypeError(`${key} must be boolean`);
  }
  if (!Array.isArray(c.allowedSides) || !c.allowedSides.length || c.allowedSides.some(s => !['long', 'short'].includes(s))) throw new TypeError('allowedSides must be a non-empty subset of [long, short]');
  if (c.sessionHoursUTC !== null) {
    if (!Array.isArray(c.sessionHoursUTC) || c.sessionHoursUTC.length !== 2 || !c.sessionHoursUTC.every(h => Number.isInteger(h) && h >= 0 && h <= 24) || c.sessionHoursUTC[0] >= c.sessionHoursUTC[1]) throw new TypeError('sessionHoursUTC must be null or [startHour, endHour] with 0 <= start < end <= 24');
  }
  if (!finite(c.minAtr) || c.minAtr < 0) throw new TypeError('minAtr must be a non-negative number');
  if (!finite(c.maxAtr) || c.maxAtr < 0) throw new TypeError('maxAtr must be a non-negative number');
  if (c.maxAtr > 0 && c.maxAtr < c.minAtr) throw new TypeError('maxAtr must be >= minAtr');
  if (!Number.isInteger(c.maxZones) || c.maxZones < 1 || c.maxZones > 20) throw new TypeError('maxZones must be an integer 1..20');
  if (!ENTRY_MODES.includes(c.entryMode)) throw new TypeError(`entryMode must be one of ${ENTRY_MODES.join(', ')}`);
  if (!finite(c.closeEdgeThreshold) || c.closeEdgeThreshold < 0.5 || c.closeEdgeThreshold > 0.95) throw new TypeError('closeEdgeThreshold must be between 0.5 and 0.95');
  if (!finite(c.minBodyRatio) || c.minBodyRatio < 0 || c.minBodyRatio > 0.95) throw new TypeError('minBodyRatio must be between 0 and 0.95');
  if (!finite(c.maxBodyRatio) || c.maxBodyRatio < 0.05 || c.maxBodyRatio > 1) throw new TypeError('maxBodyRatio must be between 0.05 and 1');
  if (c.minBodyRatio > c.maxBodyRatio) throw new TypeError('minBodyRatio must not exceed maxBodyRatio');
  if (!finite(c.minWickRatio) || c.minWickRatio < 0 || c.minWickRatio > 0.95) throw new TypeError('minWickRatio must be between 0 and 0.95');
  if (!finite(c.minVolume) || c.minVolume < 0) throw new TypeError('minVolume must be a non-negative number');
  if (!finite(c.minDeltaRatio) || c.minDeltaRatio < 0 || c.minDeltaRatio > 1) throw new TypeError('minDeltaRatio must be between 0 and 1');
  if (!TREND_FILTERS.includes(c.trendFilter)) throw new TypeError(`trendFilter must be one of ${TREND_FILTERS.join(', ')}`);
  if (!Number.isInteger(c.trendPeriod) || c.trendPeriod < 2 || c.trendPeriod > 200) throw new TypeError('trendPeriod must be an integer 2..200');
  if (!Number.isInteger(c.cooldownBars) || c.cooldownBars < 0 || c.cooldownBars > 200) throw new TypeError('cooldownBars must be an integer 0..200');
  for (const key of ['weightRejection', 'weightCloseEdge', 'weightStacked', 'weightDelta']) {
    if (!finite(c[key]) || c[key] < 0 || c[key] > 0.5) throw new TypeError(`${key} must be between 0 and 0.5`);
  }
  return c;
}

function simpleMovingAverage(bars, index, period) {
  if (index + 1 < period) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i++) {
    if (!finite(bars[i]?.c)) return null;
    sum += bars[i].c;
  }
  return sum / period;
}

function candidateTriggers(bar, entryMode) {
  const out = [];
  if (entryMode === 'sweep' || entryMode === 'any') {
    for (const sweep of (Array.isArray(bar.sweeps) ? bar.sweeps : [])) {
      const side = sweep.side === 'sell-side' ? 'long' : sweep.side === 'buy-side' ? 'short' : null;
      if (side) out.push({ side, level: sweep.level, reason: 'Снятие ликвидности и возврат' });
    }
  }
  if (entryMode === 'imbalance' || entryMode === 'any') {
    for (const item of (Array.isArray(bar.stackedImbalances) ? bar.stackedImbalances : [])) {
      const side = item.side === 'buy' ? 'long' : item.side === 'sell' ? 'short' : null;
      const level = Array.isArray(item.prices) && item.prices.length ? item.prices[0] : bar.c;
      if (side && !out.some(t => t.side === side && t.level === level)) out.push({ side, level, reason: 'Стек имбалансов в кластере' });
    }
  }
  if (entryMode === 'absorption' || entryMode === 'any') {
    const absorbed = Array.isArray(bar.absorbedLevels) ? bar.absorbedLevels : [];
    if (absorbed.length || bar.absorption) {
      const side = bar.c >= bar.o ? 'long' : 'short';
      const level = absorbed[0]?.price ?? (side === 'long' ? bar.l : bar.h);
      if (!out.some(t => t.side === side && t.level === level)) out.push({ side, level, reason: 'Поглощение объёма на экстремуме' });
    }
  }
  return out;
}

export function generateSignals(bars, options = {}) {
  const c = validateStrategyConditions(options);
  const {
    minScore, atrPeriod, requireRejection, requireCloseEdge, requireStacked, requireDeltaAgree,
    allowedSides, sessionHoursUTC, minAtr, maxAtr, entryMode, closeEdgeThreshold,
    minBodyRatio, maxBodyRatio, minWickRatio, minVolume, minDeltaRatio,
    requireAbsorption, requireExhaustion, requireUnfinished, trendFilter, trendPeriod,
    cooldownBars, weightRejection, weightCloseEdge, weightStacked, weightDelta
  } = c;
  if (!Array.isArray(bars)) throw new TypeError('Invalid strategy input');
  const signals = [];
  let lastSignalIndex = -Infinity;
  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index];
    if (cooldownBars > 0 && index - lastSignalIndex < cooldownBars) continue;
    const triggers = candidateTriggers(bar, entryMode);
    if (!triggers.length) continue;
    if (sessionHoursUTC !== null) {
      const hour = new Date(bar.time).getUTCHours();
      if (hour < sessionHoursUTC[0] || hour >= sessionHoursUTC[1]) continue;
    }
    const barVol = Number(bar.volume ?? bar.tickCount ?? 0);
    if (minVolume > 0 && barVol < minVolume) continue;
    const sma = trendFilter === 'none' ? null : simpleMovingAverage(bars, index, trendPeriod);
    for (const trigger of triggers) {
      const { side, level, reason } = trigger;
      if (!side || !allowedSides.includes(side)) continue;
      if (trendFilter !== 'none') {
        if (sma === null) continue;
        const uptrend = bar.c >= sma;
        if (trendFilter === 'with' && ((side === 'long' && !uptrend) || (side === 'short' && uptrend))) continue;
        if (trendFilter === 'counter' && ((side === 'long' && uptrend) || (side === 'short' && !uptrend))) continue;
      }
      const range = Math.max(0, bar.h - bar.l);
      if (!range) continue;
      const bodyRatio = Math.abs(bar.c - bar.o) / range;
      if (bodyRatio < minBodyRatio || bodyRatio > maxBodyRatio) continue;
      const wickSize = side === 'long' ? (Math.min(bar.o, bar.c) - bar.l) : (bar.h - Math.max(bar.o, bar.c));
      const wickRatio = Math.max(0, wickSize) / range;
      if (minWickRatio > 0 && wickRatio < minWickRatio) continue;
      const bullish = bar.c > bar.o;
      const bearish = bar.c < bar.o;
      const closeLocation = (bar.c - bar.l) / range;
      const rejection = side === 'long' ? bullish : bearish;
      const closeEdge = (side === 'long' && closeLocation >= closeEdgeThreshold) || (side === 'short' && closeLocation <= (1 - closeEdgeThreshold));
      const stacked = (bar.stackedImbalances || []).some(item => item.side === (side === 'long' ? 'buy' : 'sell'));
      const hasAbsorption = Boolean(bar.absorption) || (Array.isArray(bar.absorbedLevels) && bar.absorbedLevels.length > 0);
      const hasExhaustion = Boolean(bar.exhaustion);
      const hasUnfinished = Boolean(bar.unfinishedHigh || bar.unfinishedLow);
      const knownVol = (bar.ask || 0) + (bar.bid || 0);
      const directionalKnown = (bar.unknown || 0) === 0 && knownVol > 0;
      const delta = bar.delta ?? ((bar.ask || 0) - (bar.bid || 0));
      const deltaRatio = knownVol > 0 ? Math.abs(delta) / knownVol : 0;
      const deltaAgrees = directionalKnown && ((side === 'long' && delta > 0) || (side === 'short' && delta < 0));
      if (minDeltaRatio > 0 && deltaRatio < minDeltaRatio) continue;
      if (requireRejection && !rejection) continue;
      if (requireCloseEdge && !closeEdge) continue;
      if (requireStacked && !stacked) continue;
      if (requireDeltaAgree && !deltaAgrees) continue;
      if (requireAbsorption && !hasAbsorption) continue;
      if (requireExhaustion && !hasExhaustion) continue;
      if (requireUnfinished && !hasUnfinished) continue;
      let score = 0.45;
      const evidence = [reason];
      if (rejection) { score += weightRejection; evidence.push('Свеча отторжения подтверждает разворот'); }
      if (closeEdge) { score += weightCloseEdge; evidence.push('Закрытие удержалось у границы'); }
      if (stacked) { score += weightStacked; evidence.push('Накопленный дисбаланс подтверждает'); }
      if (directionalKnown) {
        if (deltaAgrees) { score += weightDelta; evidence.push('Дельта агрессора подтверждает'); }
        else { score -= 0.05; evidence.push('Дельта агрессора расходится'); }
      } else {
        evidence.push('Сторона агрессора недоступна');
      }
      const atr = averageTrueRange(bars, index, atrPeriod);
      if (atr !== null && atr > 0) score += 0.05;
      if (minAtr > 0 && (atr === null || atr < minAtr)) continue;
      if (maxAtr > 0 && (atr === null || atr > maxAtr)) continue;
      score = Math.max(0, Math.min(0.95, score));
      if (score < minScore) continue;
      lastSignalIndex = index;
      signals.push({
        id: `SIG-${index}-${side}-${level}`,
        index, time: bar.time, side, level,
        technicalScore: Number(score.toFixed(3)),
        probability: null,
        calibrationStatus: 'insufficient_out_of_sample_samples',
        evidence, atr
      });
    }
  }
  return signals;
}

export function attachWalkForwardCalibration(signals, closedTrades, { minSamples = 30, priorWins = 2, priorLosses = 2 } = {}) {
  if (!Array.isArray(signals) || !Array.isArray(closedTrades) || !Number.isInteger(minSamples) || minSamples < 1) throw new TypeError('Invalid calibration input');
  return signals.map(signal => {
    const prior = closedTrades.filter(trade => trade.exitIndex < signal.index && trade.side === signal.side);
    const wins = prior.filter(trade => trade.netR > 0).length;
    if (prior.length < minSamples) return { ...signal, probability: null, calibrationStatus: 'insufficient_out_of_sample_samples', calibrationSamples: prior.length };
    const probability = (wins + priorWins) / (prior.length + priorWins + priorLosses);
    return { ...signal, probability: Number(probability.toFixed(4)), calibrationStatus: 'walk_forward_historical_win_rate', calibrationSamples: prior.length };
  });
}
