// One price formatter and one ordering gate for every quote on the page.
// The broker's tick size decides how many decimals a price shows, so the same price keeps the
// same width between renders, and a tick that arrives late never moves the displayed quote back.

export function priceDigits(step, { min = 2, max = 6 } = {}) {
  const value = Number(step);
  if (!Number.isFinite(value) || value <= 0) return min;
  const digits = Math.ceil(-Math.log10(value) - 1e-9);
  return Math.min(max, Math.max(min, digits));
}

export function priceText(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const places = Number.isInteger(digits) ? Math.min(8, Math.max(0, digits)) : 2;
  return number.toLocaleString('ru-RU', { minimumFractionDigits: places, maximumFractionDigits: places });
}

// Ticks may arrive out of order (SSE replay, a refetch that overlaps the stream). A quote is
// accepted only when it is a valid book and not older than the last one shown.
export function createQuoteGate() {
  let lastTime = 0;
  return {
    reset() {
      lastTime = 0;
    },
    hasTime() {
      return lastTime > 0;
    },
    accept(tick = {}) {
      const bid = Number(tick.bid), ask = Number(tick.ask);
      if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) return null;
      const stamp = Date.parse(tick.timestamp ?? '');
      if (Number.isFinite(stamp) && stamp > 0) {
        if (stamp < lastTime) return null;
        lastTime = stamp;
      }
      const last = Number(tick.last);
      return {
        bid,
        ask,
        last: Number.isFinite(last) && last > 0 ? last : (bid + ask) / 2,
        spread: ask - bid,
        time: lastTime
      };
    }
  };
}
