// THE CANONICAL MARKET EVIDENCE OBJECT. PURE: no DB, no network, no AI.
//
// One shape for every meaningful thing Catalyst Pit knows about a company, whatever produced it —
// an 8-K, a Form 4, a 13F quarter, a congressional disclosure, a Wire catalyst, a price reaction.
// Pit Scan, the Wire, ticker pages, watchlists, alerts, the Terminal and the Brief are all meant to
// read THIS, so that "what changed" is answered once rather than reimplemented per surface with
// six subtly different opinions about what counts.
//
// ── PUBLIC_TIME IS THE WHOLE POINT ───────────────────────────────────────────
//
// Every object carries two clocks and they are not interchangeable:
//
//   eventTime   when the thing HAPPENED   (the trade, the agreement, the quarter end)
//   publicTime  when the market COULD HAVE KNOWN  (the filing timestamp, the disclosure date)
//
// Freshness, ordering, "since last check" and chart placement are ALWAYS computed from publicTime.
// Using eventTime would date a congressional purchase to a day nobody outside Congress could have
// known it, and would put a 13F marker on the chart three months before the filing existed. That is
// not a display bug, it is a backtest that cannot be reproduced in real life — the single most
// expensive mistake a market-data product can bake into its foundations.
//
// The invariant is therefore: publicTime >= eventTime, always. An object that violates it is
// QUARANTINED, not silently corrected, because a correction guesses which of the two clocks is
// wrong and we do not know.
//
// ── WHAT THIS LAYER DOES NOT DO ──────────────────────────────────────────────
//
// It does not score stocks. It does not predict. It does not interpret cross-family alignment —
// that is Consensus V1's job, and duplicating it here would give the product two answers to the
// same question. This layer states FACTS and CHANGES, with provenance, and stops.

import { isRenderableTicker } from '../security-identity.mjs';

export const METHODOLOGY_VERSION = 'evidence_v1';

/** The five families. `market` is CONTEXT — it never creates evidence, it only enriches it. */
export const FAMILY = Object.freeze({
  CATALYST: 'catalyst',
  INSIDER: 'insider',
  INSTITUTION: 'institution',
  CONGRESS: 'congress',
  MARKET: 'market',
});
const FAMILIES = new Set(Object.values(FAMILY));

/**
 * Direction is about the EVIDENCE, not about the stock.
 *
 * "An officer bought shares" is positive evidence. It is not a prediction that the stock rises, and
 * nothing downstream may read it as one.
 */
export const DIRECTION = Object.freeze({
  POSITIVE: 'positive', NEGATIVE: 'negative', MIXED: 'mixed',
  NEUTRAL: 'neutral', UNKNOWN: 'unknown',
});
const DIRECTIONS = new Set(Object.values(DIRECTION));

// ── integrity ────────────────────────────────────────────────────────────────
// FAIL CLOSED. Everything here rejects rather than repairs: a quarantined object costs one row on a
// ticker page, a silently repaired one corrupts every consumer that trusts this layer.

/** How far ahead of "now" a publicTime may sit before it is impossible rather than merely odd. */
export const FUTURE_TOLERANCE_MS = 60 * 60 * 1000;   // an hour, for clock skew between our box and a filer's

const isFiniteNum = (n) => typeof n === 'number' && Number.isFinite(n);

/** Parse to epoch ms, or null. Rejects the empty string, which `new Date('')` turns into NaN anyway. */
export function toEpoch(value) {
  if (value == null || value === '') return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Why this object may not be published, or null if it may.
 *
 * Returns a REASON rather than a boolean so quarantined rows can be counted by cause and a
 * regression in one upstream feed is visible as itself instead of as a general shortfall.
 */
export function integrityViolation(ev, { now = Date.now() } = {}) {
  if (!ev || typeof ev !== 'object') return { reason: 'malformed', detail: 'not an object' };

  if (!FAMILIES.has(ev.family)) return { reason: 'family', detail: String(ev.family) };
  if (!ev.type) return { reason: 'type', detail: 'missing' };

  // 'NONE', 'NULL', 'N/A' and friends are not tickers. This is the same gate that keeps unresolved
  // identity off the homepage; evidence goes through it for the same reason.
  if (!isRenderableTicker(ev.ticker)) return { reason: 'ticker', detail: String(ev.ticker) };

  const pub = toEpoch(ev.publicTime);
  if (pub == null) return { reason: 'public_time', detail: 'missing or unparseable' };
  if (pub > now + FUTURE_TOLERANCE_MS) {
    return { reason: 'future', detail: new Date(pub).toISOString() };
  }

  // eventTime is OPTIONAL — plenty of evidence has only a disclosure. When present it must not
  // postdate the disclosure of itself.
  if (ev.eventTime != null) {
    const evt = toEpoch(ev.eventTime);
    if (evt == null) return { reason: 'event_time', detail: 'unparseable' };
    if (evt > now + FUTURE_TOLERANCE_MS) return { reason: 'future', detail: new Date(evt).toISOString() };
    // THE POINT-IN-TIME INVARIANT. The market cannot learn something before it happens.
    if (evt > pub + FUTURE_TOLERANCE_MS) {
      return { reason: 'pit', detail: `event ${new Date(evt).toISOString()} > public ${new Date(pub).toISOString()}` };
    }
  }

  if (ev.direction != null && !DIRECTIONS.has(ev.direction)) {
    return { reason: 'direction', detail: String(ev.direction) };
  }
  for (const k of ['materiality', 'quality']) {
    if (ev[k] == null) continue;
    if (!isFiniteNum(ev[k]) || ev[k] < 0 || ev[k] > 1) return { reason: k, detail: String(ev[k]) };
  }
  // Provenance is not optional. An assertion a trader cannot chase back to a filing is a rumour.
  if (!ev.source) return { reason: 'provenance', detail: 'no source' };
  return null;
}

/**
 * The dedupe key.
 *
 * Two rows describing the SAME underlying disclosure must collapse to one, or a single 8-K that
 * arrived down both the SEC path and the Wire path is shown as two independent catalysts — which
 * would make corroboration look like confirmation. Keyed on the underlying record, not on our own
 * generated text, so re-running the engine cannot mint a second copy of anything.
 */
export function dedupeKey(ev) {
  const canon = ev.canonicalId || ev.sourceId || '';
  return [ev.ticker, ev.family, ev.type, canon].map((s) => String(s ?? '').toUpperCase()).join('|');
}

// ── construction ─────────────────────────────────────────────────────────────

/**
 * Build a canonical evidence object, or return { ok: false, reason } if it cannot be trusted.
 *
 * Nothing in the codebase should construct this shape by hand: going through here is what guarantees
 * every consumer sees the same fields, the same clocks and the same integrity floor.
 */
export function makeEvidence(input, { now = Date.now() } = {}) {
  const src = input || {};
  const publicTime = toEpoch(src.publicTime);
  const eventTime = src.eventTime == null ? null : toEpoch(src.eventTime);

  const ev = {
    evidenceId: src.evidenceId || null,        // filled below from the dedupe key
    ticker: typeof src.ticker === 'string' ? src.ticker.toUpperCase() : src.ticker,
    family: src.family,
    type: src.type,
    subtype: src.subtype ?? null,
    direction: src.direction ?? DIRECTION.UNKNOWN,
    materiality: src.materiality ?? null,
    quality: src.quality ?? null,

    // The two clocks, normalised to ISO. Both are kept; neither is derived from the other.
    eventTime: eventTime == null ? null : new Date(eventTime).toISOString(),
    publicTime: publicTime == null ? null : new Date(publicTime).toISOString(),
    // For 13F this is the quarter end; for a results 8-K, the fiscal period. Never used for
    // freshness — it exists so the UI can say "quarter ended Jun 30, disclosed Aug 14".
    referencePeriod: src.referencePeriod ?? null,

    source: src.source ?? null,                // 'sec_form4', 'sec_13f', 'congress', 'wire', ...
    sourceId: src.sourceId ?? null,            // the underlying row/accession number
    url: src.url ?? null,                      // where a trader verifies it
    canonicalId: src.canonicalId ?? null,      // the shared id when several rows are one event

    summary: src.summary ?? null,              // one factual sentence, already modality-checked
    facts: src.facts ?? null,                  // structured, machine-readable
    context: src.context ?? null,              // historical context, or null when unprovable

    methodology: METHODOLOGY_VERSION,
    calculatedAt: new Date(now).toISOString(),
  };

  // A context line that merely restates the summary is noise wearing the costume of insight. Drop
  // it rather than printing the same sentence twice under two different headings.
  if (ev.context?.text && ev.context.text === ev.summary) ev.context = null;

  const bad = integrityViolation(ev, { now });
  if (bad) return { ok: false, ...bad, evidence: null };

  ev.evidenceId = ev.evidenceId || dedupeKey(ev);
  return { ok: true, evidence: ev };
}

/**
 * Validate, deduplicate and quarantine a batch.
 *
 * Returns the survivors plus a quarantine list, because a silently shorter array is how a feed
 * regression hides. Callers are expected to log `quarantined`.
 */
export function collectEvidence(inputs, { now = Date.now() } = {}) {
  const kept = new Map();
  const quarantined = [];
  for (const raw of Array.isArray(inputs) ? inputs : []) {
    const r = makeEvidence(raw, { now });
    if (!r.ok) { quarantined.push({ reason: r.reason, detail: r.detail, input: raw }); continue; }
    const key = r.evidence.evidenceId;
    const prior = kept.get(key);
    // Same underlying event twice: keep the one that knows more. Ties keep the first, so the
    // function is deterministic for identical inputs.
    if (!prior || score(r.evidence) > score(prior)) kept.set(key, r.evidence);
  }
  return { evidence: [...kept.values()], quarantined };
}

// How much an object knows about itself — used only to break dedupe ties.
const score = (e) => (e.summary ? 2 : 0) + (e.url ? 2 : 0) + (e.context ? 1 : 0) + (e.facts ? 1 : 0);

// ── freshness ────────────────────────────────────────────────────────────────
// ALWAYS from publicTime. There is no variant of this that takes eventTime.

export const FRESH_WINDOWS = Object.freeze({
  today: 24 * 3600e3,
  recent: 7 * 24 * 3600e3,
  active: 30 * 24 * 3600e3,
});

/**
 * HOW LONG EVIDENCE REMAINS CURRENT DEPENDS ON THE FAMILY, and a single window gets 13F wrong.
 *
 * Stale should mean SUPERSEDED — no longer the best available answer — not merely old. A 13F filed
 * 36 days ago is the most current institutional positioning that exists anywhere, and nothing will
 * supersede it until next quarter's filings land; a flat 30-day window marks it stale and hides the
 * entire institutional family from the page. A congressional disclosure has a 45-day statutory
 * filing window, so a month-old one is still news. An 8-K is superseded by the next day's tape.
 */
export const ACTIVE_WINDOW_BY_FAMILY = Object.freeze({
  [FAMILY.INSTITUTION]: 110 * 24 * 3600e3,   // a quarter plus the 45-day filing lag
  [FAMILY.CONGRESS]: 45 * 24 * 3600e3,       // the STOCK Act disclosure window
  [FAMILY.CATALYST]: FRESH_WINDOWS.active,
  [FAMILY.INSIDER]: FRESH_WINDOWS.active,
  [FAMILY.MARKET]: 2 * 24 * 3600e3,          // a price reaction is about today or it is history
});

/** 'today' | 'recent' | 'active' | 'stale' — what the UI groups on. Always from publicTime. */
export function freshness(ev, { now = Date.now() } = {}) {
  const pub = toEpoch(ev?.publicTime);
  if (pub == null) return 'stale';
  const age = now - pub;
  // The family window CAPS the ladder rather than sitting at the bottom of it. Checked first
  // because a family whose window is shorter than the universal 'recent' tier — market reaction,
  // at two days — would otherwise be unreachable, and a three-day-old price move would report
  // itself as recent forever.
  const active = ACTIVE_WINDOW_BY_FAMILY[ev?.family] ?? FRESH_WINDOWS.active;
  if (age > active) return 'stale';
  if (age <= FRESH_WINDOWS.today) return 'today';
  if (age <= FRESH_WINDOWS.recent) return 'recent';
  return 'active';
}

export function ageMs(ev, { now = Date.now() } = {}) {
  const pub = toEpoch(ev?.publicTime);
  return pub == null ? null : now - pub;
}

/**
 * Evidence published strictly after a timestamp — the primitive "3 things changed since you last
 * checked" is built on. Deliberately a pure filter over publicTime rather than a per-user state
 * machine: the client supplies the watermark, so no notification system is needed to answer it.
 */
export function changedSince(list, since, { now = Date.now() } = {}) {
  const t = toEpoch(since);
  if (t == null) return [];
  return (Array.isArray(list) ? list : []).filter((e) => {
    const pub = toEpoch(e?.publicTime);
    return pub != null && pub > t && pub <= now + FUTURE_TOLERANCE_MS;
  });
}
