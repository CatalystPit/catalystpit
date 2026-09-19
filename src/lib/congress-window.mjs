// WHEN A CONGRESSIONAL TRADE BECOMES INFORMATION.
//
// Extracted so the rule can be tested exhaustively without a database, and so there is exactly one
// place that answers "could we have known this yet".
//
// ⚠️ THE DISCLOSURE DATE IS THE INFORMATION DATE. The transaction date is when a member of Congress
// traded; under the STOCK Act they may report it up to 45 days later, and in practice often do not.
// Measured on our own data: median lag 28 days, 90th percentile 116 days, maximum 1,932 — and 17.6%
// of trades are disclosed MORE than 90 days after the transaction.
//
// Windowing on the transaction date did two wrong things at once. It dated evidence to a day nobody
// outside Congress could have known it, and it silently DISCARDED every trade whose lag exceeded the
// window — those trades became public and never reached the score. That is the defect this module
// exists to make impossible to reintroduce.
//
// Pure: no database, no clock of its own.

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date string → epoch ms at UTC midnight, or null. */
export function dayMs(v) {
  if (v == null) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  const s = String(v).slice(0, 10);
  if (!DAY_RE.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

/**
 * The date this trade became public information.
 *
 * NO FALLBACK TO THE TRANSACTION DATE, deliberately. `disclosure_date` is NOT NULL in the schema and
 * has no nulls in the data; a row that somehow lacks one is UNUSABLE rather than approximated,
 * because approximating it with the transaction date is precisely the bug.
 */
export function informationDate(row) {
  return dayMs(row?.disclosureDate ?? row?.disclosure_date);
}

/** The economic event date — kept for display and context, never for windowing. */
export function transactionDate(row) {
  return dayMs(row?.transactionDate ?? row?.transaction_date);
}

/**
 * Is this trade inside the information window ending at `asOf`?
 *
 * Two conditions, and both matter:
 *   NOT YET PUBLIC   a disclosure dated after `asOf` cannot influence a score computed at `asOf`,
 *                    which is what stops future information entering a historical evaluation.
 *   TOO OLD          a disclosure older than the window has stopped being news.
 *
 * The transaction date is not consulted. A trade executed two years ago and disclosed this morning
 * is news this morning — that is the whole point.
 */
export function withinInformationWindow(row, asOfMs, windowDays = 90) {
  const info = informationDate(row);
  if (info == null || !Number.isFinite(asOfMs)) return false;
  if (info > asOfMs) return false;                       // not public yet
  return info >= asOfMs - windowDays * DAY_MS;           // still inside the window
}

/** The disclosure lag in days, for reporting. Null when either date is unusable. */
export function disclosureLagDays(row) {
  const info = informationDate(row);
  const txn = transactionDate(row);
  return (info == null || txn == null) ? null : (info - txn) / DAY_MS;
}

export const WINDOW_DAYS = 90;
