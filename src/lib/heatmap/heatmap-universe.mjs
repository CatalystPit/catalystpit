// WHICH SECURITIES ARE ON THE BOARD, and who leads it.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: a universe is only offered when its membership is actually
// KNOWN. We can rank by market capitalisation because we store market capitalisation. We cannot
// offer "S&P 500" because we do not hold its constituent list, and labelling the top 500 names by
// market cap as the S&P 500 would be a fabrication a reader could act on — the index is a committee's
// selection, not a size ranking, and the two differ by dozens of names.
//
// So unavailable universes are DECLARED, with the reason, rather than silently omitted. That is the
// architecture hook: when a constituent source is licensed, an entry flips to available and the page
// gains a control without any other change.
//
// Pure: no database, no network.

/**
 * WHAT COUNTS AS A SECURITY ON A MARKET HEATMAP.
 *
 * A market heatmap is a picture of the equity market, so it is drawn from OPERATING COMPANIES. The
 * rule is `screener_meta.asset_type`, which is existing reference data from the vendor's
 * ticker-details endpoint — not a hand-maintained exclusion list, and not a judgement about any
 * individual ticker.
 *
 * Included:
 *   Stock  (5,181 with a market cap) — US common shares
 *   ADRC   (372)                     — depositary receipts: real operating companies, US-listed
 *
 * Excluded, each for a stated reason rather than by taste:
 *   FUND    (331) — a closed-end fund's "market cap" is the value of holdings ALREADY on this board.
 *                   Drawing both double-counts the same capital and inflates whichever sector the
 *                   fund is filed under.
 *   ETF (3), ETV (4) — same double-count, more so.
 *   WARRANT (5)   — a right to buy shares, not ownership of a company; "market capitalisation" is
 *                   not a meaningful size for it.
 *   UNIT    (8)   — a bundled SPAC instrument, for the same reason.
 *
 * MUTUAL-FUND SHARE CLASSES NEED NO RULE AT ALL. All 1,671 of them (the 5-letter symbols ending in
 * X) carry no market capitalisation, so `market_cap > 0` already excludes every one. Measured, not
 * assumed — and it is why there is no symbol-shape heuristic here.
 */
export const TRADEABLE_ASSET_TYPES = Object.freeze(['Stock', 'ADRC']);

export const EXCLUDED_ASSET_REASONS = Object.freeze({
  FUND: 'A fund holds securities already on this board; drawing both double-counts the same capital.',
  ETF: 'A fund holds securities already on this board; drawing both double-counts the same capital.',
  ETV: 'A fund holds securities already on this board; drawing both double-counts the same capital.',
  WARRANT: 'A warrant is a right to buy shares, not ownership sized by market capitalisation.',
  UNIT: 'A bundled instrument, not ownership sized by market capitalisation.',
});

export const isTradeableAssetType = (t) => TRADEABLE_ASSET_TYPES.includes(t);

/**
 * The universes the page can offer.
 *
 * The sizes are chosen from MEASURED market-cap coverage of the eligible universe, so each option is
 * a meaningful slice of the market rather than a round number: 100 = 62%, 300 = 79%, 500 = 87%,
 * 1000 = 94%, 2000 = 98%. "All eligible" is every operating company we can measure.
 *
 * `available: false` entries are real product intent with a stated blocker, and the UI shows them
 * disabled with the reason rather than pretending the option does not exist.
 */
export const UNIVERSES = Object.freeze([
  { id: 'top100', label: 'Top 100', available: true, limit: 100, coverage: 62,
    description: 'The 100 largest operating companies we cover — about 62% of total market cap.' },
  { id: 'top150', label: 'Top 150', available: true, limit: 150, coverage: 68,
    description: 'The 150 largest operating companies we cover — about 68% of total market cap.' },
  { id: 'top300', label: 'Top 300', available: true, limit: 300, coverage: 79,
    description: 'The 300 largest operating companies we cover — about 79% of total market cap.' },
  { id: 'top500', label: 'Top 500', available: true, limit: 500, coverage: 87,
    description: 'The 500 largest operating companies we cover — about 87% of total market cap.' },
  { id: 'top1000', label: 'Top 1000', available: true, limit: 1000, coverage: 94,
    description: 'The 1,000 largest operating companies we cover — about 94% of total market cap.' },
  { id: 'top2000', label: 'Top 2000', available: true, limit: 2000, coverage: 98,
    description: 'The 2,000 largest operating companies we cover — about 98% of total market cap.' },
  { id: 'all', label: 'All eligible', available: true, limit: 6000, coverage: 100,
    description: 'Every operating company with a market capitalisation and a current price. Best used with a sector selected.' },
  { id: 'sp500', label: 'S&P 500', available: false, limit: 500,
    description: 'Requires licensed index constituent data. The largest 500 by market cap is NOT the S&P 500.' },
  { id: 'nasdaq100', label: 'Nasdaq 100', available: false, limit: 100,
    description: 'Requires licensed index constituent data. Exchange listing alone does not determine membership.' },
]);

export const DEFAULT_UNIVERSE = 'top500';
export const universeById = (id) => UNIVERSES.find((u) => u.id === id) || null;
export const availableUniverses = () => UNIVERSES.filter((u) => u.available);

/** How many rows a universe asks for, defaulting rather than throwing on an unknown or gated id. */
export function universeLimit(id) {
  const u = universeById(id);
  return u && u.available ? u.limit : universeById(DEFAULT_UNIVERSE).limit;
}

export const SECTOR_OTHER = 'Other';
export const ALL_SECTORS = '__all__';

/**
 * The sector list for the filter control, built from what the rows actually carry.
 *
 * "Other" appears only when something is genuinely unclassified, and always last — it is a real
 * bucket a reader may want to inspect, not a hidden dumping ground.
 */
export function sectorOptions(rows) {
  const seen = new Set();
  let other = false;
  for (const r of rows || []) {
    if (r?.sector) seen.add(r.sector); else if (r?.ticker) other = true;
  }
  const named = [...seen].sort((a, b) => a.localeCompare(b));
  return other ? [...named, SECTOR_OTHER] : named;
}

/** Rows in one sector. `Other` selects everything with no sector; ALL_SECTORS selects everything. */
export function filterBySector(rows, sector) {
  if (!sector || sector === ALL_SECTORS) return [...(rows || [])];
  if (sector === SECTOR_OTHER) return (rows || []).filter((r) => !r?.sector);
  return (rows || []).filter((r) => r?.sector === sector);
}

/**
 * Top movers over the SELECTED window — never a separate, fixed one.
 *
 * If the board is showing 1Y, the leaders are 1Y leaders. That sounds obvious and is the single
 * easiest thing to get wrong, because daily gainers are what a "Top Gainers" list usually means.
 *
 * Rows with no return are EXCLUDED rather than sorted to the bottom: a security we could not measure
 * is not the day's smallest mover, and a leaderboard is a claim about ranking.
 */
export function topMovers(rows, { direction = 'up', limit = 10 } = {}) {
  const usable = (rows || []).filter((r) => r?.ticker && r.pct != null && Number.isFinite(Number(r.pct)));
  const sign = direction === 'down' ? 1 : -1;
  // Ties break on ticker so the same board twice gives the same list.
  usable.sort((a, b) => sign * (Number(a.pct) - Number(b.pct)) || String(a.ticker).localeCompare(String(b.ticker)));
  return usable.slice(0, Math.max(1, limit));
}

/**
 * Most active by the LAST COMPLETED SESSION's share volume.
 *
 * NOT timeframe-scoped, and labelled in the UI with the session date, because "most active" is a
 * property of a trading session rather than of a return window — a "1Y most active" would be a
 * number nobody asked for. It is real consolidated session volume from stored candles, not the
 * screener's `volume` column, which falls back to an average when a session figure is missing and
 * would quietly rank a name on the wrong quantity.
 *
 * Returns [] when no row carries a volume, so the UI can omit the panel instead of showing an empty
 * or fabricated list.
 */
export function mostActive(rows, { limit = 10 } = {}) {
  const usable = (rows || []).filter((r) => r?.ticker && Number.isFinite(Number(r.volume)) && Number(r.volume) > 0);
  usable.sort((a, b) => Number(b.volume) - Number(a.volume) || String(a.ticker).localeCompare(String(b.ticker)));
  return usable.slice(0, Math.max(1, limit));
}
