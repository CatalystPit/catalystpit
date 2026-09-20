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
async function loadBars(ticker) {
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
  if (reaction && Number.isFinite(reaction.abs)) {
    const sign = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
    lines.push(`${sign(reaction.abs)} in the session after it became public`
      + (Number.isFinite(reaction.rel) ? ` · ${sign(reaction.rel)} vs SPY` : ''));
    if (Number.isFinite(reaction.five)) lines.push(`${sign(reaction.five)} over 5 sessions since`);
    if (!reaction.meaningful) {
      lines.push(`Below the ${reaction.floorPct.toFixed(1)}% threshold for a meaningful response`);
    }
  }

  // 2. CURRENT STRUCTURE — end-of-day facts, separate from the event reaction.
  if (levels) {
    if (Number.isFinite(levels.changePct)) {
      lines.push(`${levels.changePct >= 0 ? '+' : ''}${levels.changePct.toFixed(1)}% last session`
        + ` · ${levels.changePct >= 0 ? 'above' : 'below'} prior close`);
    }
    if (Number.isFinite(levels.fiveDayPct)) {
      lines.push(`5D ${levels.fiveDayPct >= 0 ? '+' : ''}${levels.fiveDayPct.toFixed(1)}%`);
    }
    if (levels.at52wHigh) lines.push('At a 52-week closing high');
    else if (levels.at52wLow) lines.push('At a 52-week closing low');
    else if (levels.at20dHigh) lines.push('At a 20-day closing high');
    else if (levels.at20dLow) lines.push('At a 20-day closing low');
    else if (Number.isFinite(levels.pctFrom20dHigh)) {
      lines.push(`${levels.pctFrom20dHigh.toFixed(1)}% below the 20-day high`);
    }
  }

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
    explain,
    // Stated so no reader mistakes any of this for live intraday data.
    basis: 'End-of-day closes. Intraday, volume and VWAP measures are unavailable on the current '
      + 'market-data entitlement and are omitted rather than estimated.',
  };
}

export async function marketFactsFor(ticker, { driver = null, reaction = null, join = null, verdict = 'UNAVAILABLE', driverLabel } = {}) {
  let levels = null;
  try {
    levels = levelFacts(await loadBars(ticker));
  } catch (e) {
    // A candle-query failure is unknown structure, not flat structure — but it is LOGGED, because a
    // silent null here is exactly how the level facts went missing from every card unnoticed.
    console.warn(`[market-facts] ${ticker} levels unavailable: ${e.message}`);
    levels = null;
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
    reaction: driver?.reaction
      ? { anchorDate: driver.reaction.anchorDate, anchorBasis: driver.reaction.anchorBasis,
        benchmark: driver.reaction.benchmark, horizons: driver.reaction.horizons }
      : null,
    // Which record the reaction is anchored to, so the card can say what it is measuring from.
    anchoredTo: driver ? { evidenceId: driver.evidenceId, family: driver.family, publicTime: driver.publicTime } : null,
    ...narrative,
  };
}
