// PIT SCAN ROWS — turning a Consensus card into a scan line.
//
// ── WHAT THIS IS ────────────────────────────────────────────────────────────
//
// boards.mjs has always been pure, tested and DEAD: nothing fed it rows, so /api/pitscan returned
// a hard-coded empty list while the board logic sat unused. This module is the missing adapter. It
// maps an already-materialized Consensus row onto the row shape boards.mjs expects, and composes
// the compact display line.
//
// ⚠️ IT COMPUTES NO EVIDENCE. Every fact here is read from the Consensus payload — setup, fact
// blocks, canonical consensus, reaction, daily levels. Scan CHOOSES WHAT TO SHOW. It never decides
// what evidence means, and it never recomputes a lean. One evidence engine, many consumers.
//
// ── WHAT A SCAN ROW MAY NOT SAY ─────────────────────────────────────────────
//
// No score, no alignment percentage, no confidence word, no Bullish/Bearish headline, no family
// soup ("Insiders Positive · Institutions Positive · …"), no 13F occupancy ("116 funds"), no RVOL,
// and never the full Consensus card. Scan answers "what is moving and why"; the card answers "what
// does the evidence say". Duplicating the card here would make Scan a worse Consensus.

import { FAMILY } from '../evidence/model.mjs';
// The real exchange calendar, so staleness is measured in SESSIONS rather than in hours — a
// weekend or a holiday must not make a current price look abandoned.
import { sessionsSince } from '../market/market-session.mjs';

export const SCAN_ROWS_VERSION = 'scan_rows_v1';

// ── FRESHNESS LABELLING ─────────────────────────────────────────────────────
//
// ⚠️ THE MOST IMPORTANT HONESTY RULE IN THIS FILE. Realtime is not entitled: Tiingo returns EOD, so
// a row's "% change" is the last completed session's close-to-close move — yesterday's move, not
// today's. A board called "Moving Now" printing that without saying so would be the precise failure
// the scanner's own header refuses: telling a trader something untrue at the moment they act.
/**
 * ⚠️ THIS MAP IS FOR A ROW, AND ONLY FOR A ROW.
 *
 * A row badge answers "what is THIS price" — the provenance of one symbol's number, which is the
 * only place a fallback can be disclosed honestly. The BOARD's status answers a different question
 * and has its own map below; the two were one function, which is how a board of mostly-live prices
 * came to be summarised with a word no row had said.
 *
 * There is no `mixed` here. A single price is never a mixture, and an entry for one would be an
 * invitation to render a board-level summary on a row.
 */
export const FRESHNESS_LABEL = Object.freeze({
  realtime: 'LIVE',
  // Seconds to about a minute behind the tape. Not a delayed feed, and saying so cost a Pro reader
  // their entitlement in the only place they could see it.
  near: 'LIVE',
  delayed: 'DELAYED',
  eod: 'LAST CLOSE',
  // The security has not printed a close for multiple sessions. Not a claim about today.
  stale: 'LAST KNOWN',
  // No price at all. A freshness badge here would be a claim about a number that is not there.
  unpriced: null,
});
// ⚠️ NOT `??` HERE. `realtime` maps to null meaning "nothing to disclose", and nullish-coalescing
// would fall straight through to 'LAST CLOSE' — labelling a genuinely live quote as stale, the
// exact inverse of the rule this map exists to enforce. An unrecognised freshness still falls
// through to the weakest label, because an unknown provenance is not a live one.
export const freshnessLabel = (f) => (f in FRESHNESS_LABEL ? FRESHNESS_LABEL[f] : 'LAST CLOSE');

/**
 * The board's own status — what the MARKET-DATA PATH delivered, not what one symbol got.
 *
 * ── ⚠️ WHY THIS IS A SEPARATE MAP FROM THE ROW BADGE ────────────────────────
 *
 * They answer different questions, and running both through one map is what produced PARTLY LIVE:
 * a summary word, correct as arithmetic over the rows, that described a working real-time service
 * as though it were half-broken. A board drawn from the entitled consolidated feed IS real-time —
 * that a particular ADR has not traded this morning is a fact about that symbol, not about the
 * feed, and its own row says so in its own badge.
 *
 * ⚠️ THE HONESTY LIVES ON THE ROWS, WHICH IS WHY THIS MAY BE THE FRIENDLIER WORD. Nothing here
 * promotes a price. A LAST CLOSE row still reads LAST CLOSE, a LAST KNOWN row still reads LAST
 * KNOWN, and an unpriced row still carries no badge at all. What changes is only the sentence at
 * the top of the board, and only for a reader whose rows contain at least one live print — a board
 * with no live price anywhere is still LAST CLOSE, because at that point there is no real-time data
 * on screen to be describing.
 */
export const BOARD_STATUS_LABEL = Object.freeze({
  realtime: 'REAL-TIME',
  near: 'REAL-TIME',
  mixed: 'REAL-TIME',
  delayed: 'DELAYED',
  eod: 'LAST CLOSE',
  stale: 'LAST KNOWN',
  unpriced: 'LAST CLOSE',
});

/** ⚠️ An unknown provenance is not a real-time one — it falls to the weakest label, as before. */
export const boardStatusLabel = (f) => (f in BOARD_STATUS_LABEL ? BOARD_STATUS_LABEL[f] : 'LAST CLOSE');

/** Is this quote live enough to describe a move as happening NOW? */
export const isLiveEnough = (f) => f === 'realtime' || f === 'near';

/**
 * One freshness for a whole board, from the freshness of the rows actually served.
 *
 * ── ⚠️ THE BUG THIS REPLACES, AND THE ONE BEFORE IT ─────────────────────────
 *
 * A board is a set of prices with a set of provenances, and collapsing that to one word has now
 * been got wrong twice in opposite directions. First it read row[0], so a single unpriceable
 * Consensus ticker collapsed a live board to LAST CLOSE. The repair made any mixed set 'near' —
 * and 'near' is labelled DELAYED, so an entitled Pro reader watching live consolidated prices was
 * told "Delayed quotes — not live" because ONE row among twenty-five had no current print.
 *
 * Both readings were pessimistic about data that was actually live. The honest answer to "some of
 * these are live and some are not" is neither of the two extremes: it is "mixed", which is a fourth
 * state the banner renders as PARTLY LIVE. Every row still carries and prints its own freshness,
 * so the board-level word is a summary and never the only disclosure.
 *
 * ⚠️ NEAR IS A PROVIDER CAPABILITY, NOT A SUMMARY. It means "seconds behind the tape" — see
 * market-capabilities.mjs — and reusing it to mean "a mixture" is what let a mixture inherit the
 * DELAYED label. It is passed through when the rows really are near-real-time and never minted.
 */
export function aggregateFreshness(values) {
  const seen = new Set((values || []).filter(Boolean));
  if (!seen.size) return null;
  if (seen.size === 1) return [...seen][0];
  const live = [...seen].filter(isLiveEnough);
  const notLive = [...seen].filter((f) => !isLiveEnough(f));
  // Live and not-live together is a mixture, whichever flavours of each.
  if (live.length && notLive.length) return 'mixed';
  // Only live values: realtime + near is near, the weaker of the two.
  if (live.length) return live.includes('near') ? 'near' : 'realtime';
  // Nothing live. A delayed print is a stronger claim than a completed session, so it wins.
  return seen.has('delayed') ? 'delayed' : 'eod';
}

// ── STRUCTURE TAGS, FROM DAILY BARS ONLY ────────────────────────────────────
//
// The only structure we can honestly claim on an end-of-day feed. Premarket highs, opening ranges,
// VWAP and session extremes all need intraday bars that do not exist in this database, and the
// signal registry already darkens them. Omitted, never approximated.
//
// ⚠️ ONE CLOCK PER ROW. `changePct` is the move the row DISPLAYS, and it does not always come from
// the same snapshot as `levels`: the quote is preferred when there is one, while the levels come
// from the Consensus row's daily bars. Deriving "above/below prior close" from `levels` while
// printing a change% from the quote produced rows reading "BELOW PRIOR CLOSE" beside a green
// +4.2% — one row making two contradictory claims about the same session, which destroys trust in
// both numbers. So the directional tag is derived from the displayed move whenever there is one,
// and only falls back to the levels flag when the row has no change% at all.
//
// The 52W/20D extremes are genuinely daily-bar facts on a slower clock, so they still come from
// `levels`; they describe where the close sits in a range, not what happened today.
export function structureTags(levels, changePct = null) {
  if (!levels) return [];
  const tags = [];
  if (levels.at52wHigh) tags.push('52W HIGH');
  else if (levels.at52wLow) tags.push('52W LOW');
  else if (levels.at20dHigh) tags.push('20D HIGH');
  else if (levels.at20dLow) tags.push('20D LOW');

  const above = Number.isFinite(changePct) ? changePct > 0
    : levels.abovePrevClose === true ? true
    : levels.abovePrevClose === false ? false
    : null;
  if (above === true) tags.push('ABOVE PRIOR CLOSE');
  else if (above === false) tags.push('BELOW PRIOR CLOSE');
  return tags;
}

/**
 * The `structure` object boards.mjs reads.
 *
 * ⚠️ `at` IS DELIBERATELY NULL. boards.mjs ages a structure signal against a 90-minute window, and
 * `levels.asOf` is a DATE — so a real timestamp here would be hours or days old and every row would
 * silently fail as 'structure-stale'. A daily level is not a 90-minute event; passing null says
 * "this has no intraday clock" rather than asserting a false one.
 *
 * `changePct` is threaded through so the label boards.mjs quotes in its reason ("52W HIGH on
 * +4.2%") is the same label the row renders, from the same snapshot.
 */
export function levelsToStructure(levels, changePct = null) {
  const tags = structureTags(levels, changePct);
  if (!tags.length) return null;
  return { label: tags[0], at: null, weight: levels.at52wHigh || levels.at52wLow ? 5 : 3 };
}

// ── THE EVIDENCE LINE ───────────────────────────────────────────────────────
//
// One line, at most two facts, composed from the Consensus setup and its fact blocks.
//
//   good  "Delisting notice vs CEO open-market buying"
//   good  "$25M insider cluster · 6 open-market buyers"
//   bad   "Fresh 8-K · Officer buying · Institutions increasing"   <- family soup
export const EVIDENCE_LINE_MAX = 80;

const shorten = (s, max = 44) => {
  const t = String(s || '').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};

/** The headline of one family's fact block, trimmed for a scan line. */
const blockOf = (sheet, family) => (sheet?.[family]?.[0] || null);

export function evidenceLine(row) {
  const sheet = row?.families || {};
  const setup = row?.setup?.setup;
  const cat = blockOf(sheet, FAMILY.CATALYST);
  const ins = blockOf(sheet, FAMILY.INSIDER);
  const con = blockOf(sheet, FAMILY.CONGRESS);
  const inst = blockOf(sheet, FAMILY.INSTITUTION);

  // A CONFLICT IS A SENTENCE WITH TWO SIDES. "X vs Y" is the whole point of the row.
  if (setup === 'CROSS_SOURCE_CONFLICT') {
    const blocks = Object.values(sheet).flat().filter(Boolean);
    const neg = blocks.find((b) => b.direction === 'negative');
    const pos = blocks.find((b) => b.direction === 'positive');
    if (neg && pos) return shorten(`${shorten(neg.headline, 36)} vs ${shorten(pos.headline, 36)}`, EVIDENCE_LINE_MAX);
  }

  // Unusual insider activity leads with the act, then the rarity claim — never a third clause.
  if (setup === 'UNUSUAL_INSIDER_ACTIVITY' && ins) {
    return shorten(ins.context ? `${shorten(ins.headline, 40)} · ${shorten(ins.context, 36)}` : ins.headline,
      EVIDENCE_LINE_MAX);
  }

  // A fresh filing leads with the filing.
  if (cat && (setup === 'FRESH_MATERIAL_CATALYST' || setup?.startsWith('FRESH_CATALYST'))) {
    return shorten(cat.publicAgo ? `${shorten(cat.headline, 48)} · ${cat.publicAgo}` : cat.headline,
      EVIDENCE_LINE_MAX);
  }

  // Otherwise the single strongest block that exists, in its own words.
  const best = ins || cat || con || inst;
  if (!best) return null;
  return shorten(best.context ? `${shorten(best.headline, 40)} · ${shorten(best.context, 36)}` : best.headline,
    EVIDENCE_LINE_MAX);
}

// ── THE JOIN LINE ───────────────────────────────────────────────────────────
//
// Scan's vocabulary for what price is doing about the evidence. It reads the Consensus join and
// reaction; it never re-derives them.
/**
 * How many completed sessions a price may fall behind before it stops being "last close".
 *
 * ⚠️ TWO, BECAUSE ONE IS ORDINARY DATA LAG. The screener rebuild runs daily, so a price one
 * session behind is a pipeline that has not caught up yet rather than a security that stopped
 * printing. Two or more completed sessions is a statement about the SECURITY, not about our
 * refresh cadence.
 */
export const STALE_SESSIONS = 2;

export const JOIN_LINE = Object.freeze({
  CONFIRMING: 'PRICE CONFIRMING',
  DIVERGING: 'PRICE DIVERGING',
  SELLING_OFF: 'PRICE SELLING OFF',
  CONFLICT_MOVING: 'CONFLICT + MOVING',
  NO_REACTION: 'NO REACTION',
  /**
   * ⚠️ "WE FOUND NO EVIDENCE" IS NOT "PRICE DID NOT MOVE", AND THIS LABEL EXISTS BECAUSE THEY WERE
   * THE SAME STRING.
   *
   * The join asks whether price agrees with the evidence. When there is no evidence there is
   * nothing to agree with — but the old code fell through to NO REACTION, so PMAX at +168.7% and
   * APUS at +131.0% were labelled "NO REACTION" on a board whose entire purpose is movement. The
   * statement was false on its face and it was the loudest thing on the card.
   *
   * This says the true thing instead: Catalyst Pit has not matched this move to canonical evidence.
   * It is a statement about our evidence, not about the tape.
   */
  NO_EVIDENCE: 'NO MATCHING EVIDENCE',
  /**
   * ⚠️ THE PRICE IS TOO OLD TO SAY ANYTHING ABOUT THE EVIDENCE.
   *
   * Every other join label is a comparison between evidence and a CURRENT market reaction. A price
   * several sessions behind cannot confirm, diverge or fail to react -- the market has not been
   * asked yet as far as we can tell. Evidence Now keeps the row because the evidence is valid; this
   * says plainly that the other half of the comparison is missing.
   */
  REACTION_UNAVAILABLE: 'REACTION UNAVAILABLE',
  /**
   * A public item was found for a major mover that carried no canonical evidence.
   *
   * ⚠️ "MATCHING", NEVER "CAUSED". The wire published this near the move and the canonical resolver
   * attributes it to this ticker. That is a statement about timing and attribution — not proof the
   * headline moved the price, which we cannot establish and do not claim.
   */
  MATCHING_CATALYST: 'MATCHING CATALYST',
  /**
   * A classified event older than the fresh window but still inside the relevance window its own
   * TYPE earns — a regulatory submission or a pivotal readout, not an ordinary headline.
   *
   * ⚠️ STILL NOT CAUSATION. It says something material became public recently and the move is
   * happening now. It does not say the first produced the second.
   */
  RECENT_CATALYST: 'RECENT RELEVANT CATALYST',
  /**
   * ⚠️ "WE DID NOT IDENTIFY ONE", NOT "THERE IS NONE".
   *
   * Reached only after the bounded resolution actually ran and returned nothing, so it means the
   * wire was searched by company name and no defensible attribution came back. NO MATCHING EVIDENCE
   * says we hold no record; this says we looked. A trader can act on the difference.
   */
  NO_CATALYST_IDENTIFIED: 'NO PUBLIC CATALYST IDENTIFIED',
  NONE: '—',
});

// The dead zone, applied to the move the row DISPLAYS. Same floor as the Consensus reaction layer.
export const SCAN_DEAD_ZONE_PCT = 3.5;
/** A hard down move earns its own word rather than a generic "diverging". */
export const SELLOFF_PCT = -5;

/**
 * ⚠️ THE JOIN MUST DESCRIBE THE MOVE THE ROW IS SHOWING.
 *
 * It first read the Consensus reaction, which is anchored to the evidence's publicTime and measured
 * SPY-relative. That is the more rigorous measurement, but it produced rows like AAOI printing
 * "+7.3%" next to "NO REACTION" — two different measurements on one line, which reads as a bug
 * whether or not it is one. A scan row has to be internally consistent above all else.
 *
 * So the displayed move decides, against the same 3.5% floor, and the evidence supplies only the
 * DIRECTION being agreed with or contradicted. SPY-relative is not available for a session move on
 * this feed, so the floor is applied to the raw move — a slightly blunter test, stated here rather
 * than hidden.
 *
 * ⚠️ AND A MIXED OR CONFLICTED READING CAN NEVER BE "CONFIRMING". There is no single direction for
 * price to agree with, and a moving tape does not resolve a disagreement between sources.
 */
export function joinLine({ setup, joinState, reaction, changePct, direction, hasEvidence = true, stale = false } = {}) {
  // ⚠️ THE FIRST QUESTION IS WHETHER THERE IS ANYTHING TO JOIN. Every branch below compares price
  // against an evidence reading, so without evidence none of them is a true sentence. Answered
  // first and independently of the move, because a 168% move with no filing behind it is still a
  // move with no filing behind it.
  if (!hasEvidence) return JOIN_LINE.NO_EVIDENCE;

  // A stale price cannot support ANY reaction claim, including "no reaction".
  if (stale) return JOIN_LINE.REACTION_UNAVAILABLE;

  const conflicted = setup === 'CROSS_SOURCE_CONFLICT' || joinState === 'SOURCES_CONFLICT'
    || direction === 'MIXED';

  // Prefer the displayed move; fall back to the evidence-anchored reaction when there is no quote.
  const move = Number.isFinite(changePct) ? changePct
    : (Number.isFinite(reaction?.abs) ? reaction.abs : null);
  // Evidence with no usable price at all is the same statement as evidence with a stale one: we
  // cannot measure what the market did. (hasEvidence is already true here — the no-evidence case
  // returned above — so this never swallows the "we found nothing" answer.)
  if (move === null) return JOIN_LINE.REACTION_UNAVAILABLE;
  // Evidence exists and price has not moved on it. This is the ONE case NO REACTION describes, and
  // it is exactly the Evidence Now thesis: something material is public and the tape is quiet.
  if (Math.abs(move) < SCAN_DEAD_ZONE_PCT) return JOIN_LINE.NO_REACTION;

  if (conflicted) {
    return move <= SELLOFF_PCT ? JOIN_LINE.SELLING_OFF : JOIN_LINE.CONFLICT_MOVING;
  }
  // With a one-sided reading, does the move agree with it?
  const evidenceUp = direction === 'POSITIVE';
  const evidenceDown = direction === 'NEGATIVE';
  // Evidence with no directional lean: there is something on file but nothing for price to agree
  // or disagree with, so the honest answer is no relationship rather than "no reaction".
  if (!evidenceUp && !evidenceDown) return JOIN_LINE.NONE;

  const agrees = (evidenceUp && move > 0) || (evidenceDown && move < 0);
  if (agrees) return JOIN_LINE.CONFIRMING;
  return move <= SELLOFF_PCT ? JOIN_LINE.SELLING_OFF : JOIN_LINE.DIVERGING;
}

// ── THE ADAPTER ─────────────────────────────────────────────────────────────

/** Up to two supporting facts, each a line the Consensus card already renders. */
export function supportingFacts(row, limit = 2) {
  const blocks = Object.values(row?.families || {}).flat().filter(Boolean);
  const out = [];
  for (const b of blocks) {
    if (b.context) out.push(b.context);
    if (out.length >= limit) break;
    if (b.dates) out.push(b.dates);
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

/**
 * Map one materialized Consensus row + its quote onto the row shape boards.mjs consumes,
 * carrying the display fields alongside.
 *
 * @param {object} row   a row from the published consensus board
 * @param {object} quote { price, changePct, freshness } from getQuotes, or null
 */
export function toScanRow(row, quote = null) {
  if (!row?.ticker) return null;
  const levels = row.market?.levels || null;

  // Prefer the live quote; fall back to the daily close the Consensus row already carries. Either
  // way the freshness that gets LABELLED is the freshness of the number actually shown.
  // ⚠️ A PRICE MUST BE POSITIVE TO BE A PRICE, AND ABSENT IS NOT ZERO.
  //
  // The realtime snapshot already refuses a non-positive or stale print (see usableMove), but the
  // DELAYED path is a different function with no integrity checks at all — so a security that has
  // stopped trading could carry a number onto a board through getQuotes while the snapshot would
  // have rejected it. The gate belongs where both paths converge, which is here.
  //
  // `> 0` rather than `isFinite` alone: zero is finite, and a zero that means "we have no price"
  // is the value that renders as "$0.00" beside a percentage move — a row asserting a price it
  // does not have. Absent is null, and the card already renders null as an em dash.
  const positive = (v) => Number.isFinite(v) && v > 0;

  // ⚠️ A QUOTE THAT HAS MISSED MULTIPLE SESSIONS IS NOT "LAST CLOSE".
  //
  // ADTX's quote feed was timestamped 2026-09-10 while the security kept trading — our own daily
  // candles show 11.5M shares on 2026-09-22 — so the board presented a fourteen-day-old print as
  // an ordinary last close. Counting SESSIONS rather than hours is what makes this correct across
  // weekends and holidays: a Monday quote is not stale because Saturday happened.
  //
  // A session-stale quote is set aside, NOT patched: the row then falls through to the daily close
  // we already store, which genuinely is the most recent completed session. Nothing is fabricated
  // and no newer price is invented — a fresher legitimate number simply wins over an older one.
  const quoteLive = quote?.freshness === 'realtime' || quote?.freshness === 'near';
  const quoteSessions = quoteLive ? 0 : sessionsSince(quote?.asOf ?? null);
  const quoteStale = quoteSessions != null && quoteSessions >= STALE_SESSIONS;

  const hasQuote = quote && positive(quote.price) && !quoteStale;
  const rawLast = hasQuote ? quote.price : (positive(levels?.close) ? levels.close : null);
  const last = rawLast === null ? null : Math.round(rawLast * 10000) / 10000;
  // ⚠️ AND A MOVE IS NOT DERIVED FROM A PRICE WE REFUSED. Keeping the change while dropping the
  // price would leave "— / +4.7%", which is the same false claim with the evidence removed.
  const rawChange = rawLast === null ? null
    : (hasQuote && Number.isFinite(quote.changePct)
      ? quote.changePct
      : (Number.isFinite(levels?.changePct) ? levels.changePct : null));
  // Rounded in the PAYLOAD, not only in the component. A raw -3.1007751937984525 in the API is a
  // precision the feed does not have, and any other consumer would render it verbatim.
  const changePct = rawChange === null ? null : Math.round(rawChange * 100) / 100;
  // The age of the price we ACTUALLY ended up showing, whichever source supplied it.
  const priceAsOf = hasQuote ? (quote.asOf ?? null) : (levels?.asOf ?? null);
  const priceSessions = (hasQuote && quoteLive) ? 0 : sessionsSince(priceAsOf);
  const priceStale = rawLast !== null && priceSessions != null && priceSessions >= STALE_SESSIONS;
  // ⚠️ STALE IS ITS OWN FRESHNESS, NOT A VARIANT OF 'eod'. "LAST CLOSE" asserts that the number is
  // the most recent completed session. When it is not, the row has to say the other thing.
  const freshness = rawLast === null ? 'unpriced'
    : priceStale ? 'stale'
      : (hasQuote ? (quote.freshness || 'eod') : 'eod');

  const catBlock = row.families?.[FAMILY.CATALYST]?.[0] || null;

  // ⚠️ WHAT "WE HAVE EVIDENCE" MEANS, IN ONE PLACE. A Moving Now row can now arrive as a bare
  // ticker from the market snapshot with no Consensus record behind it at all — that is the point
  // of a price-first board — so every evidence-shaped field on such a row is absent rather than
  // empty. Asked once here so the join, the evidence line and the card cannot disagree about it.
  const hasEvidence = Boolean(
    row.consensusV1 || row.setup
    || Object.values(row.families || {}).some((list) => (list || []).length),
  );

  return {
    // ── what boards.mjs reads ──
    symbol: row.ticker,
    last,
    changePct,
    // ⚠️ AT THE TOP LEVEL BECAUSE THE BOARD GATES READ IT. boards.mjs is pure and takes the row,
    // not the display block, so a freshness that lived only under `display` would leave the gates
    // unable to tell a current price from a last-known one — which is the whole point here.
    freshness,
    priceAsOf,
    priceSessionsBehind: priceSessions,
    // Same snapshot as the change% above — see structureTags.
    structure: levelsToStructure(levels, changePct),
    // ⚠️ consensusV1, NOT canonical. `canonical` is the v2 SYNTHESIS object (version
    // 'consensus_v2_synthesis') and the divergence gate refuses it by design — measured, it
    // rejected all 28 rows as 'legacy-consensus-refused'. The v1 object carries the
    // version/activeCount/confidence/directionValue the gate actually reads.
    // ⚠️ THE CONFIDENCE HERE IS THE CANONICAL ONE, NOT consensus_v1's.
    //
    // consensusV1 is the deprecated arithmetic the board carries for this gate's OTHER fields
    // (version, activeCount, directionValue). Its confidence is a different generation of the
    // methodology and the board's own comment says it "is shown to nobody" — but Divergence was
    // gating on it, so Consensus could publish a High row while Pit Scan saw Low. Measured on one
    // board: canonical High 2 / Medium 24 / Low 71 against v1's High 0 / Medium 17 / Low 80, and
    // v1 caps confidence at active/4 — making High arithmetically impossible for any row with two
    // or fewer families whatever the evidence said.
    //
    // Overridden here rather than recomputed: setup.confidence IS the production value, taken
    // verbatim. Pit Scan must never own a second definition of confidence. Every other Divergence
    // gate is untouched.
    consensus: row.consensusV1
      ? { ...row.consensusV1, confidence: row.setup?.confidence ?? row.consensusV1.confidence }
      : null,
    catalyst: catBlock ? {
      family: catBlock.family,
      label: catBlock.headline,
      materiality: Number.isFinite(catBlock.materiality) ? catBlock.materiality : 0,
      quality: Number.isFinite(catBlock.quality) ? catBlock.quality : undefined,
      publicAt: catBlock.publicTime,
      ref: catBlock.url || undefined,
    } : null,

    // ── what the row renders ──
    display: {
      ticker: row.ticker,
      last,
      changePct,
      freshness,
      freshnessLabel: freshnessLabel(freshness),
      live: isLiveEnough(freshness),
      structure: structureTags(levels, changePct),
      evidence: evidenceLine(row),
      join: joinLine({
        setup: row.setup?.setup, joinState: row.join_layer?.state, reaction: row.reaction_layer,
        changePct, direction: row.setup?.direction, hasEvidence, stale: priceStale,
      }),
      // Carried so the card can OMIT evidence fields rather than print dashes into them. A row that
      // says "STRUCTURE —  EVIDENCE —" advertises what we do not have; the card's job is to show
      // what we know.
      hasEvidence,
      facts: supportingFacts(row),
      setupLabel: row.setup?.label || null,
      evidenceUrl: `/ticker/${encodeURIComponent(row.ticker)}`,
    },
  };
}

/**
 * ⚠️ ONE REASON PER ROW.
 *
 * boards.mjs writes its own `why` for the gate it applied ("Q2 8-K · 6h", "52W HIGH on +4.2%"),
 * and the row separately renders a compact evidence line composed from the fact blocks. Serving
 * both unreconciled put two different explanations of the same row on screen — the board reason
 * naming a catalyst while EVIDENCE described an insider cluster — and a reader cannot tell which
 * one the row is actually about.
 *
 * The evidence line wins when there is one: it is the composed, setup-aware sentence, where the
 * board reason is a gate trace. The trace is kept under `qualifiedBy`, because "why did THIS board
 * admit this row" stays worth answering — it just is not the row's headline. A row that composes
 * no evidence line still explains itself, by falling back to the trace.
 */
export function servedRow(built) {
  const display = built?.display || {};
  return {
    ...display,
    boardReason: display.evidence || built?.boardReason || null,
    qualifiedBy: built?.boardReason || null,
  };
}

/** Map a whole published board. Rows without a ticker are dropped, never rendered blank. */
export function toScanRows(rows, quotes = {}) {
  return (rows || [])
    .map((r) => toScanRow(r, quotes[String(r?.ticker || '').toUpperCase()] || null))
    .filter(Boolean);
}
