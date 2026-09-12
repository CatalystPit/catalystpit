import 'server-only';
// ─────────────────────────────────────────────────────────────────────────────
//  CATALYST PIT INSIDER CONVICTION — proprietary scoring engine.
//
//  PRIVATE. The `server-only` import above turns any client import into a BUILD
//  ERROR. Every weight, threshold, normalisation curve and eligibility rule lives
//  in this file and MUST NOT reach the browser. The API layer emits only what
//  toPublicConviction() returns: a 0-100 score, a band, and approved display tags.
//  Never return a factor breakdown, a weight, or an intermediate value.
//  Do not import this from a 'use client' file. Mirrors the Pit Scan contract.
//
//  The question it answers: "how much genuine conviction does this purchase show?"
//  — NOT "how big is it". A $500K buy by a CEO who has not bought in three years
//  should outrank a routine $2M top-up from a serial buyer, so almost everything
//  here is relative: to the insider's own history, to their existing stake, and to
//  how unusual the purchase is within the history we actually hold.
// ─────────────────────────────────────────────────────────────────────────────

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const logistic = (x, mid, k) => 1 / (1 + Math.exp(-k * (x - mid)));
// Ratios are compared in log space so "3x their usual" and "1/3 of their usual" are
// symmetric distances rather than one being compressed against zero.
const logRatio = (a, b) => (a > 0 && b > 0 ? Math.log(a / b) : 0);

// ─── Eligibility ────────────────────────────────────────────────────────────
// V1 scores GENUINE OPEN-MARKET PURCHASES only. Grants, gifts, tax withholding,
// automatic compensation and ordinary option exercises express no conviction and
// must never carry a bullish score — they are left null, not given a low score,
// so the UI can distinguish "not applicable" from "weak".
export function isConvictionEligible(row) {
  if (!row) return false;
  if (row.transaction_code !== 'P') return false;
  if (row.is_derivative) return false;
  if (row.superseded_by) return false;
  if (!(Number(row.total_value) > 0)) return false;
  if (!(Number(row.shares) > 0)) return false;
  return true;
}

// ─── Role seniority ─────────────────────────────────────────────────────────
const CEO_RE = /\bchief executive\b|\bceo\b/i;
const CFO_RE = /\bchief financial\b|\bcfo\b/i;
const CHAIR_RE = /\bchair(man|woman|person)?\b/i;
const PRES_RE = /\bpresident\b/i;
const COO_RE = /\bchief operating\b|\bcoo\b/i;

function roleOf(row) {
  const t = String(row.title || '');
  if (CEO_RE.test(t)) return 'CEO';
  if (CFO_RE.test(t)) return 'CFO';
  if (COO_RE.test(t) || PRES_RE.test(t)) return 'SENIOR_OFFICER';
  if (CHAIR_RE.test(t)) return 'CHAIR';
  if (row.is_officer) return 'OFFICER';
  if (row.is_director) return 'DIRECTOR';
  if (row.is_ten_pct_owner) return 'TEN_PCT';
  return 'OTHER';
}

// Below this a purchase is treated as token, however strong its ratios look.
const DE_MINIMIS = 50000;

const SENIORITY = {
  CEO: 1.00, CFO: 0.92, SENIOR_OFFICER: 0.78, CHAIR: 0.74,
  OFFICER: 0.58, DIRECTOR: 0.50, TEN_PCT: 0.42, OTHER: 0.25,
};

const W = {
  seniority: 0.15,
  sizeVsSelf: 0.20,
  ownership: 0.17,
  rarity: 0.19,
  cluster: 0.13,
  scale: 0.16,
};

/**
 * Score one open-market purchase.
 * @param {object} row      insider_trades row incl. precomputed context columns
 * @param {object} person   insider_people row for this owner_cik (may be null)
 * @param {object} opts     { marketCap }
 * @returns {{score:number, band:string, factors:object}|null}
 *          `factors` is INTERNAL — callers must not forward it to a client.
 */
export function scoreConviction(row, person, opts = {}) {
  if (!isConvictionEligible(row)) return null;

  const value = Number(row.total_value) || 0;
  const role = roleOf(row);

  // 1. Seniority — who is buying.
  const fSeniority = SENIORITY[role] ?? SENIORITY.OTHER;

  // 2. Size relative to THIS insider's own buying history. This is the factor that
  //    makes the score work across a wealthy founder and an ordinary director: both
  //    are measured against themselves. With no prior history the purchase is simply
  //    unremarkable-by-default rather than assumed large.
  const baseline = Number(person?.om_buy_median) || 0;
  const priorBuys = Number(person?.om_buy_count) || 0;
  const fSizeVsSelf = baseline > 0 && priorBuys >= 2
    ? clamp01(logistic(logRatio(value, baseline), 0.55, 1.35))
    : 0.45;

  // 3. How much it moved their own stake. A purchase that lifts a holding by a third
  //    is a materially different act from one that nudges it 0.4%.
  const ownPct = Number(row.ownership_increase_pct);
  // Unknown is not the same as small: shares_owned_after is often footnoted, and a
  // missing figure should not be punished as though the stake barely moved.
  const fOwnership = Number.isFinite(ownPct) && ownPct > 0
    ? clamp01(logistic(Math.log1p(ownPct), Math.log1p(18), 1.15))
    : 0.45;

  // 4. Rarity — how unusual this purchase is for this person at this company.
  //    A long silence followed by a buy is the strongest single tell; someone who
  //    buys every month is expressing habit, not conviction, so frequent recent
  //    buying damps this rather than adding to it.
  const gap = Number(row.months_since_prev_buy);
  const buys12 = Number(row.om_buys_12m) || 1;
  let fRarity;
  if (row.is_first_om_buy) fRarity = 0.86;                      // first in stored history
  else if (Number.isFinite(gap)) fRarity = clamp01(logistic(gap, 9, 0.22));
  else fRarity = 0.5;
  const habitDamp = clamp01(1 - (buys12 - 1) * 0.075);          // many recent buys → less rare
  fRarity = clamp01(fRarity * (0.55 + 0.45 * habitDamp));

  // 5. Cluster — several insiders buying the same issuer in a short window is a
  //    different signal from one person acting alone, and seniority of the group
  //    matters, not just the headcount.
  const cluster = Number(row.cluster_insiders_10d) || 1;
  const fCluster = clamp01(logistic(cluster, 2.6, 1.05)) * (role === 'CEO' || role === 'CFO' ? 1.0 : 0.92);

  // 6. Scale — BLENDED, never purely relative. Judging size only against market cap
  //    inverts real meaning on micro caps: a $20K buy in a shell looks enormous next to
  //    the company while a $10M mega-cap CEO buy looks like a rounding error, and the
  //    first genuinely outscored the second before this blend existed. Absolute dollars
  //    still say something about commitment, and cap-relative says something about
  //    significance to the issuer, so both are counted.
  const cap = Number(opts.marketCap) || 0;
  const fScaleAbs = clamp01(logistic(Math.log10(Math.max(value, 1)), 6.0, 1.0));
  const fScale = cap > 0
    ? clamp01(0.5 * fScaleAbs + 0.5 * clamp01(logistic(Math.log10(Math.max(value / cap, 1e-9)), -3.6, 1.25)))
    : fScaleAbs;

  let raw =
    W.seniority * fSeniority +
    W.sizeVsSelf * fSizeVsSelf +
    W.ownership * fOwnership +
    W.rarity * fRarity +
    W.cluster * fCluster +
    W.scale * fScale;

  // ── Modifiers ─────────────────────────────────────────────────────────────
  // A disclosed 10b5-1 plan means the trade was scheduled in advance, so it is not a
  // fresh read on the business. It is damped hard rather than excluded: the purchase
  // still happened, and the plan itself was a decision once.
  if (row.rule_10b5_1 === true) raw *= 0.62;
  // Explicitly NOT under a plan is affirmative evidence of a discretionary decision.
  else if (row.rule_10b5_1 === false) raw *= 1.06;

  // Indirect ownership (trusts, partnerships) is a weaker personal signal than a
  // direct purchase, but not meaningless.
  if (row.ownership_type === 'I') raw *= 0.93;

  // De-minimis damper. A token purchase cannot express high conviction no matter how
  // flattering its ratios look: a $20K buy lifting a small holding 71% in a shell was
  // reaching VERY HIGH and outranking a $10M mega-cap CEO purchase. This scales the
  // whole result rather than distorting one factor, so relative signals still rank
  // among themselves inside the damped band.
  if (value < DE_MINIMIS) {
    raw *= 0.55 + 0.45 * clamp01(Math.log10(Math.max(value, 1000) / 1000) / Math.log10(DE_MINIMIS / 1000));
  }

  let score = Math.round(clamp01(raw) * 100);
  // Hard ceiling on token purchases. The damper alone still let a $20K buy outrank a
  // $10M one on ratios, which is indefensible on a ranked board however good the
  // ratios are. A sub-threshold purchase can reach HIGH on merit but never VERY HIGH
  // or EXTREME, so the top bands always mean real committed capital.
  if (value < DE_MINIMIS) score = Math.min(score, 74);
  return { score, band: bandFor(score), factors: { role, fSeniority, fSizeVsSelf, fOwnership, fRarity, fCluster, fScale } };
}

// ─── Presentation bands ─────────────────────────────────────────────────────
// Calibrate against the real distribution once the backfill lands.
export function bandFor(score) {
  if (score == null) return null;
  if (score >= 90) return 'EXTREME';
  if (score >= 75) return 'VERY HIGH';
  if (score >= 60) return 'HIGH';
  if (score >= 40) return 'MODERATE';
  return 'LOW';
}

// ─── Approved public tags ───────────────────────────────────────────────────
// These explain WHY something scored well WITHOUT revealing how. Every tag is a
// restatement of a fact already visible in the filing — never a weight, a factor
// value, or a threshold.
//
// `historyLabel` comes from insider_history_meta.covered_from so wording can never
// outrun the data: with 3 years stored we say "IN 3-YEAR HISTORY", never "EVER".
export function convictionTags(row, person, historyLabel = 'AVAILABLE HISTORY') {
  if (!isConvictionEligible(row)) return [];
  const tags = [];
  const role = roleOf(row);

  if (role === 'CEO') tags.push('CEO PURCHASE');
  else if (role === 'CFO') tags.push('CFO PURCHASE');
  else if (role === 'CHAIR') tags.push('CHAIR PURCHASE');

  const gap = Number(row.months_since_prev_buy);
  if (row.is_first_om_buy) tags.push(`FIRST OPEN-MARKET BUY IN ${historyLabel}`);
  else if (Number.isFinite(gap) && gap >= 6) tags.push(`FIRST BUY IN ${Math.round(gap)} MONTHS`);

  const ownPct = Number(row.ownership_increase_pct);
  if (Number.isFinite(ownPct) && ownPct >= 5) {
    tags.push(`OWNERSHIP +${ownPct >= 100 ? Math.round(ownPct) : ownPct.toFixed(ownPct < 10 ? 1 : 0)}%`);
  }

  const cluster = Number(row.cluster_insiders_10d) || 0;
  if (cluster >= 3) tags.push(`${cluster} INSIDERS BUYING`);

  // "Unusually large" is stated only when there is enough of this person's own history
  // for the comparison to mean anything.
  const median = Number(person?.om_buy_median) || 0;
  const count = Number(person?.om_buy_count) || 0;
  if (median > 0 && count >= 3 && Number(row.total_value) >= median * 3) {
    tags.push(`UNUSUALLY LARGE VS ${historyLabel}`);
  }

  // Ordinal counts ("13TH BUY IN 12 MONTHS") read as noise on a public board and get
  // worse the higher they climb, so the public tag stays qualitative. The underlying
  // counts remain available in om_buys_* for filtering and for the score itself.
  const buys12 = Number(row.om_buys_12m) || 0;
  if (buys12 >= 4) tags.push('BUYING REPEATEDLY');
  else if (row.is_repeat_buyer && buys12 >= 2) tags.push('REPEAT BUYER');

  if (row.rule_10b5_1 === false) tags.push('DISCRETIONARY');
  else if (row.rule_10b5_1 === true) tags.push('10b5-1 PLAN');

  return tags;
}

// ─── The ONLY shape allowed to leave the server ─────────────────────────────
// Callers must project through this. It cannot leak internals because it builds a
// fresh object from an explicit allow-list rather than deleting fields from one.
export function toPublicConviction(scored, tags) {
  if (!scored || scored.score == null) return null;
  return { score: scored.score, band: scored.band, tags: Array.isArray(tags) ? tags.slice(0, 6) : [] };
}
