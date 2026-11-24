// Where a footprint price row sits in its candle, so each column reads as the candle it came from:
// 'body' between open and close, 'wick' inside the high-low range but outside the body, 'out' beyond
// the bar. Half a price step of tolerance keeps row rounding from pushing the open or close row out
// of the body.
export function candlePart(bar, price, step) {
  const half = (Number(step) > 0 ? Number(step) : 0.1) / 2;
  if (![bar?.o, bar?.c, bar?.h, bar?.l, price].every(Number.isFinite)) return 'out';
  const top = Math.max(bar.o, bar.c), bottom = Math.min(bar.o, bar.c);
  if (price >= bottom - half && price <= top + half) return 'body';
  if (price >= bar.l - half && price <= bar.h + half) return 'wick';
  return 'out';
}
