// THE CHART-TYPE REGISTRY.
//
// One entry per series shape the chart can actually draw. The toolbar renders from this list, so
// adding Hollow Candles, Heikin Ashi, Bars or Baseline later is an entry here plus its data mapping —
// the dropdown, the persistence and the keyboard shortcut all keep working untouched.
//
// NOTHING UNSUPPORTED IS LISTED. A chart type in the menu that renders wrongly is worse than one
// that is absent, so an entry exists only when both `series` and `map` are real.
//
//   series  the Lightweight Charts series constructor name, resolved against the imported module
//           at draw time so this file stays free of the library
//   map     bar -> the point shape that series expects
//   options styling, as a function of the palette so both themes are handled in one place

export const CHART_TYPES = [
  {
    id: 'Candles',
    label: 'Candlestick',
    glyph: '⁝',
    // Two candles: a wick line and a body rect each.
    shapes: [
      ['line', { x1: 5, y1: 2, x2: 5, y2: 14 }],
      ['rect', { x: 3, y: 5, width: 4, height: 6, fill: true }],
      ['line', { x1: 11, y1: 3, x2: 11, y2: 13 }],
      ['rect', { x: 9, y: 6, width: 4, height: 5 }],
    ],
    series: 'CandlestickSeries',
    map: (b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }),
    options: (p) => ({
      upColor: p.up, downColor: p.down, borderUpColor: p.up, borderDownColor: p.down,
      wickUpColor: p.up, wickDownColor: p.down,
    }),
  },
  {
    id: 'Line',
    label: 'Line',
    glyph: '∿',
    shapes: [['polyline', { points: '2,12 6,7 9,10 14,3' }]],
    series: 'LineSeries',
    map: (b) => ({ time: b.time, value: b.close }),
    options: (p) => ({ color: p.areaLine, lineWidth: 2 }),
  },
  {
    id: 'Area',
    label: 'Area',
    glyph: '◣',
    shapes: [
      ['polygon', { points: '2,12 6,7 9,10 14,3 14,14 2,14', fill: true, faint: true }],
      ['polyline', { points: '2,12 6,7 9,10 14,3' }],
    ],
    series: 'AreaSeries',
    map: (b) => ({ time: b.time, value: b.close }),
    options: (p) => ({
      lineColor: p.areaLine, topColor: p.areaTop, bottomColor: p.areaBottom, lineWidth: 2,
    }),
  },
];

export const CHART_TYPE_IDS = CHART_TYPES.map((t) => t.id);
const BY_ID = new Map(CHART_TYPES.map((t) => [t.id, t]));

/** Unknown ids resolve to candles rather than to nothing — a chart with no series is a blank box. */
export const chartTypeOf = (id) => BY_ID.get(id) || BY_ID.get('Candles');

/**
 * Declared, not built. Listed so the roadmap lives in the code and each one's requirement is
 * decided before it is written, rather than being discovered when somebody picks it from a menu.
 */
export const PLANNED_CHART_TYPES = [
  { id: 'HollowCandles', label: 'Hollow candles', needs: 'per-bar body fill derived from open/close' },
  { id: 'HeikinAshi', label: 'Heikin Ashi', needs: 'a derived OHLC series, computed from the bars' },
  { id: 'Bars', label: 'Bars (OHLC)', needs: 'BarSeries mapping' },
  { id: 'Baseline', label: 'Baseline', needs: 'a chosen baseline price' },
];
