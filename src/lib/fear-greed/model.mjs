// CATALYST PIT FEAR & GREED — the methodology, pure.
//
// No database, no vendor, no clock. Raw component values go in, a 0-100 index comes out, and every
// rule below can be exercised with numbers. data.mjs supplies the observations; this file decides
// what they mean.
//
// ── ⚠️ THIS MEASURES SENTIMENT. IT DOES NOT PREDICT RETURNS. ────────────────
//
// Nothing here is fitted to anything. Weights are equal because we have no defensible reason to
// prefer one component over another, and tuning them against historical returns would quietly turn
// a sentiment gauge into a backtested signal — a different product with a different burden of proof.
//
// ── ⚠️ WHAT WE DO NOT HAVE, AND DO NOT FAKE ─────────────────────────────────
//
// There is no implied-volatility component, because Catalyst Pit has no entitled source for the VIX
// index: Tiingo returns 404 for it, FMP 403 (legacy endpoint), Finnhub "market data subscription
// required for CFD indices" and Polygon NOT_AUTHORIZED. Deriving a VIX-like number from stock
// prices and calling it volatility would be inventing data.
//
// What we CAN compute from our own licensed daily bars is two DIFFERENT volatility statistics, and
// each is labelled as what it is everywhere it appears:
//
//   Realized Volatility  what the equity market actually did — the dispersion of SPY's own returns.
//   Market Volatility    whether the volatility market is stressed relative to its own recent
//                        trend, read from a traded instrument. Not the VIX, not implied volatility,
//                        and never a price level presented as a volatility reading.
//
// Neither replaces the other and neither is a VIX proxy. V2 added the second; see COMPONENTS.
//
// There IS a put/call component as of V3 — Options Sentiment — and it reads official cleared
// equity-options VOLUME from the clearing house, not an estimate and not open interest. What we
// still do not have is a customer-only breakdown: see occ.mjs for why that endpoint cannot serve
// one. The component is all-account cleared volume and says so where it matters.
//
// See METHODOLOGY at the bottom for the full disclosure the UI renders.

/**
 * ⚠️ null IS NOT ZERO, AND JavaScript DISAGREES.
 *
 * `Number(null)` is 0 and `Number('')` is 0, so a plain Number()/isFinite() guard accepts BOTH as
 * valid scores. Caught by the suite: zoneFor(null) returned EXTREME FEAR, which would have rendered
 * an unavailable index as the most alarming reading on the card, and scoreComponent() scored a
 * missing raw value as if it were 0. A missing number has to be missing all the way through.
 */
export const finite = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The five zones, in ascending order. Boundaries are inclusive of the lower bound. */
export const ZONES = Object.freeze([
  { max: 24, label: 'EXTREME FEAR', key: 'extreme-fear' },
  { max: 44, label: 'FEAR', key: 'fear' },
  { max: 55, label: 'NEUTRAL', key: 'neutral' },
  { max: 75, label: 'GREED', key: 'greed' },
  { max: 100, label: 'EXTREME GREED', key: 'extreme-greed' },
]);

/** 0-24 EXTREME FEAR · 25-44 FEAR · 45-55 NEUTRAL · 56-75 GREED · 76-100 EXTREME GREED */
export function zoneFor(score) {
  const s = finite(score);
  if (s === null) return null;
  const clamped = Math.min(100, Math.max(0, s));
  return ZONES.find((z) => clamped <= z.max) || ZONES[ZONES.length - 1];
}

/**
 * The zones as continuous [from, to] bands on the 0-100 axis, for anything that DRAWS the scale.
 *
 * ⚠️ DERIVED FROM ZONES, NEVER RETYPED. The gauge arc and the history chart both shade this
 * scale, and a drawn boundary that disagrees with the classifying boundary is the worst kind of
 * wrong: the picture stays plausible while a needle sits in a band whose name contradicts the
 * word printed next to it. ZONES holds the inclusive integer maxima; the .5 offsets put each cut
 * exactly halfway between two integer scores, so neither band claims a value belonging to the
 * other and the five bands still tile 0-100 without a gap.
 */
export const ZONE_BANDS = Object.freeze(ZONES.map((z, i) => Object.freeze({
  key: z.key,
  label: z.label,
  from: i === 0 ? 0 : ZONES[i - 1].max + 0.5,
  to: i === ZONES.length - 1 ? 100 : z.max + 0.5,
})));

// ── NORMALISATION ────────────────────────────────────────────────────────────
//
// ── ⚠️ PERCENTILE RANK, NOT A RAW-VALUE MAPPING ────────────────────────────
//
// "VIX 30 = fear" is an arbitrary constant that ages badly and means nothing across regimes. Every
// component here is scored by where TODAY sits inside its OWN trailing distribution, so each answers
// the same question: how unusual is this, for this measure, lately.
//
// ⚠️ AND RANK IS WHY ONE OUTLIER CANNOT DESTROY THE SCALE. A single crash print moves a mean or a
// z-score for years; it moves a rank by exactly one observation. That is the robustness requirement,
// satisfied by construction rather than by winsorising to a threshold somebody has to choose.
//
// The convention is mid-rank: strictly-below plus half the ties. A value equal to the median scores
// 50 whether or not the sample has an even count, and a series of identical values scores 50 rather
// than 0 or 100.

/**
 * Where `value` sits inside `history`, as 0-100.
 *
 * @param {number} value    the current observation; MUST also be present in `history`
 * @param {number[]} history the trailing window, including the current observation
 */
export function percentileRank(value, history) {
  const v = finite(value);
  const xs = (history || []).map(finite).filter((x) => x !== null);
  if (v === null || xs.length === 0) return null;
  let below = 0, equal = 0;
  for (const x of xs) {
    if (x < v) below++;
    else if (x === v) equal++;
  }
  return (100 * (below + 0.5 * equal)) / xs.length;
}

/**
 * ⚠️ DIRECTION IS DECLARED PER COMPONENT AND APPLIED IN ONE PLACE.
 *
 * Every component must end up meaning the same thing: 0 is maximum fear, 100 is maximum greed. For
 * most, a higher raw value is greedier. For volatility it is the reverse — a high realized vol is
 * fear — and for anything spread-like a wider number is fear too. Inverting at the point of scoring
 * means no consumer downstream has to remember which way a given measure runs.
 */
export const DIRECTION = Object.freeze({ HIGHER_IS_GREED: 1, HIGHER_IS_FEAR: -1 });

/**
 * The trailing window every component is normalised against: two years of sessions.
 *
 * ⚠️ WHY IT IS BOUNDED BY OUR DATA, NOT BY PREFERENCE. The two credit instruments carry 762
 * sessions in our store, and the 52-week high/low lookback consumes 252 of the equity panel's
 * history, so two years is the longest window every component can actually fill. A longer one would quietly leave the credit
 * component ranking against a shorter history than the others.
 */
export const NORM_WINDOW = 504;

/**
 * Observations required before a component may be scored at all.
 *
 * ⚠️ EQUAL TO THE WINDOW, DELIBERATELY. An expanding window — rank against 252 early on, 756 later
 * — makes two published points incomparable: the same percentile means something different when it
 * is drawn from a third as many observations. Requiring the FULL window means every score the index
 * ever prints was ranked against exactly `NORM_WINDOW` sessions. A component that cannot fill it is
 * refused, which is the same discipline applied everywhere else here: absent, never estimated.
 */
export const MIN_WINDOW = NORM_WINDOW;

/**
 * Score one component 0-100.
 *
 * @returns {{score,raw,direction,samples}|null} null when there is not enough history to rank
 *          against — which is a REFUSAL, never a 50. See composite().
 */
export function scoreComponent({ raw, history, direction = DIRECTION.HIGHER_IS_GREED } = {}) {
  const v = finite(raw);
  const xs = (history || []).map(finite).filter((x) => x !== null);
  if (v === null || xs.length < MIN_WINDOW) return null;
  const pct = percentileRank(v, xs);
  if (pct === null) return null;
  // ⚠️ THE INVERSION IS 100 - p, NOT -p. Reversing a percentile keeps it inside 0-100 and keeps the
  // midpoint at 50, which is what makes "neutral" mean the same thing for every component.
  const score = direction === DIRECTION.HIGHER_IS_FEAR ? 100 - pct : pct;
  return {
    score: Math.min(100, Math.max(0, Math.round(score * 10) / 10)),
    raw: v,
    direction,
    samples: xs.length,
  };
}

// ── THE COMPOSITE ────────────────────────────────────────────────────────────

/**
 * ⚠️ HOW MANY COMPONENTS THE INDEX NEEDS BEFORE IT IS WORTH PRINTING.
 *
 * Below this the average stops describing the market and starts describing whichever feed happened
 * to be up. Three of five is the floor: it keeps the index alive through a single bad vendor day
 * while refusing to publish a number built on one or two measures.
 */
/**
 * ⚠️ STILL THREE AFTER THE INDEX GREW TO SIX COMPONENTS, AND THAT IS A DECISION.
 *
 * Three of five was a majority; three of six is half. The temptation is to scale it to four so the
 * ratio is preserved — and that would be a stricter index than the one this floor was chosen for.
 * The floor answers "how few measures can still describe a market rather than a vendor outage",
 * which is a question about the absolute number of independent measures, not about the fraction of
 * a registry whose size is our editorial choice. Raising it to four would also retire readings the
 * V1 index published: 103 of its 507 sessions ran on exactly three components while the credit and
 * momentum series were still filling their windows, and they were honest readings.
 *
 * So the count is unchanged, which is also what keeps V1 and V2 comparable where they overlap:
 * every session V1 could publish, V2 can publish.
 */
export const MIN_COMPONENTS = 3;

/**
 * Equal-weighted mean of the components that produced a score.
 *
 * ⚠️ A MISSING COMPONENT IS NOT A 50. Substituting neutral for absent would silently drag the index
 * toward the middle and present a data outage as a market reading. An absent component is dropped
 * from both the numerator and the denominator, and if too many are absent the index refuses to
 * publish at all.
 */
export function composite(components = {}) {
  const entries = Object.entries(components).filter(([, c]) => c && Number.isFinite(c.score));
  const missing = Object.entries(components).filter(([, c]) => !c || !Number.isFinite(c.score))
    .map(([k]) => k);
  if (entries.length < MIN_COMPONENTS) {
    return {
      available: false,
      reason: 'insufficient-components',
      score: null, zone: null,
      included: entries.map(([k]) => k),
      missing,
      componentCount: entries.length,
      minComponents: MIN_COMPONENTS,
    };
  }
  const sum = entries.reduce((a, [, c]) => a + c.score, 0);
  const score = Math.round((sum / entries.length) * 10) / 10;
  return {
    available: true,
    reason: 'ok',
    score,
    zone: zoneFor(score),
    included: entries.map(([k]) => k),
    missing,
    componentCount: entries.length,
    minComponents: MIN_COMPONENTS,
  };
}

// ── THE COMPONENT REGISTRY ───────────────────────────────────────────────────
//
// One place naming every component, what it reads, and which way it runs. The UI renders from this
// so a label can never drift from the calculation behind it.

export const COMPONENTS = Object.freeze([
  {
    key: 'momentum',
    label: 'Market Momentum',
    direction: DIRECTION.HIGHER_IS_GREED,
    source: 'Our own licensed daily bars for SPY (Tiingo EOD, stored in ticker_daily_candles).',
    calculation: 'SPY close divided by its 125-session simple moving average, minus 1.',
    meaning: 'How far the broad market sits above or below its own medium-term trend.',
  },
  {
    key: 'volatility',
    // ⚠️ THE LABEL SAYS REALIZED BECAUSE THE NUMBER IS REALIZED. 'Market Volatility' beside a
    // sentiment gauge invites a reader to assume VIX; this is computed from SPY's own returns and
    // must never be read as implied volatility.
    label: 'Realized Volatility',
    direction: DIRECTION.HIGHER_IS_FEAR,
    source: 'Our own licensed daily bars for SPY.',
    calculation: 'Annualised standard deviation of the last 21 daily log returns of SPY '
      + '(population standard deviation x sqrt(252)).',
    meaning: 'REALIZED volatility, not implied. Catalyst Pit has no entitled source for the VIX '
      + 'index, so this measures what the market actually did rather than what options imply.',
  },
  {
    key: 'marketvol',
    label: 'Market Volatility',
    // ⚠️ HIGHER IS FEAR, AND THE INVERSION LIVES IN scoreComponent. A volatility market bid above
    // its own trend is protection being paid for.
    direction: DIRECTION.HIGHER_IS_FEAR,
    // ── ⚠️ THE ONLY COMPONENT WHOSE RECIPE IS NOT PUBLISHED ──────────────────
    //
    // `source`, `calculation` and `meaning` are served by /api/fear-greed and rendered verbatim by
    // the methodology panel, so these three strings ARE the public disclosure. The instrument, the
    // moving-average length and the inversion are deliberately absent from them — they live in
    // series.mjs and data.mjs, which nothing public reads. Two things they must never say, whatever
    // gets edited here later: this is not the VIX, and it is not a price level.
    source: 'Our own licensed daily bars for a market-traded short-term volatility instrument.',
    calculation: 'Proprietary. The volatility market measured against its own recent trend, then '
      + 'ranked in the same trailing distribution every other component is ranked in. It is a '
      + 'relative measure by construction: no absolute price level is used as a volatility reading.',
    meaning: 'Measures whether volatility stress is elevated or subdued relative to its recent '
      + 'trend. This is NOT the VIX and is not implied volatility — Catalyst Pit has no entitled '
      + 'source for the VIX index — and it is a different measurement from Realized Volatility, '
      + 'which is what the equity market actually did.',
  },
  {
    key: 'breadth',
    label: 'Market Breadth',
    direction: DIRECTION.HIGHER_IS_GREED,
    source: 'Our own licensed daily bars for the eligible U.S. equity universe.',
    calculation: 'Share of eligible tickers whose close is above their own 50-session simple '
      + 'moving average, on that session.',
    meaning: 'How broadly the advance is shared, rather than how far the index moved.',
  },
  {
    key: 'strength',
    label: 'Price Strength',
    direction: DIRECTION.HIGHER_IS_GREED,
    source: 'Our own licensed daily bars for the eligible U.S. equity universe.',
    calculation: 'Tickers making a new 252-session closing high minus those making a new '
      + '252-session closing low, divided by the eligible count.',
    meaning: 'Net new highs. Positive when leadership is expanding, negative when it is breaking.',
  },
  {
    key: 'options',
    label: 'Options Sentiment',
    // ⚠️ HIGHER PUT ACTIVITY IS FEAR, and the inversion is declared here and applied once, in
    // scoreComponent — the same mechanism the two volatility components use.
    direction: DIRECTION.HIGHER_IS_FEAR,
    // ── ⚠️ CONCEPTUAL, LIKE MARKET VOLATILITY AND CREDIT. THE RECIPE IS NOT PUBLISHED ────
    //
    // These three strings are served by /api/fear-greed and rendered verbatim by the methodology
    // panel. The endpoint, the account scope, the product class, the ratio and the normalisation
    // window are absent from them by design — they live in occ.mjs and series.mjs, which nothing
    // public reads. Attribution to the clearing source is given because it is a credit to the
    // source rather than a description of the method.
    source: 'Official cleared equity-class options volume from the U.S. options clearing house, '
      + 'stored per market session exactly as published.',
    calculation: 'Proprietary. The balance of defensive against speculative equity-options activity '
      + 'for the session, ranked in the same trailing distribution every other component is ranked '
      + 'in. It reads cleared VOLUME only — never open interest, never a single symbol.',
    // ⚠️ IT DOES NOT SAY "SINGLE-NAME", BECAUSE IT IS NOT. An earlier draft of this string claimed
    // the component covered individual stocks rather than broad-market hedging. The clearing
    // house's equity class is 91% of all options volume — single names AND exchange-traded
    // products together — so that claim was false and the hedging flow it promised to exclude is
    // in there. The wording describes the universe we actually read.
    meaning: 'Measures whether equity-options activity is leaning more defensive or speculative '
      + 'relative to its recent history. It covers the whole equity class — options on individual '
      + 'stocks and on exchange-traded products — and excludes index options. Because exchange-'
      + 'traded product options carry hedging as well as directional positioning, this is a '
      + 'measure of overall options posture rather than of speculation alone. Clearing data is '
      + 'published on a short delay, so the most recent sessions may not carry this component yet — '
      + 'it is reported as unavailable rather than estimated.',
  },
  {
    key: 'credit',
    label: 'Credit Risk Appetite',
    direction: DIRECTION.HIGHER_IS_GREED,
    // ── ⚠️ CONCEPTUAL, LIKE MARKET VOLATILITY'S. THE INSTRUMENTS ARE NOT NAMED HERE ──────
    //
    // These three strings are served verbatim by /api/fear-greed and rendered by the methodology
    // panel, so they ARE the public disclosure. The two instruments, the lookback and the
    // normalisation live in data.mjs and series.mjs, which nothing public reads. What they must
    // keep saying is the part a reader could otherwise get wrong: this is relative PRICE
    // performance, and it is not a yield spread of any kind.
    source: 'Our own licensed daily bars for a high-yield corporate credit instrument and a '
      + 'short-duration government one.',
    calculation: 'Proprietary. The relative price performance of credit against government paper '
      + 'over a fixed recent window, ranked in the same trailing distribution every other '
      + 'component is ranked in. The government leg is deliberately short-duration so the measure '
      + 'reflects credit behaviour rather than interest-rate duration.',
    meaning: 'Whether the bond market is paying up for credit risk or hiding in government paper. '
      + 'This is a market-price risk-appetite measure and is NOT a direct measurement of '
      + 'high-yield credit spreads, an option-adjusted spread, or a junk-bond yield spread.',
  },
]);

export const COMPONENT_KEYS = COMPONENTS.map((c) => c.key);

/** Full disclosure text, rendered by the methodology panel. */
export const METHODOLOGY = Object.freeze({
  name: 'Catalyst Pit Fear & Greed',
  // ⚠️ THE VERSION IS NOT COSMETIC. It keys the KV payload and is half the primary key of
  // fear_greed_daily, so each methodology's stored series is preserved untouched under its own
  // version and the two are never mixed on one chart: a reader sees one methodology end to end.
  //
  //   v1  five components.
  //   v2  added Market Volatility — volatility-market stress against its own recent trend.
  //   v3  Credit Risk Appetite's control leg moved from long- to short-duration government paper,
  //       The component was 44% driven by the Treasury leg and 2% by the credit leg, and printed
  //       GREED on 62% of the sessions where BOTH bond legs fell. It is now 89% credit-driven and
  //       does that on none of them. Same component, same orientation, same weight — a corrected
  //       construction, not a new measure. V3 also adds Options Sentiment, a seventh component
  //       reading official cleared equity-options volume. A version because the numbers move.
  version: 'fear_greed_v3',
  updateFrequency: 'Daily, after the U.S. equity close. Every component is derived from completed '
    + 'daily sessions, so the index is a daily measure and is never presented as intraday.',
  normalization: `Each component is scored as its percentile rank within its own trailing `
    + `${NORM_WINDOW}-session distribution (two years), using the mid-rank convention: `
    + `strictly-below plus half the ties. 0 is the most fearful reading in that window, 50 the `
    + `median, 100 the most greedy. Rank is used rather than a z-score or a fixed threshold so a `
    + `single extreme session cannot distort the scale for years afterwards. The window is the same `
    + `length for every published point — a component that cannot fill all ${MIN_WINDOW} sessions is `
    + `refused rather than ranked against a shorter history, because the same percentile drawn from `
    + `fewer observations does not mean the same thing.`,
  composite: `The equal-weighted mean of every component that produced a score. Weights are equal `
    + `because we have no defensible basis for preferring one measure; they are deliberately not `
    + `fitted to historical returns, because this is a sentiment gauge and not a prediction model. `
    + `A missing component is dropped from the average, never replaced with 50. Fewer than `
    + `${MIN_COMPONENTS} components and the index reports itself unavailable.`,
  excluded: [
    {
      name: 'Implied volatility (VIX)',
      why: 'No entitled source. Tiingo returns 404 for the index, FMP 403 on its legacy endpoint, '
        + 'Finnhub reports that a CFD-indices subscription is required, and Polygon returns '
        + 'NOT_AUTHORIZED. Neither volatility component is a substitute for it and neither is '
        + 'presented as one: Realized Volatility measures what the equity market actually did, and '
        + 'Market Volatility reads a traded volatility instrument against its own recent trend. '
        + 'Both are named for what they measure, and no VIX level is quoted, estimated or implied '
        + 'anywhere in this index.',
    },
    {
      name: 'Put/call ratio',
      why: 'Catalyst Pit holds no broad-market options data, and estimating it would be inventing it.',
    },
    {
      name: 'Credit spreads (option-adjusted)',
      why: 'These come from public macro series we have no ingestion for. Credit Risk Appetite is '
        + 'NOT a substitute for them: it reads the relative PRICE performance of two bond ETFs, '
        + 'which moves with risk appetite but is not a yield-spread measurement and is never '
        + 'presented as one.',
    },
    {
      name: 'Safe-haven demand (equities vs Treasuries)',
      why: 'Measurable from our data, and excluded on measurement rather than for want of it. '
        + 'Scored over 504 sessions, an SPY-versus-TLT component correlates 0.82 with Credit '
        + 'Appetite — both are the same bonds-against-risk axis — so including both would weight '
        + 'that axis twice while Momentum, Breadth and Price Strength carry one vote each. Its '
        + 'correlation with Momentum is only 0.32, so the overlap is with credit, not with equities.',
    },
  ],
});
