// Alert rules, without any DOM: price levels, zone touches and new strategy signals.
//
// Every rule fires on a change, never on a state: a price alert when the price crosses the level,
// a zone alert when the price enters a zone it was outside of, a signal alert when a signal appears
// that was not on screen before. So a quiet market at a level does not ring every tick.

const MINUTE = 60_000;

export const DEFAULT_ALERT_RULES = Object.freeze({ zones: false, zoneMinStrength: 0.6, signals: false, sound: true });

export function normalizeAlerts(input) {
  const list = Array.isArray(input?.alerts) ? input.alerts : [];
  const alerts = list.filter(a => a && Number.isFinite(Number(a.price)) && Number(a.price) > 0).slice(0, 50).map(a => ({
    id: String(a.id || 'A-' + Math.random().toString(36).slice(2, 9)),
    price: Number(a.price),
    note: typeof a.note === 'string' ? a.note.slice(0, 80) : '',
    active: a.active !== false,
    createdAt: Number(a.createdAt) || 0,
    triggeredAt: Number(a.triggeredAt) || null
  }));
  const raw = input?.rules || {};
  const strength = Number(raw.zoneMinStrength);
  const rules = {
    zones: raw.zones === true,
    zoneMinStrength: Number.isFinite(strength) ? Math.min(0.95, Math.max(0.05, strength)) : DEFAULT_ALERT_RULES.zoneMinStrength,
    signals: raw.signals === true,
    sound: raw.sound !== false
  };
  return { alerts, rules };
}

export function createAlertEngine({ now = () => Date.now(), zoneCooldownMs = 15 * MINUTE } = {}) {
  let lastPrice = null;
  const zoneInside = new Map();
  const zoneFiredAt = new Map();
  const seenSignals = new Set();
  let signalsPrimed = false;

  // A new price: which price alerts it crossed and which zones it entered.
  function onPrice(price, { alerts = [], zones = [], rules = DEFAULT_ALERT_RULES } = {}) {
    const p = Number(price);
    if (!(p > 0)) return [];
    const prev = lastPrice;
    lastPrice = p;
    const events = [];
    if (prev !== null) {
      for (const alert of alerts) {
        if (!alert.active) continue;
        const up = prev < alert.price && p >= alert.price, down = prev > alert.price && p <= alert.price;
        if (!up && !down) continue;
        alert.active = false;
        alert.triggeredAt = now();
        events.push({ kind: 'price', id: alert.id, price: alert.price, direction: up ? 'up' : 'down', note: alert.note });
      }
    }
    for (const zone of zones) {
      const inside = p >= zone.low && p <= zone.high;
      const was = zoneInside.get(zone.id);
      zoneInside.set(zone.id, inside);
      if (!rules.zones || !inside || was !== false) continue; // first sight or already inside: no alert
      if (!(Number(zone.strength) >= rules.zoneMinStrength)) continue;
      if (zoneFiredAt.has(zone.id) && now() - zoneFiredAt.get(zone.id) < zoneCooldownMs) continue;
      zoneFiredAt.set(zone.id, now());
      events.push({ kind: 'zone', id: zone.id, zone, direction: prev !== null && prev > zone.high ? 'down' : 'up' });
    }
    return events;
  }

  // The signals on screen: the first list only primes what was already there.
  function onSignals(signals = [], rules = DEFAULT_ALERT_RULES) {
    const fresh = [];
    for (const signal of signals) {
      if (!signal?.id || seenSignals.has(signal.id)) continue;
      seenSignals.add(signal.id);
      if (signalsPrimed && rules.signals) fresh.push({ kind: 'signal', id: signal.id, signal });
    }
    signalsPrimed = true;
    if (seenSignals.size > 2000) { const keep = [...seenSignals].slice(-1000); seenSignals.clear(); for (const id of keep) seenSignals.add(id); }
    return fresh;
  }

  // A new symbol or timeframe: the next prices and signals are a new baseline.
  function reset() { lastPrice = null; zoneInside.clear(); seenSignals.clear(); signalsPrimed = false; }

  return { onPrice, onSignals, reset };
}
