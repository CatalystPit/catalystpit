// Deterministic Catalyst Pit headline composition. PURE: no DB, no network, no AI.
//
// This is the difference between republishing and reporting. It does NOT clean a publisher's
// sentence — it reads an unambiguous factual assertion out of the source and writes a NEW sentence
// in Catalyst Pit's own voice from the extracted parts.
//
//   source  : "Acme Corp Announces $500 Million Share Repurchase Program"
//   composed: "Acme authorizes $500M buyback"
//
// WHY THIS FILE IS NARROW. An earlier version classified with the dedupe actionClass and filled a
// template from whatever keywords appeared anywhere in the headline. Tested against 1,200 live
// headlines it produced confident falsehoods: "Don't Raise Rates Based On A PCE..." became "Fed
// raises rates"; "Psychedelics on the cusp of market breakthrough" became "Psychedelics wins FDA
// approval"; "Frazier adds $1.1B+ to biotech fund" became "Frazier announces $10B acquisition".
// Keyword presence is not an assertion. Turning it into one is a worse failure than republishing,
// because a trader cannot tell it is wrong.
//
// So every pattern below ANCHORS THE SUBJECT AND THE VERB TOGETHER — the declarative form a company
// or agency uses when announcing something. "Acme Corp Announces ... Repurchase Program" states a
// buyback. "Analysts debate whether Acme should buy back stock" matches nothing here and is handed
// to the model instead.
//
// Two rules:
//   1. NOTHING IS INVENTED. Every name and figure in the output appears in the source text.
//   2. REFUSING IS THE NORMAL OUTCOME. Commentary, opinion and analysis carry no extractable event.

import { cleanHeadline, numericFacts } from './news-normalize.mjs';
import { shingles, jaccard } from './event-cluster.mjs';

// How close a composed headline may be to the source before it counts as republication rather than
// a rewrite. Exported so the audit measures the same thing the composer enforces.
export const REWRITE_MAX_SIMILARITY = 0.60;
export const similarity = (a, b) => jaccard(shingles(a), shingles(b));

// ── helpers ──────────────────────────────────────────────────────────────────
const CORP_SUFFIX = /\b(Inc|Incorporated|Corp|Corporation|Co|Company|LLC|Ltd|Limited|PLC|plc|LP|N\.V|NV|S\.A|SA|AG|GmbH|AB|ASA|Holdings?|Group)\b\.?,?/g;

// Words that open a sentence looking like a name but name no company.
const NOT_SUBJECT = new Set(['this', 'that', 'these', 'those', 'why', 'how', 'what', 'when', 'where',
  'who', 'here', 'there', 'being', 'prediction', 'should', 'could', 'would', 'will', 'is', 'are',
  'was', 'were', 'best', 'worst', 'top', 'my', 'your', 'our', 'their', 'its', 'it', 'stocks',
  'stock', 'markets', 'market', 'investors', 'traders', 'wall', 'street', 'us', 'america',
  'american', 'americans', 'dow', 'nasdaq', 'today', 'tomorrow', 'week', 'month', 'year',
  'new', 'more', 'most', 'she', 'he', 'they', 'we', 'you', 'webinar', 'deadline', 'sept', 'steady',
  'the', 'a', 'an', 'as', 'at', 'in', 'on', 'for', 'with', 'and', 'but', 'or', 'from', 'ultimate']);

// Short display form: drop the corporate suffix so it reads like a wire, not a filing.
// Title-cased headlines capitalise connectors too, so a name capture can run past the name itself
// ("Alif Semiconductor For"). Trailing connectors are trimmed before the name is used.
const TRAIL_CONNECTOR = /\s+(?:For|With|In|At|And|To|From|Of|On|By|As|Its|The|A|An)$/i;
export const trimName = (n) => { let x = String(n || '').trim(), prev; do { prev = x; x = x.replace(TRAIL_CONNECTOR, ''); } while (x !== prev); return x; };

export const shortName = (n) => trimName(String(n || '').replace(CORP_SUFFIX, '').replace(/\s{2,}/g, ' ').replace(/[,\s]+$/, '').trim());

// Money as a trader writes it, and only when the source stated it.
const SCALE_OUT = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M']];
export function moneyOf(text) {
  const vals = numericFacts(text).filter((f) => f.startsWith('m')).map((f) => Number(f.slice(1)));
  if (!vals.length) return null;
  const v = Math.max(...vals);
  if (v < 1e6) return null;
  for (const [mult, sfx] of SCALE_OUT) {
    if (v >= mult) { const n = v / mult; return '$' + (n >= 100 ? Math.round(n) : Number(n.toFixed(1))) + sfx; }
  }
  return null;
}
const bpsOf = (t) => { const m = /(\d+(?:\.\d+)?)\s*(?:bps|basis points?)\b/i.exec(t); return m ? Number(m[1]) + ' bps' : null; };
const periodOf = (t) => {
  const q = /\b(?:Q([1-4])|(first|second|third|fourth)[-\s]quarter)\b/i.exec(t);
  if (q) {
    if (q[1]) return 'Q' + q[1];
    const w = { first: 1, second: 2, third: 3, fourth: 4 }[q[2].toLowerCase()];
    return 'Q' + w;
  }
  if (/\b(?:full[-\s]year|fiscal year|FY\d{2,4})\b/i.test(t)) return 'full-year';
  return null;
};
const guidanceMove = (t) => (/\b(?:raises?|lifts?|boosts?)\b/i.test(t) ? 'raises'
  : /\b(?:cuts?|lowers?|reduces?)\b/i.test(t) ? 'cuts'
  : /\b(?:reaffirms?|reiterates?|maintains?)\b/i.test(t) ? 'reaffirms' : null);
const beatMiss = (t) => (/\b(?:beats?|tops?|exceeds?|surpasses?)\b/i.test(t) ? 'beats'
  : /\b(?:misses?|falls? short)\b/i.test(t) ? 'misses' : null);

// ── anchored patterns ────────────────────────────────────────────────────────
// Each entry: [type, regex anchored at the start of the headline, builder]. Group 1 binds the actor.
const SUBJ = String.raw`([A-Z][A-Za-z0-9&.'’\-]*(?:\s+[A-Z][A-Za-z0-9&.'’\-]*){0,4}?)`;
const A = (re) => new RegExp('^\\s*' + re, 'i');
const NAMEISH = String.raw`[A-Z][A-Za-z0-9&.'’\-]*(?:\s+[A-Z][A-Za-z0-9&.'’\-]*){0,3}`;
const AMT = String.raw`(?:\$?[\d.,]+\s*(?:million|billion|m|bn?)\s+)?`;

const PATTERNS = [
  ['buyback', A(SUBJ + String.raw`\s+(?:announces|approves|authorizes|launches|expands|increases)\s+(?:a\s+|its\s+|an\s+|new\s+)*` + AMT + String.raw`(?:share\s+)?(?:repurchase|buy-?back)`),
    (m, h) => (h.money ? `${h.s} authorizes ${h.money} buyback` : `${h.s} approves share repurchase program`)],

  ['dividend', A(SUBJ + String.raw`\s+(?:declares|announces|approves|increases|raises|cuts|suspends)\s+(?:a\s+|its\s+|the\s+)*(?:quarterly|special|annual|monthly|semi-annual)?\s*(?:cash\s+)?dividend`),
    // "quarterly" is only stated when the source states it. A cash dividend of unstated cadence
    // must not be asserted as quarterly — that would be inventing a fact about the payout.
    (m, h) => (/\bspecial\b/i.test(m[0]) ? `${h.s} declares special dividend`
      : /\b(?:increases?|raises?)\b/i.test(m[0]) ? `${h.s} raises dividend`
      : /\b(?:cuts?|suspends?)\b/i.test(m[0]) ? `${h.s} cuts dividend`
      : /\bquarterly\b/i.test(m[0]) ? `${h.s} declares quarterly dividend`
      : `${h.s} declares dividend`)],

  ['offering', A(SUBJ + String.raw`\s+(?:announces|prices|completes|launches|closes)\s+(?:the\s+)?(?:pricing\s+of\s+)?(?:a\s+|an\s+|its\s+)*` + AMT + String.raw`(?:underwritten\s+|registered\s+|public\s+|private\s+|convertible\s+|senior\s+)*(?:offering|placement|notes\s+offering)`),
    (m, h) => { const priced = /\bpric(?:es|ing)\b/i.test(m[0]);
      return h.money ? `${h.s} ${priced ? 'prices' : 'announces'} ${h.money} offering`
        : `${h.s} ${priced ? 'prices' : 'announces'} share offering`; }],

  ['merger', A(SUBJ + String.raw`\s+(?:to\s+acquire|acquires|has\s+acquired|agrees\s+to\s+acquire|to\s+buy|agrees\s+to\s+buy|completes\s+(?:the\s+)?acquisition\s+of)\s+(` + NAMEISH + ')'),
    (m, h) => { const tgt = shortName(m[2]); if (!tgt) return null;
      return h.money ? `${h.s} to acquire ${tgt} for ${h.money}` : `${h.s} to acquire ${tgt}`; }],

  ['earnings', A(SUBJ + String.raw`\s+(?:reports|posts|announces)\s+(?:its\s+|record\s+)*(?:Q[1-4]|first|second|third|fourth|full[-\s]year|fiscal)[^,.]{0,30}?(?:results|earnings)`),
    (m, h) => { const head = h.period ? `${h.s} reports ${h.period} results` : `${h.s} reports results`;
      if (h.beatMiss && h.guidance) return `${head}, ${h.beatMiss} estimates and ${h.guidance} guidance`;
      if (h.beatMiss) return `${head} and ${h.beatMiss} estimates`;
      if (h.guidance) return `${head} and ${h.guidance} guidance`;
      return head; }],

  ['guidance', A(SUBJ + String.raw`\s+(?:raises|lifts|boosts|cuts|lowers|reduces|reaffirms|reiterates|withdraws|suspends)\s+(?:its\s+|the\s+|full[-\s]year\s+|FY\d*\s+|\d{4}\s+)*(?:guidance|outlook|forecast)`),
    (m, h) => { const g = /\b(?:raises|lifts|boosts)\b/i.test(m[0]) ? 'raises'
      : /\b(?:cuts|lowers|reduces)\b/i.test(m[0]) ? 'cuts'
      : /\b(?:withdraws|suspends)\b/i.test(m[0]) ? 'withdraws' : 'reaffirms';
      return `${h.s} ${g} ${h.period === 'full-year' ? 'full-year ' : ''}guidance`; }],

  ['bankruptcy', A(SUBJ + String.raw`\s+(?:files|filed|has\s+filed)\s+for\s+(?:chapter\s*(7|11)|bankruptcy)`),
    (m, h) => (m[2] ? `${h.s} files for Chapter ${m[2]}` : `${h.s} files for bankruptcy`)],

  // The object is cut at the first clause boundary and capped, so this states WHAT was approved
  // rather than reprinting the publisher's whole sentence back with "FDA approves" on the front.
  ['approval_agency', A(String.raw`(?:U\.S\.\s+)?FDA\s+(?:approves|clears|authorizes)\s+(.{3,70})`),
    (m) => { const obj = m[1].replace(/[,.;:(].*$/, '').replace(/\s+(?:as|for|in|to|after|amid|with)\s+.*$/i, '').trim();
      return obj.length >= 3 && obj.length <= 42 ? `FDA approves ${obj}` : null; }],

  ['approval_company', A(SUBJ + String.raw`\s+(?:receives|wins|gains|secures|announces)\s+(?:U\.S\.\s+)?FDA\s+(?:approval|clearance|authorization)`),
    (m, h) => `${h.s} wins FDA approval`],

  ['crl', A(SUBJ + String.raw`\s+(?:receives|announces\s+receipt\s+of|gets)\s+(?:a\s+)?(?:complete\s+response\s+letter|CRL)\b`),
    (m, h) => `${h.s} receives FDA complete response letter`],

  ['trial', A(SUBJ + String.raw`\s+(?:announces|reports|presents)\s+(?:positive\s+|topline\s+|detailed\s+|initial\s+)*(?:results|data)\s+from\s+(?:its\s+)?(?:pivotal\s+)?Phase\s*(3|III|2|II|1|I)\b`),
    (m, h) => { const ph = /^(?:3|III)$/i.test(m[2]) ? '3' : /^(?:2|II)$/i.test(m[2]) ? '2' : '1';
      return `${h.s} reports ${/\bpositive\b/i.test(m[0]) ? 'positive ' : ''}Phase ${ph} data`; }],

  ['trial_miss', A(SUBJ + String.raw`\s+(?:fails|failed|misses|missed)\s+(?:to\s+meet\s+)?(?:its\s+)?(?:primary\s+)?(?:endpoint|goal)`),
    (m, h) => `${h.s} trial misses primary endpoint`],

  ['contract', A(SUBJ + String.raw`\s+(?:wins|is\s+awarded|receives|secures)\s+(?:a\s+|an\s+)?` + AMT + String.raw`(?:contract|order|award)\b`),
    (m, h) => (h.money ? `${h.s} wins ${h.money} contract` : `${h.s} wins new contract`)],

  ['leadership_exit', A(SUBJ + String.raw`\s+(?:CEO|CFO|COO|Chief\s+Executive|Chief\s+Financial\s+Officer)\s+(?:to\s+)?(?:steps?\s+down|resigns?|departs?|to\s+retire|exits?)`),
    (m, h) => { const r = /CFO|Financial/i.test(m[0]) ? 'CFO' : /COO|Operating/i.test(m[0]) ? 'COO' : 'CEO';
      return `${h.s} ${r} steps down`; }],

  // The role must CLOSE the clause. "Names Chief Financial Officer Richard Park as President"
  // appoints a president, not a CFO — the trailing "as <other role>" is what the person is becoming,
  // so a role followed by "as" is too ambiguous to assert and is refused.
  ['leadership_hire', A(SUBJ + String.raw`\s+(?:names|appoints|hires)\s+(?:[A-Z][A-Za-z.'’\-]+\s+){0,3}?(?:as\s+)?(?:its\s+)?(?:new\s+)?(CEO|CFO|COO|Chief\s+Executive(?:\s+Officer)?|Chief\s+Financial\s+Officer|Chief\s+Operating\s+Officer)(?=\s*(?:[,;.]|$))`),
    (m, h) => { const r = /CFO|Financial/i.test(m[2]) ? 'CFO' : /COO|Operating/i.test(m[2]) ? 'COO' : 'CEO';
      return `${h.s} appoints new ${r}`; }],

  ['split', A(SUBJ + String.raw`\s+(?:announces|approves|completes)\s+(?:a\s+)?(?:\d+[-\s]for[-\s]\d+\s+)?(?:reverse\s+)?(?:stock|share)\s+split`),
    (m, h) => (/\breverse\b/i.test(m[0]) ? `${h.s} announces reverse stock split` : `${h.s} announces stock split`)],

  ['rates', A(String.raw`(?:The\s+)?(Federal\s+Reserve|Fed|FOMC|ECB|European\s+Central\s+Bank|Bank\s+of\s+England)\s+(cuts|raises|lifts|hikes|lowers|holds|keeps|leaves)\s+(?:its\s+|the\s+|key\s+|benchmark\s+|interest\s+)*rates?`),
    (m, h) => { const who = /ecb|european/i.test(m[1]) ? 'ECB' : /england/i.test(m[1]) ? 'BoE' : 'Fed';
      const mv = /^(?:cuts|lowers)$/i.test(m[2]) ? 'cuts' : /^(?:raises|lifts|hikes)$/i.test(m[2]) ? 'raises' : 'holds';
      if (mv === 'holds') return `${who} holds rates steady`;
      return h.bps ? `${who} ${mv} rates by ${h.bps}` : `${who} ${mv} rates`; }],

  ['enforcement', A(String.raw`(FTC|DOJ|SEC|CFTC|Justice\s+Department)\s+(?:sues|charges|files\s+(?:suit|charges)\s+against|takes\s+action\s+against)\s+(` + NAMEISH + ')'),
    (m) => { const who = /justice/i.test(m[1]) ? 'DOJ' : m[1].toUpperCase(); const def = shortName(m[2]);
      return def ? `${who} sues ${def}` : null; }],

  ['recall', A(SUBJ + String.raw`\s+(?:issues|announces|initiates|expands)\s+(?:a\s+|voluntary\s+|nationwide\s+)*recall\b`),
    (m, h) => `${h.s} issues product recall`],
];

const NO_SUBJECT_NEEDED = new Set(['approval_agency', 'rates', 'enforcement']);

// ── entry point ──────────────────────────────────────────────────────────────
// { headline, type } when an unambiguous factual assertion was found, else null.
// null is NORMAL and means "hand this to the model as rewrite_pending".
// A headline that ends on a connector, an article, or a bare infinitive ("… to Create", "… and",
// "… for the") was cut off mid-phrase. Checked on the OUTPUT only, so no pattern changes behaviour;
// the worst it can do is send an event to the model that would otherwise have shipped broken.
const DANGLING = [
  /\s(?:to|for|with|and|or|of|in|on|at|by|from|as|the|a|an|its|their|into|over|after|that)$/i,
  /\bto\s+[A-Za-z]+$/,   // a bare infinitive with nothing to act on: "… to Create"
];
const isDangling = (s) => DANGLING.some((re) => re.test(s));

export function composeHeadline({ headline, summary = '', tickers = [] } = {}) {
  const src = cleanHeadline(headline);
  if (!src) return null;

  for (const [type, re, build] of PATTERNS) {
    const m = re.exec(src);
    if (!m) continue;
    let subject = null;
    if (!NO_SUBJECT_NEEDED.has(type)) {
      subject = shortName(m[1]);
      const first = subject.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '');
      if (!subject || subject.length < 2 || !/[A-Z]/.test(subject) || NOT_SUBJECT.has(first)) continue;
    }
    const h = { s: subject, t: src, money: moneyOf(src), bps: bpsOf(src),
      period: periodOf(src), guidance: guidanceMove(src), beatMiss: beatMiss(src) };
    let out;
    try { out = build(m, h); } catch { continue; }
    if (!out) continue;
    out = out.replace(/\s{2,}/g, ' ').trim();
    if (out.length < 12 || out.length > 120) continue;
    // Reproducing the source sentence is republication, not composition. An exact match is the
    // obvious case; the similarity gate catches the subtler one, where a template only changed a
    // tense or dropped a corporate suffix ("Gordon Brothers Acquires LK Bennett Brand" ->
    // "Gordon Brothers to acquire LK Bennett Brand" scored 0.83 and is not a rewrite). Anything
    // that close goes to the model instead of being presented as Catalyst Pit's own wording.
    const flat = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (flat(out) === flat(src)) continue;
    if (similarity(out, src) >= REWRITE_MAX_SIMILARITY) continue;
    // A composition that stops mid-phrase is not a headline. Trimming a long object can leave the
    // sentence hanging on a connector or a bare infinitive — "Single Cell Discoveries Acquires TATAA
    // Biocenter to Create an End-to-End Precision Biology CRO" came out as "Single Cell Discoveries
    // to acquire TATAA Biocenter to Create", which reads as truncated because it is. Rejecting it
    // costs nothing: the event simply goes to the model as rewrite_pending, which is where anything
    // we cannot state cleanly and deterministically is supposed to go.
    if (isDangling(out)) continue;
    return { headline: out, type };
  }
  return null;
}
