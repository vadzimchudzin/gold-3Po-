import { averageTrueRange, generateSignals } from './strategy-engine.js';

export function runBacktest(bars, options = {}) {
  const {
    initialEquity = 10000, riskPct = 0.5, maxRiskPct = 1,
    atrPeriod = 14, stopAtr = 1.5, targetR = 2,
    maxBars = 20, pointValue = 1, feePerUnit = 0, slippage = 0,
    breakevenR = 0, trailingAtr = 0,
    minScore = 0.55, maxTrades = 5000, strategyConditions = null
  } = options;
  const numeric = [initialEquity, riskPct, maxRiskPct, stopAtr, targetR, pointValue, feePerUnit, slippage, breakevenR, trailingAtr];
  if (!Array.isArray(bars) || numeric.some(value => !Number.isFinite(value)) ||
      initialEquity <= 0 || riskPct <= 0 || maxRiskPct <= 0 || riskPct > maxRiskPct ||
      stopAtr <= 0 || targetR <= 0 || pointValue <= 0 || feePerUnit < 0 || slippage < 0 ||
      breakevenR < 0 || trailingAtr < 0 ||
      !Number.isInteger(maxBars) || maxBars < 1 || !Number.isInteger(maxTrades) || maxTrades < 1) {
    throw new TypeError('Invalid backtest configuration');
  }
  const signals = generateSignals(bars, strategyConditions ? { ...strategyConditions, minScore, atrPeriod } : { minScore, atrPeriod });
  let equity = initialEquity, peak = initialEquity, maxDrawdown = 0, cursor = 0;
  const trades = [];
  while (cursor < signals.length && trades.length < maxTrades) {
    const signal = signals[cursor++];
    const entryIndex = signal.index + 1;
    if (entryIndex >= bars.length) continue;
    const atr = signal.atr || averageTrueRange(bars, signal.index, atrPeriod);
    if (!Number.isFinite(atr) || atr <= 0) continue;
    const stopDistance = atr * stopAtr;
    const riskBudget = equity * riskPct / 100;
    if (riskBudget <= 0) break;
    const quantity = riskBudget / (stopDistance * pointValue);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    const direction = signal.side === 'long' ? 1 : -1;
    const rawEntry = bars[entryIndex].o;
    const entry = rawEntry + direction * slippage;
    let stop = entry - direction * stopDistance;
    const target = entry + direction * stopDistance * targetR;
    const lastIndex = Math.min(bars.length - 1, entryIndex + maxBars - 1);
    let exitIndex = lastIndex, exit = bars[lastIndex].c, exitReason = 'time';
    let bestPrice = entry;
    for (let i = entryIndex; i <= lastIndex; i++) {
      const bar = bars[i];
      const stopHit = direction === 1 ? bar.l <= stop : bar.h >= stop;
      const targetHit = direction === 1 ? bar.h >= target : bar.l <= target;
      if (stopHit) {
        exitIndex = i;
        exit = (direction === 1 && bar.o < stop) || (direction === -1 && bar.o > stop) ? bar.o : stop;
        exitReason = 'stop';
        break;
      }
      if (targetHit) { exitIndex = i; exit = target; exitReason = 'target'; break; }
      // Update breakeven / trailing stop at bar close so intra-bar stop evaluation stays conservative.
      bestPrice = direction === 1 ? Math.max(bestPrice, bar.h) : Math.min(bestPrice, bar.l);
      if (breakevenR > 0 && (bestPrice - entry) * direction >= stopDistance * breakevenR) {
        stop = direction === 1 ? Math.max(stop, entry) : Math.min(stop, entry);
      }
      if (trailingAtr > 0 && (bestPrice - entry) * direction > 0) {
        const trailed = bestPrice - direction * atr * trailingAtr;
        stop = direction === 1 ? Math.max(stop, trailed) : Math.min(stop, trailed);
      }
    }
    exit -= direction * slippage;
    const grossPnl = (exit - entry) * direction * quantity * pointValue;
    const fees = quantity * feePerUnit * 2;
    const netPnl = grossPnl - fees;
    const netR = netPnl / riskBudget;
    equity += netPnl;
    peak = Math.max(peak, equity);
    const drawdown = peak > 0 ? (peak - equity) / peak * 100 : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
    trades.push({
      side: signal.side, signalIndex: signal.index, entryIndex, exitIndex,
      entryTime: bars[entryIndex].time, exitTime: bars[exitIndex].time,
      entry, exit, stop, target, quantity, riskBudget,
      grossPnl, fees, netPnl, netR, exitReason,
      technicalScore: signal.technicalScore
    });
    cursor = signals.findIndex((item, i) => i >= cursor && item.index > exitIndex);
    if (cursor < 0) break;
  }
  const wins = trades.filter(trade => trade.netPnl > 0);
  const losses = trades.filter(trade => trade.netPnl < 0);
  const grossWins = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLosses = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  const netPnl = trades.reduce((sum, trade) => sum + trade.netPnl, 0);
  // Slippage is charged on entry and exit, in price units, per unit of quantity.
  const slippageCost = trades.reduce((sum, trade) => sum + 2 * slippage * trade.quantity * pointValue, 0);
  const firstTime = bars.find(bar => bar && bar.time)?.time ?? null;
  const lastTime = bars.findLast(bar => bar && bar.time)?.time ?? null;
  const limitations = ['Сигналы рассчитываются на закрытии свечи, вход — по открытию следующей.', 'Если стоп и цель задеты в одной свече, первым считается стоп.', 'Результаты — историческая симуляция, а не прогноз; проверяйте их вне выборки и скользящим окном.'];
  return {
    config: { initialEquity, riskPct, maxRiskPct, atrPeriod, stopAtr, targetR, maxBars, pointValue, feePerUnit, slippage, minScore },
    summary: {
      trades: trades.length, wins: wins.length, losses: losses.length,
      winRate: trades.length ? wins.length / trades.length : null,
      profitFactor: grossLosses ? grossWins / grossLosses : grossWins ? null : 0,
      expectancyR: trades.length ? trades.reduce((sum, trade) => sum + trade.netR, 0) / trades.length : null,
      netPnl, finalEquity: equity, maxDrawdownPct: maxDrawdown,
      avgR: trades.length ? trades.reduce((sum, trade) => sum + trade.netR, 0) / trades.length : null,
      avgWin: wins.length ? grossWins / wins.length : null,
      avgLoss: losses.length ? -grossLosses / losses.length : null,
      totalFees: trades.reduce((sum, trade) => sum + trade.fees, 0),
      slippageCost,
      bars: bars.length,
      periodStart: firstTime,
      periodEnd: lastTime
    },
    trades,
    limitations
  };
}
