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
/**
 * ⚠️ ONE CORRUPT FILING USED TO DECIDE THE WHOLE FAMILY.
 *
 * Measured in production, `insider_trades.total_value` carries values that cannot be real:
 *
 *     SCKT  $177,777,600,000  on a microcap        (median insider buy is $36,338)
 *     CRWV  $253,022,580,000  of "discretionary selling"
 *
 * Strength is `saturate(total / 1_000_000, 1.5)`, so a single bad row pins S to 1.0, and D is
 * whatever that row's side happens to be. The board then publishes a maximum-confidence reading
 * built on a parsing error.
 *
 * ⚠️ THE CEILING IS NOT A NEW CONSTANT. $50M is `dollarWeight`'s existing ceiling in
 * evidence-model.mjs — the value this codebase already treats as "as large as a transaction can
 * meaningfully be" when scoring significance. Reusing it means there is one definition of a very
 * large insider transaction rather than two that can drift.
 *
 * Winsorising rather than dropping is deliberate: a genuine $80M purchase is real evidence and
 * should not vanish, it simply must not count for eighty times a $1M one. Above the ceiling the
 * differences stop being informative anyway.
 */
export const TXN_VALUE_CEILING = 50_000_000;
const txnValue = (x) => Math.min(Number(x?.total_value || 0), TXN_VALUE_CEILING);

/**
 * The share of observed insider dollars that reflects a CHOICE made now, rather than a plan filed
 * months ago or a tax withholding. Below this, no direction is readable. See the worked measurement
 * at the guard itself.
 */
export const MIN_DISCRETIONARY_SHARE = 0.25;

/**
 * CAN A DIRECTION BE READ FROM THIS INSIDER ACTIVITY AT ALL?
 *
 * Pure, and separated from the query so the rule can be exercised with numbers rather than only
 * against the database — the same reason intradayRowReturn() was lifted out of the heatmap store.
 * A guard that can only be tested by round-tripping Postgres does not get tested.
 *
 * @returns { readable, discretionaryShare } — `readable` false means the activity is real but
 *          carries no view, so the family reports `routine-sale` and a direction of zero.
 */
export function directionReadable({ buyValue = 0, discSellValue = 0, routineValue = 0 } = {}) {
  const disc = Math.max(0, Number(buyValue) || 0) + Math.max(0, Number(discSellValue) || 0);
  const observed = disc + Math.max(0, Number(routineValue) || 0);
  const discretionaryShare = observed > 0 ? disc / observed : 0;
  return { readable: discretionaryShare >= MIN_DISCRETIONARY_SHARE, discretionaryShare };
}


export async function insiderEvidence(ticker, now, ctx = null) {
  const windowDays = CONSTANTS.activationWindowDays.insiders;
  // ⚠️ SAME ROWS, FETCHED ONCE FOR THE WHOLE CHUNK. See consensus/build-context.mjs. A null means
  // "not preloaded" and falls through to the query below; an empty array means "preloaded, none".
  const pre = ctx?.rows('consensus.insider', ticker);
  const res = pre ?? await db.execute(sql`
    select action, transaction_code, total_value, executive, filing_date, accession,
           coalesce(rule_10b5_1, false) as planned,
           coalesce(is_officer, false) as officer, coalesce(is_director, false) as director
      from insider_trades
     where ticker = ${ticker}
       and filing_date >= (current_date - make_interval(days => ${windowDays}))
       and total_value > 0
     order by filing_date desc, accession desc, id desc
     limit 400`);
  const r = rows(res);
  if (!r.length) return familyValue({ family: 'insiders', evidenceCount: 0 });

  const buys = r.filter((x) => x.action === 'BUY');
  const sells = r.filter((x) => x.action === 'SELL');
  const routineSells = sells.filter((x) => x.planned);
  const discretionarySells = sells.filter((x) => !x.planned);

  const buyers = new Set(buys.map((x) => x.executive)).size;
  const sellers = new Set(discretionarySells.map((x) => x.executive)).size;
  const buyValue = buys.reduce((s, x) => s + txnValue(x), 0);
  const discSellValue = discretionarySells.reduce((s, x) => s + txnValue(x), 0);

  // A routine sale still counts, at a fraction — it is real evidence, just weak directional
  // evidence, and zeroing it entirely would be its own distortion.
  const ROUTINE_WEIGHT = 0.15;
  const rawRoutineValue = routineSells.reduce((s, x) => s + txnValue(x), 0);
  const routineSellValue = rawRoutineValue * ROUTINE_WEIGHT;

  const bullWeight = buyValue * 1.0;
  const bearWeight = discSellValue * 0.55 + routineSellValue;   // a sold dollar says less than a bought one
  const total = bullWeight + bearWeight;
  if (total <= 0) return familyValue({ family: 'insiders', evidenceCount: 0 });

  // ⚠️ A PRE-SCHEDULED SALE IS NOT A BEARISH OPINION, AND THE ARITHMETIC USED TO SAY IT WAS.
  //
  // D = (bull - bear) / total returns exactly -1.0 whenever there are NO BUYS, however routine the
  // selling is — the ROUTINE_WEIGHT above discounts a plan sale's MAGNITUDE and never its
  // DIRECTION. Measured on the live board, that put five of thirteen bearish insider readings on
  // companies whose selling was overwhelmingly pre-scheduled:
  //
  //     AAPL   $0.00M discretionary   $2.72M planned    0.0% → read "bearish"
  //     JPM    $0.00M discretionary   $1.79M planned    0.0% → read "bearish"
  //     ENVA   $0.00M discretionary  $14.78M planned    0.0% → read "bearish"
  //     ADI    $0.00M discretionary  $16.58M planned    0.0% → read "bearish"
  //     MSFT   $7.27M discretionary  $64.15M planned   10.2% → read "bearish"
  //
  // Apple and JPMorgan were marked bearish on ZERO discretionary selling. Executives at large
  // companies sell every quarter under plans filed months earlier and through tax withholding;
  // reading that as a view on the business is the exact error this file's own header warns about
  // ("an insider sells for many reasons — diversification, tax, a house, a pre-scheduled 10b5-1
  // plan filed months earlier").
  //
  // ⚠️ THE THRESHOLD IS MEASURED, NOT PICKED. Across the same thirteen rows the discretionary
  // share was 0.0%, 0.0%, 0.0%, 0.0% and 10.2% for the false readings, and 88.1%, 99.8%, 100%,
  // 100%, 100%, 100%, 100%, 100% for the genuine ones. There is an empty band between 10.2% and
  // 88.1%, and 25% sits in the middle of it — so the cut does not depend on where in that gap it
  // is placed.
  //
  // It is a symmetric guard, not an anti-sell rule: a token purchase beside a large scheduled
  // disposal fails it too, which is correct — that is not a bullish opinion either.
  const { readable, discretionaryShare } =
    directionReadable({ buyValue, discSellValue, routineValue: rawRoutineValue });

  // ⚠️ DIRECTIONLESS, NOT ABSENT. The family stays ACTIVE and keeps its strength and freshness, so
  // the card can still say "seven insiders sold, all under pre-scheduled plans" — which is a real
  // and useful fact. Only the DIRECTION is withheld, because that is the only part the data cannot
  // support. Marking it inactive would delete evidence we hold; `routine-sale` is already in
  // synthesis.mjs's NEUTRAL set, so it counts toward coverage and toward neither side.
  const D = readable ? (bullWeight - bearWeight) / total : 0;
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
  // ⚠️ SAY WHY THE DIRECTION IS MISSING. A blank where a reading used to be invites the reader to
  // assume we found nothing; the honest statement is that we found activity and it does not carry
  // a view.
  if (!readable) {
    reasons.unshift(`${Math.round((1 - discretionaryShare) * 100)}% of insider dollars here are pre-scheduled or tax-related — no direction can be read from them`);
  }

  return familyValue({
    family: 'insiders', direction: D, strength: S, freshness: F, quality: Q,
    evidenceCount: r.length,
    state: !readable ? 'routine-sale' : D > 0.2 ? 'bullish' : D < -0.2 ? 'bearish' : 'mixed',
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
export async function institutionEvidence(ticker, now, ctx = null) {
  const pre = ctx?.rows('consensus.institution', ticker);
  const res = pre ?? await db.execute(sql`
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

  // ── THE REASON MUST EXPLAIN THE STATE IT SITS BESIDE ──
  //
  // This reported only the winning side whenever bull > bear, including when the net was well inside
  // the mixed band. So a near-balanced quarter printed "Institutions: Mixed" above "3,324 managers
  // increased and 269 initiated positions" — a one-sided fact that reads bullish, directly under a
  // label saying it was not. When the state is mixed, BOTH sides are stated, because that is what
  // made it mixed.
  const state = D > 0.2 ? 'accumulating' : D < -0.2 ? 'distributing' : 'mixed';
  const upSide = `${increased} manager${increased === 1 ? '' : 's'} increased and ${initiated} initiated`;
  const downSide = `${reduced} reduced and ${exited} exited`;
  const asOf = 'in the latest reported quarter';
  const reasons = [];
  if (state === 'accumulating') reasons.push(`${upSide} positions ${asOf}`);
  else if (state === 'distributing') reasons.push(`${reduced} manager${reduced === 1 ? '' : 's'} reduced and ${exited} exited positions ${asOf}`);
  else reasons.push(`${upSide} positions, against ${downSide}, ${asOf}`);

  return familyValue({
    family: 'institutions', direction: D, strength: S, freshness: F, quality: Q,
    evidenceCount: movers,
    state,
    trend: initiated > exited ? 'accumulating' : exited > initiated ? 'distributing' : 'stable',
    reasons,
    refs: [],
    // BOTH DATES SURVIVE, and the UI is required to show them: "as of quarter ended Mar 31,
    // disclosed May 15". Reporting only the filing date would imply live positioning.
    dates: { quarterEnd: r.quarter_end, disclosedAt: r.disclosed_at, quarterEndAgeDays: qEndAge == null ? null : Math.round(qEndAge) },
  });
}

// ── 3. CONGRESS ──────────────────────────────────────────────────────────────
export async function congressEvidence(ticker, now, ctx = null) {
  const windowDays = CONSTANTS.activationWindowDays.congress;
  const pre = ctx?.rows('consensus.congress', ticker);
  const res = pre ?? await db.execute(sql`
    select action, amount_mid, member_slug, disclosure_date, transaction_date
      from congress_trades
     where ticker = ${ticker}
       and disclosure_date >= (current_date - make_interval(days => ${windowDays}))
     order by disclosure_date desc, id desc
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

  // ── THE REASON MUST EXPLAIN THE STATE IT SITS BESIDE ──
  //
  // This previously said "Congressional activity is mixed" whenever both purchases and sales
  // existed, while the STATE came from the dollar-weighted net. So KO read "Congress: Bullish" with
  // "activity is mixed" printed directly underneath it — the explanation contradicting the label it
  // was meant to justify. In a product whose entire claim is explainability, that is the worst
  // possible defect: a reader who checks the reasoning is punished for doing so.
  //
  // The counts and the direction are now stated together, so a net-bullish reading with sales in it
  // says exactly that, and the reader can see both facts that produced the state.
  const state = D > 0.2 ? 'bullish' : D < -0.2 ? 'bearish' : 'mixed';
  const counts = `${buys.length} purchase${buys.length === 1 ? '' : 's'} and ${sells.length} sale${sells.length === 1 ? '' : 's'} disclosed`;
  const reasons = [];
  if (buys.length && sells.length) {
    reasons.push(state === 'mixed'
      ? `Congressional activity is mixed — ${counts}`
      : `${counts}; the larger dollar value was on the ${state === 'bullish' ? 'buy' : 'sell'} side`);
  } else if (buys.length) reasons.push(`${actors} member${actors === 1 ? '' : 's'} of Congress disclosed purchases`);
  else if (sells.length) reasons.push(`${actors} member${actors === 1 ? '' : 's'} of Congress disclosed sales`);

  return familyValue({
    family: 'congress', direction: D, strength: S, freshness: F, quality: Q,
    evidenceCount: r.length,
    state,
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

export async function catalystEvidence(ticker, now, ctx = null) {
  const windowDays = CONSTANTS.activationWindowDays.catalysts;
  const pre = ctx?.rows('consensus.catalyst', ticker);
  const res = pre ?? await db.execute(sql`
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

/**
 * MARKET STRUCTURE — the price evidence, carried as its own family.
 *
 * ⚠️ IT IS NOT A WEIGHTED INPUT. It contributes a STATE and the facts behind it, exactly like every
 * other family, and the synthesis never multiplies or sums it against them. The direction/strength
 * fields exist only so this family has the same shape as the others; nothing downstream aggregates
 * them any more.
 *
 * The state words are the engine's own, post-correction: a confirmed higher-high/higher-low
 * SEQUENCE, not a claim that a trend is currently running. Measured over 112,620 point-in-time
 * samples, that reading is accurate about the window it is derived from and a coin flip about the
 * window it is displayed over — so it is reported as confirmed structure and nothing more.
 *
 * DAILY is used. Weekly is carried as a supporting fact rather than a second vote, because two
 * timeframes of the same price series are not two independent families and counting them twice
 * would be the weighting error this redesign exists to remove.
 */
export async function structureEvidence(ticker, now, ctx = null) {
  const { tickerStructure } = await import('../structure/structure-data.js');
  const s = await tickerStructure(ticker, { ctx }).catch(() => null);
  if (!s || !s.available || !s.daily?.available) {
    return familyValue({ family: 'structure', evidenceCount: 0 });
  }

  const STATE = { uptrend: 'higher-highs-and-lows', downtrend: 'lower-highs-and-lows', range: 'no-clear-sequence' };
  const state = STATE[s.daily.trend] || 'no-clear-sequence';
  if (!STATE[s.daily.trend]) {
    // insufficient-history and anything unrecognised are INACTIVE, never silently "no clear
    // sequence" — an engine that could not read the series has not said the series is neutral.
    if (s.daily.trend !== 'range') return familyValue({ family: 'structure', evidenceCount: 0 });
  }

  const reasons = [];
  for (const r of (s.daily.trendReasons || []).slice(0, 2)) reasons.push(`Daily: ${r}`);
  if (s.weekly?.available && s.weekly.trend) {
    reasons.push(`Weekly structure reads ${String(s.weekly.trend).replace(/-/g, ' ')}`);
  }
  if (s.daily.structuralDisruption?.note) reasons.push(s.daily.structuralDisruption.note);
  if (Number.isFinite(s.daily.priceSincePivotPct) && s.daily.trendAsOfPivot) {
    reasons.push(`${s.daily.priceSincePivotPct >= 0 ? '+' : ''}${s.daily.priceSincePivotPct}% since the `
      + `${s.daily.trendAsOfPivot} pivot this structure was confirmed on`);
  }

  return familyValue({
    family: 'structure',
    direction: state === 'higher-highs-and-lows' ? 1 : state === 'lower-highs-and-lows' ? -1 : 0,
    strength: 1, freshness: 1,
    // Quality is high because this is computed from our own point-in-time engine over price data we
    // hold, not inferred from a third party.
    quality: 0.95,
    evidenceCount: Number(s.daily.swings?.count) || 0,
    state,
    trend: s.weekly?.available ? `weekly-${s.weekly.trend}` : null,
    reasons,
    refs: [],
    dates: { confirmedOn: s.daily.trendAsOfPivot ?? null, priceDate: s.priceDate ?? null },
  });
}

/** All families for one ticker, resolved independently and in parallel. */
export async function resolveEvidence(ticker, { now = Date.now(), ctx = null } = {}) {
  const t = String(ticker || '').toUpperCase().trim();
  if (!t) return [];
  // ⚠️ ctx IS DATA ACCESS ONLY. Each family below receives the same rows it would have queried for
  // itself; every calculation, window and threshold is untouched. See consensus/build-context.mjs.
  const settled = await Promise.allSettled([
    insiderEvidence(t, now, ctx), institutionEvidence(t, now, ctx), congressEvidence(t, now, ctx),
    catalystEvidence(t, now, ctx),
    structureEvidence(t, now, ctx),
  ]);
  // Must stay aligned with the Promise.allSettled order above — a mismatch would label a failed
  // family as the wrong one, which is worse than reporting nothing.
  const names = ['insiders', 'institutions', 'congress', 'catalysts', 'structure'];
  // A family whose query fails is INACTIVE with a recorded reason — never silently absent, and never
  // defaulted to neutral. One broken query must not quietly change the reading.
  return settled.map((s, i) => (s.status === 'fulfilled'
    ? s.value
    : { family: names[i], active: false, inactiveReason: 'resolution-error', D: null, S: null, F: null, Q: null, E: null, state: 'error', trend: null, evidenceCount: 0, reasons: [], refs: [], dates: {} }));
}
