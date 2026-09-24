// BIOTECH / PHARMA EVENT CLASSIFICATION — what a release SAYS HAPPENED.
//
// ── ⚠️ THE FAILURE THIS EXISTS FOR ──────────────────────────────────────────
//
// Catalyst evidence read one table: eightk_filings. So a company press release could be ingested
// perfectly, ticker-resolved correctly, and still never become evidence — measured, LLY's FDA
// approval release sat in primary_events while the engine returned zero catalyst records for LLY.
// Small biotechs announce INDs, topline data and designations by press release and frequently file
// no 8-K at all, so the entire class was invisible.
//
// ── ⚠️ EVENTS, NOT VOCABULARY ───────────────────────────────────────────────
//
// Biotech WORDS are not a catalyst. "Company to present at the Jefferies Healthcare Conference"
// contains Phase 3, FDA and oncology and is worth nothing. NOISE is tested first so a promotional
// release naming a milestone cannot ride in on it.
//
// ── ⚠️ MATCHED AS A SET OF TERMS, NOT AS ONE ORDERED PHRASE ─────────────────
//
// The first version used ordered proximity regexes and missed real releases, because wires do not
// agree on word order: "Announces Submission of IND Application" puts the action before the noun,
// and "Submits New Drug Application to FDA" never writes "NDA" at all. `all` requires every listed
// term SOMEWHERE in the text, which is what the sentence actually guarantees; `none` excludes a
// more specific sibling so a general rule cannot steal its match.
//
// ── ⚠️ STAGES ARE NOT INTERCHANGEABLE ───────────────────────────────────────
//
// IND submitted is not IND cleared. NDA submitted is not approval. Fast Track is not Breakthrough
// Therapy. Endpoint met is not approval. Each has its own type, materiality and summary, and the
// summary repeats the stage the release actually states. Collapsing them would be the most damaging
// thing this file could do, because a reader would act on the wrong one.

import { DIRECTION } from './model.mjs';

/**
 * ⚠️ NOISE IS TESTED FIRST AND WINS.
 *
 * A release that is fundamentally an invitation, a grant notice or a marketing update is refused
 * even when it names a real milestone — "to present Phase 3 data at ASCO" is a calendar entry.
 */
export const NOISE = [
  /\b(?:to\s+)?present(?:s|ing|ation)?\s+at\b/i,
  /\bwill\s+(?:present|participate|host|attend|report)\b/i,
  /\b(?:fireside\s+chat|webcast|webinar|investor\s+(?:day|conference|presentation)|corporate\s+presentation)\b/i,
  /\bconference\s+(?:call|presentation)\b/i,
  /\bto\s+(?:participate|attend|report|host)\b/i,
  /\binducement\s+(?:grant|award)\b/i,
  /\bequity\s+inducement\b/i,
  /\bnasdaq\s+listing\s+rule\s+5635/i,
  /\bappoints?\b/i,
  /\bnames?\s+(?:new\s+)?(?:chief|ceo|cfo|president)\b/i,
  /\b(?:annual|quarterly)\s+(?:report|financial\s+results)\b/i,
  /\bpublishes?\s+(?:its\s+)?(?:annual|esg|sustainability)\b/i,
  /\bhighlights?\b/i,
  /\bbusiness\s+update\b/i,
  /\bupcoming\s+(?:presentation|data|oral|poster)/i,

  // ⚠️ MINERAL EXPLORATION WRITES "PHASE 2" AND "RESULTS" EXACTLY AS A TRIAL DOES, and BIO_CONTEXT
  // cannot separate them, because the phase term in that gate is the very thing a mining release
  // satisfies. Measured: "Blue Star Reports Completion of 2026 Phase 2 Drilling Program and Auma
  // Results Including 4.3 m of 6.06 g/t Au" classified as Phase 2 clinical results. No drug
  // release contains an assay grade.
  /\b(?:drill(?:ing|ed|s)?|assays?|mineraliz|ore\s+body|exploration\s+(?:program|target))\b|\bg\/t\b/i,

  // ⚠️ SECURITIES-LITIGATION SPAM IS THE LARGEST BIOTECH-SHAPED NOISE CLASS ON THE WIRE.
  //
  // Law firms publish a constant stream of "DEADLINE ALERT", "Investor Notice" and "Encourages
  // Investors" releases that quote the drug, the trial and the FDA action they are suing about.
  // Measured on 30 days of resolved wire items, these produced classifications like AARD ->
  // clinical hold and CAPR -> advisory committee. They are advertisements about a lawsuit, not a
  // company announcing an event, and the company is not even the sender.
  /\b(?:class\s+action|securities\s+(?:fraud|litigation)|lawsuit)\b/i,
  /\b(?:deadline|investor\s+notice|investigation\s+notice)\b/i,
  /\b(?:encourages?|alerts?|reminds?)\s+(?:.{0,30})?investors\b/i,
  /\b(?:hagens\s+berman|rosen\s+law|levi\s+&|faruqi|pomerantz|bronstein|glancy|kaplan\s+fox|schall\s+law|bragar)\b/i,
  /\blead\s+plaintiff\b/i,

  // Analyst opinion is not a company event. "Strong Buy on ABC's BLA" describes someone's view of
  // a filing, and promoting it would put a rating on a board that refuses ratings.
  /\b(?:strong\s+buy|price\s+target|initiates?\s+coverage|upgrade[sd]?\s+to|downgrade[sd]?\s+to)\b/i,
];

/**
 * ⚠️ AND THE RELEASE MUST ACTUALLY BE ABOUT A DRUG OR A TRIAL.
 *
 * Several patterns below use ordinary business words — milestone, licence agreement, discontinued
 * development — which non-biotech issuers use constantly. Measured, "Gunnison Copper Achieves
 * Commercial Production" classified as a development milestone and "Greenland Mines Completes
 * Equity Financing" as a discontinued programme. Requiring one clinical or regulatory term
 * somewhere in the text is what keeps a mining release out of a biotech taxonomy.
 */
const BIO_CONTEXT = /\b(?:fda|ema|nmpa|clinical|trial|stud(?:y|ies)|patients?|phase\s*(?:1|2|3|i{1,3})\b|therap(?:y|ies|eutic)|drug|dose|dosing|oncolog|vaccine|biotech|pharmaceutic|indication|efficacy|endpoint|enroll|preclinical|biologic|ind\b|nda\b|bla\b)/i;

/** First match wins, so the most specific and most consequential phrasings come first. */
export const BIOTECH_EVENTS = Object.freeze([
  // ── REGULATORY DECISIONS ────────────────────────────────────────────────
  { type: 'bio_fda_crl', label: 'FDA Complete Response Letter', materiality: 0.98, direction: DIRECTION.NEGATIVE,
    all: [/\bcomplete\s+response\s+letter\b/i] },   // ⚠️ NOT bare \bcrl\b: that is Charles River Labs ticker.
  { type: 'bio_hold_lifted', label: 'FDA clinical hold lifted', materiality: 0.92, direction: DIRECTION.POSITIVE,
    all: [/\bclinical\s+hold\b/i, /\b(?:lift|remov|resolv)/i] },
  { type: 'bio_clinical_hold', label: 'FDA clinical hold', materiality: 0.95, direction: DIRECTION.NEGATIVE,
    all: [/\bclinical\s+hold\b/i] },
  // ⚠️ `none` KEEPS AN IND CLEARANCE OUT OF "FDA APPROVAL". Both sentences contain FDA and a form
  // of approve; only one of them means the drug may be sold.
  { type: 'bio_fda_approval', label: 'FDA approval', materiality: 0.95, direction: DIRECTION.POSITIVE,
    all: [/\bfda\b/i, /\bapprov(?:al|es|ed)\b/i],
    none: [/\bind\b|\binvestigational\s+new\s+drug\b/i] },
  { type: 'bio_adcom', label: 'FDA advisory committee outcome', materiality: 0.85, direction: DIRECTION.UNKNOWN,
    all: [/\badvisory\s+committee\b|\badcom(?:m)?\b|\bodac\b/i] },
  { type: 'bio_pdufa', label: 'PDUFA action date', materiality: 0.75, direction: DIRECTION.UNKNOWN,
    all: [/\bpdufa\b/i] },

  // ── REGULATORY SUBMISSIONS — NOT DECISIONS ──────────────────────────────
  { type: 'bio_nda_bla_accepted', label: 'NDA/BLA accepted for review', materiality: 0.82, direction: DIRECTION.POSITIVE,
    all: [/\b(?:nda|bla|marketing\s+application|new\s+drug\s+application|biologics\s+license\s+application)\b/i, /\baccept/i] },
  { type: 'bio_bla_submitted', label: 'BLA submitted to FDA', materiality: 0.78, direction: DIRECTION.POSITIVE,
    all: [/\b(?:bla|biologics\s+license\s+application)\b/i, /\bsubmi(?:t|ts|tted|ssion)\b|\bfil(?:e|ed|es|ing)\b/i] },
  { type: 'bio_nda_submitted', label: 'NDA submitted to FDA', materiality: 0.78, direction: DIRECTION.POSITIVE,
    all: [/\b(?:nda|new\s+drug\s+application)\b/i, /\bsubmi(?:t|ts|tted|ssion)\b|\bfil(?:e|ed|es|ing)\b/i] },
  { type: 'bio_ind_cleared', label: 'IND cleared by FDA', materiality: 0.80, direction: DIRECTION.POSITIVE,
    all: [/\b(?:ind|investigational\s+new\s+drug)\b/i, /\bclear(?:s|ed|ance)?\b|\ballow(?:s|ed)?\s+to\s+proceed\b/i] },
  // ⚠️ SUBMITTED, NOT CLEARED. The FDA has been told; it has not answered.
  { type: 'bio_ind_submitted', label: 'IND application submitted to FDA', materiality: 0.70, direction: DIRECTION.POSITIVE,
    all: [/\b(?:ind|investigational\s+new\s+drug)\b/i, /\bsubmi(?:t|ts|tted|ssion)\b|\bfil(?:e|ed|es|ing)\b/i] },

  // ── DESIGNATIONS — DISTINCT FROM EACH OTHER ─────────────────────────────
  { type: 'bio_breakthrough', label: 'Breakthrough Therapy designation', materiality: 0.80, direction: DIRECTION.POSITIVE,
    all: [/\bbreakthrough\s+therapy\b/i] },
  { type: 'bio_priority_review', label: 'Priority Review granted', materiality: 0.78, direction: DIRECTION.POSITIVE,
    all: [/\bpriority\s+review\b/i] },
  { type: 'bio_fast_track', label: 'Fast Track designation', materiality: 0.70, direction: DIRECTION.POSITIVE,
    all: [/\bfast\s+track\b/i, /\bdesignation\b/i] },
  { type: 'bio_orphan_drug', label: 'Orphan Drug designation', materiality: 0.68, direction: DIRECTION.POSITIVE,
    all: [/\borphan\s+(?:drug\s+)?designation\b/i] },

  // ── CLINICAL RESULTS ────────────────────────────────────────────────────
  { type: 'bio_endpoint_missed', label: 'Primary endpoint missed', materiality: 0.95, direction: DIRECTION.NEGATIVE,
    all: [/\bendpoint\b/i, /\b(?:did\s+not\s+(?:meet|achieve)|fail(?:ed|s)?\s+to\s+(?:meet|achieve)|missed)\b/i] },
  { type: 'bio_program_discontinued', label: 'Trial or program discontinued', materiality: 0.90, direction: DIRECTION.NEGATIVE,
    all: [/\b(?:discontinu|terminat|halt)(?:e|ed|es|ing|ation)?\b/i, /\b(?:trial|study|program|development|candidate|asset)\b/i] },
  { type: 'bio_safety_event', label: 'Clinical safety event', materiality: 0.88, direction: DIRECTION.NEGATIVE,
    all: [/\b(?:safety\s+signal|serious\s+adverse\s+event|patient\s+death)\b/i] },
  { type: 'bio_endpoint_met', label: 'Primary endpoint met', materiality: 0.88, direction: DIRECTION.POSITIVE,
    all: [/\bprimary\s+endpoint\b/i, /\b(?:met|achiev(?:ed|es))\b/i] },
  { type: 'bio_phase3_results', label: 'Phase 3 results', materiality: 0.85, direction: DIRECTION.UNKNOWN,
    all: [/\bphase\s*(?:3|iii)\b/i, /\b(?:results?|data|readout|topline)\b/i] },
  { type: 'bio_phase2_results', label: 'Phase 2 results', materiality: 0.75, direction: DIRECTION.UNKNOWN,
    all: [/\bphase\s*(?:2|ii)\b/i, /\b(?:results?|data|readout|topline)\b/i] },
  { type: 'bio_phase1_results', label: 'Phase 1 results', materiality: 0.62, direction: DIRECTION.UNKNOWN,
    all: [/\bphase\s*(?:1|i)\b/i, /\b(?:results?|data|readout|topline)\b/i] },
  { type: 'bio_topline_results', label: 'Topline results reported', materiality: 0.80, direction: DIRECTION.UNKNOWN,
    all: [/\btopline\b/i, /\b(?:results?|data)\b/i] },
  { type: 'bio_interim_results', label: 'Interim results', materiality: 0.68, direction: DIRECTION.UNKNOWN,
    all: [/\binterim\s+(?:analysis|results?|data)\b/i] },

  // ── TRIAL OPERATIONS ────────────────────────────────────────────────────
  { type: 'bio_enrollment_paused', label: 'Enrollment paused', materiality: 0.80, direction: DIRECTION.NEGATIVE,
    all: [/\benroll(?:ment|ing)\b/i, /\b(?:paus|suspend|stop)/i] },
  // Before enrolment-complete and trial-started: "Doses First Patient in Phase 1 Trial" satisfies
  // all three, and the most specific statement is the one the release is actually making.
  { type: 'bio_first_patient_dosed', label: 'First patient dosed', materiality: 0.62, direction: DIRECTION.POSITIVE,
    all: [/\bfirst\s+patient\b/i, /\b(?:dos(?:e|ed|es|ing)|treat(?:ed|s)?|enroll|randomi)/i] },
  { type: 'bio_enrollment_complete', label: 'Enrollment completed', materiality: 0.62, direction: DIRECTION.POSITIVE,
    all: [/\benroll(?:ment)?\b/i, /\bcomplet(?:e|ed|es|ion)\b/i] },
  { type: 'bio_trial_started', label: 'Clinical trial initiated', materiality: 0.58, direction: DIRECTION.POSITIVE,
    all: [/\b(?:initiat|commenc|launch|begins?)\b/i, /\b(?:phase\s*(?:1|2|3|i{1,3})|clinical\s+trial|clinical\s+study)\b/i] },

  // ── PIPELINE / BUSINESS ─────────────────────────────────────────────────
  { type: 'bio_license_partnership', label: 'Drug licensing or partnership', materiality: 0.72, direction: DIRECTION.POSITIVE,
    all: [/\b(?:licens(?:e|ing)\s+agreement|exclusive\s+licen|collaboration\s+(?:and\s+licen\w+\s+)?agreement)\b/i] },
  { type: 'bio_milestone_payment', label: 'Development milestone achieved', materiality: 0.60, direction: DIRECTION.POSITIVE,
    all: [/\bmilestone\b/i, /\b(?:payment|achiev(?:ed|es))\b/i] },
]);

/**
 * Classify one headline (optionally with a summary for context).
 *
 * @returns {{type,label,materiality,direction}|null} null whenever this is not a stated event.
 */
export function classifyBiotechEvent(headline, summary = '') {
  const head = String(headline || '').trim();
  const text = `${head} ${String(summary || '')}`.trim();
  if (text.length < 12) return null;
  for (const n of NOISE) if (n.test(text)) return null;
  // See BIO_CONTEXT: a taxonomy of drug events may not classify a mining release.
  if (!BIO_CONTEXT.test(text)) return null;
  for (const spec of BIOTECH_EVENTS) {
    // ⚠️ THE SUMMARY MAY CONFIRM AN EVENT. IT MAY NOT INTRODUCE ONE. The first term is the SUBJECT
    // and must be in the HEADLINE. Measured without this: "InspireMD Announces Amendments to
    // Certain Series J and Series K Warrants" was reported as an FDA approval, and "FDA Grants
    // Priority Review to Insmed's sNDA" was reported as an approval rather than a priority review
    // — both because a later sentence, about something else, carried the missing word.
    if (!spec.all[0].test(head)) continue;
    if (!spec.all.slice(1).every((r) => r.test(text))) continue;
    if (spec.none?.some((r) => r.test(text))) continue;
    const { all, none, ...rest } = spec;
    return rest;
  }
  return null;
}

/**
 * ⚠️ HOW LONG A CATALYST STAYS RELEVANT DEPENDS ON WHAT IT IS.
 *
 * An ordinary headline is stale in two days. A regulatory submission or a pivotal readout is the
 * reason a small biotech reprices for weeks — SRZN's IND submission was sixteen days old and still
 * the only public thing that had happened to the company. The window is a property of the EVENT
 * TYPE, not a global constant, and it is deliberately not applied to anything else.
 */
export const RELEVANCE_DAYS = Object.freeze({
  default: 2,
  regulatory: 30,     // submissions, decisions, designations, holds
  clinical: 21,       // results, endpoints, discontinuations
  operational: 10,    // enrolment, dosing, trial starts
});

const REGULATORY = /^bio_(?:fda|ind|nda|bla|adcom|pdufa|breakthrough|priority|fast|orphan|hold|clinical_hold)/;
const CLINICAL = /^bio_(?:phase|topline|interim|endpoint|safety|program_discontinued)/;

/** Days a classified event stays usable as context for a current move. */
export function relevanceDays(type) {
  if (!type) return RELEVANCE_DAYS.default;
  if (REGULATORY.test(type)) return RELEVANCE_DAYS.regulatory;
  if (CLINICAL.test(type)) return RELEVANCE_DAYS.clinical;
  if (/^bio_/.test(type)) return RELEVANCE_DAYS.operational;
  return RELEVANCE_DAYS.default;
}
