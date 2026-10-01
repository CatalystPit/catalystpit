/**
 * WHICH SCREENER COLUMNS ARE THE PRO AGGREGATE, AND WHY THOSE.
 *
 * ── ⚠️ WHAT WAS WRONG ────────────────────────────────────────────────────────
 *
 * /api/screener took no auth and returned `db.select()` — the whole row — so an anonymous caller got
 * every derived analytic for all 18,036 securities, 100 at a time. Measured on production before this
 * change, the first page carried insiderNet90d ($1.38B on the leader), insiderBuyers90d, insiderBuy90d,
 * insiderSell90d, congressNet90d, congressBuy90d, fundNetQoq and consensusScore.
 *
 * Those are not market data. They are OUR cross-dataset aggregates over the exact products that are
 * gated everywhere else: the Insiders, Politicians and Institutions boards each serve an anonymous
 * visitor ten records, and Pit Consensus is a Pro board outright. The Screener was handing the same
 * analysis for the entire universe to anyone who could write a for-loop — 181 requests for the whole
 * book. Gating ten rows on one page while publishing the aggregate on another is not a policy, it is
 * an oversight with two different answers.
 *
 * ── ⚠️ WHAT IS DELIBERATELY *NOT* IN THIS LIST ──────────────────────────────
 *
 * Everything a screener is actually for: company, sector, industry, country, market cap, price, change,
 * volume, the technicals, the performance series, the valuation multiples and the fundamentals. Those
 * are ordinary market and reference data, available on every finance site, and the product rule is that
 * the Screener stays usable for Free and logged-out visitors. Narrowing access to them would be
 * inventing a restriction rather than fixing one.
 *
 * insiderOwnPct and instOwnPct stay too, and that distinction is the point of the list: a static
 * ownership percentage is standard reference data, while insiderNet90d is a ninety-day flow WE compute
 * from filings we gate. One is a fact about the company; the other is our analysis.
 *
 * hasMaterial8k and newsRecent stay: the existence of a recent 8-K is a public SEC fact that the Pit
 * Wire already publishes.
 */
export const PRO_AGGREGATE_FIELDS = Object.freeze([
  // 90-day insider flow — the Insiders board gives an anonymous visitor ten records.
  'insiderNet90d', 'insiderBuyers90d', 'insiderBuy90d', 'insiderSell90d',
  // 90-day congressional flow — same, on the Politicians board.
  'congressNet90d', 'congressBuy90d',
  // Quarter-over-quarter institutional net — same, on the Institutions board.
  'fundNetQoq',
  // Pit Consensus is a Pro board; its score must not leak as a screener column.
  'consensusScore',
]);

const GATED = new Set(PRO_AGGREGATE_FIELDS);

/** Is this field part of the Pro aggregate? */
export const isProAggregateField = (k) => GATED.has(String(k));

/**
 * Strip the Pro aggregate from one row.
 *
 * ⚠️ DELETED, NOT NULLED. A null is a claim — "we looked and there is nothing" — and on these columns
 * that reads as "no insider buying", which is a statement about the security rather than about the
 * reader's entitlement. An absent key renders as the same em dash the UI already shows for unknown
 * values, and tells no lie about the market.
 */
export function stripProAggregate(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const k of Object.keys(row)) if (!GATED.has(k)) out[k] = row[k];
  return out;
}

/**
 * ⚠️ THE FILTER AND THE SORT MATTER AS MUCH AS THE COLUMN, which is the half a "hide the field" fix
 * always misses. With the column stripped but the filter live, `filters={"insiderBuy90d":{"eq":true}}`
 * still answers "which of the 18,036 have insider buying" — the aggregate, read out through the result
 * set instead of a cell. And an ORDERING by a hidden column leaks the ranking it was hiding: sorting by
 * insiderNet90d descending publishes the top of the list in order.
 *
 * So for a non-Pro caller the gated keys are removed from the filter object and refused as a sort, and
 * the caller is told which were dropped rather than silently served a different query than they asked
 * for.
 */
export function sanitizeFilters(active, { pro }) {
  const src = active && typeof active === 'object' ? active : {};
  if (pro) return { filters: src, dropped: [] };
  const filters = {};
  const dropped = [];
  for (const k of Object.keys(src)) {
    if (GATED.has(k)) dropped.push(k);
    else filters[k] = src[k];
  }
  return { filters, dropped };
}

/**
 * The sort column a caller may actually use.
 *
 * ⚠️ THE DEFAULT ITSELF WAS A GATED FIELD. The route's fallback ordering is insiderNet90d — so every
 * unsorted request from an anonymous visitor was already ranking the universe by the Pro aggregate, and
 * simply stripping the cell would have left the ranking intact and readable. Non-Pro callers fall back
 * to market cap, which is the obvious neutral ordering for a screener and is not gated.
 */
export const NON_PRO_DEFAULT_SORT = 'marketCap';

export function sanitizeSort(requested, { pro }) {
  const key = String(requested || '');
  if (pro || !GATED.has(key)) return { sort: requested, refused: false };
  return { sort: NON_PRO_DEFAULT_SORT, refused: true };
}
