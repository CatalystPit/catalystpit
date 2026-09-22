// FAMILY FACTS — what each evidence family actually SAYS.
//
// V2.1 rendered "Institutions Positive". That is the shape of a vote. The intelligence is
// "448 managers vs 433 prior quarter, breadth up four consecutive quarters, quarter ended Jun 30,
// disclosed Aug 6" — and every one of those numbers already exists on the canonical record.
//
// ── RULES ───────────────────────────────────────────────────────────────────
//
// 1. EVERY LINE COMES FROM A CANONICAL FIELD. Nothing is inferred, estimated or phrased into
//    meaning the record does not carry. If a fact is absent the line is omitted — never rendered as
//    "undefined", never back-filled with a neutral-sounding guess.
// 2. THE ENGINE'S OWN SUMMARY IS THE HEADLINE. It is already a factual sentence written from the
//    same record, and rewriting it here would be a second opinion — the exact drift that makes What
//    Changed and Consensus disagree about the same filing.
// 3. BOTH CLOCKS, ALWAYS, WHERE THEY DIFFER. A congressional trade on Aug 7 disclosed Sep 7 is two
//    facts, and collapsing them would claim the market knew a month early.
// 4. NO PREDICTION. These sentences describe what was disclosed. None of them says what price will
//    do, and none may acquire a verb like "should" or "will".
//
// Field availability was measured in production first — see research/consensus-v3-capability-
// census.md. Coverage differs sharply by family (congress 100% on ten fields, catalysts only two),
// so each builder branches on presence rather than assuming a uniform shape.

import { FAMILY } from '../evidence/model.mjs';
import { implausibleBreadth } from '../evidence/history.mjs';

export const FACTS_VERSION = 'consensus_v3_facts';

// ── FORMATTING ──────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-06-30' or an ISO instant -> 'Jun 30'. Returns null rather than a broken string. */
export function shortDate(value) {
  if (!value) return null;
  const s = String(value);
  // A bare date is formatted from its parts so a timezone cannot shift it across midnight.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** How long ago something became public, in the words What Changed already uses. */
export function publicAgo(publicTime, now = Date.now()) {
  const t = Date.parse(publicTime);
  if (!Number.isFinite(t)) return null;
  const mins = Math.floor((now - t) / 60000);
  if (mins < 0) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  const days = Math.floor(mins / 1440);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/** 2638405.99 -> '$2.6M'. Only used when the engine did not already supply a label. */
export function usd(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ── PER-FAMILY BUILDERS ─────────────────────────────────────────────────────
//
// Each returns { lines: string[], dates: string|null }. `lines` are supporting facts beneath the
// engine's summary; `dates` is the second-clock line, present only where the two clocks differ.

/**
 * INSIDERS. Buy records carry buyers/officer/executive/title/totalValueLabel; sell records carry
 * sellers and a raw totalValue instead. Measured: those buy-only fields appear on 22% of records,
 * so branching on presence is mandatory, not defensive.
 */
function insiderFacts(ev) {
  const f = ev.facts || {};
  const lines = [];

  // WHO acted, when we know. A title is the single most useful insider fact after the amount —
  // "CEO AND PRESIDENT" is a different signal from a 10% owner.
  if (f.title) lines.push(f.executive ? `${f.title} · ${f.executive}` : String(f.title));
  else if (f.executive) lines.push(String(f.executive));

  // HOW MUCH and HOW MANY, when the summary has not already said it.
  const value = f.totalValueLabel || usd(f.totalValue);
  const actors = f.buyers ?? f.sellers ?? null;
  const detail = [];
  if (Number.isFinite(f.transactions) && f.transactions > 1) {
    detail.push(plural(f.transactions, 'transaction', 'transactions'));
  }
  if (value && !String(ev.summary || '').includes(value)) detail.push(value);
  if (actors != null && actors > 1 && !String(ev.summary || '').includes(String(actors))) {
    detail.push(plural(actors, f.buyers != null ? 'buyer' : 'seller', f.buyers != null ? 'buyers' : 'sellers'));
  }
  if (detail.length) lines.push(detail.join(' · '));

  return { lines, dates: null };
}

/**
 * INSTITUTIONS. The two clocks are the whole point: a 13F published in August describes positions
 * as they stood on June 30. Presenting breadth without both dates would read as live positioning.
 */
function institutionFacts(ev) {
  const f = ev.facts || {};
  const lines = [];

  // ⚠️ SUPPRESS TICKER-RESOLUTION ARTIFACTS. A breadth "change" of 1139 -> 1750 is a CUSIP mapping
  // artifact, not 611 managers opening a position in one quarter. The engine already refuses to
  // draw a historical conclusion from these; printing the raw pair anyway would put the artifact in
  // front of the reader as a fact. The quarter and disclosure dates below still render.
  const artifact = implausibleBreadth(f.breadthFrom, f.breadthTo);

  // The engine's summary already reads "Institutions holding this stock increased from 433 to
  // 448", so repeating it as "448 managers vs 433 prior quarter" printed the same fact twice.
  //
  // ⚠️ AND THE WORDING HERE HAS TO MATCH IT. This line sits directly under that summary on the
  // same card, so "55 managers added" beside "Institutions holding this stock increased" gave one
  // concept two vocabularies in two adjacent sentences. "added"/"dropped" also read as trades,
  // which 13F cannot support — what changed is how many filers REPORTED a position.
  if (!artifact && Number.isFinite(f.delta) && f.delta !== 0) {
    const dir = f.delta > 0 ? 'more' : 'fewer';
    lines.push(`${Math.abs(f.delta)} ${dir} institutions reported holding it than the prior quarter`);
  }
  if (artifact) lines.push('Institutional ownership count not shown — inconsistent ticker mapping between quarters');

  const qEnd = shortDate(f.quarterEnd);
  const disclosed = shortDate(f.disclosedAt || ev.publicTime);
  // ⚠️ NEVER COLLAPSED. Quarter represented and disclosure date are separate facts.
  const dates = qEnd && disclosed ? `Quarter ended ${qEnd} · disclosed ${disclosed}` : null;

  return { lines, dates };
}

/**
 * CONGRESS. The richest family: every field below is present on 100% of production records.
 * The disclosure lag is stated explicitly because it is the point-in-time fact a reader most needs.
 */
function congressFacts(ev) {
  const f = ev.facts || {};
  const lines = [];

  // Member identity, where the record names one. `congress_multi` names the largest filer.
  const who = [f.party, f.state && `${f.state}`, f.chamber && f.chamber === 'house' ? 'House' : f.chamber === 'senate' ? 'Senate' : null]
    .filter(Boolean).join(' · ');
  if (who) lines.push(who);
  if (f.amountRange) lines.push(String(f.amountRange));
  if (Number.isFinite(f.members) && f.members > 1) lines.push(plural(f.members, 'member', 'members'));

  // ⚠️ TRANSACTION DATE IS NOT PUBLIC TIME. Stating the lag makes that impossible to misread.
  const traded = shortDate(f.transactionDate);
  const lag = Number.isFinite(f.disclosureLagDays) ? f.disclosureLagDays : null;
  const dates = traded
    ? (lag !== null ? `Traded ${traded} · disclosed ${lag} ${lag === 1 ? 'day' : 'days'} later` : `Traded ${traded}`)
    : null;

  return { lines, dates };
}

/**
 * CATALYSTS. Deliberately thin, because the record is thin: measured in production, an 8-K carries
 * only its item codes and a materiality flag, and no historical context ever. The item codes are
 * shown verbatim for verification — they are a citation, not an interpretation, and the engine's
 * own `type` has already done the classifying.
 */
function catalystFacts(ev) {
  const f = ev.facts || {};
  const lines = [];
  if (Array.isArray(f.items) && f.items.length) lines.push(`8-K item ${f.items.join(', ')}`);
  // The event date, when the filing reports something that happened on a different day.
  const evented = shortDate(ev.eventTime);
  const pub = shortDate(ev.publicTime);
  const dates = evented && pub && evented !== pub ? `Event dated ${evented} · filed ${pub}` : null;
  return { lines, dates };
}

const BUILDERS = {
  [FAMILY.INSIDER]: insiderFacts,
  [FAMILY.INSTITUTION]: institutionFacts,
  [FAMILY.CONGRESS]: congressFacts,
  [FAMILY.CATALYST]: catalystFacts,
};

const FAMILY_LABEL = Object.freeze({
  [FAMILY.CATALYST]: 'CATALYST',
  [FAMILY.INSIDER]: 'INSIDERS',
  [FAMILY.INSTITUTION]: 'INSTITUTIONS',
  [FAMILY.CONGRESS]: 'CONGRESS',
  [FAMILY.MARKET]: 'PRICE',
});

/**
 * The display model for one evidence record: a headline the engine wrote, supporting facts, both
 * clocks, historical context where provable, and a verification link where one is stored.
 */
export function evidenceFacts(ev, { now = Date.now() } = {}) {
  if (!ev) return null;
  const build = BUILDERS[ev.family];
  const { lines, dates } = build ? build(ev) : { lines: [], dates: null };

  return {
    evidenceId: ev.evidenceId,
    family: ev.family,
    familyLabel: FAMILY_LABEL[ev.family] || String(ev.family || '').toUpperCase(),
    direction: ev.direction,
    // THE ENGINE'S SENTENCE, not ours.
    headline: ev.summary || null,
    lines,
    dates,
    // Only where history.mjs was willing to make the claim. A null context means say nothing.
    context: ev.context?.text || null,
    contextNote: ev.context?.note || null,
    unusual: Boolean(ev.context?.unusual || ev.context?.boundedByCoverage
      || typeof ev.context?.gapDays === 'number'),
    publicTime: ev.publicTime,
    publicAgo: publicAgo(ev.publicTime, now),
    // ⚠️ PASSED THROUGH, NEVER CONSTRUCTED. Institutions legitimately have none — there is no
    // per-ticker 13F document — and a fabricated link that does not open the filing looks like
    // verification, which is worse than no link.
    url: ev.url || null,
    materiality: ev.materiality ?? null,
    quality: ev.quality ?? null,
  };
}

/**
 * The best record per family, as facts.
 *
 * Ranked by the canonical engine before selection, so the record shown here is the same one the
 * ticker page ranks first. A family with nothing to say is ABSENT from the result — never present
 * with a neutral-sounding placeholder, because missing is not neutral.
 */
export function familyFactSheet(evidence, { now = Date.now(), perFamily = 1 } = {}) {
  const out = {};
  for (const ev of evidence || []) {
    if (!BUILDERS[ev.family]) continue;
    (out[ev.family] ||= []).push(evidenceFacts(ev, { now }));
  }
  for (const k of Object.keys(out)) out[k] = out[k].slice(0, perFamily);
  return out;
}
