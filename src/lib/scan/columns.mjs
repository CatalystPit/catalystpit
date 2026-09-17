// THE SCANNER TABLE'S COLUMNS.
//
// Declared as data so the panel does not hard-code a table: columns can be hidden, reordered and
// persisted, and a column whose data the feed cannot supply is not offered at all rather than
// rendering a column of dashes.
//
// NOT ALL AT ONCE. Twenty-eight columns is a spreadsheet, not a scanner. The defaults are the ones a
// trader reads at a glance; everything else is available and off.

const n2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
const pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%` : '—');
const big = (v) => {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(Math.round(v));
};

const col = (id, label, opts = {}) => ({
  id,
  label,
  align: opts.align || 'right',
  width: opts.width || 62,
  requires: opts.requires || {},
  read: opts.read,
  format: opts.format || n2,
  // Numeric columns colour by sign; the rest do not, so a green "2.1" volume figure never implies
  // direction it does not have.
  signed: opts.signed === true,
  sortable: opts.sortable !== false,
});

export const COLUMNS = [
  col('symbol', 'Symbol', { align: 'left', width: 92, read: (r) => r.symbol, format: (v) => v }),
  col('company', 'Company', { align: 'left', width: 150, read: (r) => r.company, format: (v) => v || '—' }),
  col('price', 'Price', { read: (r) => r.price }),
  col('changePct', 'Chg', { read: (r) => r.changePct, format: pct, signed: true }),
  col('gapPct', 'Gap', { read: (r) => r.gapPct, format: pct, signed: true, requires: { historicalDaily: true } }),

  // One per velocity window, each carrying that window's own requirement — so the 30-second column
  // simply does not exist until a feed observes fast enough to fill it.
  ...['30s', '1m', '2m', '3m', '5m', '10m', '15m', '30m'].map((w) => col(`vel_${w}`, w, {
    read: (r) => r.velocity?.[w]?.pct,
    format: pct,
    signed: true,
    width: 58,
    requires: w === '30s'
      ? { observationsPerMinute: 2, quoteFreshness: 'realtime' }
      : { quoteFreshness: 'near', minBarSeconds: 60 },
  })),

  col('volume', 'Vol', { read: (r) => r.volume, format: big, requires: { liveVolume: true } }),
  col('rvol', 'RVOL', {
    read: (r) => r.rvol,
    format: (v) => (Number.isFinite(v) ? `${v.toFixed(1)}×` : '—'),
    requires: { liveVolume: true, consolidatedVolume: true, intradayVolumeHistory: true },
  }),
  col('dollarVolume', '$ Vol', { read: (r) => r.dollarVolume, format: big, requires: { liveVolume: true } }),
  col('marketCap', 'Mkt cap', { read: (r) => r.marketCap, format: big, requires: { marketCap: true } }),
  col('float', 'Float', { read: (r) => r.float, format: big, requires: { float: true } }),
  col('spreadPct', 'Spread', {
    read: (r) => r.spreadPct,
    format: (v) => (Number.isFinite(v) ? `${v.toFixed(2)}%` : '—'),
    requires: { bidAsk: true },
  }),
  col('rsSpread', 'RS', {
    read: (r) => r.relativeStrength?.spread, format: pct, signed: true,
    requires: { quoteFreshness: 'near', minBarSeconds: 60 },
  }),
  col('haltStatus', 'Status', {
    align: 'left', width: 64, read: (r) => r.haltStatus,
    format: (v) => (v ? String(v).toUpperCase() : '—'), requires: { haltStatus: true },
  }),

  // THE COLUMN THE PRODUCT IS ABOUT. Not a number — the list of what is true, which is why it is
  // wide, left-aligned and not sortable as a scalar.
  col('signals', 'Signals', { align: 'left', width: 260, read: (r) => r.signals, format: null, sortable: false }),
  col('context', 'Catalyst', { align: 'left', width: 120, read: (r) => r.context, format: null, sortable: false }),
];

export const COLUMN_BY_ID = new Map(COLUMNS.map((c) => [c.id, c]));

/** What a trader sees before touching anything: identity, move, momentum, and why it is here. */
export const DEFAULT_COLUMNS = ['symbol', 'price', 'changePct', 'vel_1m', 'vel_5m', 'signals', 'context'];

/** Columns the active feed can actually fill. */
export function availableColumns(caps, availabilityFn) {
  return COLUMNS.filter((c) => availabilityFn({ requires: c.requires }, caps).available);
}

/**
 * Resolve a saved layout against what is available now.
 *
 * A column the feed stopped supporting is dropped rather than rendering empty, and an unknown id in
 * a stored layout is ignored — so a layout saved against a richer provider degrades instead of
 * breaking.
 */
export function resolveLayout(saved, caps, availabilityFn) {
  const ok = new Set(availableColumns(caps, availabilityFn).map((c) => c.id));
  const wanted = (Array.isArray(saved) && saved.length ? saved : DEFAULT_COLUMNS).filter((id) => ok.has(id));
  return wanted.length ? wanted : DEFAULT_COLUMNS.filter((id) => ok.has(id));
}
