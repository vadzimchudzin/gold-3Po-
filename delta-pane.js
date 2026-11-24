// Cumulative delta under the price chart: the running total of aggressive buying minus selling,
// drawn the way an order-flow terminal shows it — one zero line, an area that grows on net buying
// and falls on net selling. It reads the same bars as the chart, so the pane can never disagree with
// the clusters above it.
export const DELTA_PANE = Object.freeze({ LEFT: 64, HEIGHT: 84, TOP: 8, LABEL_ROW: 18, AXIS: 80 });

const finite = value => Number.isFinite(Number(value)) && value !== null && value !== '';

// Group with thin spaces, keeping the sign: "-12 480" reads better than "-12480" at a glance.
export function formatDelta(value) {
  const rounded = Math.round(Number(value) || 0);
  const grouped = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  return (rounded < 0 ? '−' : rounded > 0 ? '+' : '') + grouped;
}

export function deltaSeries(bars) {
  let cumulative = 0;
  return (Array.isArray(bars) ? bars : []).map(bar => {
    const delta = finite(bar?.delta) ? Number(bar.delta) : 0;
    cumulative += delta;
    return { delta, cumulative };
  });
}

// Markup for the pane's SVG. `scale` is the chart's own scale (left inset, bar step, drawing width,
// full SVG width), so the pane lines up with the candles column for column.
export function deltaPaneMarkup(bars, scale = {}) {
  const left = DELTA_PANE.LEFT;
  const height = DELTA_PANE.HEIGHT;
  const plot = height - DELTA_PANE.LABEL_ROW;
  const mid = DELTA_PANE.TOP + plot / 2;
  const step = Math.max(1, Number(scale.step) || 8);
  const width = Math.max(1, Number(scale.width) || 600);
  const svgWidth = Math.max(left + width + 8, Number(scale.svgWidth) || left + width + DELTA_PANE.AXIS);
  const series = deltaSeries(bars);
  if (!series.length) return { html: '', current: 0, peak: 0, svgWidth, height };

  const peak = Math.max(1, ...series.map(item => Math.abs(item.cumulative)));
  const y = value => mid - (value / peak) * (plot / 2 - 3);
  const x = index => left + step * (index + 0.5);
  const points = series.map((item, index) => [x(index), y(item.cumulative)]);
  const path = points.map(([px, py], index) => `${index ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join(' ');

  const lastX = points.at(-1)[0].toFixed(1);
  const firstX = points[0][0].toFixed(1);
  const baseline = mid.toFixed(1);
  const current = series.at(-1).cumulative;
  const tone = current < 0 ? 'down' : 'up';
  const axis = left + width + 8;

  const html = [
    `<line x1="${left}" y1="${baseline}" x2="${left + width}" y2="${baseline}" class="delta-zero"/>`,
    `<path d="${path} L${lastX} ${baseline} L${firstX} ${baseline} Z" class="delta-area ${tone}"/>`,
    `<path d="${path}" class="delta-line ${tone}"/>`,
    `<circle cx="${lastX}" cy="${points.at(-1)[1].toFixed(1)}" r="2.4" class="delta-dot ${tone}"/>`,
    `<text x="${left + 4}" y="14" class="delta-caption">CVD · ${series.at(-1).delta >= 0 ? '+' : '−'}${Math.abs(series.at(-1).delta)} за бар</text>`,
    `<text x="${axis}" y="14" class="delta-value ${tone}">${formatDelta(current)}</text>`
  ].join('');

  return { html, current, peak, svgWidth, height };
}
