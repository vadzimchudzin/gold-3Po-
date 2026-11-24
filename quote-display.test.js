import test from 'node:test';
import assert from 'node:assert/strict';
import { priceDigits, priceText, createQuoteGate } from './quote-display.js';

test('price digits follow the broker tick size with a two-decimal floor', () => {
  assert.equal(priceDigits(0.1), 2);
  assert.equal(priceDigits(0.01), 2);
  assert.equal(priceDigits(0.001), 3);
  assert.equal(priceDigits(0.00001), 5);
  assert.equal(priceDigits(undefined), 2);
  assert.equal(priceDigits(0), 2);
  assert.equal(priceDigits(-1), 2);
});

// ru-RU groups thousands with a non-breaking space; the test compares the visible text.
const plain = value => value.replace(/[\u00a0\u202f]/g, ' ');

test('price text keeps one fixed width for one price', () => {
  assert.equal(plain(priceText(2648.3, 2)), '2 648,30');
  assert.equal(plain(priceText(2648.3099, 2)), '2 648,31');
  assert.equal(plain(priceText(2648.3099, 4)), '2 648,3099');
  assert.equal(priceText(NaN, 2), '—');
  assert.equal(priceText(undefined, 2), '—');
});

test('a valid book is accepted and yields the spread', () => {
  const gate = createQuoteGate();
  const quote = gate.accept({ bid: 2648.3, ask: 2648.5, last: 2648.4, timestamp: '2026-01-05T10:00:00.000Z' });
  assert.ok(quote);
  assert.equal(quote.bid, 2648.3);
  assert.equal(quote.ask, 2648.5);
  assert.equal(quote.last, 2648.4);
  assert.ok(Math.abs(quote.spread - 0.2) < 1e-9);
  assert.equal(quote.time, Date.parse('2026-01-05T10:00:00.000Z'));
});

test('a malformed or crossed book is rejected', () => {
  const gate = createQuoteGate();
  assert.equal(gate.accept({ bid: 0, ask: 2648.5 }), null);
  assert.equal(gate.accept({ bid: 2648.5, ask: 2648.3 }), null);
  assert.equal(gate.accept({ bid: 'x', ask: 2648.5 }), null);
  assert.equal(gate.accept(), null);
  assert.equal(gate.hasTime(), false);
});

test('a late tick never moves the quote back', () => {
  const gate = createQuoteGate();
  const newer = gate.accept({ bid: 2650, ask: 2650.2, timestamp: '2026-01-05T10:00:05.000Z' });
  assert.ok(newer);
  const older = gate.accept({ bid: 2640, ask: 2640.2, timestamp: '2026-01-05T10:00:01.000Z' });
  assert.equal(older, null);
  assert.equal(gate.hasTime(), true);
});

test('a tick without a timestamp is accepted and keeps the last known time', () => {
  const gate = createQuoteGate();
  gate.accept({ bid: 2650, ask: 2650.2, timestamp: '2026-01-05T10:00:05.000Z' });
  const untimed = gate.accept({ bid: 2650.4, ask: 2650.6 });
  assert.ok(untimed);
  assert.equal(untimed.time, Date.parse('2026-01-05T10:00:05.000Z'));
});

test('the last price falls back to the mid of the book', () => {
  const gate = createQuoteGate();
  const quote = gate.accept({ bid: 2648, ask: 2650 });
  assert.equal(quote.last, 2649);
});

test('reset forgets the ordering so a new feed starts clean', () => {
  const gate = createQuoteGate();
  gate.accept({ bid: 2650, ask: 2650.2, timestamp: '2026-01-05T10:00:05.000Z' });
  gate.reset();
  assert.equal(gate.hasTime(), false);
  assert.ok(gate.accept({ bid: 2600, ask: 2600.2, timestamp: '2026-01-05T10:00:01.000Z' }));
});
