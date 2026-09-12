// src/lib/insider-format.js
//
// ONE canonical ownership-change calculation and ONE formatter, shared by every place
// that shows it: the insider row badges, the ΔOWN column, Notable Activity, Conviction
// tags, tooltips and any future alert. Client-safe (no imports, no secrets, no DB), so
// the client, the API route and the server-only Conviction engine can all use it.
//
// This exists because the same percentage was being computed in three places and
// formatted in four, which is how a badge ended up rendering
// "OWNERSHIP +35.20681508102892%" next to a ΔOWN column reading "+35%" for the very
// same transaction. Same number, different formatting, and one path that never rounded.

/**
 * Canonical ownership change for a single insider transaction.
 *
 * shares_owned_after is the holding AFTER the trade, so the prior holding is
 * (after - shares) for a buy and (after + shares) for a sell. Returns a SIGNED
 * percentage: positive when the stake grew, negative when it shrank.
 *
 * Returns null when it cannot be known, which is not the same as zero:
 *  - no post-transaction holding reported (filers often footnote it instead)
 *  - no share count
 * A buy that establishes a brand-new position (prior holding of zero) is reported as
 * 100, matching the long-standing behaviour of the insiders table. It is a floor, not a
 * literal measurement: going from nothing to something has no finite percentage.
 */
export function ownershipChangePct(row) {
  if (!row) return null;
  const after = typeof row.sharesOwnedAfter === 'number' ? row.sharesOwnedAfter
    : (typeof row.shares_owned_after === 'number' ? row.shares_owned_after : null);
  const sh = typeof row.shares === 'number' ? row.shares : 0;
  const action = row.action || null;
  if (after == null || !(sh > 0)) return null;
  const before = action === 'BUY' ? after - sh : after + sh;
  if (!(before > 0)) return action === 'BUY' ? 100 : null;
  const pct = (sh / before) * 100;
  return action === 'SELL' ? -pct : pct;
}

/**
 * Canonical display formatting for an ownership-change percentage.
 *
 *   below 100%      at most one decimal, and only when it carries information
 *                   35.20681508102892 -> "35.2"      15 -> "15"
 *   100% to 999%    whole number        273.3840380228028 -> "273"
 *   1,000% and up   whole number, grouped   6064.203825244359 -> "6,064"
 *
 * Raw floating point is never shown. The sign is preserved; `sign: false` drops the
 * leading "+" for contexts that supply their own.
 */
export function fmtOwnershipPct(value, { sign = true, suffix = '%' } = {}) {
  const v = Number(value);
  if (value == null || !Number.isFinite(v)) return null;
  const abs = Math.abs(v);
  let body;
  if (abs < 100) {
    // Round to 1dp first, then drop a trailing ".0" so whole values read as whole.
    const one = Math.round(abs * 10) / 10;
    body = Number.isInteger(one) ? String(one) : one.toFixed(1);
  } else {
    body = Math.round(abs).toLocaleString('en-US');
  }
  const lead = v < 0 ? '-' : (sign ? '+' : '');
  return `${lead}${body}${suffix}`;
}
