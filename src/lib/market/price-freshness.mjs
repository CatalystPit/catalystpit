import { boardStatusLabel, aggregateFreshness } from '../scan/scan-rows.mjs';

// WHAT THE BADGE OVER A PRICE IS ALLOWED TO SAY.
//
// ── ⚠️ THE DEFECT ────────────────────────────────────────────────────────────────────────────────
//
// MarketSnapshotCard and TickerTape each printed the string "DELAYED" into the markup
// unconditionally. So the homepage told a paying Pro subscriber their prices were delayed, and told
// a signed-out visitor exactly the same thing over FRIDAY'S CLOSES. Measured mid-session on Monday
// 2026-11-23: the tape served 2026-11-20 closes, NVDA at 125.53 against a live print of 166.55.
// One literal standing in for three different products, and wrong for all three.
//
// ── ⚠️ IT READS THE SERVED QUOTES, NEVER THE TIER ────────────────────────────────────────────────
//
// Being entitled to real-time and receiving it are different facts, and only the second may be
// announced — the rule the scan board's FeedBanner is already written around. A Pro reader whose
// licence flag is off, or whose provider has gone quiet, must see the truth about the prices on the
// screen rather than a claim about their subscription. That is also what makes this safe to ship
// without knowing whether this deployment's real-time licence is switched on: an unlicensed
// deployment stamps 'eod' and the badge says LAST CLOSE.
//
// ── ⚠️ AND IT IS A PURE MODULE BECAUSE THE FIRST VERSION WAS NOT ─────────────────────────────────
//
// These two functions lived in cp-shared.jsx, which pulls in React, Clerk and next/navigation and
// therefore cannot be imported by a test. The suite restated the two-line composition and pinned the
// shipped copy with a regex — a test that executes its own copy of the logic and greps the real one
// is the shape that has produced several false greens in this codebase. Here, the suite runs this.
//
// The vocabulary is deliberately NOT new: boardStatusLabel is what the scan board and the Terminal
// already print and seven verify suites already pin.

/**
 * The badge text for one freshness, with the delay appended when the payload states one.
 *
 * ⚠️ THE MEASURED DELAY, NOT AN ASSUMED FIFTEEN. The released delayed snapshot was 40 minutes old
 * when this was written — the capture fires every 15 minutes and the store holds a release back
 * until it is at least 15 minutes stale, so "15-MIN DELAYED" is a number the product cannot
 * promise. A bare "DELAYED" over a 40-minute-old price is the same approximation in the other
 * direction, so the figure is shown when it is known.
 */
export function priceFreshnessLabel(freshness, delayMinutes = null) {
  const base = boardStatusLabel(freshness);
  const m = Number(delayMinutes);
  return (freshness === 'delayed' && Number.isFinite(m) && m > 0)
    ? `${base} · ${Math.round(m)}M`
    : base;
}

/**
 * The single freshness a set of served quotes adds up to, with the delay they report.
 *
 * aggregateFreshness is the shared rule, and it exists because this was got wrong twice in opposite
 * directions on the scan board: one unpriced symbol must not collapse a live tape to LAST CLOSE, and
 * a mixture must not borrow the live claim on behalf of everything in it.
 *
 * ⚠️ `delayMinutes` TAKES THE WORST DELAY PRESENT. A badge over a row of prices may not quote the
 * most flattering number in it.
 */
export function quotesFreshness(quotes) {
  const list = Object.values(quotes || {}).filter((q) => q && typeof q === 'object');
  if (!list.length) return { freshness: null, delayMinutes: null };
  const delays = list.map((q) => Number(q.delayMinutes)).filter((n) => Number.isFinite(n) && n > 0);
  return {
    freshness: aggregateFreshness(list.map((q) => q.freshness)),
    delayMinutes: delays.length ? Math.max(...delays) : null,
  };
}
