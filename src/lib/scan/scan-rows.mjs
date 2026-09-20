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

export const SCAN_ROWS_VERSION = 'scan_rows_v1';

// ── FRESHNESS LABELLING ─────────────────────────────────────────────────────
//
// ⚠️ THE MOST IMPORTANT HONESTY RULE IN THIS FILE. Realtime is not entitled: Tiingo returns EOD, so
// a row's "% change" is the last completed session's close-to-close move — yesterday's move, not
// today's. A board called "Moving Now" printing that without saying so would be the precise failure
// the scanner's own header refuses: telling a trader something untrue at the moment they act.
export const FRESHNESS_LABEL = Object.freeze({
  realtime: null,          // nothing to disclose
  near: 'DELAYED',
  delayed: 'DELAYED',
  eod: 'LAST CLOSE',
});
// ⚠️ NOT `??` HERE. `realtime` maps to null meaning "nothing to disclose", and nullish-coalescing
// would fall straight through to 'LAST CLOSE' — labelling a genuinely live quote as stale, the
// exact inverse of the rule this map exists to enforce. An unrecognised freshness still falls
// through to the weakest label, because an unknown provenance is not a live one.
export const freshnessLabel = (f) => (f in FRESHNESS_LABEL ? FRESHNESS_LABEL[f] : 'LAST CLOSE');

/** Is this quote live enough to describe a move as happening NOW? */
export const isLiveEnough = (f) => f === 'realtime' || f === 'near';

// ── STRUCTURE TAGS, FROM DAILY BARS ONLY ────────────────────────────────────
//
// The only structure we can honestly claim on an end-of-day feed. Premarket highs, opening ranges,
// VWAP and session extremes all need intraday bars that do not exist in this database, and the
// signal registry already darkens them. Omitted, never approximated.
export function structureTags(levels) {
  if (!levels) return [];
  const tags = [];
  if (levels.at52wHigh) tags.push('52W HIGH');
  else if (levels.at52wLow) tags.push('52W LOW');
  else if (levels.at20dHigh) tags.push('20D HIGH');
  else if (levels.at20dLow) tags.push('20D LOW');
  if (levels.abovePrevClose === true) tags.push('ABOVE PRIOR CLOSE');
  else if (levels.abovePrevClose === false) tags.push('BELOW PRIOR CLOSE');
  return tags;
}

/**
 * The `structure` object boards.mjs reads.
 *
 * ⚠️ `at` IS DELIBERATELY NULL. boards.mjs ages a structure signal against a 90-minute window, and
 * `levels.asOf` is a DATE — so a real timestamp here would be hours or days old and every row would
 * silently fail as 'structure-stale'. A daily level is not a 90-minute event; passing null says
 * "this has no intraday clock" rather than asserting a false one.
 */
export function levelsToStructure(levels) {
  const tags = structureTags(levels);
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
export const JOIN_LINE = Object.freeze({
  CONFIRMING: 'PRICE CONFIRMING',
  DIVERGING: 'PRICE DIVERGING',
  SELLING_OFF: 'PRICE SELLING OFF',
  CONFLICT_MOVING: 'CONFLICT + MOVING',
  NO_REACTION: 'NO REACTION',
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
export function joinLine({ setup, joinState, reaction, changePct, direction } = {}) {
  const conflicted = setup === 'CROSS_SOURCE_CONFLICT' || joinState === 'SOURCES_CONFLICT'
    || direction === 'MIXED';

  // Prefer the displayed move; fall back to the evidence-anchored reaction when there is no quote.
  const move = Number.isFinite(changePct) ? changePct
    : (Number.isFinite(reaction?.abs) ? reaction.abs : null);
  if (move === null) return JOIN_LINE.NONE;
  if (Math.abs(move) < SCAN_DEAD_ZONE_PCT) return JOIN_LINE.NO_REACTION;

  if (conflicted) {
    return move <= SELLOFF_PCT ? JOIN_LINE.SELLING_OFF : JOIN_LINE.CONFLICT_MOVING;
  }
  // With a one-sided reading, does the move agree with it?
  const evidenceUp = direction === 'POSITIVE';
  const evidenceDown = direction === 'NEGATIVE';
  if (!evidenceUp && !evidenceDown) return JOIN_LINE.NO_REACTION;

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
  const hasQuote = quote && Number.isFinite(quote.price);
  const last = hasQuote ? quote.price : (Number.isFinite(levels?.close) ? levels.close : null);
  const changePct = hasQuote && Number.isFinite(quote.changePct)
    ? quote.changePct
    : (Number.isFinite(levels?.changePct) ? levels.changePct : null);
  const freshness = hasQuote ? (quote.freshness || 'eod') : 'eod';

  const catBlock = row.families?.[FAMILY.CATALYST]?.[0] || null;

  return {
    // ── what boards.mjs reads ──
    symbol: row.ticker,
    last,
    changePct,
    structure: levelsToStructure(levels),
    // ⚠️ consensusV1, NOT canonical. `canonical` is the v2 SYNTHESIS object (version
    // 'consensus_v2_synthesis') and the divergence gate refuses it by design — measured, it
    // rejected all 28 rows as 'legacy-consensus-refused'. The v1 object carries the
    // version/activeCount/confidence/directionValue the gate actually reads.
    consensus: row.consensusV1 || null,
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
      structure: structureTags(levels),
      evidence: evidenceLine(row),
      join: joinLine({
        setup: row.setup?.setup, joinState: row.join_layer?.state, reaction: row.reaction_layer,
        changePct, direction: row.setup?.direction,
      }),
      facts: supportingFacts(row),
      setupLabel: row.setup?.label || null,
      evidenceUrl: `/ticker/${encodeURIComponent(row.ticker)}`,
    },
  };
}

/** Map a whole published board. Rows without a ticker are dropped, never rendered blank. */
export function toScanRows(rows, quotes = {}) {
  return (rows || [])
    .map((r) => toScanRow(r, quotes[String(r?.ticker || '').toUpperCase()] || null))
    .filter(Boolean);
}
