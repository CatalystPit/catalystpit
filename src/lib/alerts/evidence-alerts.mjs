// EVIDENCE ALERTS — deciding which canonical evidence becomes an alert, and for whom.
//
// ── ⚠️ THIS DECIDES NOTHING ABOUT MARKETS. IT DECIDES TIMING AND AUDIENCE. ──
//
// An alert means exactly one thing: "something meaningful just became publicly knowable about a
// ticker I asked Catalyst Pit to monitor." It is not a recommendation, not a prediction and not a
// judgement that the evidence is bullish or bearish. The Evidence Engine already decided what
// counts as evidence and what it says; this file only asks two questions about an object the
// engine already produced:
//
//   1. Is it in a family a person can be alerted about?
//   2. Did it become public AFTER this person asked to be told?
//
// There is no threshold here, no score, no ranking and no second materiality rule. If you find
// yourself adding one, it belongs in the Evidence Engine or nowhere.
//
// ── ⚠️ PUBLIC TIME, AND ONLY PUBLIC TIME ────────────────────────────────────
//
// The engine carries two clocks on every object — eventTime (when it happened) and publicTime
// (when the market could have known). Alerting on eventTime would tell a trader about a
// congressional purchase on a day nobody outside Congress could have known it, and would fire a
// 13F alert three months before the filing existed. Every timing decision below runs through
// changedSince(), which reads publicTime and nothing else.
//
// ── ⚠️ AND IT FAILS CLOSED ──────────────────────────────────────────────────
//
// Every rejection path here drops the alert rather than repairing it. A missing alert costs a
// person one row they can still find on the ticker page; a fabricated or mistimed one costs them
// the belief that the bell means something.

import { FAMILY, changedSince } from '../evidence/model.mjs';

/**
 * The families a person can be alerted about.
 *
 * ⚠️ MARKET IS ABSENT ON PURPOSE, AND IT IS THE ONLY EXCLUSION. The engine documents `market` as
 * CONTEXT — "it never creates evidence, it only enriches it" — so a price reaction is not something
 * that became publicly knowable, it is the market responding to something that did. Alerting on it
 * would be a price alert wearing an evidence costume, which is explicitly a later product.
 */
export const ALERTABLE_FAMILIES = Object.freeze([
  FAMILY.CATALYST, FAMILY.INSIDER, FAMILY.INSTITUTION, FAMILY.CONGRESS,
]);
const ALERTABLE = new Set(ALERTABLE_FAMILIES);

/**
 * What the family is CALLED in the inbox.
 *
 * ⚠️ A NAME, NOT A CHARACTERISATION. "Insider activity" says which record moved; it does not say
 * whether that is good news. The sentence under it is the engine's own summary, unedited.
 */
export const FAMILY_LABEL = Object.freeze({
  [FAMILY.CATALYST]: 'Material SEC filing',
  [FAMILY.INSIDER]: 'Insider activity',
  [FAMILY.CONGRESS]: 'Congress disclosure',
  [FAMILY.INSTITUTION]: 'Institutional disclosure',
});

/**
 * How far back a single worker run looks for evidence it has not delivered yet.
 *
 * ⚠️ THIS IS A CATCH-UP MARGIN, NOT A WINDOW. Every candidate is still gated on
 * publicTime > the subscriber's own watermark, so widening this can never deliver something older
 * than a person's subscription — it only decides how long an outage can last before a legitimately
 * new item is missed. A week is generous for a worker that runs every fifteen minutes.
 */
export const LOOKBACK_DAYS = 7;

/** How long a READ alert is kept. */
export const RETENTION_DAYS = 30;

/**
 * How long an UNREAD alert is kept.
 *
 * ⚠️ LONGER THAN READ ON PURPOSE. Deleting something a person has not seen yet is deleting the
 * feature: they asked to be told, and a quiet prune would mean they never were.
 */
export const UNREAD_RETENTION_DAYS = 90;

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

/**
 * One canonical evidence object as an alert row, or null.
 *
 * ⚠️ EVERY FIELD IS THE ENGINE'S. `title` is the family's name from the table above, `detail` is
 * the engine's own factual summary, `url` is where the person verifies it, and `evidenceId` is the
 * engine's own canonical identity — which is what makes one real-world event one alert even when
 * it reached us as a press release, a wire item and an SEC filing.
 */
export function toAlert(ev) {
  if (!ev || typeof ev !== 'object') return null;
  // Identity first: without the engine's id there is no way to promise this fires once, and the
  // brief's rule is that an id we cannot establish means no alert rather than a possible duplicate.
  const evidenceId = typeof ev.evidenceId === 'string' ? ev.evidenceId.trim() : '';
  if (!evidenceId) return null;
  const ticker = typeof ev.ticker === 'string' ? ev.ticker.trim().toUpperCase() : '';
  if (!TICKER_RE.test(ticker)) return null;
  if (!ALERTABLE.has(ev.family)) return null;
  const title = FAMILY_LABEL[ev.family];
  if (!title) return null;
  // publicTime is re-validated here even though changedSince already compared it, because this
  // function is also the one that writes the row and the row's timestamp must be sound on its own.
  const pub = Date.parse(ev.publicTime);
  if (!Number.isFinite(pub)) return null;
  // The engine's own sentence, or the type it assigned when it had no sentence to give. Never a
  // sentence composed here.
  const detail = (typeof ev.summary === 'string' && ev.summary.trim())
    || (typeof ev.type === 'string' && ev.type.trim()) || null;
  if (!detail) return null;
  return {
    evidenceId,
    ticker,
    family: ev.family,
    title,
    detail,
    url: typeof ev.url === 'string' && ev.url ? ev.url : null,
    publicTime: new Date(pub).toISOString(),
  };
}

/**
 * The alerts one subscriber should receive from one ticker's resolved evidence.
 *
 * @param evidence resolved canonical evidence for the ticker, as tickerEvidence() returns it.
 * @param since    the subscriber's watermark — when they asked to be told.
 *
 * ⚠️ changedSince IS THE POINT-IN-TIME GUARANTEE, AND IT IS NOT REIMPLEMENTED HERE. It compares
 * publicTime only, rejects anything dated beyond the engine's future tolerance, and returns NOTHING
 * when `since` is unreadable — so a malformed watermark produces no alerts rather than all of them.
 */
export function alertsFor(evidence, since, { now = Date.now() } = {}) {
  const fresh = changedSince(Array.isArray(evidence) ? evidence : [], since, { now });
  const out = [];
  const seen = new Set();
  for (const ev of fresh) {
    const a = toAlert(ev);
    if (!a || seen.has(a.evidenceId)) continue;
    seen.add(a.evidenceId);
    out.push(a);
  }
  // Oldest first, so a burst arrives in the order it became public rather than in ranking order.
  out.sort((a, b) => Date.parse(a.publicTime) - Date.parse(b.publicTime));
  return out;
}
