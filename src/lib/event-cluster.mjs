// Cross-source event clustering. PURE: no DB, no network.
//
// Clustering here is NON-DESTRUCTIVE by design. Two outlets reporting the same event produce two
// rows, both kept, both with their own URL, headline and raw payload — they simply share a
// cluster_id. Nothing is ever deleted or skipped.
//
// That choice is deliberate: the failure modes are asymmetric. A duplicate on screen is a blemish,
// but wrongly MERGING two distinct events loses news permanently. Keeping every row means a bad
// merge is a display artifact that re-running fixes, not data loss. Where the signals are
// ambiguous we therefore leave the items unclustered rather than guessing them together.

// Tracking junk that changes per-outlet but never identifies a different article.
const STRIP_PARAMS = /^(utm_|ref$|ref_|source$|src$|cmp$|cmpid$|ito$|at_|mc_|fbclid$|gclid$|igshid$|s$|__twitter|sh$|taid$)/i;

// Same article, different link decoration → one canonical string.
export function canonicalUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return ''; }
  u.protocol = 'https:';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  // The fragment is USUALLY cosmetic ("#top"), but some feeds use it as the item identifier: the
  // Fed's G.19 feed publishes every notice as ".../G19.html#3929". Stripping it merged 44 distinct
  // announcements spanning three years into one event. So only known cosmetic anchors are dropped.
  if (/^#?(?:$|top$|main$|content$|comments?$|start$|header$|footer$|nav$)/i.test(u.hash)) u.hash = '';
  const keep = [...u.searchParams.entries()].filter(([k]) => !STRIP_PARAMS.test(k));
  u.search = '';
  for (const [k, v] of keep.sort(([a], [b]) => a.localeCompare(b))) u.searchParams.append(k, v);
  // A trailing slash is not a different article.
  u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  return u.toString();
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'at', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'that', 'this',
  'after', 'over', 'into', 'up', 'down', 'out', 'about', 'says', 'said', 'new', 'will', 'has', 'have']);

export const normWords = (s) => String(s || '').toLowerCase()
  .replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));

// Action classes. Two outlets describe the same corporate event with different verbs ("acquires" /
// "to buy" / "takeover"); collapsing to a class makes the fingerprint agree without the wording
// having to. An item matching no class gets no deterministic fingerprint — it falls through to
// similarity, which is the conservative path.
// Order matters: the FIRST match wins, so the most specific classes are listed first. Buyback,
// dividend and offering are deliberately separate — lumping them into one "corporate action" class
// would let a $500M buyback merge with a $500M offering announced the same week.
const ACTION_CLASSES = [
  ['halt', /\b(halt\w*|circuit breaker|resumption|trading suspend\w*)\b/i],
  ['buyback', /\b(buy-?back|share repurchase|repurchase program|repurchase of|tender offer)\b/i],
  ['dividend', /\b(dividend|distribution declar\w*)\b/i],
  ['split', /\b(stock split|reverse split|share consolidation)\b/i],
  ['offering', /\b(offering|pricing of|prices? \$|ipo|direct listing|private placement|atm program|convertible notes)\b/i],
  ['merger', /\b(acquir\w*|acquisition|merger|merges?|buyout|takeover|to buy|definitive agreement)\b/i],
  ['bankruptcy', /\b(bankrupt\w*|chapter 11|chapter 7|insolven\w*|going concern|delist\w*)\b/i],
  ['approval', /\b(approv\w*|authoriz\w*|clearance|cleared|greenlight\w*)\b/i],
  ['rejection', /\b(reject\w*|denied|denies|complete response letter|declin\w*)\b/i],
  ['trial', /\b(phase (1|2|3|i|ii|iii)|topline|clinical (trial|study|data|results)|endpoint)\b/i],
  ['lawsuit', /\b(sues?|sued|lawsuit|litigation|complaint|antitrust|indict\w*|charges?)\b/i],
  ['settlement', /\b(settle\w*|consent (order|decree)|resolves?|fine[sd]?|penalt\w*)\b/i],
  ['earnings', /\b(earnings|quarterly results|revenue|eps|guidance|outlook|profit warning)\b/i],
  ['rates', /\b(rate (cut|hike|decision)|basis points|fomc|monetary policy|interest rates?)\b/i],
  ['recall', /\b(recall\w*|safety (alert|communication)|withdraw\w*)\b/i],
  ['leadership', /\b(ceo|cfo|coo|chief executive|chief financial|resign\w*|steps? down|appoint\w*)\b/i],
  ['rating', /\b(upgrade[sd]?|downgrade[sd]?|price target|initiat\w+ coverage)\b/i],
  ['contract', /\b(contract award|wins? (a )?contract|signs? (a )?(deal|agreement)|selected by)\b/i],
];

export function actionClass(text) {
  const s = String(text || '');
  for (const [name, re] of ACTION_CLASSES) if (re.test(s)) return name;
  return null;
}

// Deterministic identity: WHO + WHAT KIND + WHEN. Requires at least one ticker, because without a
// named entity "approval on Tuesday" is not specific enough to merge on.
export function eventKey({ tickers = [], headline = '', summary = '', publishedAt = null }) {
  const syms = [...new Set(tickers.map((t) => String(t).toUpperCase()))].sort();
  if (!syms.length) return null;
  const cls = actionClass(`${headline} ${summary || ''}`);
  if (!cls) return null;
  const day = publishedAt ? String(publishedAt).slice(0, 10) : '';
  if (!day) return null;
  return `${syms.join('+')}|${cls}|${day}`;
}

// WHO + WHAT KIND + THE NUMBER. This is the layer that collapses differently-worded reports of one
// event without needing a model:
//
//   "XYZ Corp Announces $500 Million Share Repurchase Program"  → xyz|buyback|500000000
//   "XYZ authorizes new $500M stock buyback"                    → xyz|buyback|500000000
//   "XYZ board approves share repurchase of up to $500 million" → xyz|buyback|500000000
//
// and which keeps genuinely different developments apart:
//
//   "XYZ announces $750M acquisition"                           → xyz|merger|750000000
//
// A numeric signature is REQUIRED. Without one, "XYZ wins approval" twice in a week would merge two
// unrelated approvals, so those items fall through to similarity instead. No date is included —
// candidates are already bounded to a recent window, and a date would split an event across midnight.
export function factKey({ entity = '', headline = '', summary = '', factSig = '' }) {
  if (!entity || !factSig) return null;
  const cls = actionClass(`${headline} ${summary || ''}`);
  if (!cls) return null;
  return `${String(entity).toLowerCase()}|${cls}|${factSig}`;
}

// Near-identical wording across syndicating outlets, which is common when several sites carry the
// same press release verbatim. Cheaper than shingling and catches the easy majority.
export function normHash(headline) {
  const norm = normWords(headline).join(' ');
  return norm.length >= 12 ? norm : '';
}

// Character-level 4-grams over the normalized word stream. Robust to different phrasings of the
// same fact in a way word-set overlap alone is not.
export function shingles(text, n = 4) {
  const s = normWords(text).join(' ');
  const out = new Set();
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Two thresholds, because the two kinds of shared entity are not equally strong evidence.
//
// A shared TICKER is a resolved, unambiguous identifier: if two items are both about NVDA and read
// alike, they are almost certainly one event, so 0.60 is safe.
//
// A shared ENTITY TOKEN is just the leading capitalised words of a headline, which for wire copy is
// often a common noun. Measured on live data, "Danger has passed in Abha" and "Danger has passed in
// Khamis Mushait" — two different cities, two genuinely different events — scored 0.607 and were
// wrongly merged at the old single threshold. 0.72 separates them while still collapsing real
// duplicates. Under-merging shows a duplicate; over-merging destroys a distinct event, so the
// weaker signal gets the stricter bar.
export const SIMILARITY_THRESHOLD = 0.6;
export const SIMILARITY_THRESHOLD_WEAK = 0.72;

// Decide which existing event (if any) a candidate belongs to.
//   candidates: [{ seq, cluster_id, canonical_url, event_key, fact_key, norm_hash, headline,
//                  summary, tickers, entity }]
//
// Five layers, DETERMINISTIC FIRST so the common cases resolve in microseconds and no model is ever
// consulted to decide whether something is a duplicate. Only the last layer does real work, and it
// runs against a bounded recent window.
//
//   1 source uid     — enforced by the UNIQUE constraint at insert, not here
//   2 canonical url  — same article, different link decoration
//   3 fact key       — entity + event type + the number (see factKey)
//   4 norm hash      — same headline, trivially reworded
//   5 similarity     — shingle overlap, and only with a shared entity
// Time proximity. A recurring headline is the trap here: "Federal Reserve issues FOMC statement" is
// word-for-word identical at every meeting, and "Powell, Semiannual Monetary Policy Report to the
// Congress" repeats twice a year. Measured on live data, those merged across YEARS because a cold
// backfill puts the whole archive inside one received_at window. Same wording plus same numbers is
// only the same event if it also happened at the same time.
export const PROXIMITY_MS = 36 * 3600 * 1000;
function nearInTime(a, b) {
  const ta = Date.parse(a?.published_at ?? a?.received_at ?? '');
  const tb = Date.parse(b?.published_at ?? b?.received_at ?? '');
  // An undated item cannot be proven distant, and the candidate window already bounds it.
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return true;
  return Math.abs(ta - tb) <= PROXIMITY_MS;
}

export function findCluster(item, candidates) {
  // A shared canonical URL is normally the same article — but the time test still applies, because
  // a feed that reuses one landing URL across years of notices would otherwise collapse all of them.
  const url = canonicalUrl(item.original_url);
  if (url) {
    for (const c of candidates) if (c.canonical_url === url && nearInTime(item, c)) return { match: c, tier: 'url' };
  }
  if (item.fact_key) {
    for (const c of candidates) {
      if (c.fact_key && c.fact_key === item.fact_key && nearInTime(item, c)) return { match: c, tier: 'fact_key' };
    }
  }
  if (item.event_key) {
    // event_key already carries the calendar day, but the proximity test also covers the case of
    // two reports that straddle midnight.
    for (const c of candidates) {
      if (c.event_key && c.event_key === item.event_key && nearInTime(item, c)) return { match: c, tier: 'event_key' };
    }
  }
  if (item.norm_hash) {
    for (const c of candidates) {
      if (c.norm_hash && c.norm_hash === item.norm_hash && nearInTime(item, c)) return { match: c, tier: 'norm_hash' };
    }
  }

  // Shared-entity requirement: two unrelated stories that merely read alike are never merged.
  const mine = shingles(`${item.headline} ${item.summary || ''}`);
  const myTickers = new Set((item.tickers || []).map((t) => String(t).toUpperCase()));
  const myEntity = String(item.entity || '').toLowerCase();
  let best = null, bestScore = 0, bestNeeded = 1;
  for (const c of candidates) {
    const theirs = new Set((c.tickers || []).map((t) => String(t).toUpperCase()));
    let sharedTicker = false;
    for (const t of myTickers) if (theirs.has(t)) { sharedTicker = true; break; }
    const sharedEntity = myEntity && String(c.entity || '').toLowerCase() === myEntity;
    if (!sharedTicker && !sharedEntity) continue;
    // A different headline number means a different development, whatever the wording overlap.
    if (item.fact_sig && c.fact_sig && item.fact_sig !== c.fact_sig) continue;
    if (!nearInTime(item, c)) continue;
    const needed = sharedTicker ? SIMILARITY_THRESHOLD : SIMILARITY_THRESHOLD_WEAK;
    const score = jaccard(mine, shingles(`${c.headline} ${c.summary || ''}`));
    if (score >= needed && score > bestScore) { bestScore = score; best = c; bestNeeded = needed; }
  }
  if (best) return { match: best, tier: 'similarity', score: Number(bestScore.toFixed(3)), needed: bestNeeded };
  return null;
}
