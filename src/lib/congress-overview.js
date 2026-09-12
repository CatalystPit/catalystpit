// src/lib/congress-overview.js
//
// The three Congress discovery modules, plus the shared "Best Traders" ranking they and
// /api/politicians both use.
//
// leaderboardView lives HERE rather than inside a route so the Politicians page and the new
// overview cannot drift apart. A second copy of a scoring method is how the Form 4 parser ended
// up with two divergent implementations, and it is not a mistake worth repeating.
//
// Every window is bounded by the 3-year cap from lib/congress-chart.mjs.

import { db } from './db';
import { congressTrades, congressTickerPrices } from './schema';
import { and, eq, sql, desc } from 'drizzle-orm';
import { MAX_HISTORY_DAYS } from './congress-chart.mjs';

export const LB_WINDOWS = { '30d': '30 days', '3m': '3 months', '6m': '6 months', '1y': '1 year', '2y': '2 years', '3y': '3 years' };
export const LB_WEIGHT_CAP = 0.30;   // no single position counts for more than 30% of a member's weight
export const LB_MIN_TRADES = 5;      // V1 floor, deliberately low; recalibrate once the distribution is real

export const photoUrl = (slug) =>
  /^[A-Z]\d{6}$/.test(slug || '')
    ? `https://unitedstates.github.io/images/congress/225x275/${slug}.jpg`
    : null;

const isOptionRow = (assetType) => { const s = (assetType || '').toLowerCase(); return s === 'op' || s.includes('option'); };

// Every window clause is also floored at the 3-year cap, so no module can reach past it even if
// a wider window string is ever added to LB_WINDOWS.
const windowClause = (window) => {
  const interval = window === 'all' ? null : (LB_WINDOWS[window] || '1 year');
  // Also excludes future-dated trades. At least one filing carries a transaction date after its
  // own disclosure date (a year typo at the source), and without this guard that row sorts to the
  // top of "most recent" and reads as the newest congressional trade in the country.
  const capped = and(
    sql`${congressTrades.transactionDate} >= CURRENT_DATE - ${sql.raw(`INTERVAL '${MAX_HISTORY_DAYS} days'`)}`,
    sql`${congressTrades.transactionDate} <= CURRENT_DATE`,
  );
  if (!interval) return capped;
  return and(capped, sql`${congressTrades.transactionDate} >= CURRENT_DATE - ${sql.raw(`INTERVAL '${interval}'`)}`);
};

/**
 * Size-weighted return on PRICED buys: "if you had copied their buys, held to today".
 * Options are valued at the real option-contract price, never the underlying's move.
 * A single position is capped at 30% of weight, so one lucky trade cannot carry a member.
 * Unpriceable trades are skipped rather than assumed flat.
 */
export async function leaderboardView({ chamber, party, min = LB_MIN_TRADES, window = '1y' } = {}) {
  const conds = [eq(congressTrades.action, 'BUY'), windowClause(window)];
  if (chamber === 'house' || chamber === 'senate') conds.push(eq(congressTrades.chamber, chamber));
  if (party) conds.push(eq(congressTrades.party, party));

  const rows = await db.select({
    slug: congressTrades.memberSlug, name: congressTrades.representative,
    party: congressTrades.party, state: congressTrades.state, chamber: congressTrades.chamber,
    amt: congressTrades.amountMid, pat: congressTrades.priceAtTrade, cur: congressTickerPrices.currentPrice,
    assetType: congressTrades.assetType, optPat: congressTrades.optionPriceAtTrade, optCur: congressTrades.optionCurrentPrice,
    date: congressTrades.transactionDate,
  })
    .from(congressTrades)
    .leftJoin(congressTickerPrices, eq(congressTickerPrices.ticker, congressTrades.ticker))
    .where(and(...conds));

  const byMember = new Map();
  let oldest = null, pricedCount = 0;
  for (const r of rows) {
    const amt = Number(r.amt) || 0;
    let ret = null;
    if (isOptionRow(r.assetType)) {
      const p0 = Number(r.optPat), p1 = Number(r.optCur);
      if (p0 > 0 && p1 > 0) ret = (p1 - p0) / p0;
    } else {
      const p0 = Number(r.pat), p1 = Number(r.cur);
      if (p0 > 0 && p1 > 0) ret = (p1 - p0) / p0;
    }
    if (ret == null) continue;
    pricedCount++;
    if (r.date && (!oldest || r.date < oldest)) oldest = r.date;
    const m = byMember.get(r.slug) || { slug: r.slug, name: r.name, party: r.party, state: r.state, chamber: r.chamber, trades: [] };
    m.trades.push({ amt, ret, win: ret > 0 });
    byMember.set(r.slug, m);
  }

  const list = [];
  for (const m of byMember.values()) {
    const n = m.trades.length;
    if (n < min) continue;
    const total = m.trades.reduce((s, t) => s + t.amt, 0);
    if (!(total > 0)) continue;
    const capW = LB_WEIGHT_CAP * total;
    let wsum = 0, wr = 0, wins = 0;
    for (const t of m.trades) { const w = Math.min(t.amt, capW); wsum += w; wr += w * t.ret; if (t.win) wins++; }
    list.push({
      slug: m.slug, name: m.name, party: m.party, state: m.state, chamber: m.chamber,
      photoUrl: photoUrl(m.slug),
      pricedBuys: n,                                   // the qualifying trade count, shown prominently
      totalVolume: total,                              // estimated, from disclosed midpoints
      returnPct: wsum > 0 ? +((wr / wsum) * 100).toFixed(1) : null,
      winRate: Math.round((wins / n) * 100),
    });
  }
  list.sort((a, b) => b.returnPct - a.returnPct);
  return { list, meta: { pricedBuys: pricedCount, oldest, min, window } };
}

/**
 * Most traded stocks in the window.
 *
 * Dollar activity is reported as a RANGE (sum of disclosed minimums to sum of disclosed maximums)
 * because that is what filers actually disclose. The midpoint sum rides along only for sorting and
 * is labelled an estimate wherever it surfaces.
 */
// sort: 'trades' (most congressional activity), 'recent' (most recently traded), 'value'
// (largest disclosed activity). The chart's ticker list is meant to surface where Congress is
// actually active, not act as a ticker directory.
export async function mostTradedStocks({ window = '30d', limit = 12, sort = 'trades' } = {}) {
  const rows = await db.select({
    ticker: congressTrades.ticker,
    company: sql`max(${congressTrades.assetDescription})`,
    trades: sql`count(*)`.mapWith(Number),
    politicians: sql`count(distinct ${congressTrades.memberSlug})`.mapWith(Number),
    buys: sql`count(*) filter (where ${congressTrades.action} = 'BUY')`.mapWith(Number),
    sells: sql`count(*) filter (where ${congressTrades.action} = 'SELL')`.mapWith(Number),
    other: sql`count(*) filter (where ${congressTrades.action} not in ('BUY','SELL'))`.mapWith(Number),
    disclosedMin: sql`coalesce(sum(${congressTrades.amountMin}), 0)`.mapWith(Number),
    disclosedMax: sql`coalesce(sum(${congressTrades.amountMax}), 0)`.mapWith(Number),
    estimatedMid: sql`coalesce(sum(${congressTrades.amountMid}), 0)`.mapWith(Number),
    lastTraded: sql`max(${congressTrades.transactionDate})`,
  })
    .from(congressTrades)
    .where(and(sql`${congressTrades.ticker} is not null`, windowClause(window)))
    .groupBy(congressTrades.ticker)
    .orderBy(
      sort === 'recent' ? sql`max(${congressTrades.transactionDate}) desc`
      : sort === 'value' ? sql`coalesce(sum(${congressTrades.amountMid}),0) desc`
      : sql`count(*) desc`,
      sql`count(distinct ${congressTrades.memberSlug}) desc`,
    )
    .limit(limit);
  return rows;
}

/**
 * Latest filers: one row per disclosure a member made, newest first.
 *
 * Grouped by member and disclosure date so a single filing reporting 40 transactions reads as one
 * filing, not 40 rows. maxDelay is the oldest trade in that filing, which is the honest headline
 * for how late a disclosure ran.
 */
export async function latestFilers({ limit = 12 } = {}) {
  const rows = await db.select({
    slug: congressTrades.memberSlug,
    name: sql`max(${congressTrades.representative})`,
    chamber: sql`max(${congressTrades.chamber})`,
    party: sql`max(${congressTrades.party})`,
    state: sql`max(${congressTrades.state})`,
    district: sql`max(${congressTrades.district})`,
    disclosureDate: congressTrades.disclosureDate,
    transactions: sql`count(*)`.mapWith(Number),
    buys: sql`count(*) filter (where ${congressTrades.action} = 'BUY')`.mapWith(Number),
    sells: sql`count(*) filter (where ${congressTrades.action} = 'SELL')`.mapWith(Number),
    earliestTrade: sql`min(${congressTrades.transactionDate})`,
    latestTrade: sql`max(${congressTrades.transactionDate})`,
    maxDelay: sql`max(${congressTrades.filingLagDays})`.mapWith(Number),
    minDelay: sql`min(${congressTrades.filingLagDays})`.mapWith(Number),
    link: sql`max(${congressTrades.link})`,
  })
    .from(congressTrades)
    .where(windowClause('3y'))
    .groupBy(congressTrades.memberSlug, congressTrades.disclosureDate)
    .orderBy(desc(congressTrades.disclosureDate), sql`count(*) desc`)
    .limit(limit);
  return rows.map((r) => ({ ...r, photoUrl: photoUrl(r.slug) }));
}

// ─── Best 30-Day Record ─────────────────────────────────────────────────────
//
// Measures how each member's DISCLOSED POSITIONS moved over the last 30 days. It does NOT mean
// they traded in the last 30 days: congressional trades are disclosed up to 45 days late, so a
// window of "purchases made in the last 30 days" is nearly empty by construction (32 priced buys
// across the whole chamber, only 2 members reaching a 5-trade minimum).
//
// This is NOT portfolio performance and must never be presented as one. Filers disclose an amount
// RANGE, not a position size; they may have sold since; and we only see what was disclosed. It is
// the size-weighted 30-day price move of the securities a member disclosed buying, nothing more.
//
// Both prices come from the SAME daily series (ticker_daily_candles) so the move is not an
// artifact of mixing sources or of adjusted-vs-raw pricing.
export async function bestThirtyDayRecord({ min = LB_MIN_TRADES, days = 30 } = {}) {
  // Postgres rejects a window function nested inside an aggregate, so the per-member total is
  // computed in its own CTE and the 30 percent cap applied against it afterwards.
  const res = await db.execute(sql`
    WITH buys AS (
      SELECT t.member_slug, t.representative, t.party, t.state, t.chamber, t.ticker, t.amount_mid
      FROM congress_trades t
      WHERE t.action = 'BUY' AND t.ticker IS NOT NULL AND t.amount_mid > 0
        AND t.transaction_date >= CURRENT_DATE - ${sql.raw(String(MAX_HISTORY_DAYS))}
    ),
    px AS (
      -- Anchored rather than "earliest bar in the window": the close on or before the cutoff, and
      -- the most recent close. Taking whatever bar happened to be oldest in a padded window would
      -- silently measure 42 days for a thinly traded name and 30 for a liquid one.
      SELECT c.ticker,
        (SELECT close FROM ticker_daily_candles x
          WHERE x.ticker = c.ticker AND x.date <= CURRENT_DATE - ${sql.raw(String(days))}
          ORDER BY x.date DESC LIMIT 1) AS then_px,
        (SELECT close FROM ticker_daily_candles x
          WHERE x.ticker = c.ticker AND x.date >= CURRENT_DATE - 10
          ORDER BY x.date DESC LIMIT 1) AS now_px
      FROM (SELECT DISTINCT ticker FROM buys) c
    ),
    joined AS (
      SELECT b.member_slug, b.representative, b.party, b.state, b.chamber, b.amount_mid,
             (p.now_px - p.then_px) / NULLIF(p.then_px, 0) AS move
      FROM buys b JOIN px p ON p.ticker = b.ticker
      WHERE p.then_px > 0 AND p.now_px > 0
    ),
    tot AS (SELECT member_slug, sum(amount_mid) total, count(*) n FROM joined GROUP BY 1),
    w AS (
      SELECT j.*, LEAST(j.amount_mid, ${sql.raw(String(LB_WEIGHT_CAP))} * t.total) AS wt
      FROM joined j JOIN tot t ON t.member_slug = j.member_slug
      WHERE t.n >= ${sql.raw(String(min))}
    )
    SELECT member_slug AS slug, max(representative) AS name, max(party) AS party,
           max(state) AS state, max(chamber) AS chamber,
           count(*)::int AS positions,
           sum(wt * move) / NULLIF(sum(wt), 0) * 100 AS move_pct,
           count(*) FILTER (WHERE move > 0)::int AS winners
    FROM w GROUP BY member_slug
    ORDER BY sum(wt * move) / NULLIF(sum(wt), 0) DESC
  `);
  const rows = res.rows ?? res;
  return rows.map((r) => ({
    slug: r.slug, name: r.name, party: r.party, state: r.state, chamber: r.chamber,
    photoUrl: photoUrl(r.slug),
    positions: Number(r.positions),                        // sample size, shown with every row
    movePct: r.move_pct == null ? null : +Number(r.move_pct).toFixed(2),
    winRate: Number(r.positions) ? Math.round((Number(r.winners) / Number(r.positions)) * 100) : null,
  }));
}
