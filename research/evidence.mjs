// THE EVIDENCE MODEL — and the rule that makes the rest of the research trustworthy.
//
// ⚠️ RESEARCH ONLY. Nothing under research/ is imported by src/. It changes no score, no API, no UI,
// no cron. It exists to find out which evidence carries information; production keeps using the
// current confluence formula until that question has an answer.
//
// ── THE ONE INVARIANT ─────────────────────────────────────────────────────────
//
// An observation carries the timestamp at which CATALYST PIT COULD ACTUALLY HAVE KNOWN IT — never
// the timestamp of the underlying economic event. These are different dates and the gap is not
// small: measured on our own congressional data the median disclosure lag is 28 days, the 90th
// percentile is 116 days, and 40.3% of trades are disclosed more than a month after they happened.
// A model trained on transaction dates would be reading the future.
//
// This is enforced STRUCTURALLY rather than by convention. `observation()` refuses to build a record
// unless the caller names the information timestamp, and `asOfFilter()` is the only supported way to
// select evidence for a research date. There is deliberately no "just use the event date" option.
//
// ── WHY STATE AND CHANGE ARE SEPARATE KINDS ───────────────────────────────────
//
// "Analyst consensus is Buy" and "analyst expectations improved sharply this month" are different
// claims with different half-lives, and the second is not derivable from the first. Every family
// that can express both declares both, so the research can ask which one carries information rather
// than assuming — because assuming is how a scoring model ends up rewarding a stock for a rating it
// has had for three years.
//
// Pure: no database, no network, no clock of its own.

/** The families evidence can belong to. Declared, so a typo cannot invent a new one silently. */
export const FAMILY = Object.freeze({
  ANALYST: 'analyst',
  ESTIMATES: 'estimates',
  EARNINGS: 'earnings',
  INSTITUTIONS: 'institutions',
  INSIDERS: 'insiders',
  CONGRESS: 'congress',
  FUNDAMENTALS: 'fundamentals',
  VALUATION: 'valuation',
  MOMENTUM: 'momentum',
  RELATIVE_STRENGTH: 'relative_strength',
  VOLUME: 'volume',
  CATALYST: 'catalyst',
  SHORT_INTEREST: 'short_interest',
  OPTIONS: 'options',
});
export const FAMILIES = Object.freeze(Object.values(FAMILY));

/**
 * STATE is a level that persists; CHANGE is a transition that decays.
 *
 * Kept as a first-class dimension because they must be aggregated differently and tested separately.
 * A stale STATE is still true. A stale CHANGE is not news any more.
 */
export const KIND = Object.freeze({ STATE: 'state', CHANGE: 'change' });

/** How confident we are in the observation itself — distinct from how bullish it is. */
export const QUALITY = Object.freeze({
  HIGH: 'high',       // a filed, dated, primary-source fact
  MEDIUM: 'medium',   // derived from a primary source, or a vendor value we cannot audit
  LOW: 'low',         // inferred, sparse, or known to be methodologically fragile
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * One piece of evidence about one ticker at one moment.
 *
 * `informationAt` is MANDATORY and is the date the fact became knowable to us. Passing an event date
 * here is the one mistake that would invalidate every result downstream, so callers are expected to
 * go through the *At() helpers below, which name the correct column for each source.
 *
 * `value` may be null. MISSING STAYS MISSING: there is no default, no zero, and no neutral fill. A
 * stock we have no insider data for is not a stock with no insider buying, and collapsing those two
 * is the most common way a scoring model acquires a bias it cannot see.
 */
export function observation({
  ticker, family, type, kind = KIND.STATE,
  value = null, normalized = null, direction = null, magnitude = null,
  informationAt, source, quality = QUALITY.MEDIUM, methodology = null, meta = null,
} = {}) {
  if (!ticker || typeof ticker !== 'string') throw new Error('observation: ticker required');
  if (!FAMILIES.includes(family)) throw new Error(`observation: unknown family "${family}"`);
  if (!type) throw new Error('observation: type required');
  // THE GUARD. No information timestamp, no observation — there is no permitted fallback.
  if (!isNum(informationAt)) throw new Error(`observation: informationAt (epoch ms) required for ${ticker}/${type}`);
  if (!source) throw new Error('observation: source required');
  if (direction !== null && ![-1, 0, 1].includes(direction)) throw new Error('observation: direction must be -1, 0, 1 or null');

  return Object.freeze({
    ticker: ticker.toUpperCase(),
    family, type, kind,
    value: value ?? null,
    // Normalization is the researcher's job and is deliberately NOT computed here: it depends on the
    // cross-section at the observation date, which a single record cannot see.
    normalized: isNum(normalized) ? normalized : null,
    direction, magnitude: isNum(magnitude) ? magnitude : null,
    informationAt,
    source, quality, methodology,
    meta: meta ?? null,
  });
}

/**
 * THE POINT-IN-TIME TIMESTAMP RULES, one per source, stated where they cannot be forgotten.
 *
 * Each returns the epoch ms at which the fact became public, or null when we cannot establish it —
 * and null means the observation is UNUSABLE for research rather than usable with a guessed date.
 */
export const PIT_RULES = Object.freeze({
  /**
   * Form 4. The transaction date is when the insider traded; the FILING date is when anyone else
   * could know. Median lag on our data is 2 days, 90th percentile 4 — small, but never zero, and the
   * two-day rule means a Friday trade is Tuesday's news.
   */
  insiderTrade: (row) => dayMs(row?.filing_date ?? row?.filingDate),

  /**
   * STOCK Act disclosures. The lag is the entire problem: median 28 days, p90 116, max 1,932 on our
   * own data. Using the transaction date would hand the model information up to five years early.
   */
  congressTrade: (row) => dayMs(row?.disclosure_date ?? row?.disclosureDate),

  /**
   * 13F. The position is a snapshot of a quarter that ended weeks earlier, and it is knowable only
   * when the fund files — measured on our data, a median of ~38 days after quarter end. A model that
   * used the quarter-end date would act on ownership six weeks before it was public.
   */
  fundHolding: (row) => dayMs(row?.filed_date ?? row?.filedDate),

  /** 8-K. `filed_at` is already the publication instant. */
  eightK: (row) => msOf(row?.filed_at ?? row?.filedAt),

  /**
   * Pit Wire. `published_at` is the publisher's stamp; `first_seen_at` is when WE had it. The later
   * of the two is the honest answer — we cannot act on a story before we receive it, and a publisher
   * timestamp can predate our ingestion by hours during a backfill.
   */
  wireEvent: (row) => {
    const pub = msOf(row?.published_at ?? row?.publishedAt);
    const seen = msOf(row?.first_seen_at ?? row?.firstSeenAt ?? row?.received_at ?? row?.receivedAt);
    if (pub == null) return seen;
    if (seen == null) return pub;
    return Math.max(pub, seen);
  },

  /**
   * FINRA short interest. The settlement date is NOT the publication date — FINRA publishes roughly
   * eight business days later. We do not store the publication date, so it is approximated
   * conservatively and the observation is marked LOW quality for it.
   */
  shortInterest: (row) => {
    const settle = dayMs(row?.settlement_date ?? row?.settlementDate);
    return settle == null ? null : settle + SHORT_INTEREST_PUBLICATION_LAG_MS;
  },

  /** A daily bar is knowable at the close of that session. */
  dailyBar: (row) => dayMs(row?.date),
});

/** FINRA's own publication schedule: about eight business days after settlement. */
export const SHORT_INTEREST_PUBLICATION_LAG_DAYS = 12;   // 8 business days, expressed in calendar days
export const SHORT_INTEREST_PUBLICATION_LAG_MS = SHORT_INTEREST_PUBLICATION_LAG_DAYS * 86_400_000;

function dayMs(v) {
  if (v == null) return null;
  const s = typeof v === 'string' ? v.slice(0, 10) : null;
  if (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(`${s}T00:00:00Z`);
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
function msOf(v) {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * THE ONLY SUPPORTED WAY TO SELECT EVIDENCE FOR A RESEARCH DATE.
 *
 * Strictly BEFORE the as-of instant, not "at or before": an observation stamped the same millisecond
 * as the decision is a coin-flip on ordering, and in research a coin-flip that favours the model is
 * indistinguishable from cheating.
 */
export function asOfFilter(observations, asOfMs) {
  if (!isNum(asOfMs)) throw new Error('asOfFilter: asOfMs (epoch ms) required');
  return (observations || []).filter((o) => o && isNum(o.informationAt) && o.informationAt < asOfMs);
}

/** How stale an observation is at a research date, in days. Never negative — see asOfFilter. */
export const ageDays = (o, asOfMs) => (o && isNum(o.informationAt) ? (asOfMs - o.informationAt) / 86_400_000 : null);

/**
 * A decay weight for CHANGE evidence.
 *
 * A rating upgrade from this morning and one from four months ago are not the same fact, and a model
 * that treats them alike will rank on history rather than news. STATE evidence does NOT decay — a
 * company is not less profitable because the filing is old.
 *
 * Exponential with a stated half-life, because it is one parameter a reader can argue with. Which
 * half-life is right is a research question, not a decision to bury here.
 */
export function recencyWeight(o, asOfMs, { halfLifeDays = 30 } = {}) {
  if (!o) return null;
  if (o.kind === KIND.STATE) return 1;
  const age = ageDays(o, asOfMs);
  if (age == null || age < 0) return null;
  return 2 ** (-age / halfLifeDays);
}

/**
 * ⚠️ CORRELATED EVIDENCE — declared, because double counting is invisible once it is summed.
 *
 * Three columns describing one underlying event is not three pieces of evidence. An analyst reacting
 * to an earnings beat typically raises the rating, the price target and the EPS estimate in a single
 * note; counting all three triples the weight of one opinion. The same is true of price momentum,
 * relative strength and moving-average structure, which are largely three views of one price path.
 *
 * The architecture's answer is WITHIN-FAMILY AGGREGATION FIRST: members of a group collapse to one
 * family verdict before anything crosses family boundaries. What the collapse function should be is
 * a research question; that it must happen is not.
 */
export const CORRELATION_GROUPS = Object.freeze([
  {
    id: 'analyst_reaction',
    members: ['analyst.rating_change', 'estimates.eps_revision', 'estimates.pt_revision', 'estimates.revenue_revision'],
    why: 'One analyst note usually moves the rating, the target and the estimate together.',
  },
  {
    id: 'price_path',
    members: ['momentum.return', 'momentum.trend', 'relative_strength.vs_spy', 'relative_strength.vs_sector', 'momentum.ma_structure'],
    why: 'Momentum, relative strength and moving-average structure are largely one price path re-expressed.',
  },
  {
    id: 'earnings_reaction',
    members: ['earnings.surprise', 'estimates.post_earnings_revision', 'catalyst.earnings_event'],
    why: 'The beat, the revisions that follow it and the event itself are one occurrence.',
  },
  {
    id: 'smart_money_flow',
    members: ['insiders.open_market_buy', 'institutions.accumulation', 'congress.purchase'],
    why: 'Genuinely independent actors, but they can react to the same public catalyst — tested, not assumed.',
  },
  {
    id: 'volume_activity',
    members: ['volume.rvol', 'volume.dollar_volume', 'volume.acceleration'],
    why: 'Three measurements of one session\'s participation.',
  },
]);

/** The correlation group an evidence key belongs to, or null when it stands alone. */
export function correlationGroupOf(familyDotType) {
  for (const g of CORRELATION_GROUPS) if (g.members.includes(familyDotType)) return g.id;
  return null;
}

/**
 * Group observations by family, preserving missingness.
 *
 * A family with no observations is ABSENT from the result rather than present-and-empty, so a
 * downstream aggregate cannot mistake "we looked and found nothing" for "we never looked".
 */
export function byFamily(observations) {
  const out = new Map();
  for (const o of observations || []) {
    if (!o?.family) continue;
    if (!out.has(o.family)) out.set(o.family, []);
    out.get(o.family).push(o);
  }
  return out;
}

/**
 * How much INDEPENDENT support a direction has — the input to confidence, not to direction.
 *
 * Counts distinct families, then distinct correlation groups within them, so seven observations that
 * are really one analyst note count once. This is a count, deliberately: turning it into a
 * probability would be inventing certainty we have not measured.
 */
export function independentSupport(observations) {
  const families = new Set();
  const groups = new Set();
  let ungrouped = 0;
  for (const o of observations || []) {
    if (!o?.family) continue;
    families.add(o.family);
    const g = correlationGroupOf(`${o.family}.${o.type}`);
    if (g) groups.add(g); else ungrouped += 1;
  }
  return { families: families.size, correlationGroups: groups.size, ungrouped, distinctSources: groups.size + ungrouped };
}
