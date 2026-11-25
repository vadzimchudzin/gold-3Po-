import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { candlePart } from './footprint-candle.js';

test('a footprint row is body, wick or blank depending on its candle', () => {
  const bar = { o: 2640.5, c: 2641.5, h: 2642.0, l: 2640.0 };
  assert.equal(candlePart(bar, 2641.0, 0.1), 'body', 'between open and close');
  assert.equal(candlePart(bar, 2640.5, 0.1), 'body', 'the open row is in the body');
  assert.equal(candlePart(bar, 2641.5, 0.1), 'body', 'the close row is in the body');
  assert.equal(candlePart(bar, 2641.8, 0.1), 'wick', 'above the close, inside the high');
  assert.equal(candlePart(bar, 2640.2, 0.1), 'wick', 'below the open, inside the low');
  assert.equal(candlePart(bar, 2642.0, 0.1), 'wick', 'the high row alone is a wick');
  assert.equal(candlePart(bar, 2642.3, 0.1), 'out', 'beyond the high');
  assert.equal(candlePart(bar, 2639.6, 0.1), 'out', 'beyond the low');
  // A down bar has the same shape with the body inverted.
  const down = { o: 2641.5, c: 2640.5, h: 2642.0, l: 2640.0 };
  assert.equal(candlePart(down, 2641.0, 0.1), 'body');
  assert.equal(candlePart(down, 2641.8, 0.1), 'wick');
  // Row rounding within half a price step still counts as the body edge.
  assert.equal(candlePart(bar, 2640.55, 0.1), 'body');
  // A finer broker grid narrows the tolerance.
  assert.equal(candlePart(bar, 2641.52, 0.01), 'wick');
  // Incomplete bars never claim a row.
  assert.equal(candlePart({ o: 1, c: 2 }, 1.5, 0.1), 'out');
  assert.equal(candlePart(null, 1.5, 0.1), 'out');
  assert.equal(candlePart(bar, NaN, 0.1), 'out');
});

test('the browser loads the candle module and the build ships it', async () => {
  const server = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(server, /'\/footprint-candle\.js': \['footprint-candle\.js'/, 'the browser can load the module');
  const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.build.files.includes('footprint-candle.js'), 'the desktop build ships the module');
  const main = await readFile(new URL('./electron/main.js', import.meta.url), 'utf8');
  assert.match(main.match(/for \(const asset of \[([^\]]*)\]\)/) [1], /'\/footprint-candle\.js'/, 'the packaged-app smoke test fetches it');
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /candlePart\(f, r\.price, /, 'the canvas footprint shades each row by its candle part');
});
