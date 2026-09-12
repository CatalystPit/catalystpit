// src/lib/disclosure.js
//
// One canonical treatment of congressional disclosure timing and disclosed amounts, shared by
// Latest Filers, chart hover cards, the transactions table and politician detail pages.
// Client-safe: no imports, no secrets, no network.

/**
 * Days between the trade and its disclosure.
 *
 * congress_trades.filing_lag_days is already stored, so prefer that; this recomputes only when a
 * caller has the dates but not the column. Both paths must agree, which is the whole reason this
 * lives in one file.
 */
export function disclosureDelayDays(row) {
  if (!row) return null;
  const stored = row.filingLagDays ?? row.filing_lag_days;
  if (Number.isFinite(Number(stored))) return Number(stored);
  const t = row.transactionDate ?? row.transaction_date;
  const d = row.disclosureDate ?? row.disclosure_date;
  if (!t || !d) return null;
  const days = Math.round((new Date(d) - new Date(t)) / 86400000);
  return Number.isFinite(days) ? days : null;
}

/** "Filed 27 days later". Returns null when the delay is unknown, never a guess. */
export function formatDisclosureDelay(row, { short = false } = {}) {
  const n = disclosureDelayDays(row);
  if (n == null) return null;
  if (n <= 0) return short ? 'same day' : 'Filed same day';
  const unit = n === 1 ? 'day' : 'days';
  return short ? `${n}d later` : `Filed ${n} ${unit} later`;
}

// The STOCK Act gives members 45 days from the transaction to disclose. Past that a filing is
// late. This is a factual threshold from the statute, not a judgement we invented.
export const STOCK_ACT_DEADLINE_DAYS = 45;
export const isLateDisclosure = (row) => {
  const n = disclosureDelayDays(row);
  return n == null ? false : n > STOCK_ACT_DEADLINE_DAYS;
};

/**
 * The amount a filer actually disclosed. Congressional PTRs report a RANGE, never an exact
 * figure, so the range is what users see. amount_mid exists for ranking and for sizing chart
 * markers, and must never be shown as if it were a reported amount.
 */
export function formatDisclosedAmount(row) {
  if (!row) return null;
  const raw = row.amountRange ?? row.amount_range;
  if (raw && String(raw).trim()) return String(raw).trim();
  const min = Number(row.amountMin ?? row.amount_min);
  const max = Number(row.amountMax ?? row.amount_max);
  const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
  if (Number.isFinite(min) && Number.isFinite(max)) return `${money(min)} to ${money(max)}`;
  if (Number.isFinite(min)) return `${money(min)} or more`;
  return null;
}

/** Label for the estimated midpoint, always marked as an estimate where it appears. */
export function formatEstimatedMidpoint(row) {
  const mid = Number(row?.amountMid ?? row?.amount_mid);
  if (!Number.isFinite(mid) || mid <= 0) return null;
  const abbr = mid >= 1e6 ? `$${(mid / 1e6).toFixed(1)}M` : mid >= 1e3 ? `$${Math.round(mid / 1e3)}K` : `$${Math.round(mid)}`;
  return `${abbr} est. midpoint`;
}

/** Marker intent: purchases green, sales red, everything else neutral. Never guess a direction. */
export function tradeDirection(row) {
  const a = String(row?.action || '').toUpperCase();
  if (a === 'BUY') return 'buy';
  if (a === 'SELL') return 'sell';
  return 'other';
}

/** "House" / "Senate", plus state and district when we hold them. */
export function formatSeat(row) {
  if (!row) return null;
  const chamber = row.chamber === 'senate' ? 'Senate' : row.chamber === 'house' ? 'House' : null;
  const state = row.state || null;
  const district = row.district || null;
  // District values arrive as "NJ07"; show "NJ-07" and avoid repeating the state.
  let seat = state;
  if (district) {
    const m = String(district).match(/^([A-Za-z]{2})(\d+)$/);
    seat = m ? `${m[1].toUpperCase()}-${m[2]}` : (state ? `${state} ${district}` : String(district));
  }
  return [chamber, seat].filter(Boolean).join(' · ') || null;
}
