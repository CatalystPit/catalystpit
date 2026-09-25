// THE FACTS A FORM 4 GROUP CARRIES — written once, read by both resolvers.
//
// ── ⚠️ WHY THIS FILE EXISTS ────────────────────────────────────────────────
//
// Two resolvers turn insider_trades rows into evidence: resolve.js for the 45-day "what changed"
// view, and timeline.js for the chart's historical range. They are separate on purpose — one
// aggregates a window, the other groups by filing day — but they had each grown their OWN copy of
// the facts block, and the copies had drifted.
//
// The drift was not cosmetic. highSignificance() — the canonical attention tag that decides whether
// a marker is promoted on the chart — reads `leadRoleValue`, `topBuyerValue` and `totalValue`.
// resolve.js emitted all three; timeline.js emitted none of them. So a CEO's $10.0M open-market
// purchase was correctly promoted everywhere resolve.js fed, and could not be promoted at all on
// the ticker chart, which is fed by timeline.js. Same filing, same engine, two answers — and the
// one a trader was actually looking at was the silent one.
//
// Anything a consumer keys off must therefore live HERE, so a third consumer cannot be born missing
// a field that decides how something renders.
//
// ── ⚠️ THIS COMPUTES FACTS. IT DOES NOT JUDGE THEM. ────────────────────────
//
// No threshold, no score, no materiality. It sums what the filings state and reports what they
// state, and refuses to report anything it would have to estimate.

import { isLeadRole } from '../consensus/high-significance.mjs';

const num = (v) => (v == null ? null : Number(v));
const msOf = (d) => (d == null ? null : new Date(d).getTime());

/** 'YYYY-MM-DD' for a date-ish value, or null. */
export function isoDayOf(v) {
  const t = msOf(v);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

/**
 * The transaction date shared by a set of Form 4 rows, or null when they do not share one.
 *
 * ⚠️ ONE DATE OR NONE — NEVER A REPRESENTATIVE ONE. A Form 4 evidence object can aggregate several
 * purchases, and picking the newest of five transaction dates to stand for all of them would put a
 * date on the card that four of the transactions did not happen on.
 */
export function sharedEventDay(list) {
  const days = new Set();
  for (const x of list || []) {
    const d = isoDayOf(x?.transaction_date);
    if (!d) return null;                 // one unreadable date makes the set unknowable
    days.add(d);
  }
  return days.size === 1 ? [...days][0] : null;
}

/**
 * The span the transactions actually cover, or null.
 *
 * ⚠️ A RANGE IS NOT AN ESTIMATE — IT IS TWO FILED DATES. Measured across 40 active tickers, only
 * 13% of insider evidence objects aggregate a single transaction, so reporting only the unambiguous
 * case left seven of eight cards with no transaction date at all.
 */
export function eventDayRange(list) {
  const days = [];
  for (const x of list || []) {
    const d = isoDayOf(x?.transaction_date);
    if (!d) return null;
    days.push(d);
  }
  if (!days.length) return null;
  days.sort();
  return { from: days[0], to: days[days.length - 1] };
}

/**
 * An eventTime that cannot break the engine's own invariant.
 *
 * ⚠️ publicTime >= eventTime IS ENFORCED BY makeEvidence, AND A VIOLATION QUARANTINES THE WHOLE
 * OBJECT. A stored transaction date somehow later than its filing date must therefore not be handed
 * over: doing so would delete a legitimate purchase from the chart in order to show a date.
 */
export function eventClock(eventDay, publicTime) {
  if (!eventDay) return null;
  const e = msOf(`${eventDay}T00:00:00Z`);
  const p = msOf(publicTime);
  if (e == null || p == null || Number.isNaN(e) || Number.isNaN(p) || e > p) return null;
  return new Date(e).toISOString();
}

/** Currency label in the engine's own shape. */
export function usdLabel(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}

/**
 * The facts block for a group of Form 4 purchase rows.
 *
 * ⚠️ topBuyer IS A PERSON'S TOTAL, NOT THEIR LARGEST TICKET. Three $400K purchases by one officer
 * is a $1.2M commitment by one person, and splitting it across filings must not hide it.
 *
 * ⚠️ AND leadRoleValue IS WHAT THE ATTENTION TAG READS. Omitting it does not make a marker smaller;
 * it makes the marker un-promotable, which is invisible until someone reports that a $10M CEO
 * purchase looks like a quarterly breadth change.
 */
export function insiderBuyFacts(buyRows) {
  const list = Array.isArray(buyRows) ? buyRows : [];
  const buyers = [...new Set(list.map((x) => x.executive).filter(Boolean))];
  const totalValue = list.reduce((s, x) => s + (num(x.total_value) || 0), 0);

  const byPerson = new Map();
  for (const x of list) {
    const k = x.executive || '(unknown)';
    byPerson.set(k, (byPerson.get(k) || 0) + (num(x.total_value) || 0));
  }
  let topBuyer = null, topBuyerValue = 0;
  for (const [k, v] of byPerson) if (v > topBuyerValue) { topBuyer = k; topBuyerValue = v; }

  // The filed title is the only role source; it is present on 100% of buys measured.
  const lead = list.filter((x) => isLeadRole(x.title));
  const leadValue = lead.reduce((s, x) => s + (num(x.total_value) || 0), 0);
  const officerRow = list.find((x) => x.officer);

  return {
    buyers: buyers.length,
    transactions: list.length,
    totalValue: totalValue || null,
    totalValueLabel: usdLabel(totalValue),
    officer: !!officerRow,
    executive: officerRow?.executive || list[0]?.executive || null,
    title: officerRow?.title || list[0]?.title || null,
    topBuyer,
    topBuyerValue: topBuyerValue || null,
    leadRoleValue: leadValue || null,
    leadRoleTitle: lead[0]?.title || null,
    leadRoleExecutive: lead[0]?.executive || null,
    ...transactionFacts(list),
  };
}

/** The facts block for a group of discretionary sale rows. */
export function insiderSellFacts(sellRows) {
  const list = Array.isArray(sellRows) ? sellRows : [];
  const sellers = [...new Set(list.map((x) => x.executive).filter(Boolean))];
  const totalValue = list.reduce((s, x) => s + (num(x.total_value) || 0), 0);
  return {
    sellers: sellers.length,
    transactions: list.length,
    totalValue: totalValue || null,
    totalValueLabel: usdLabel(totalValue),
    executive: list[0]?.executive || null,
    title: list[0]?.title || null,
    ...transactionFacts(list),
  };
}

/**
 * Shares, price and dates — the figures a reader asks for after the headline number.
 *
 * ⚠️ SHARES SUM EXACTLY; A PRICE DOES NOT. Adding share counts across filings is arithmetic, so it
 * is always reported. A price per share is reported only for a SINGLE transaction, because blending
 * several fills into one number would be a figure no filing contains.
 */
function transactionFacts(list) {
  const shares = list.reduce((s, x) => s + (num(x.shares) || 0), 0);
  return {
    shares: shares || null,
    pricePerShare: list.length === 1 ? (num(list[0].price_per_share) || null) : null,
    transactionDate: sharedEventDay(list),
    transactionSpan: eventDayRange(list),
  };
}
