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
import { congressTrades, congressTickerPrices, tickerPriceQuality } from './schema';
import { and, eq, sql, desc } from 'drizzle-orm';
import { MAX_HISTORY_DAYS } from './congress-chart.mjs';
import { returnBlocked, BLOCK_COPY } from './price-continuity.mjs';
import { STOCK_ACT_DEADLINE_DAYS } from './disclosure';

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
    patDate: congressTrades.priceAtTradeDate,
    priceUsable: tickerPriceQuality.usable, priceReason: tickerPriceQuality.reason,
    priceLastBreak: tickerPriceQuality.lastBreak,
  })
    .from(congressTrades)
    .leftJoin(congressTickerPrices, eq(congressTickerPrices.ticker, congressTrades.ticker))
    .leftJoin(tickerPriceQuality, eq(tickerPriceQuality.ticker, congressTrades.ticker))
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
      // A stock whose price history breaks between the anchor and today is skipped the same way an
      // unpriceable one is: dropped from the member's sample, never assumed flat and never counted
      // with a return computed across the break. LAZR alone would otherwise contribute +23,169%.
      const broken = returnBlocked({ usable: r.priceUsable, reason: r.priceReason, lastBreak: r.priceLastBreak }, r.patDate || r.date);
      const p0 = Number(r.pat), p1 = Number(r.cur);
      if (!broken && p0 > 0 && p1 > 0) ret = (p1 - p0) / p0;
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
 * Late filings: the disclosures that broke the STOCK Act's 45 day deadline, worst delay first.
 *
 * This replaced a "latest filers" list that ranked by disclosure date. The two answer different
 * questions and only one of them is intelligence: "what landed today" is a feed, while "who is 880
 * days past a statutory deadline" is a finding. 19.6 percent of the rows we hold were filed late,
 * so there is a real signal here rather than a handful of stragglers.
 *
 * Grouped by member and disclosure date so a single filing reporting 40 transactions reads as one
 * filing, not 40 rows. maxDelay is the oldest trade in that filing, which is the honest headline
 * for how late a disclosure ran: the deadline runs from the transaction, so the earliest trade in
 * the filing is the one that waited longest.
 */
export async function lateFilings({ limit = 12, threshold = STOCK_ACT_DEADLINE_DAYS } = {}) {
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
    .where(and(windowClause('3y'), sql`${congressTrades.filingLagDays} > ${threshold}`))
    .groupBy(congressTrades.memberSlug, congressTrades.disclosureDate)
    // Worst delay first. Ranking by disclosure date answered "what landed most recently", which is
    // a different and much less interesting question than "who is furthest past the deadline".
    .orderBy(sql`max(${congressTrades.filingLagDays}) desc`, sql`count(*) desc`)
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    photoUrl: photoUrl(r.slug),
    // Days past the statutory deadline, which is the number the module is actually about.
    daysLate: r.maxDelay == null ? null : r.maxDelay - threshold,
    threshold,
  }));
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
      LEFT JOIN ticker_price_quality q ON q.ticker = b.ticker
      WHERE p.then_px > 0 AND p.now_px > 0
        -- Both ends of this move must describe the same security. A break inside the 30-day window
        -- (a reused symbol, an unadjusted reverse split) would be read as performance, so the
        -- position is dropped from the member's sample rather than measured across it.
        AND COALESCE(q.usable, true) = true
        AND (q.last_break IS NULL OR q.last_break <= CURRENT_DATE - ${sql.raw(String(days))})
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


// ─── Trade shaping ──────────────────────────────────────────────────────────
// Moved here from the politicians route so every surface that renders a congressional trade
// derives option type, strike, expiry, contracts and share counts the same way.
// Every query selecting tradeCols must add this join, or the continuity columns come back
// undefined and the guard silently passes. Exported as one value so it cannot drift per caller.
export const priceQualityJoin = (q) => q.leftJoin(tickerPriceQuality, eq(tickerPriceQuality.ticker, congressTrades.ticker));

export const computeReturn = (priceAtTrade, currentPrice) =>
  (priceAtTrade != null && currentPrice != null && priceAtTrade > 0)
    ? +(((currentPrice - priceAtTrade) / priceAtTrade) * 100).toFixed(1)
    : null;

// Columns shared by the detail + ticker trade tables (joined to current price).
export const tradeCols = {
  id:               congressTrades.id,
  ticker:           congressTrades.ticker,
  assetDescription: congressTrades.assetDescription,
  assetType:        congressTrades.assetType,
  comment:          congressTrades.comment,
  owner:            congressTrades.owner,
  type:             congressTrades.type,
  action:           congressTrades.action,
  amountRange:      congressTrades.amountRange,
  amountMid:        congressTrades.amountMid,
  transactionDate:  congressTrades.transactionDate,
  disclosureDate:   congressTrades.disclosureDate,
  filingLagDays:    congressTrades.filingLagDays,
  priceAtTrade:     congressTrades.priceAtTrade,
  priceAtTradeDate: congressTrades.priceAtTradeDate,   // the bar the return is anchored on
  currentPrice:     congressTickerPrices.currentPrice,
  // Continuity verdict for the symbol. A return is refused when the series breaks between the
  // anchor and today; see priceQualityJoin below for the join every caller must add.
  priceUsable:      tickerPriceQuality.usable,
  priceReason:      tickerPriceQuality.reason,
  priceLastBreak:   tickerPriceQuality.lastBreak,
  link:             congressTrades.link,   // original filing PDF (source verification)
  // member fields — needed by ticker view, where rows span members
  slug:             congressTrades.memberSlug,
  representative:   congressTrades.representative,
  party:            congressTrades.party,
  state:            congressTrades.state,
  chamber:          congressTrades.chamber,
};

// Option details come from the filer's disclosure text: Senate "Option Type: Put/Call" in the asset
// name, House "D:" description ("Purchased 200 call options, strike $50, expires 3/19/27"). Parse
// call/put + strike + expiry + # contracts from both; plain 'Option' when the type isn't disclosed.
export const shapeTrade = (t) => {
  const desc = t.assetDescription || '', atype = t.assetType || '', cmt = t.comment || '';
  const src = `${desc} ${cmt}`;
  const isOpt = /\bOP\b/.test(atype) || /option/i.test(atype) || /\boptions?\b/i.test(src);
  const cp = /option\s*type\s*[:\-]?\s*(call|put)/i.exec(src) || (isOpt ? /\b(call|put)s?\b/i.exec(src) : null);
  const optionType = cp ? (cp[1].toLowerCase().startsWith('put') ? 'Put' : 'Call') : (isOpt ? 'Option' : null);
  const gm = (re) => (re.exec(src) || [])[1] || null;
  // Handles "strike price of $50", "at $22.00", "@ 150"; and "200 call options" / "10 puts".
  const strike = optionType ? gm(/(?:strike\s*(?:price)?\s*(?:of\s*)?|@\s*|\bat\s*)\$?\s*([\d,]+(?:\.\d+)?)/i) : null;
  const expiration = optionType ? gm(/(?:expir\w*|exp\.?)\s*(?:date)?\s*(?:of\s*)?(\d{1,2}\/\d{1,2}\/\d{2,4})/i) : null;
  const contracts = optionType ? gm(/\b([\d,]+)\s*(?:call|put)s?(?:\s*(?:options?|contracts?))?\b/i) : null;
  // Share count for stock trades — "Purchased 10,000 shares" / "Sold 500 shares".
  const shares = !optionType ? gm(/\b([\d,]+(?:\.\d+)?)\s*shares?\b/i) : null;
  // Filers rarely disclose an exact count, so estimate from the disclosed dollar amount ÷ the
  // trade-date price (same basis HedgeFollow uses). Stock trades only; never override an exact count.
  const px = Number(t.priceAtTrade), mid = Number(t.amountMid);
  const estShares = (!optionType && !shares && px > 0 && mid > 0) ? Math.round(mid / px) : null;
  const assetName = desc.split(/\s*[-–—]?\s*option\s*type\s*[:\-]/i)[0].trim() || desc;
  // Return Since is refused, not estimated, when the symbol's price history breaks between the
  // anchor bar and today. Options are priced from the option contract's own series, so a break in
  // the underlying's history does not apply to them.
  const blocked = optionType ? null : returnBlocked(
    { usable: t.priceUsable, reason: t.priceReason, lastBreak: t.priceLastBreak },
    t.priceAtTradeDate || t.transactionDate,
  );
  return {
    ...t,
    returnPct: blocked ? null : computeReturn(t.priceAtTrade, t.currentPrice),
    returnUnavailable: blocked || null,
    returnNote: blocked ? BLOCK_COPY[blocked] : null,
    optionType, assetName,
    strike: strike ? strike.replace(/,/g, '') : null,
    expiration: expiration || null,
    contracts: contracts ? contracts.replace(/,/g, '') : null,
    shares: shares ? shares.replace(/,/g, '') : null,
    estShares,
  };
};
