// EVIDENCE RESOLUTION — turning our own public-filing tables into the four family values.
//
// This is the only part of Pit Consensus that touches the database. consensus-v1.mjs stays pure so
// the methodology can be tested and recomputed without fixtures; everything vendor-, schema- and
// PIT-specific lives here.
//
// ── POINT-IN-TIME IS THE WHOLE JOB ──────────────────────────────────────────
//
// Every family windows on the date the evidence BECAME PUBLIC, never the date the economic event
// happened. Those differ by days for a Form 4, by weeks for Congress and by months for a 13F, and
// using the economic date reads the future.
//
//   Form 4    filing_date       — the SEC publication, not transaction_date
//   Congress  disclosure_date   — under the STOCK Act a member may disclose up to 45 days later;
//                                 measured on our own data the median lag is 28 days and 17.6%
//                                 exceed 90. This is enforced by withinInformationWindow().
//   13F       filed_date        — and the quarter end is carried separately, because a filing
//                                 published yesterday describes a position up to ~135 days old
//   8-K       filed_at
//
// ── NOTHING HERE READS A PRICE ──────────────────────────────────────────────
//
// No quote, no return, no volume, no Tiingo. Consensus must stay market-price independent so Pit
// Scan can later join it against market reaction — a divergence board is only meaningful if the
// evidence side has not already seen the price.

import { sql } from 'drizzle-orm';
import { db } from '../db';
import { familyValue, decayFreshness, institutionsFreshness, CONSTANTS } from './consensus-v1.mjs';

const DAY_MS = 86_400_000;
const ageDays = (d, now) => (d == null ? null : Math.max(0, (now - new Date(d).getTime()) / DAY_MS));
const rows = (res) => res?.rows ?? res ?? [];
// Saturating magnitude: 0 at none, approaching 1 as n grows, never reaching it. Used wherever "more
// is stronger but the tenth is worth less than the second" — which is every count here.
const saturate = (n, k) => (n > 0 ? 1 - Math.exp(-n / k) : 0);

// ── 1. INSIDERS (Form 4) ─────────────────────────────────────────────────────
/**
 * ⚠️ SELLING IS NOT THE MIRROR OF BUYING, and treating it as one is the classic error.
 *
 * An insider buys for one reason. An insider sells for many — diversification, tax, a house, a
 * pre-scheduled 10b5-1 plan filed months earlier. So purchases carry more directional information
 * per dollar, routine sales are heavily discounted, and only clustered non-routine selling is
 * allowed to produce a strong bearish reading.
 *
 * `rule_10b5_1` is the discriminator when present: a plan sale was decided before whatever is
 * happening now, and says little about today.
 */
export async function insiderEvidence(ticker, now) {
  const windowDays = CONSTANTS.activationWindowDays.insiders;
  const res = await db.execute(sql`
    select action, transaction_code, total_value, executive, filing_date, accession,
           coalesce(rule_10b5_1, false) as planned,
           coalesce(is_officer, false) as officer, coalesce(is_director, false) as director
      from insider_trades
     where ticker = ${ticker}
       and filing_date >= (current_date - make_interval(days => ${windowDays}))
       and total_value > 0
     order by filing_date desc
     limit 400`);
  const r = rows(res);
  if (!r.length) return familyValue({ family: 'insiders', evidenceCount: 0 });

  const buys = r.filter((x) => x.action === 'BUY');
  const sells = r.filter((x) => x.action === 'SELL');
  const routineSells = sells.filter((x) => x.planned);
  const discretionarySells = sells.filter((x) => !x.planned);

  const buyers = new Set(buys.map((x) => x.executive)).size;
  const sellers = new Set(discretionarySells.map((x) => x.executive)).size;
  const buyValue = buys.reduce((s, x) => s + Number(x.total_value || 0), 0);
  const discSellValue = discretionarySells.reduce((s, x) => s + Number(x.total_value || 0), 0);

  // A routine sale still counts, at a fraction — it is real evidence, just weak directional
  // evidence, and zeroing it entirely would be its own distortion.
  const ROUTINE_WEIGHT = 0.15;
  const routineSellValue = routineSells.reduce((s, x) => s + Number(x.total_value || 0), 0) * ROUTINE_WEIGHT;

  const bullWeight = buyValue * 1.0;
  const bearWeight = discSellValue * 0.55 + routineSellValue;   // a sold dollar says less than a bought one
  const total = bullWeight + bearWeight;
  if (total <= 0) return familyValue({ family: 'insiders', evidenceCount: 0 });

  const D = (bullWeight - bearWeight) / total;
  // Breadth first, then size. Four buyers at $50k each is stronger evidence than one at $200k.
  const breadth = saturate(buyers + sellers, 3);
  const size = saturate(total / 1_000_000, 1.5);
  const S = Math.min(1, 0.6 * breadth + 0.4 * size);

  const newest = r.reduce((m, x) => Math.max(m, new Date(x.filing_date).getTime()), 0);
  const F = decayFreshness(ageDays(newest, now), CONSTANTS.halfLifeDays.insiders);
  // Form 4 is a signed filing with a known filer — the highest-quality evidence we hold. Officer or
  // director attribution raises it further, since a named executive's own account is the clearest
  // version of this signal.
  const attributed = r.some((x) => x.officer || x.director);
  const Q = attributed ? 0.95 : 0.85;

  const reasons = [];
  if (buyers > 0) reasons.push(`${buyers} insider${buyers > 1 ? 's' : ''} purchased shares in the last ${windowDays} days`);
  if (buyers >= 3) reasons.push('Cluster buying across multiple insiders');
  if (discretionarySells.length) reasons.push(`${sellers} insider${sellers > 1 ? 's' : ''} sold outside a 10b5-1 plan`);
  if (routineSells.length && !discretionarySells.length) reasons.push(`${routineSells.length} sale${routineSells.length > 1 ? 's' : ''} under a pre-scheduled 10b5-1 plan (routine)`);

  return familyValue({
    family: 'insiders', direction: D, strength: S, freshness: F, quality: Q,
    evidenceCount: r.length,
    state: D > 0.2 ? 'bullish' : D < -0.2 ? 'bearish' : 'mixed',
    trend: insiderTrend(r, now),
    reasons,
    refs: [...new Set(r.map((x) => x.accession).filter(Boolean))].slice(0, 12),
    dates: { latestFiling: r[0]?.filing_date ?? null },
  });
}

/** Descriptive metadata, never another score: is recent activity building or fading? */
function insiderTrend(r, now) {
  const half = CONSTANTS.activationWindowDays.insiders / 2;
  const recent = r.filter((x) => ageDays(x.filing_date, now) <= half);
  const older = r.filter((x) => ageDays(x.filing_date, now) > half);
  const recentBuyers = new Set(recent.filter((x) => x.action === 'BUY').map((x) => x.executive)).size;
  const olderBuyers = new Set(older.filter((x) => x.action === 'BUY').map((x) => x.executive)).size;
  if (recentBuyers >= 3 && olderBuyers === 0) return 'new-cluster';
  if (recentBuyers > olderBuyers) return 'strengthening';
  if (recentBuyers < olderBuyers) return 'weakening';
  return 'stable';
}

// ── 2. INSTITUTIONS (13F) ────────────────────────────────────────────────────
/**
 * BREADTH OVER DOLLARS, deliberately.
 *
 * One enormous manager adding a position moves more dollars than forty small managers adding
 * theirs, but forty managers independently reaching the same conclusion is the stronger evidence.
 * Counting managers rather than dollars also keeps a single index fund's mechanical rebalance from
 * dominating the family.
 */
export async function institutionEvidence(ticker, now) {
  const res = await db.execute(sql`
    with q as (
      select max(quarter) as cur from fund_holdings where ticker = ${ticker}
    ),
    prev as (
      select max(quarter) as p from fund_holdings
       where ticker = ${ticker} and quarter < (select cur from q)
    ),
    per_fund as (
      select cik,
             sum(case when quarter = (select cur from q) then shares else 0 end) as cur_sh,
             sum(case when quarter = (select p from prev) then shares else 0 end) as prev_sh
        from fund_holdings
       where ticker = ${ticker}
         and quarter in ((select cur from q), (select p from prev))
         and put_call = ''
       group by cik
    )
    select (select cur from q)::text as quarter_end,
           (select max(filed_date) from fund_filings f
             where f.quarter = (select cur from q))::text as disclosed_at,
           count(*) filter (where cur_sh > prev_sh)::int as increased,
           count(*) filter (where cur_sh < prev_sh and cur_sh > 0)::int as reduced,
           count(*) filter (where prev_sh = 0 and cur_sh > 0)::int as initiated,
           count(*) filter (where cur_sh = 0 and prev_sh > 0)::int as exited,
           count(*) filter (where cur_sh > 0)::int as holders
      from per_fund`);
  const r = rows(res)[0];
  if (!r || !r.quarter_end || !Number(r.holders)) return familyValue({ family: 'institutions', evidenceCount: 0 });

  const increased = Number(r.increased) || 0, reduced = Number(r.reduced) || 0;
  const initiated = Number(r.initiated) || 0, exited = Number(r.exited) || 0;
  const holders = Number(r.holders) || 0;

  const bull = increased + initiated;
  const bear = reduced + exited;
  const movers = bull + bear;
  if (!movers) return familyValue({ family: 'institutions', evidenceCount: 0 });

  const D = (bull - bear) / movers;
  // Breadth of managers who MOVED, and how much of the holder base that represents.
  const S = Math.min(1, 0.65 * saturate(movers, 25) + 0.35 * Math.min(1, movers / Math.max(1, holders)));

  const qEndAge = ageDays(r.quarter_end, now);
  const F = institutionsFreshness({ quarterEndAgeDays: qEndAge });
  // A 13F is a signed quarterly filing: reliable about what it reports, and stale by construction.
  // The staleness is disclosed through the dates rather than discounted through Q.
  const Q = 0.85;

  const reasons = [];
  if (bull > bear) reasons.push(`${increased} manager${increased === 1 ? '' : 's'} increased and ${initiated} initiated positions in the latest reported quarter`);
  if (bear > bull) reasons.push(`${reduced} manager${reduced === 1 ? '' : 's'} reduced and ${exited} exited positions in the latest reported quarter`);
  if (bull === bear) reasons.push('Institutional accumulation and reduction were balanced in the latest reported quarter');

  return familyValue({
    family: 'institutions', direction: D, strength: S, freshness: F, quality: Q,
    evidenceCount: movers,
    state: D > 0.2 ? 'accumulating' : D < -0.2 ? 'distributing' : 'mixed',
    trend: initiated > exited ? 'accumulating' : exited > initiated ? 'distributing' : 'stable',
    reasons,
    refs: [],
    // BOTH DATES SURVIVE, and the UI is required to show them: "as of quarter ended Mar 31,
    // disclosed May 15". Reporting only the filing date would imply live positioning.
    dates: { quarterEnd: r.quarter_end, disclosedAt: r.disclosed_at, quarterEndAgeDays: qEndAge == null ? null : Math.round(qEndAge) },
  });
}

// ── 3. CONGRESS ──────────────────────────────────────────────────────────────
export async function congressEvidence(ticker, now) {
  const windowDays = CONSTANTS.activationWindowDays.congress;
  const res = await db.execute(sql`
    select action, amount_mid, member_slug, disclosure_date, transaction_date
      from congress_trades
     where ticker = ${ticker}
       and disclosure_date >= (current_date - make_interval(days => ${windowDays}))
     order by disclosure_date desc
     limit 200`);
  const r = rows(res);
  if (!r.length) return familyValue({ family: 'congress', evidenceCount: 0 });

  const buys = r.filter((x) => x.action === 'BUY');
  const sells = r.filter((x) => x.action === 'SELL');
  const buyVal = buys.reduce((s, x) => s + Number(x.amount_mid || 0), 0);
  const sellVal = sells.reduce((s, x) => s + Number(x.amount_mid || 0), 0);
  const actors = new Set(r.map((x) => x.member_slug).filter(Boolean)).size;
  const total = buyVal + sellVal;
  if (total <= 0) return familyValue({ family: 'congress', evidenceCount: 0 });

  const D = (buyVal - sellVal) / total;
  // INDEPENDENT ACTORS ARE THE POINT. One member selling once is an anecdote; five members moving
  // the same way is evidence. Capping the single-actor case is what stops an isolated sale from
  // becoming a bearish thesis.
  const breadth = saturate(actors, 2.5);
  const size = saturate(total / 500_000, 1.5);
  const S = Math.min(1, (actors <= 1 ? 0.35 : 1) * (0.7 * breadth + 0.3 * size));

  const newest = r.reduce((m, x) => Math.max(m, new Date(x.disclosure_date).getTime()), 0);
  const F = decayFreshness(ageDays(newest, now), CONSTANTS.halfLifeDays.congress);
  // Self-reported, in wide amount bands, often long after the fact — genuine public evidence, and
  // the least precise of the four.
  const Q = 0.6;

  const reasons = [];
  if (buys.length && sells.length) reasons.push(`Congressional activity is mixed — ${buys.length} purchase${buys.length === 1 ? '' : 's'} and ${sells.length} sale${sells.length === 1 ? '' : 's'} disclosed`);
  else if (buys.length) reasons.push(`${actors} member${actors === 1 ? '' : 's'} of Congress disclosed purchases`);
  else if (sells.length) reasons.push(`${actors} member${actors === 1 ? '' : 's'} of Congress disclosed sales`);

  return familyValue({
    family: 'congress', direction: D, strength: S, freshness: F, quality: Q,
    evidenceCount: r.length,
    state: D > 0.2 ? 'bullish' : D < -0.2 ? 'bearish' : 'mixed',
    trend: actors > 1 ? 'multiple-actors' : 'single-actor',
    reasons,
    refs: [],
    dates: { latestDisclosure: r[0]?.disclosure_date ?? null, latestTransaction: r[0]?.transaction_date ?? null },
  });
}

// ── 4. CATALYSTS ─────────────────────────────────────────────────────────────
/**
 * Only structured evidence we can classify. 8-K item codes are the canonical case: they are the
 * SEC's own taxonomy, not a publisher's opinion.
 *
 * ⚠️ NO HEADLINE POLARITY. Raw publisher sentiment is not evidence — it is someone else's reading of
 * evidence, with no accountability and no consistent taxonomy. An 8-K we cannot classify becomes an
 * UNKNOWN catalyst, and an unknown catalyst is inactive rather than neutral: averaging "we do not
 * know" into a direction is how a reading acquires false confidence.
 */
const ITEM_DIRECTION = Object.freeze({
  '1.01': +0.4,   // entry into a material agreement
  '2.02': 0,      // results of operations — direction depends on content we do not parse
  '5.02': -0.2,   // departure/appointment of officers
  '1.02': -0.4,   // termination of a material agreement
  '2.04': -0.5,   // triggering of a direct financial obligation
  '4.01': -0.5,   // change in certifying accountant
  '4.02': -0.8,   // non-reliance on previously issued financials
  '3.01': -0.6,   // delisting notice / failure to satisfy listing rules
  '8.01': 0,      // other events — deliberately neutral, it is a catch-all
});

export async function catalystEvidence(ticker, now) {
  const windowDays = CONSTANTS.activationWindowDays.catalysts;
  const res = await db.execute(sql`
    select items, material, filed_at, accession, report_date
      from eightk_filings
     where ticker = ${ticker}
       and filed_at >= (now() - make_interval(days => ${windowDays}))
     order by filed_at desc
     limit 40`);
  const r = rows(res);
  if (!r.length) return familyValue({ family: 'catalysts', evidenceCount: 0 });

  let weighted = 0, mass = 0, classified = 0;
  for (const f of r) {
    const codes = String(f.items || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    const known = codes.map((c) => ITEM_DIRECTION[c]).filter((v) => v !== undefined);
    if (!known.length) continue;                       // unclassifiable → contributes nothing
    classified += 1;
    const dir = known.reduce((s, v) => s + v, 0) / known.length;
    // Each filing decays on its own age, so one fresh 8-K is not diluted by a fortnight-old one.
    const w = decayFreshness(ageDays(f.filed_at, now), CONSTANTS.halfLifeDays.catalysts) * (f.material ? 1 : 0.5);
    weighted += dir * w;
    mass += Math.abs(w);
  }
  // Every filing was a catch-all or an unknown code: real filings, no classifiable direction.
  if (!classified || mass <= 0) return familyValue({ family: 'catalysts', evidenceCount: 0 });

  const D = Math.max(-1, Math.min(1, weighted / mass));
  const anyMaterial = r.some((f) => f.material);
  // MATERIALITY AND QUALITY STILL MATTER — freshness alone must never push |E| to 1.
  const S = Math.min(1, (anyMaterial ? 0.7 : 0.4) * saturate(classified, 2));
  const newest = r.reduce((m, f) => Math.max(m, new Date(f.filed_at).getTime()), 0);
  const F = decayFreshness(ageDays(newest, now), CONSTANTS.halfLifeDays.catalysts);
  const Q = 0.9;   // SEC item codes — structured and authoritative, though coarse about direction

  return familyValue({
    family: 'catalysts', direction: D, strength: S, freshness: F, quality: Q,
    evidenceCount: classified,
    state: D > 0.2 ? 'positive' : D < -0.2 ? 'negative' : 'mixed',
    trend: ageDays(newest, now) <= 2 ? 'fresh' : 'fading',
    reasons: [`${classified} classifiable 8-K filing${classified === 1 ? '' : 's'} in the last ${windowDays} days`],
    refs: [...new Set(r.map((f) => f.accession).filter(Boolean))].slice(0, 12),
    dates: { latestFiling: r[0]?.filed_at ?? null },
  });
}

/** All four families for one ticker, resolved independently and in parallel. */
export async function resolveEvidence(ticker, { now = Date.now() } = {}) {
  const t = String(ticker || '').toUpperCase().trim();
  if (!t) return [];
  const settled = await Promise.allSettled([
    insiderEvidence(t, now), institutionEvidence(t, now), congressEvidence(t, now), catalystEvidence(t, now),
  ]);
  const names = ['insiders', 'institutions', 'congress', 'catalysts'];
  // A family whose query fails is INACTIVE with a recorded reason — never silently absent, and never
  // defaulted to neutral. One broken query must not quietly change the reading.
  return settled.map((s, i) => (s.status === 'fulfilled'
    ? s.value
    : { family: names[i], active: false, inactiveReason: 'resolution-error', D: null, S: null, F: null, Q: null, E: null, state: 'error', trend: null, evidenceCount: 0, reasons: [], refs: [], dates: {} }));
}
