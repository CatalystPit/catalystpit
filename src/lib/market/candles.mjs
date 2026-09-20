// THE CANONICAL CONTRACT FOR ticker_daily_candles. Server-only, pure, no DB and no network.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// ticker_daily_candles is the trader-facing historical price series. Charts, Market Structure,
// Market Reaction and the level engine all read it, and every one of them assumes ONE convention:
// SPLIT_ADJUSTED (price-semantics.mjs, REQUIRED_CONVENTION).
//
// For a long time two writers quietly disagreed with that. /api/chart-daily and /api/ticker both
// persisted Tiingo's `adj*` fields, which are TOTAL RETURN — splits *and* dividends removed. That is
// a different quantity. It back-adjusts historic prices downward by every dividend paid since, so a
// level a trader could actually have traded is not the level we stored, and a return measured across
// it silently contains distributions the tape never printed on that day.
//
// The damage was not theoretical: it produced a ~10% fabricated gap on KO, 8.9% on PG, 9.2% on JNJ
// at the provenance boundary, and it put the Market Reaction BENCHMARK (SPY) on a different basis
// from the stocks being measured against it.
//
// Repairing the data without fixing the writers would have been pointless — 1,655 rows on the old
// convention were written in the 30 days before this module existed. So the conversion lives here,
// once, and both writers go through it.
//
// ── THE TRANSFORMATION, AND WHY IT IS THIS ONE ──────────────────────────────
//
// Tiingo does not serve a split-adjusted series. It serves RAW (`open/high/low/close/volume`) and
// TOTAL RETURN (`adj*`), plus a per-bar `splitFactor`. Split-adjusted is therefore DERIVED:
//
//     raw OHLCV + splitFactor  ->  splitAdjustSeries()  ->  SPLIT_ADJUSTED
//
// This is not a new derivation invented here. It is the one already proven in the seam repair:
// applied to 16 tickers it agreed with Polygon's independently-computed split-adjusted series on
// 100% of shared dates, worst difference 0.00%. Two vendors, different inputs, same number.
//
// ⚠️ `splitAdjustSeries` accumulates the factor BACKWARDS from the end of the array it is given, so
// it is only correct for a window whose last bar is the most recent bar that exists. Both writers
// fetch windows ending at "today", which satisfies that. A window ending in the past would be
// adjusted only for the splits inside it — see assertWindowEndsAtPresent().
//
// ── KNOWN LIMITATION, RECORDED DELIBERATELY ─────────────────────────────────
//
// A stored adjusted series is a snapshot: when a split occurs, every previously-written row for that
// ticker becomes stale until refetched, and `onConflictDoNothing` means we never rewrite them. That
// is true of the Polygon rows too and is not introduced by this module. It is a real follow-up
// (a split-triggered re-base), not something a write-time conversion can fix.

import { CONVENTION, splitAdjustSeries } from '../price-semantics.mjs';

/** The one convention ticker_daily_candles is allowed to hold. */
export const CANDLE_CONVENTION = CONVENTION.SPLIT_ADJUSTED;

/**
 * Provenance values. The source column records WHICH VENDOR and, for Tiingo, WHICH CONVENTION —
 * `tiingo` is the retired total-return basis and must never be written again; `tiingo_split_adj` is
 * canonical. Keeping the retired value distinct is what makes the contaminated rows identifiable
 * rather than guessable, and it is the same marker the repair already used.
 */
export const CANDLE_SOURCE = Object.freeze({
  TIINGO: 'tiingo_split_adj',
  POLYGON: 'polygon',
});

/** Written by the pre-fix writers. Total return. Never produced by this module. */
export const RETIRED_SOURCES = Object.freeze(['tiingo']);

export class CandleContractViolation extends Error {
  constructor(message, detail = {}) {
    super(`candle contract: ${message}`);
    this.name = 'CandleContractViolation';
    Object.assign(this, detail);
  }
}

const num = (v) => (v == null ? null : Number(v));
const finite = (v) => Number.isFinite(v);

/**
 * Guard against the mistake this module exists to prevent: adjusting a window that does not reach
 * the present. Such a window is missing every split after its last bar, so its "split-adjusted"
 * prices are on a basis that matches nothing.
 */
export function assertWindowEndsAtPresent(lastBarDate, today, { toleranceDays = 5 } = {}) {
  const a = Date.parse(`${String(lastBarDate).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(today).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new CandleContractViolation('window bounds are not dates', { lastBarDate, today });
  }
  // Weekends and holidays mean the newest bar legitimately trails today by a few days.
  const gapDays = (b - a) / 86_400_000;
  if (gapDays > toleranceDays) {
    throw new CandleContractViolation(
      'split adjustment requires a window ending at the present; this one stops earlier',
      { lastBarDate, today, gapDays });
  }
  return true;
}

/**
 * Tiingo daily rows -> canonical split-adjusted candle rows, ready to insert.
 *
 * `rows` is Tiingo's daily prices payload (ascending or not; it is sorted here). The RAW fields are
 * read deliberately and by name. The `adj*` fields are never read — that is the entire point, and a
 * test asserts the output differs from them on a dividend payer.
 *
 * Returns [] rather than throwing on an empty/unusable payload, so a caller's cache-serving path is
 * unaffected by a bad vendor response. Structural violations DO throw, because writing a malformed
 * candle is worse than serving stale cache.
 */
export function tiingoDailyToCanonical(rows, { ticker, today = null } = {}) {
  if (!ticker) throw new CandleContractViolation('ticker is required');
  if (!Array.isArray(rows) || !rows.length) return [];

  const raw = rows
    .map((d) => ({
      date: String(d?.date || '').slice(0, 10),
      open: num(d?.open), high: num(d?.high), low: num(d?.low), close: num(d?.close),
      volume: finite(num(d?.volume)) ? num(d.volume) : 0,
      // Absent or malformed splitFactor means "no split on this bar", which is the overwhelmingly
      // common case and the only safe default: inventing a factor would re-base real history.
      splitFactor: finite(num(d?.splitFactor)) && num(d.splitFactor) > 0 ? num(d.splitFactor) : 1,
    }))
    .filter((b) => b.date && [b.open, b.high, b.low, b.close].every((v) => finite(v) && v > 0))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (!raw.length) return [];
  if (today) assertWindowEndsAtPresent(raw[raw.length - 1].date, today);

  return splitAdjustSeries(raw).map((b) => ({
    ticker,
    date: b.date,
    open: b.open, high: b.high, low: b.low, close: b.close,
    volume: finite(b.volume) ? b.volume : 0,
    source: CANDLE_SOURCE.TIINGO,
  }));
}

/**
 * The write-integrity guard. Call immediately before inserting into ticker_daily_candles.
 *
 * It cannot verify a price is *true* — no local check can. What it CAN do is make the semantic
 * contract explicit and refuse the specific ways an adapter silently changes the meaning of the
 * columns: an unknown or retired provenance value, a row that never went through a declared
 * conversion, and OHLC that cannot describe a real session.
 *
 * Throws. A malformed or mis-converted candle must not reach the table that every price feature
 * reads, and returning a count the caller might ignore is how that happens.
 */
export function assertCanonicalCandles(rows, { ticker = null } = {}) {
  if (!Array.isArray(rows)) throw new CandleContractViolation('rows must be an array');
  const allowed = new Set(Object.values(CANDLE_SOURCE));

  for (const r of rows) {
    if (!r || typeof r !== 'object') throw new CandleContractViolation('row is not an object');
    if (!allowed.has(r.source)) {
      // Names the retired value explicitly, because that is the defect that actually happened and a
      // generic "unknown source" would not have told the next person what they did wrong.
      throw new CandleContractViolation(
        RETIRED_SOURCES.includes(r.source)
          ? `source '${r.source}' is the retired TOTAL RETURN basis; convert with tiingoDailyToCanonical() and write '${CANDLE_SOURCE.TIINGO}'`
          : `unknown source '${r.source}'`,
        { ticker: r.ticker, date: r.date, source: r.source });
    }
    if (ticker && r.ticker !== ticker) {
      throw new CandleContractViolation('row ticker does not match the batch', { expected: ticker, got: r.ticker });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.date || ''))) {
      throw new CandleContractViolation('date must be YYYY-MM-DD', { ticker: r.ticker, date: r.date });
    }
    const { open: o, high: h, low: l, close: c } = r;
    if (![o, h, l, c].every((v) => finite(v) && v > 0)) {
      throw new CandleContractViolation('OHLC must be finite and positive', { ticker: r.ticker, date: r.date });
    }
    // A tolerance, because vendor rounding can put a close a hair outside the printed high.
    const eps = Math.max(h, 1) * 1e-6;
    if (l > Math.min(o, c) + eps || h < Math.max(o, c) - eps || h < l - eps) {
      throw new CandleContractViolation('OHLC relationships are impossible', {
        ticker: r.ticker, date: r.date, open: o, high: h, low: l, close: c });
    }
    if (r.volume != null && (!finite(r.volume) || r.volume < 0)) {
      throw new CandleContractViolation('volume must be finite and non-negative', { ticker: r.ticker, date: r.date });
    }
  }
  return rows;
}
