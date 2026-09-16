// WHAT THE FACEBOOK PAGE IS ABOUT: economics and markets, and nothing else.
//
// Pure. No database, no network. Two decisions live here and both are deliberately conservative.
//
// 1. RELEVANCE — an ALLOWLIST, not a blocklist. A post publishes only when it carries a recognisable
//    market or economic subject; anything unrecognised is dropped. That is the right way round for a
//    public Page: the cost of dropping a borderline story is one missed post, and the cost of
//    publishing the wrong one is who we look like. Measured on live rows, roughly half of ZeroHedge's
//    output is military, electoral or cultural — "Houthis claim shooting down Saudi F-15 fighter
//    jet", "Left-wing parties win narrow Swedish national election victory", "Rep. Mace Demands
//    Public Execution For Lindsay Clancy" — none of which belongs under #stockmarket #investing.
//
// 2. ONE STORY, ONE POST. Walter and ZeroHedge cover the same events, and ZeroHedge never folds into
//    the ingestion pipeline's clusters — 0 of 162 measured over three days — so the existing
//    cross-source dedupe does not see it. Without a topic check the Page would carry both.

// ── relevance ────────────────────────────────────────────────────────────────
// Subjects that ARE the Page's remit. Grouped only for readability; any single hit qualifies.
const MARKET_TERMS = [
  // central banks, rates, policy
  'fed', 'federal reserve', 'fomc', 'central bank', 'ecb', 'boe', 'bank of england', 'boj',
  'bank of japan', 'pboc', 'rate hike', 'rate cut', 'interest rate', 'basis point', 'bps',
  'monetary policy', 'quantitative', 'tightening', 'easing', 'yield curve', 'dot plot',
  // macro statistics
  'inflation', 'deflation', 'cpi', 'ppi', 'pce', 'gdp', 'recession', 'retail sales', 'payroll',
  'unemployment', 'jobless', 'jobs report', 'employment', 'consumer spending', 'consumer price',
  'economy', 'economic', 'economist', 'pmi', 'ism', 'industrial production', 'trade deficit',
  'budget deficit', 'national debt', 'debt ceiling', 'fiscal', 'stimulus', 'austerity',
  // markets and instruments
  'market', 'markets', 'stock', 'stocks', 'shares fall', 'shares rise', 'equity', 'equities', 'stock index',
  's&p', 'nasdaq', 'dow jones', 'russell', 'ftse', 'dax', 'nikkei', 'hang seng',
  'bond', 'bonds', 'yield', 'yields', 'treasury', 'treasuries', 'gilt', 'gilts', 'bund',
  'futures', 'options', 'derivative', 'crack spread', 'credit spread', 'repo', 'sofr',
  'currency', 'us dollar', 'dollar index', 'the euro', 'the yen', 'sterling', 'forex', 'exchange rate', 'devalu',
  'crypto', 'bitcoin', 'ethereum', 'stablecoin',
  // commodities and energy
  'oil', 'crude', 'brent', 'wti', 'opec', 'barrel', 'refinery', 'refining', 'pipeline',
  'natural gas', 'lng', 'gasoline', 'diesel', 'gas price', 'fuel price', 'oil price', 'commodity', 'commodities',
  'gold', 'silver', 'copper', 'uranium', 'lithium', 'wheat', 'grain', 'force majeure',
  'energy prices', 'power grid', 'electricity price', 'output cut', 'production cut',
  // corporate and investing
  'earnings', 'revenue', 'profit', 'net loss', 'guidance', 'profit margin', 'eps',
  'ipo', 'listing', 'merger', 'acquisition', 'acquires', 'takeover', 'buyback', 'repurchase',
  'dividend', 'valuation', 'price target', 'analyst', 'downgrade', 'upgrade',
  'hedge fund', 'private equity', 'venture capital', 'investor', 'investment fund',
  'bankruptcy', 'chapter 11', 'default', 'restructuring', 'layoff', 'job cuts', 'hiring',
  'ceo', 'cfo', 'chief executive', 'board of directors', 'shareholder', 'sec filing',
  'central bank', 'investment bank', 'lender', 'mortgage', 'credit rating', 'loan', 'lending',
  // trade and policy with a direct market channel
  'tariff', 'tariffs', 'trade deal', 'trade war', 'export ban', 'export controls', 'sanction',
  'supply chain', 'shipping', 'freight', 'tanker', 'chip', 'chips', 'semiconductor',
  'subsidy for', 'tax cut', 'tax hike', 'corporate tax', 'capital gains',
];

// Subjects that are NOT the remit even when a market word appears nearby. Checked FIRST, because
// "US strikes Iranian small boats attempting to seize surface drone in Hormuz" contains no market
// term but a story about troops can still pick one up incidentally.
const OFF_TOPIC = [
  'fighter jet', 'shot down', 'shooting down', 'shootdown', 'airstrike', 'air strike',
  'missile strike', 'troops', 'soldier', 'infantry', 'battalion', 'nato', 'ceasefire',
  'election', 'electoral', 'poll shows', 'opinion poll', 'parliament', 'referendum',
  'campaign trail', 'impeach', 'indictment', 'arrested', 'execution', 'murder', 'homicide',
  'sexual', 'abuse', 'celebrity', 'sports', 'football', 'basketball', 'nfl', 'nba',
  'birth rate', 'fertility', 'vaccine mandate', 'surveillance camera',
];

const hay = (s) => ' ' + String(s || '').toLowerCase().replace(/[^a-z0-9&$.\s-]/g, ' ').replace(/\s+/g, ' ') + ' ';

/**
 * Is this post about economics or markets?
 *
 * The subject vocabulary decides it, and nothing else. `tickers` is accepted so callers can pass the
 * event through unchanged, and is deliberately ignored — see the note below.
 */
export function facebookRelevance(text, tickers = []) {
  const h = hay(text);
  if (!h.trim()) return { relevant: false, reason: 'no text' };

  for (const bad of OFF_TOPIC) {
    if (h.includes(' ' + bad) || h.includes(bad + ' ')) {
      return { relevant: false, reason: `off topic (${bad})`, matched: bad };
    }
  }
  // DELIBERATELY NOT A TICKER SHORTCUT. A resolved ticker looks like the strongest possible signal
  // and is not: the resolver's false positives put FUSB (First US Bancshares) on an SK Hynix story
  // and FTEK (Fuel Tech) on an Aurora Cannabis one, the latter published to X before it was caught.
  // Trusting a ticker here would let a wrong one drag an off-topic story onto the Page.
  for (const term of MARKET_TERMS) {
    if (h.includes(' ' + term) || h.includes(term + ' ')) {
      return { relevant: true, reason: 'market subject', matched: term };
    }
  }
  return { relevant: false, reason: 'no market or economic subject' };
}

// ── one story, one post ──────────────────────────────────────────────────────
// Words that identify WHICH story this is. Deliberately not the market vocabulary above: "oil",
// "market" and "fed" appear in half the corpus and would collapse unrelated stories together.
const TOPIC_STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'says', 'said', 'will', 'has', 'have', 'had',
  'was', 'were', 'are', 'its', 'his', 'her', 'their', 'after', 'before', 'over', 'under', 'into',
  'more', 'most', 'than', 'then', 'they', 'them', 'been', 'being', 'also', 'about', 'could',
  'would', 'should', 'may', 'might', 'new', 'first', 'last', 'next', 'amid', 'against', 'between',
  'report', 'reports', 'reported', 'according', 'week', 'month', 'year', 'today', 'yesterday',
  // Generic market furniture. These appear in a large share of the corpus and carry no identity:
  // "Fed raises rates 25 basis points" and "Fed cuts rates 50 basis points" share rates/basis/points
  // and were being collapsed into one story despite saying the opposite thing.
  'rate', 'rates', 'basis', 'point', 'points', 'market', 'markets', 'price', 'prices', 'percent',
  'stock', 'stocks', 'share', 'shares', 'data', 'level', 'levels', 'high', 'highs', 'low', 'lows',
]);

// Direction words, as opposing pairs. Two posts that disagree on direction are never the same story,
// whatever they share — this is the guard that stops a hike and a cut being deduped into one post.
const DIRECTION = [
  [/\b(?:rais\w*|hik\w*|increas\w*|lift\w*|up|higher|rise[sn]?|rose|rally\w*|gain\w*|surg\w*|jump\w*|rebound\w*|climb\w*)\b/i,
   /\b(?:cut\w*|lower\w*|reduc\w*|decreas\w*|down|fall\w*|fell|drop\w*|declin\w*|slump\w*|tumbl\w*|sink\w*|slid\w*)\b/i],
  [/\b(?:beat\w*|top\w*|exceed\w*|above)\b/i, /\b(?:miss\w*|below|short of)\b/i],
  [/\b(?:approv\w*|clear\w*|grant\w*|win[s]?|won)\b/i, /\b(?:reject\w*|den(?:y|ies|ied)|block\w*|refus\w*)\b/i],
  [/\b(?:open\w*|resum\w*|restart\w*|restor\w*)\b/i, /\b(?:clos\w*|halt\w*|suspend\w*|shut\w*|stopp\w*)\b/i],
];

/** Do these two texts assert OPPOSITE directions on the same axis? */
export function directionDiffers(a, b) {
  const A = String(a || ''), B = String(b || '');
  for (const [pos, neg] of DIRECTION) {
    const aPos = pos.test(A), aNeg = neg.test(A), bPos = pos.test(B), bNeg = neg.test(B);
    // Only assert a conflict when each side is unambiguous on this axis.
    if (aPos && !aNeg && bNeg && !bPos) return true;
    if (aNeg && !aPos && bPos && !bNeg) return true;
  }
  return false;
}

/**
 * The distinctive words of a story, as a sorted set.
 *
 * Numbers are kept: "25 basis points" and "50 basis points" are different stories, and a figure is
 * the most reliable thing two reports of the same event share.
 */
export function topicTokens(text) {
  const words = String(text || '').toLowerCase().match(/[a-z][a-z'-]{2,}|\d+(?:\.\d+)?%?/g) || [];
  const out = new Set();
  for (const w of words) {
    if (TOPIC_STOP.has(w)) continue;
    if (/^[a-z]/.test(w) && w.length < 4) continue;      // short words carry no identity
    out.add(w);
  }
  return out;
}

/**
 * Do two posts tell the same story?
 *
 * CONSERVATIVE ON PURPOSE. Suppressing a genuinely new story is worse than occasionally posting a
 * near-duplicate, so this requires BOTH a high proportion of shared words and at least three of
 * them. "Saudi" and "oil" co-occur across many unrelated stories; three shared distinctive words
 * with most of the sentence in common is a repeat.
 */
// TUNED AGAINST FALSE MERGES, not guessed. At 3 shared words and a 0.5 ratio these two pairs were
// being collapsed into one post, and both are genuinely different stories:
//
//   "Tesla recalls vehicles over a software defect"  |  "Tesla recalls chargers over an overheating defect"
//   "Federal Reserve officials signal caution on inflation ..."  |  "European Central Bank officials signal caution on growth ..."
//
// Suppressing a real story is the worse failure — a near-duplicate is untidy, a missing story is
// missing news — so the bar sits above both of those and still catches the true duplicates, which
// share four or more distinctive words and most of the shorter sentence.
export const SAME_TOPIC_MIN_SHARED = 4;
export const SAME_TOPIC_MIN_RATIO = 0.6;

export function sameTopic(a, b) {
  // Opposite directions are never the same story, however much wording they share.
  if (typeof a === 'string' && typeof b === 'string' && directionDiffers(a, b)) return false;
  const A = a instanceof Set ? a : topicTokens(a);
  const B = b instanceof Set ? b : topicTokens(b);
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  if (shared < SAME_TOPIC_MIN_SHARED) return false;
  // Measured against the SHORTER post: a one-line flash restating a longer story shares most of
  // itself with it, and dividing by the union would hide that.
  return shared / Math.min(A.size, B.size) >= SAME_TOPIC_MIN_RATIO;
}

/** A compact, storable fingerprint: the story's most distinctive words, sorted. */
export function topicKey(text) {
  return [...topicTokens(text)].sort().slice(0, 12).join(' ');
}
