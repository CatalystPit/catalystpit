// MARKET STRUCTURE FACTS — what price actually did, and when.
//
// ── THE V2.1 FAILURE THIS FIXES ─────────────────────────────────────────────
//
// The card said "Market Diverging" and stopped. A trader could not tell what price did, what it was
// diverging from, whether the move was 1% or 8%, or whether it happened before or after the
// evidence became public. "Diverging" without the move is a label, not a fact.
//
// ── WHAT WE MAY HONESTLY SAY TODAY ──────────────────────────────────────────
//
// Measured, not assumed. The Tiingo account reports `quoteFreshness: eod`, `liveVolume: false`,
// `consolidatedVolume: false`, `streaming: false`, and THERE IS NO INTRADAY TABLE IN THE DATABASE.
// So this module is built entirely on daily bars, and the following are deliberately ABSENT rather
// than approximated:
//
//   VWAP / VWAP reclaim      needs intraday bars with consolidated volume — we have neither
//   RVOL, volume spike       needs consolidated live volume AND time-of-day volume history;
//                            `intradayVolumeHistory` is false and intraday bars carry no volume
//   opening range            needs today's intraday bars
//   session / premarket H-L  needs today's extended-hours intraday bars
//   intraday relative strength  needs the symbol AND every benchmark on the same intraday clock
//
// A card that showed any of those would be inventing them. Missing is better than false.
//
// ── THE ANCHOR ──────────────────────────────────────────────────────────────
//
// Reaction is measured from PUBLIC TIME using the existing, tested reaction engine — never from a
// transaction date, a quarter end, or a report date. That module already handles the 16:00 ET
// boundary, weekends, holidays, incomplete windows and price breaks; reimplementing it here would
// be a second opinion about the most look-ahead-prone calculation in the product.

// The database is imported LAZILY, inside loadBars. levelFacts() and marketNarrative() are pure and
// must stay importable — and therefore testable — without a database connection.

import { structureFacts, structureLines as linesForStructure } from './structure-levels.mjs';

export const MARKET_FACTS_VERSION = 'consensus_v3_market_facts';

/** Roughly 52 weeks of sessions plus padding, which is all any level below needs. */
const BAR_DAYS = 400;
const SESSIONS_20D = 20;
const SESSIONS_52W = 252;

// A move smaller than this is not a story. Daily closes round, companies drift, and calling a 0.2%
// change "confirmation" would make the word meaningless. Used ONLY for the narrative line — the
// canonical CONFIRMING/DIVERGING verdict still comes from V2.1's marketConfirmation().
export const MEANINGFUL_MOVE_PCT = 1.0;

const pct = (from, to) => (Number.isFinite(from) && Number.isFinite(to) && from > 0
  ? ((to - from) / from) * 100 : null);

/** Daily closes/highs/lows for one ticker, oldest first. */
async function loadBars(ticker, ctx = null) {
  // ⚠️ SERVED FROM THE SAME PRELOADED CANDLES AS STRUCTURE. BAR_DAYS is 400 and the context holds
  // 4,380, so the in-memory filter reproduces this query's rows exactly — one load, three readers.
  const pre = ctx?.rows('price.candles', ticker);
  if (pre) {
    const cutoff = new Date(Date.now() - BAR_DAYS * 86400000).toISOString().slice(0, 10);
    return pre.filter((r) => String(r.date) >= cutoff && Number.isFinite(Number(r.close)))
      .map((r) => ({ date: String(r.date), close: Number(r.close), high: Number(r.high),
        low: Number(r.low), open: Number(r.open) }));
  }
  const [{ db }, { sql }] = await Promise.all([import('../db'), import('drizzle-orm')]);
  const res = await db.execute(sql`
    select date::text as date, close::float8 as close, high::float8 as high, low::float8 as low,
           open::float8 as open
      from ticker_daily_candles
     where ticker = ${String(ticker).toUpperCase()}
       and date >= current_date - make_interval(days => ${BAR_DAYS})
     order by date asc`);
  const rows = Array.isArray(res) ? res : (res?.rows || []);
  return rows.filter((r) => Number.isFinite(r.close));
}

/**
 * Daily level context. Every value is an end-of-day fact and is labelled as one.
 *
 * Returns null rather than partial guesses when there is not enough history — an unknown level is
 * not a level of zero, and "broke the 52-week high" computed from 30 bars would be a lie.
 */
export function levelFacts(bars) {
  if (!bars || bars.length < 2) return null;
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];

  const changePct = pct(prev.close, last.close);
  const w20 = bars.slice(-SESSIONS_20D);
  const w52 = bars.slice(-SESSIONS_52W);

  const hi = (w) => w.reduce((a, b) => (Number.isFinite(b.high) && b.high > a ? b.high : a), -Infinity);
  const lo = (w) => w.reduce((a, b) => (Number.isFinite(b.low) && b.low < a ? b.low : a), Infinity);

  const high20 = w20.length >= SESSIONS_20D ? hi(w20) : null;
  const low20 = w20.length >= SESSIONS_20D ? lo(w20) : null;
  const high52 = w52.length >= SESSIONS_52W ? hi(w52) : null;
  const low52 = w52.length >= SESSIONS_52W ? lo(w52) : null;

  return {
    asOf: last.date,
    close: last.close,
    prevClose: prev.close,
    changePct: Number.isFinite(changePct) ? Math.round(changePct * 100) / 100 : null,
    abovePrevClose: Number.isFinite(changePct) ? changePct > 0 : null,
    // `bars` is the honest denominator for every claim below.
    sessions: bars.length,
    high20, low20, high52, low52,
    fiveDayPct: bars.length >= 6 ? Math.round(pct(bars[bars.length - 6].close, last.close) * 100) / 100 : null,
    pctFrom20dHigh: Number.isFinite(high20) && high20 > 0
      ? Math.round(((last.close - high20) / high20) * 10000) / 100 : null,
    at20dHigh: Number.isFinite(high20) ? last.close >= high20 : null,
    at20dLow: Number.isFinite(low20) ? last.close <= low20 : null,
    at52wHigh: Number.isFinite(high52) ? last.close >= high52 : null,
    at52wLow: Number.isFinite(low52) ? last.close <= low52 : null,
  };
}

/**
 * Turn the reaction + levels into the sentences a card shows.
 *
 * @param {object} reaction the canonical reaction object attached to the DRIVING evidence record
 * @param {object} levels   levelFacts()
 * @param {string} verdict  V2.1's CONFIRMING | DIVERGING | MIXED | UNAVAILABLE — never recomputed here
 */
export function marketNarrative({ reaction, levels, verdict, join, driverLabel = 'the evidence' } = {}) {
  const lines = [];

  // 1. THE EVENT REACTION — what price did after the evidence became public.
  //    Measured: the MEDIAN absolute 1-session move across 195 real reactions is 1.60%. So a move
  //    is REPORTED whatever its size, but it is only called meaningful once it clears the floor on
  //    both the absolute and the SPY-relative leg. V3 called +0.8% 'diverging'; that was the 25th
  //    to 50th percentile of ordinary daily noise wearing a market opinion.
  // ⚠️ WHEN THE REACTION CANNOT BE MEASURED, SAY SO AND STOP. The old card filled this space with
  // "+54.3% last session · above prior close" and "5D +41.6%" — returns that have nothing to do
  // with the evidence and are not a reaction to anything. An empty, honest section beats a full,
  // irrelevant one.
  const measured = Boolean(reaction && Number.isFinite(reaction.abs));
  if (measured) {
    const sign = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
    // ⚠️ THE SPY-RELATIVE LEG IS COMPUTED, STILL BINDING, AND NO LONGER SHOWN.
    //
    // `reaction.rel` is untouched: evidence-model.mjs still requires a move to clear the floor on
    // BOTH the absolute and the relative leg before it is called meaningful, and the field remains
    // on the reaction object for research and for a benchmark choice made later. What changed is
    // that the card no longer prints it beside the stock's own move.
    //
    // The question this section answers is "how did THIS stock react once the evidence was
    // public". A single market-wide benchmark appended to every ticker's primary readout answers a
    // different question, and answers it badly for the ones SPY does not represent. Removing the
    // text changes no number, no threshold and no classification — the relative move goes on
    // deciding `meaningful`, it just stops being presented as part of the reaction itself.
    lines.push(`${sign(reaction.abs)} in the session after it became public`);
    if (Number.isFinite(reaction.five)) lines.push(`${sign(reaction.five)} over 5 sessions since`);
    if (!reaction.meaningful) {
      lines.push(`Below the ${reaction.floorPct.toFixed(1)}% threshold for a meaningful response`);
    }
  }

  // ⚠️ THE GENERIC-RETURN BLOCK THAT USED TO SIT HERE IS GONE. It emitted "+1.4% last session",
  // "5D +0.7%" and "-39.7% below the 20-day high" under a MARKET STRUCTURE heading. The first two
  // are performance a trader reads anywhere and say nothing about location; the third names a
  // distance to a level it never showed. Location now comes from structure-levels.mjs, which names
  // the level, and this function is left as what it always was: the event reaction.

  // 3. THE JOIN, in words. Inside the dead zone this is never confirming and never diverging.
  let explain = null;
  if (join?.state === 'PRICE_DIVERGING') explain = `Price is moving against ${driverLabel}`;
  else if (join?.state === 'PRICE_CONFIRMING') explain = `Price is moving with ${driverLabel}`;
  else if (join?.state === 'SOURCES_CONFLICT') explain = 'Independent sources disagree; price is not the tiebreaker';
  else if (join?.state === 'EVIDENCE_BUILDING' || join?.state === 'NO_REACTION') {
    explain = reaction?.reason === 'not-measured'
      ? 'No measurable price response yet'
      : 'No meaningful price response to the evidence';
  }

  return {
    lines,
    measured,
    explain,
    // Stated so no reader mistakes any of this for live intraday data.
    basis: 'End-of-day closes. Intraday, volume and VWAP measures are unavailable on the current '
      + 'market-data entitlement and are omitted rather than estimated.',
  };
}

export async function marketFactsFor(ticker, { driver = null, reaction = null, join = null, verdict = 'UNAVAILABLE', driverLabel, ctx = null } = {}) {
  let levels = null;
  let structure = null;
  let structureLines = [];
  // ⚠️ DO WE HOLD ANY PRICE HISTORY FOR THIS TICKER AT ALL? A separate question from whether a
  // LEVEL can be drawn: a company can be a legitimate SEC filer with real insider evidence and no
  // vendor price coverage, in which case every price surface must decline rather than render empty.
  let sessions = 0;
  try {
    // ⚠️ ONE BAR LOAD FOR BOTH. Structure and levels read the same completed-session candles, so
    // adding structure costs no extra query — which is what keeps this out of the React card and
    // free of an N+1.
    const bars = await loadBars(ticker, ctx);
    sessions = bars.length;
    levels = levelFacts(bars);
    structure = structureFacts(bars);
    structureLines = linesForStructure(structure);
  } catch (e) {
    // A candle-query failure is unknown structure, not flat structure — but it is LOGGED, because a
    // silent null here is exactly how the level facts went missing from every card unnoticed.
    console.warn(`[market-facts] ${ticker} levels unavailable: ${e.message}`);
    levels = null; structure = null; structureLines = []; sessions = 0;
  }
  const narrative = marketNarrative({ reaction, levels, verdict, join, driverLabel });
  return {
    version: MARKET_FACTS_VERSION,
    verdict,
    // The JOIN state is the trader-facing verdict now; `verdict` is V2.1's structure reading,
    // retained for existing consumers.
    joinState: join?.state || null,
    meaningfulReaction: Boolean(reaction?.meaningful),
    levels,
    // WHERE PRICE SITS — named levels from completed daily candles. Separate from the reaction
    // above, which is what price DID after the evidence became public.
    structure,
    structureLines,
    // Consumed by any surface that would otherwise offer a chart for a ticker we cannot chart.
    sessions,
    reaction: driver?.reaction
      ? { anchorDate: driver.reaction.anchorDate, anchorBasis: driver.reaction.anchorBasis,
        benchmark: driver.reaction.benchmark, horizons: driver.reaction.horizons }
      : null,
    // Which record the reaction is anchored to, so the card can say what it is measuring from.
    anchoredTo: driver ? { evidenceId: driver.evidenceId, family: driver.family, publicTime: driver.publicTime } : null,
    ...narrative,
  };
}
