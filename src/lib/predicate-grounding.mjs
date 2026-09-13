// Predicate grounding. PURE: no DB, no network, no AI.
//
// The existing validators in grounding.mjs catch fabricated NOUNS and NUMBERS. They never inspect
// the predicate, so from "Acme Corp raises full-year guidance" every one of these passed:
//
//   "Acme Corp cuts full-year guidance"          the opposite fact
//   "Acme Corp files for bankruptcy protection"  a different event entirely
//   "Acme Corp raises guidance on strong AI demand"   a cause the source never gave
//
// A verb flip invents no proper noun and no figure, so nothing fired. For a trading wire that is the
// most dangerous failure available, and it is exactly the mistake a language model is most likely to
// make. This module checks what the sentence ASSERTS, not just what it names.
//
// FAIL CLOSED: anything this cannot prove safe is rejected, and the event stays rewrite_pending.

import { actionClass } from './event-cluster.mjs';

// ── direction ────────────────────────────────────────────────────────────────
// Each axis is a pair of opposed verb families. If the source is positive on an axis and the rewrite
// is negative on that same axis (or vice versa), the rewrite reversed a fact.
const AXES = [
  ['guidance', /\b(?:rais(?:e|es|ed|ing)|lift(?:s|ed|ing)?|boost(?:s|ed|ing)?|hik(?:e|es|ed|ing)|upgrad(?:e|es|ed)|increas(?:e|es|ed|ing))\b/i,
    /\b(?:cut(?:s|ting)?|lower(?:s|ed|ing)?|reduc(?:e|es|ed|ing)|trim(?:s|med|ming)?|slash(?:es|ed|ing)?|downgrad(?:e|es|ed)|decreas(?:e|es|ed|ing)|withdraw(?:s|n|ing)?|suspend(?:s|ed|ing)?)\b/i],

  ['results', /\b(?:beat(?:s|ing)?|top(?:s|ped|ping)?|exceed(?:s|ed|ing)?|surpass(?:es|ed|ing)?|above estimates?)\b/i,
    /\b(?:miss(?:es|ed|ing)?|fall(?:s|ing)? short|trail(?:s|ed|ing)?|below estimates?|shy of)\b/i],

  ['regulatory', /\b(?:approv(?:e|es|ed|al)|clear(?:s|ed|ance)?|authoriz(?:e|es|ed|ation)|grant(?:s|ed)?)\b/i,
    /\b(?:reject(?:s|ed|ion)?|denie[sd]|deny(?:ing)?|declin(?:e|es|ed)|refus(?:e|es|ed)|complete response letter|CRL)\b/i],

  ['trade', /\b(?:buy(?:s|ing)?|bought|acquir(?:e|es|ed|ing)|purchas(?:e|es|ed|ing)|takes? (?:a )?stake)\b/i,
    /\b(?:sell(?:s|ing)?|sold|divest(?:s|ed|ing|iture)?|offload(?:s|ed|ing)?|exit(?:s|ed|ing)?|unload(?:s|ed)?)\b/i],

  ['scale', /\b(?:expand(?:s|ed|ing|sion)?|grow(?:s|ing)?|grew|add(?:s|ed|ing)?|open(?:s|ed|ing)?|hir(?:e|es|ing))\b/i,
    /\b(?:contract(?:s|ed|ing)?|shrink(?:s|ing)?|shrank|clos(?:e|es|ed|ing)|layoff|lay(?:s|ing)? off|shut(?:s|ting)?|fir(?:e|es|ed|ing))\b/i],

  ['trend', /\b(?:ris(?:e|es|ing)|rose|climb(?:s|ed|ing)?|jump(?:s|ed|ing)?|gain(?:s|ed|ing)?|surg(?:e|es|ed|ing)|rall(?:y|ies|ied)|soar(?:s|ed|ing)?)\b/i,
    /\b(?:fall(?:s|ing)?|fell|drop(?:s|ped|ping)?|declin(?:e|es|ed|ing)|slid(?:e|es)?|sink(?:s|ing)?|sank|plung(?:e|es|ed|ing)|tumbl(?:e|es|ed|ing))\b/i],

  ['outcome', /\b(?:win(?:s|ning)?|won|succeed(?:s|ed)?|success(?:ful)?|meet(?:s|ing)? (?:its )?(?:primary )?endpoint|positive)\b/i,
    /\b(?:los(?:e|es|ing)|lost|fail(?:s|ed|ure|ing)?|miss(?:es|ed)? (?:its )?(?:primary )?endpoint|negative)\b/i],
];

// -1, 0 (absent or both) or +1 for one axis.
function polarity(text, [, pos, neg]) {
  const p = pos.test(text), n = neg.test(text);
  if (p && n) return 0;          // both present — no single direction is being asserted
  if (p) return 1;
  if (n) return -1;
  return 0;
}

export function directionConflict(output, source) {
  for (const axis of AXES) {
    const o = polarity(output, axis), s = polarity(source, axis);
    if (o !== 0 && s !== 0 && o !== s) {
      return { axis: axis[0], source: s > 0 ? 'positive' : 'negative', output: o > 0 ? 'positive' : 'negative' };
    }
  }
  return null;
}

// ── event type ───────────────────────────────────────────────────────────────
// Reuses the engine's own deterministic classifier, read-only, to COMPARE the two sentences. It is
// never used here to assert what happened — only to notice that the rewrite claims a different kind
// of event from the one the source described.
// "approves" is the regulatory verb, but it is also what a board does to a payout or a buyback.
// Without a regulator or a regulatory noun in the sentence, "approves" is not evidence that the
// rewrite claims a regulatory approval — and treating it as such would reject ordinary corporate
// paraphrases like "approves its quarterly payout" and strand them as pending forever.
const REGULATORY_CONTEXT = /\b(?:FDA|EMA|MHRA|CE mark|regulator|regulatory|clearance|authoriz\w*|marketing authorisation|approval)\b/i;
const classOf = (text) => {
  const c = actionClass(text);
  if (c === 'approval' && !REGULATORY_CONTEXT.test(text)) return null;
  return c;
};

export function eventTypeConflict(output, source) {
  const so = classOf(source), oo = classOf(output);
  // Both classify and disagree: the rewrite changed the event.
  if (so && oo && so !== oo) return { source: so, output: oo };
  // The rewrite asserts an event class the source never did: an added claim.
  if (!so && oo) return { source: null, output: oo };
  // Source classifies, rewrite does not: a vaguer sentence is not a changed fact, so this is
  // allowed. The number, name and direction checks still apply to it.
  return null;
}

// ── unsupported causal claims ────────────────────────────────────────────────
// "X raises guidance ON STRONG AI DEMAND" asserts a reason. If the source never gave that reason,
// the rewrite invented the WHY even though every noun and figure in it might be real.
const CAUSAL = /\b(?:on the back of|due to|because of|driven by|thanks to|owing to|amid|following|citing|after|as|on)\s+(.{3,80})$/i;
const CAUSE_STOP = new Set(['the', 'a', 'an', 'its', 'their', 'his', 'her', 'this', 'that', 'these',
  'those', 'and', 'or', 'but', 'for', 'with', 'from', 'into', 'over', 'under', 'more', 'most',
  'than', 'then', 'also', 'both', 'each', 'such', 'some', 'any', 'all', 'new', 'year', 'years',
  'quarter', 'first', 'second', 'third', 'fourth', 'full']);

// A word counts as supported when the source contains it in ANY form. Matching on a stem rather
// than the exact string matters: rejecting "quarterly" because the source wrote "third-quarter"
// would force rewrites back toward copying the publisher's exact words, which defeats the point of
// rewriting at all. A genuinely invented reason ("strong AI demand") shares no stem and still fails.
const stem = (w) => w.replace(/(?:ies|ly|s|es|ed|ing)$/, '');
function supported(word, hay) {
  if (hay.includes(word)) return true;
  const st = stem(word);
  return st.length >= 4 && hay.includes(st);
}

export function unsupportedCause(output, source) {
  const m = CAUSAL.exec(String(output || ''));
  if (!m) return null;
  const hay = String(source || '').toLowerCase();
  const words = m[1].toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 4 && !CAUSE_STOP.has(w));
  if (!words.length) return null;                 // nothing substantive asserted
  // Every content word of the stated reason must be traceable to the source.
  const missing = words.filter((w) => !supported(w, hay));
  return missing.length ? { clause: m[1].trim().slice(0, 60), missing: missing.slice(0, 4) } : null;
}

// ── entry point ──────────────────────────────────────────────────────────────
// { ok: true } or { ok: false, reason, detail }. Reasons:
//   direction   the rewrite reversed a fact the source asserted
//   event_type  the rewrite describes a different kind of event
//   cause       the rewrite added a reason the source did not give
export function validatePredicate(output, sourceText) {
  const out = String(output || '');
  const src = String(sourceText || '');
  if (!out) return { ok: false, reason: 'empty' };

  const d = directionConflict(out, src);
  if (d) return { ok: false, reason: 'direction', detail: `${d.axis}: source ${d.source}, rewrite ${d.output}` };

  const e = eventTypeConflict(out, src);
  if (e) return { ok: false, reason: 'event_type', detail: `source ${e.source || 'none'} -> rewrite ${e.output}` };

  const c = unsupportedCause(out, src);
  if (c) return { ok: false, reason: 'cause', detail: `"${c.clause}" (unsupported: ${c.missing.join(', ')})` };

  return { ok: true };
}
