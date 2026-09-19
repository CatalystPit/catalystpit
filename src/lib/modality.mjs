// Modality preservation. PURE: no DB, no network, no AI.
//
// predicate-grounding.mjs checks WHAT the rewrite asserts. This file checks HOW STRONGLY it asserts
// it — whether a thing the source merely floated has come out the other side as a fact.
//
// THE FAILURE THIS EXISTS TO STOP:
//
//   source:  "Gold At $155,000 An Ounce"          (a revaluation thought experiment)
//   rewrite: "Gold reaches $155,000 per ounce"    (an asserted market event)
//
// Every existing gate passes that. "155,000" traces to the source. "Gold" appears in the source.
// No direction is reversed — neither sentence has a direction verb. No event class conflicts. No
// causal clause is added. And anticipationConflict() does not fire, because the source contains none
// of its markers: there is no "ahead of", no "expected to", no "consensus is for". The source
// headline contains NO HEDGING WORD AT ALL. It is verbless. That is precisely why a word list cannot
// catch it, and why this file reasons about STRUCTURE instead:
//
//   1. ASSERTION STRENGTH MAY NEVER INCREASE. Classify the frame of the source and the frame of the
//      rewrite. A source that does not assert a fact cannot produce a rewrite that does.
//
//   2. A QUOTED LEVEL IS NOT AN ACHIEVED LEVEL. If the rewrite says a number was REACHED, the source
//      must say that number was reached. A price sitting behind "at", "to", "target" or "forecast"
//      is a level under discussion, not a level attained.
//
//   3. AN OPINION IS ITS HOLDER'S. Drop the person and an argument becomes a finding.
//
// Rule 2 is the load-bearing one. It does not care what words the source used to frame the number,
// only that it never said the number happened — so it holds against phrasings nobody has thought of
// yet, which is the property a word list can never have.
//
// SCOPE. `sourceText` is built by primary-events.js as "HEADLINE: <headline>\n<summary>". The
// headline carries the frame and the body elaborates it, so the frame is read from line 0. The body
// is consulted only to CONFIRM a fact, never to license one — an essay about a hypothetical is full
// of ordinary factual sentences, and letting the body vote would hand back the whole failure.
//
// FAIL CLOSED, like every other gate here: what this cannot prove safe is rejected, and the event
// keeps the source's own headline (headline_status='source_fallback'). A suppressed rewrite costs us
// one original headline. A published one costs us the only thing the product sells.

// ── the scale ────────────────────────────────────────────────────────────────
// How close a sentence comes to asserting that something is REAL. Only two comparisons are ever made
// against it — "is the rewrite factual when the source was not", and the attribution rule below — so
// the ordering of the middle bands carries no weight it cannot bear. Arguing whether a forecast
// outranks a possibility would be arguing about something this file never asks.
export const RANK = Object.freeze({
  question: 0,
  hypothetical: 1,
  framing: 2,
  opinion: 3,
  forecast: 4,
  possible: 5,
  factual: 6,
});

export const LABEL = Object.freeze({
  question: 'a question',
  hypothetical: 'a hypothetical',
  framing: 'a verbless framing',
  opinion: 'an attributed view',
  forecast: 'a forecast or target',
  possible: 'a possibility',
  factual: 'an asserted fact',
});

// ── markers ──────────────────────────────────────────────────────────────────
// Evidence, not a verdict. The verdict is the ordinal comparison; these only say which band a
// sentence sits in, and rule 2 holds even when every one of them misses.

const HYPOTHETICAL = new RegExp(
  '\\b(?:what if|if\\b|were to|were it|had it|hypothetical(?:ly)?|scenario|thought experiment'
  + '|imagine|suppose|supposing|assuming|in a world where|counterfactual|on paper|revaluation'
  + '|would (?:mean|imply|require|need|put|take|be|become|make|leave|give))\\b', 'i');

// Explicitly about the future, or a level someone is aiming at. "Target" is here rather than in
// `possible` because a price target is a stated destination, not a report of arrival.
const FORECAST = new RegExp(
  '\\b(?:forecast(?:s|ed|ing)?|projec(?:t|ts|ted|tion|tions)|predict(?:s|ed|ion|ions)?'
  + '|price target|target(?:s|ed|ing)? (?:of|to|price)?|\\bPT\\b|estimat(?:e|es|ed)'
  + '|expect(?:s|ed|ation|ations)?|anticipat(?:e|es|ed)|outlook|guidance for|sees\\b|seen\\b'
  + '|on track (?:to|for)|path to|road to|headed (?:to|for)|set to|poised to|due to'
  + '|by (?:20\\d\\d|next (?:year|quarter|month))|in (?:20[3-9]\\d))\\b', 'i');

// Able to happen. The user's list — could / would / may / might / potential / possible — lives here.
const POSSIBLE = new RegExp(
  '\\b(?:could|would|may|might|can\\b|potential(?:ly)?|possib(?:le|ly|ility)|prospect'
  + '|risks? (?:of|to)|threatens? to|stands? to|in line to|likely to|unlikely to'
  + '|not out of the question)\\b', 'i');

// Somebody's position, as opposed to a reported occurrence. Deliberately excludes REPORTING verbs
// (reports, announced, said in a filing, according to a statement): those attribute an observation
// to a newswire, and dropping "Reuters reports" from a real event is correct editing, not invention.
const OPINION = new RegExp(
  '\\b(?:argues?|argued|believes?|thinks?|contends?|reckons?|warns?|warned|cautions?'
  + '|is bullish|is bearish|bull case|bear case|case for|case against|opinion|op-ed'
  + '|commentary|analysis|explains why|here(?:\'|’)s why|takes? aim|calls? for'
  + '|urges?|insists?|claims?)\\b', 'i');

// ── structural framing ───────────────────────────────────────────────────────
// A headline asserts an event by PREDICATING something. "Gold At $155,000 An Ounce" names a subject
// and a level and predicates nothing — it is a caption, not a claim. Detecting that needs no
// vocabulary of hedges, which is the whole point: the source contained none.
//
// Conservative by construction. A nominal shape alone is not enough; the sentence must also contain
// no finite verb at all. Anything with a verb falls through to the other bands, so an ordinary
// factual headline is never mistaken for a caption.
const NOMINAL_SHAPE = new RegExp(
  '^[^,:?]{1,60}\\b(?:at|to|above|below|past|near|toward|towards)\\s+[$€£]?\\d'   // "Gold At $155,000"
  + '|\\b(?:path|road|route|case|argument|countdown|guide|primer|prospects?)\\s+(?:to|for|against)\\b'
  + '|^(?:why|how|what|when|whether|inside|meet|the case)\\b'
  + '|^[^:]{2,40}:\\s',                                                                      // "Analyst: Gold $155,000"
  'i');

// Finite verb forms common in headline English. Presence of ANY of these means something is being
// predicated, so the caption test declines to fire. Kept broad on purpose: a false NEGATIVE here
// costs nothing (rule 2 still guards every number), whereas a false positive would start rejecting
// ordinary factual rewrites.
const FINITE_VERB = new RegExp(
  '\\b(?:is|are|was|were|be|been|being|has|have|had|does|do|did|will|shall|wo n\'t|won\'t'
  + '|says?|said|reports?|reported|announces?|announced|posts?|posted|files?|filed'
  + '|raises?|raised|cuts?|lifts?|lifted|lowers?|lowered|buys?|bought|sells?|sold'
  + '|wins?|won|loses?|lost|gains?|gained|falls?|fell|rises?|rose|jumps?|jumped'
  + '|hits?|reaches|reached|tops?|topped|crosses|crossed|climbs?|climbed|drops?|dropped'
  + '|adds?|added|names?|named|approves?|approved|rejects?|rejected|launches|launched'
  + '|plans?|planned|agrees?|agreed|acquires?|acquired|opens?|opened|closes?|closed'
  + '|beats?|beat|misses|missed|makes?|made|takes?|took|gets?|got|goes|went|becomes?|became'
  + '|keeps?|kept|remains?|remained|continues?|continued|stays?|stayed|holds?|held'
  + '|leads?|led|faces?|faced|sends?|sent|turns?|turned|pushes|pushed|slips?|slipped'
  + '|could|would|may|might|can|must|should)\\b', 'i');

/** Is this a caption rather than a claim? Structural: nominal shape AND nothing predicated. */
export function isFraming(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return NOMINAL_SHAPE.test(t) && !FINITE_VERB.test(t);
}

/**
 * Which band does this sentence sit in?
 *
 * THE WEAKEST MARKER WINS. A hedge anywhere scopes the whole sentence: "Gold could reach $155,000 if
 * inflation persists" is a hypothetical, not a possibility, because the "if" governs the "could".
 * Taking the strongest marker instead would let one confident-sounding clause launder the sentence
 * around it.
 */
export function classifyModality(text) {
  const t = String(text || '').trim();
  if (!t) return { class: 'factual', rank: RANK.factual, markers: [] };

  const markers = [];
  if (/\?\s*$/.test(t)) markers.push(['question', '?']);
  const hyp = t.match(HYPOTHETICAL); if (hyp) markers.push(['hypothetical', hyp[0]]);
  if (isFraming(t)) markers.push(['framing', 'no finite verb']);
  const opi = t.match(OPINION); if (opi) markers.push(['opinion', opi[0]]);
  const fc = t.match(FORECAST); if (fc) markers.push(['forecast', fc[0]]);
  const ps = t.match(POSSIBLE); if (ps) markers.push(['possible', ps[0]]);

  if (!markers.length) return { class: 'factual', rank: RANK.factual, markers: [] };
  markers.sort((a, b) => RANK[a[0]] - RANK[b[0]]);
  return { class: markers[0][0], rank: RANK[markers[0][0]], markers: markers.map((m) => m[1]) };
}

// ── rule 2: a quoted level is not an achieved level ──────────────────────────
// The rewrite saying a number WAS ATTAINED. Bare infinitives are excluded for the same reason
// anticipationConflict() excludes them: "to reach $155,000" is the hedge, not the claim.
const ACHIEVED = new RegExp(
  '\\b(?:reach(?:es|ed)|hits?|hit|tops?|topped|crosses|crossed|surpass(?:es|ed)|exceed(?:s|ed)'
  + '|climbs? to|climbed to|ris(?:es|e) to|rose to|jumps? to|jumped to|soars? to'
  + '|falls? to|fell to|drops? to|dropped to|slid(?:es)? to|sinks? to|sank to'
  // Bare plurals ("shares TRADE at $430") are finite verbs with a plural subject, so the forms
  // without -s belong here. Leaving them out let "Tesla shares trade at $430" through.
  + '|clos(?:e|es|ed) at|settl(?:e|es|ed) at|trad(?:e|es|ed) at|chang(?:e|es|ed) hands at'
  + '|is at|sits at|stands at|now at|breaks? (?:above|below)|broke (?:above|below))\\b', 'i');

// A number the SOURCE places under discussion rather than in the past. If the value sits in any of
// these frames it is explicitly NOT reported as attained, whatever else the source says.
const QUOTED_FRAME = new RegExp(
  '\\b(?:target|forecast\\w*|projec\\w*|estimat\\w*|expect\\w*|outlook|guidance|predict\\w*'
  + '|sees|seen|could|would|may|might|potential\\w*|possib\\w*|if|scenario|hypothetical\\w*'
  + '|path to|road to|toward|towards|by 20\\d\\d|\\bPT\\b)\\b', 'i');

/** Monetary and plain numeric tokens, normalised for comparison across "$155,000" / "155000". */
const VALUE_TOKEN = /[$€£]\s?\d[\d,.]*\s?(?:trillion|billion|million|bn|mn|[kmbt])?\b|\b\d[\d,.]*\s?(?:trillion|billion|million|bn|mn)\b|\b\d[\d,.]{2,}\b/gi;
const normValue = (s) => String(s).toLowerCase().replace(/[\s,$€£]/g, '');

// A bare four-digit year is a date, not a level. Without this, "Nasdaq closes at a record for the
// first time since 2021" reads as a claim that 2021 was REACHED, and every such rewrite is rejected.
const isYear = (s) => /^(?:19|20)\d\d$/.test(normValue(s));

/**
 * Every value the rewrite claims was ATTAINED.
 *
 * A value counts as claimed-attained when an achievement verb governs it — the verb appears before
 * it with no other verb intervening, within a short window. The window keeps "Gold hits record as
 * Treasury sells $155,000 of..." from being read as a claim about $155,000.
 */
export function achievedValues(text) {
  const t = String(text || '');
  const out = [];
  for (const m of t.matchAll(VALUE_TOKEN)) {
    if (isYear(m[0])) continue;
    const before = t.slice(Math.max(0, m.index - 42), m.index);
    const verb = before.match(ACHIEVED);
    if (!verb) continue;
    // Only the NEAREST preceding achievement verb may govern; anything after it and before the
    // number that looks like another predicate breaks the link.
    out.push({ value: m[0].trim(), norm: normValue(m[0]), verb: verb[0] });
  }
  return out;
}

/**
 * Does the source report this value as attained?
 *
 * Both halves must hold: the source says it, AND says it outside a quoted frame. A source that reads
 * "gold would reach $155,000" contains both the verb and the number and still asserts nothing.
 */
export function sourceAsserts(value, sourceText) {
  const t = String(sourceText || '');
  const want = normValue(value);
  for (const m of t.matchAll(VALUE_TOKEN)) {
    if (normValue(m[0]) !== want) continue;
    const before = t.slice(Math.max(0, m.index - 60), m.index);
    if (QUOTED_FRAME.test(before)) continue;      // under discussion, not attained
    if (ACHIEVED.test(before)) return true;
  }
  return false;
}

export function valueNotAchieved(output, sourceText) {
  for (const c of achievedValues(output)) {
    if (!sourceAsserts(c.norm, sourceText)) return c;
  }
  return null;
}

// ── rule 3: an opinion is its holder's ───────────────────────────────────────
// "Dalio says gold hits $155,000" -> "Gold hits $155,000" keeps every noun and every figure and
// converts one man's argument into a market report.
const ATTRIBUTED = new RegExp(
  '\\b(?:\\w+\\s+)?(?:argues?|argued|believes?|thinks?|contends?|reckons?|warns?|warned'
  + '|predicts?|forecasts?|expects?|sees\\b|claims?|insists?|urges?|says\\b|said)\\b', 'i');

// Who is speaking. Present in the rewrite means the attribution survived.
const CARRIES_ATTRIBUTION = new RegExp(
  '\\b(?:according to|per\\b|says?|said|argues?|argued|believes?|thinks?|contends?|warns?|warned'
  + '|predicts?|forecasts?|expects?|sees\\b|claims?|insists?|urges?|\\w+\'s (?:view|call|case|take))\\b', 'i');

export function attributionStripped(output, sourceHead) {
  const src = String(sourceHead || '');
  const out = String(output || '');
  // Only OPINION attribution matters. A newswire reporting a real event is not the holder of a view,
  // and "Reuters reports Acme cut guidance" -> "Acme cuts guidance" is correct editing.
  if (!OPINION.test(src) && !/\b(?:predicts?|forecasts?|expects?|sees)\b/i.test(src)) return null;
  if (!ATTRIBUTED.test(src)) return null;
  if (CARRIES_ATTRIBUTION.test(out)) return null;
  const m = src.match(ATTRIBUTED);
  return { speaker: m ? m[0].trim() : 'source' };
}

// ── entry point ──────────────────────────────────────────────────────────────

/** Line 0 of the source blob, without the "HEADLINE:" prefix primary-events.js adds. */
export function sourceHeadlineOf(sourceText) {
  return String(sourceText || '').split('\n')[0].replace(/^HEADLINE:\s*/i, '').trim();
}

/**
 * { ok: true } or { ok: false, reason, detail }. Reasons:
 *   modality      the source did not assert this as fact and the rewrite does
 *   unachieved    the rewrite says a level was reached that the source never says was reached
 *   attribution   the rewrite dropped the person whose view this is
 */
export function validateModality(output, sourceText) {
  const out = String(output || '').trim();
  const src = String(sourceText || '');
  if (!out) return { ok: false, reason: 'empty' };

  const head = sourceHeadlineOf(src);
  const body = src.split('\n').slice(1).join(' ').trim();

  // Rule 2 first. It is the one that holds without recognising any hedge vocabulary, so it should
  // not be reachable only after the vocabulary-based rule has had its say.
  const v = valueNotAchieved(out, src);
  if (v) {
    return { ok: false, reason: 'unachieved',
      detail: `rewrite asserts "${v.verb} ${v.value}"; source never reports ${v.value} as reached` };
  }

  const sHead = classifyModality(head);
  const oOut = classifyModality(out);

  // Rule 3 before rule 1. An attributed source is non-factual, so rule 1 would fire on it first and
  // report the generic "modality" — and, worse, would reject the CORRECT rewrite that kept the
  // attribution, because "Dalio says X" carries no hedge of its own and classifies as factual.
  // Deciding attribution first names the failure precisely and lets the good rewrite through.
  const a = attributionStripped(out, head);
  if (a) {
    return { ok: false, reason: 'attribution',
      detail: `source attributes this ("${a.speaker}"); rewrite states it unattributed` };
  }
  // The attribution survived, so nothing was escalated: an attributed claim restated with its
  // attribution asserts exactly what the source asserted.
  if (sHead.class === 'opinion' && CARRIES_ATTRIBUTION.test(out)) return { ok: true };

  // Rule 1. Read from the headline, because that is where the frame is set.
  if (sHead.rank < RANK.factual && oOut.rank === RANK.factual) {
    // The body may CONFIRM what the headline only floated — a caption over a story that does report
    // the event. It may not license anything on its own, so the escape needs the body to be factual
    // in its own right, and rule 2 has already independently cleared every number in the rewrite.
    const sBody = body ? classifyModality(body) : { rank: RANK.factual };
    if (sBody.rank < RANK.factual) {
      return { ok: false, reason: 'modality',
        detail: `source frames this as ${LABEL[sHead.class]} (${sHead.markers[0]}); rewrite asserts it as fact` };
    }
  }

  return { ok: true };
}
