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
// ── ⚠️ THE PUT/CALL COMPONENT IS A CHANGE, NOT A LEVEL, AND THAT DISTINCTION IS THE WHOLE STORY ──
//
// V3 shipped Options Sentiment as the LEVEL of the cleared equity-options put/call ratio. It was
// withdrawn in V4 because its yearly mean slid 82 → 66 → 38 across 2024-2026 — a 44-point drift
// against 16-24 for every other component. The slide was not in the market: the raw ratio's yearly
// medians went 0.73 → 0.68 → 0.76, non-monotonic. The options market's product mix has shifted
// structurally on roughly the same horizon as the normalisation window, and a rolling percentile
// cannot tell that apart from sentiment.
//
// V5 restores the component as the CHANGE in that ratio over a recent horizon. Differencing removes
// the structural shift: measured on the same data, 8.1 points of yearly swing — better than any
// other component in the index. A ratio-to-its-own-average construction scores about as well on
// drift but correlates 0.550 with the rest of the index against this one's 0.421, because it is the
// same shape as Market Volatility and inherits its information.
//
// ⚠️ THE UNIVERSE IS STILL NOT SINGLE-NAME. The clearing house's equity class is 90.7% of all
// cleared options — single names AND exchange-traded products — so ETP hedging is in there, and the
// public wording says so. Cboe publishes a single-name-only equity ratio, and its dated pages DO
// expose auditable call and put volumes (an earlier note here claimed otherwise; that was wrong).
// It is not used because Cboe's website terms expressly prohibit creating an index from their
// Materials without written permission.
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
    source: 'Our own licensed daily bars for the broad U.S. equity market.',
    calculation: 'Proprietary. The broad market measured against its own medium-term trend, then '
      + 'ranked in the same trailing distribution every other component is ranked in.',
    meaning: 'Measures the strength of the broad market relative to its recent trend.',
  },
  {
    key: 'volatility',
    // ⚠️ THE LABEL SAYS REALIZED BECAUSE THE NUMBER IS REALIZED. 'Market Volatility' beside a
    // sentiment gauge invites a reader to assume VIX; this is computed from SPY's own returns and
    // must never be read as implied volatility.
    label: 'Realized Volatility',
    direction: DIRECTION.HIGHER_IS_FEAR,
    source: 'Our own licensed daily bars for the broad U.S. equity market.',
    calculation: 'Proprietary. The dispersion of the market\'s own recent returns, annualised, '
      + 'then ranked in the same trailing distribution every other component is ranked in.',
    meaning: 'Measures how turbulent recent market price movement has been relative to its own '
      + 'history. This is REALIZED volatility — what the market actually did — not implied '
      + 'volatility and not the VIX, for which Catalyst Pit has no entitled source.',
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
    meaning: 'Measures current market stress relative to its own historical conditions. This is '
      + 'NOT the VIX and is not implied volatility — Catalyst Pit has no entitled source for the '
      + 'VIX index — and it is a different measurement from Realized Volatility, which is what '
      + 'the equity market actually did.',
  },
  {
    key: 'breadth',
    label: 'Market Breadth',
    direction: DIRECTION.HIGHER_IS_GREED,
    source: 'Our own licensed daily bars for the eligible U.S. equity universe.',
    calculation: 'Proprietary. The share of a stable panel of U.S. stocks trading above their own '
      + 'recent trend, then ranked in the same trailing distribution every other component is '
      + 'ranked in.',
    meaning: 'Measures how broadly strength or weakness is distributed across U.S. stocks, rather '
      + 'than how far the index itself moved.',
  },
  {
    key: 'strength',
    label: 'Price Strength',
    direction: DIRECTION.HIGHER_IS_GREED,
    source: 'Our own licensed daily bars for the eligible U.S. equity universe.',
    calculation: 'Proprietary. The net balance of stocks reaching new long-term highs against '
      + 'those reaching new lows, then ranked in the same trailing distribution every other '
      + 'component is ranked in.',
    meaning: 'Measures the balance of stocks reaching strong versus weak price territory. '
      + 'Positive when leadership is expanding, negative when it is breaking.',
  },
  {
    key: 'options',
    label: 'Options Sentiment',
    // ⚠️ A RISING PUT/CALL RATIO IS POSITIONING TURNING DEFENSIVE, WHICH IS FEAR. Declared here,
    // applied once, in scoreComponent.
    direction: DIRECTION.HIGHER_IS_FEAR,
    // ── ⚠️ CONCEPTUAL, LIKE EVERY OTHER ENTRY. THESE THREE STRINGS ARE THE PUBLIC DISCLOSURE ──
    //
    // Served verbatim by /api/fear-greed and rendered by the methodology panel. The source, the
    // endpoint, the ratio, the lookback and the normalisation are absent by design — they live in
    // occ.mjs and series.mjs, which nothing public reads. What this must keep saying is the part a
    // reader could get wrong: the universe is not single-name only, and a late session is
    // unavailable rather than estimated.
    source: 'Official cleared equity-class options volume from the U.S. options clearing house, '
      + 'stored per market session exactly as published.',
    calculation: 'Proprietary. The recent shift in the balance of defensive against speculative '
      + 'equity-options activity, ranked in the same trailing distribution every other component '
      + 'is ranked in. It reads cleared VOLUME only — never open interest, never a single symbol — '
      + 'and it measures the CHANGE in that balance rather than its level.',
    meaning: 'Measures whether equity-options activity is turning more defensive or more '
      + 'speculative relative to its recent history. It covers the whole equity class — options on '
      + 'individual stocks and on exchange-traded products — and excludes index options. Because '
      + 'exchange-traded product options carry hedging as well as directional positioning, this is '
      + 'a measure of overall options posture rather than of speculation alone. Clearing data is '
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
    // ⚠️ IT MEASURES A RECENT SHIFT, NOT THE STANDING LEVEL, AND THE PROSE HAS TO SAY WHICH.
    //
    // Measured against the official ICE BofA US High Yield option-adjusted spread over 733 shared
    // sessions, this component's raw value correlates -0.873 with the 20-session CHANGE in that
    // spread and only -0.047 with its LEVEL. It is a faithful proxy for the recent move in credit
    // and is very nearly orthogonal to how tight or wide credit actually is.
    //
    // That distinction is not academic. On 2026-09-25 this component read 3.9 while the spread
    // level sat at the 39th percentile of its own trailing two years — around the middle. A reader
    // who takes "is showing risk aversion" to mean "credit conditions are stressed" would be
    // reading something the number does not say, so the wording now names the recent move.
    meaning: 'Measures the recent SHIFT in credit risk appetite — whether, over a recent window, '
      + 'the bond market has been paying up for credit risk or moving toward government paper. It '
      + 'is a measure of change, not of level: a low reading means credit has lost ground lately, '
      + 'NOT that credit conditions are historically tight or wide. It is NOT a direct measurement '
      + 'of high-yield credit spreads, an option-adjusted spread, or a junk-bond yield spread.',
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
  //       construction, not a new measure. V3 also added Options Sentiment, a seventh component
  //       reading official cleared equity-options volume.
  //   v4  Options Sentiment REMOVED. It measured real, auditable data but drifted 44 points of
  //       yearly mean against 16-24 for every other component, so it was reporting a multi-year
  //       shift in the options market's product mix as sentiment. Back to six. The raw
  //       observations keep accruing in occ_options_volume; nothing about the other six changed.
  version: 'fear_greed_v5',
  updateFrequency: 'Daily, after the U.S. equity close. Every component is derived from completed '
    + 'daily sessions, so the index is a daily measure and is never presented as intraday.',
  // ⚠️ CONCEPTUAL, NOT REPRODUCIBLE. These two paragraphs are served by the API and rendered by
  // the methodology panel. They used to interpolate NORM_WINDOW, MIN_WINDOW and MIN_COMPONENTS,
  // which handed a reader the exact window length and the exact refusal threshold — most of the
  // recipe, in prose. What a reader needs is the PRINCIPLE: each measure is judged against its own
  // recent history, weights are equal and unfitted, and a missing measure is dropped rather than
  // guessed. The constants stay in the code, where they are load-bearing and unpublished.
  normalization: 'Each component is scored by where today sits inside that component\'s own recent '
    + 'distribution, rather than against any fixed threshold. 0 is the most fearful reading in that '
    + 'history, 50 the median, 100 the most greedy. Rank is used rather than an average or a fixed '
    + 'cut-off so a single extreme session cannot distort the scale for years afterwards, and every '
    + 'published point is ranked against a history of the same length — a component that cannot '
    + 'fill it is refused rather than ranked against a shorter one, because the same percentile '
    + 'drawn from fewer observations does not mean the same thing. '
    // ⚠️ THE CONSEQUENCE A READER WOULD OTHERWISE GET WRONG, AUDITED 2026-09-26.
    //
    // Because the reference distribution is recent, it moves, so an identical raw observation does
    // not always earn the same score. Measured across nine probe values per component — the deciles
    // of each component's own raw history — scored against the window available at every 21st
    // session: median drift 11.3 points of score, worst component 31.7 points. Price Strength is
    // the worst (median 23.2), Options Sentiment the best (median 7.9). Day to day the effect is
    // negligible (0.099 points, one rank step in the window, under 3% of the daily move); it is the
    // accumulation over months that matters.
    //
    // ⚠️ AND THE ALTERNATIVES WERE TESTED AND ARE WORSE. All three were built point-in-time:
    //
    //   expanding percentile (rank against ALL history so far, no window to choose): drift 11.3 ->
    //     6.3 and the best cross-regime consistency of any candidate (mean across-year spread
    //     within regime 9.10 -> 7.21). Rejected because it assumes the raw measures are stationary
    //     and they demonstrably are not — the trailing distribution's own tails move by up to 1.58
    //     interquartile ranges over the sample. Its own output shows the cost: it pushes the index
    //     off centre (sessions above NEUTRAL minus below: +7.4pp -> +17.1pp) and its neutral point
    //     depends on when our data licence happens to begin, which is arbitrary in exactly the way
    //     a fixed window length is not.
    //
    //   robust standardisation (expanding median and MAD through a normal CDF): drift 8.9, but it
    //     assumes a normality the raw series do not have, and reachability breaks per component —
    //     Market Volatility clears 90 on 0.6% of sessions against 7.8% today.
    //
    //   fixed economic anchors: lowest drift of all, 3.8. Rejected on two counts. Only four of the
    //     seven have a defensible anchor at all — 'sitting on its own trend' is 1.23 interquartile
    //     ranges from where Momentum actually lives, because the index spends most of its time
    //     above its average, so anchoring there would report fear as the normal state. And where
    //     the anchors do hold, the fixed centre shifts the whole index (+27.7pp asymmetry, median
    //     58.0 against 52.3) while barely improving cross-regime consistency (8.59 against 9.10).
    //     Low drift is necessary and not sufficient: a ruler that always says greed has none.
    //
    // A longer rolling window is the one change that would cut drift without giving up robustness
    // to non-stationarity, and it is unavailable rather than unwanted: at a 1008-session window
    // Momentum (906 raw observations) and Credit (742) do not score at all. Revisit as history
    // accumulates; 756 becomes viable for the whole set around 2028.
    + 'One consequence is deliberate and worth stating plainly: because the reference '
    + 'distribution is recent, it moves. The same raw market observation can therefore earn a '
    + 'somewhat different score depending on when it happens, so a reading is best compared '
    + 'with other readings near it in time rather than read as a fixed absolute across years. '
    + 'The alternatives were tested — ranking against all available history instead of recent '
    + 'history, standardising against a robust centre, and anchoring to fixed economic neutral '
    + 'points — and this one was kept. The underlying measures are not stable enough over time '
    + 'for those methods to hold, and each of them shifted the whole index off centre instead of '
    + 'making different periods more comparable.',
  // ⚠️ EQUAL WEIGHTING IS A TESTED CHOICE, NOT AN ABSENCE OF ONE, AND THE PROSE NOW SAYS SO.
  //
  // This text used to read "weights are equal because we have no defensible basis for preferring
  // one measure". That was too weak and, after measurement, wrong: there is a defensible basis for
  // refusing to fit weights, and it is worth stating because a reader who notices that several
  // components move together will otherwise assume nobody checked.
  //
  // Measured over the stored history: the seven components deliver about 2.2 effective independent
  // votes (1/(w'Rw)) and the set spans about 4.0 effective independent dimensions (participation
  // ratio of the correlation eigenvalues, 2.87/1.32/1.04/0.82/0.57/0.22/0.15). So the redundancy is
  // real. What the audit also found is that nothing available fixes it:
  //
  //   * equal weighting already captures 79-85% of the maximum effective independence any
  //     non-negative weight vector can reach, so the entire prize is 0.37-0.70 of a vote;
  //   * that unconstrained optimum sets two components to exactly zero, i.e. it deletes them, and
  //     refit on rolling windows its weights swing 18-30 percentage points;
  //   * every transparent grouping raises the largest share a single component can control (14.3%
  //     to 16.7-25.0% with all seven present) and the candidate pairs are not stable dimensions -
  //     the most correlated pair in the index swings 0.43-0.85 across rolling windows and the
  //     next one visits 0.23.
  //
  // Hence: fixed equal weights, disclosed as a choice, with the correlation admitted.
  composite: 'The equal-weighted mean of every component that produced a score. Equal weighting is '
    + 'a deliberate choice that has been measured rather than assumed. The components are '
    + 'correlated with one another to differing degrees, so the index carries meaningfully fewer '
    + 'independent dimensions than it has components, and we say so rather than implying that '
    + 'seven measures are seven independent pieces of information. Alternatives that group '
    + 'components into dimensions, or weight them by how much each one duplicates the others, have '
    + 'been tested against equal weighting and were not adopted: weights derived from measured '
    + 'correlation move substantially as that correlation moves, and grouping concentrates the '
    + 'index on whichever components are left, including ones that are sometimes unavailable. '
    + 'Weights are also deliberately not fitted to historical returns, because this is a sentiment '
    + 'gauge and not a prediction model. A missing component is dropped from the average, never '
    + 'replaced with 50, and if too few components are available the index reports itself '
    + 'unavailable rather than publishing a number built on one or two measures.',
  excluded: [
    {
      name: 'Implied volatility (VIX)',
      why: 'No entitled source. Every market-data provider we hold a licence with either does not '
        + 'carry the index or requires a separate subscription for it. Neither volatility '
        + 'component is a substitute for it and neither is '
        + 'presented as one: Realized Volatility measures what the equity market actually did, and '
        + 'Market Volatility reads a traded volatility instrument against its own recent trend. '
        + 'Both are named for what they measure, and no VIX level is quoted, estimated or implied '
        + 'anywhere in this index.',
    },
    {
      // ⚠️ THE HONEST VERSION OF A COMPONENT WE BUILT AND THEN WITHDREW. The old text said we held
      // no options data; we now hold official cleared volume and ingest it daily. What it fails is
      // the measurement test, and saying so is a stronger disclosure than pretending it is absent.
      name: 'Put/call ratio (options sentiment)',
      why: 'Built, measured against several years of official cleared options volume, and withdrawn '
        + 'rather than published. As a component it averaged far from neutral for a year at a time '
        + 'because the options market\'s product mix has changed structurally faster than any '
        + 'sensible recent-history comparison can absorb — so it reported that structural change as '
        + 'sentiment. The measure that would avoid this covers a narrower slice of the options '
        + 'market and is not published in a form we can verify to the contract, so it is not '
        + 'sourceable for a daily index. The underlying observations continue to be collected.',
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
      // ⚠️ THIS NOTE USED TO CLAIM "Momentum, Breadth and Price Strength carry one vote each",
      // which measurement does not support: Breadth and Price Strength correlate 0.753 and sit on
      // the same side of neutral 76% of the time. The exclusion still holds on its own merits —
      // 0.82 against Credit is higher still — but the index should not claim an independence it
      // does not have. Measured across the full seven-component history, the effective number of
      // independent measures is about 4 of 7.
      // ⚠️ THE EARLIER REASON GIVEN HERE WAS MEASURED ON THE WRONG DATA. RE-TESTED 2026-09-26.
      //
      // This note used to say the candidate correlates 0.82 with Credit Risk Appetite. That figure
      // came from PRICE-ONLY bars over three years, and price-only bars cannot measure a
      // stocks-versus-bonds spread at all: our candle table is split-adjusted only, and TLT's
      // price-only return since 2002 is -4% against a +121% total return. The whole observation was
      // partly reading coupon payments.
      //
      // Re-run on dividend-and-split-adjusted series over 5,497 shared sessions from 2004, the
      // overlap with Credit is 0.450 for the long-Treasury version and 0.217 once gold is included.
      // Nothing like 0.82. The old reason does not survive; the exclusion now rests on different
      // ground, stated below.
      //
      // ⚠️ WHAT THE PROPER TEST FOUND. Best construction: equity total return against an equally
      // weighted intermediate-Treasury-and-gold leg over one month. 4,974 scored sessions from 2006,
      // R² 38.3% against the existing seven — lower than five of them — and it lifts the index's
      // effective independent component count from 4.03 of 7 to 4.57 of 8. Directionally coherent in
      // every regime: 61.6 in quiet bull markets, 21.6 in gradual corrections, 7.7 in sharp selloffs.
      //
      // ⚠️ AND WHY TREASURIES ALONE CANNOT BE THE DEFENSIVE LEG. On the 175 sessions where long
      // Treasuries sat in their worst decile AND equities were falling — 63 of them in 2022 — the
      // Treasury-only version reads 50.2, calling a bond-and-equity rout neutral, because the
      // defensive leg fell further than equities did. Adding gold fixes that: 24.8 on the same days.
      //
      // ⚠️ SO IT IS HELD BACK ON DATA PROVENANCE, NOT ON INFORMATION. The series it needs is
      // dividend-adjusted, and nothing in production stores that: ticker_daily_candles is
      // deliberately split-adjusted only and its own notes say mixing bases in one column would
      // make the column meaningless. Shipping this means a separate adjusted-price path, a
      // twenty-four-year backfill, a daily ingest and a history rebuild. That is a deliberate piece
      // of work, not a line in a component file.
      //
      // ⚠️ ONE HONEST CAVEAT FOR WHOEVER PICKS THIS UP. Where it disagrees with the equity internals
      // it is not always right. On 16% of the sessions where Market Breadth is below 20 it reads
      // above 70, because a spread goes up when the defensive leg falls for its own reasons as well
      // as when money moves into risk. 2026-09-25 is such a session — gold -6.9%, long Treasuries
      // -4.2%, small caps -5.7%, large caps +0.3% — and the candidate reads 85.4, the 85th
      // percentile of its own twenty-year record, on a day almost nothing was being bought. Resolve
      // that before trusting it, and do not let the fact that adding it would raise today's
      // composite by about eight points stand in for having resolved it.
      why: 'Measurable, re-tested on total-return data, and held back on data provenance rather '
        + 'than on information. Built properly — equities against a defensive basket rather than '
        + 'against government bonds alone — it does carry information the rest of the index lacks, '
        + 'and it behaves sensibly in the regime that breaks the naive version, where rising rates '
        + 'push bonds and equities down together. What it needs is a total-return price history we '
        + 'do not yet carry in the pipeline that builds this index, because comparing an '
        + 'income-paying bond fund with an equity index on price alone measures coupons rather than '
        + 'conviction. Components here are not independent of one another and are not presented as '
        + 'such, so the bar for a new one is that it add something the others do not already say; '
        + 'this one may clear that bar, and it is not in the index until the data behind it is '
        + 'built to the same standard as everything else here.',
    },
  ],
});
