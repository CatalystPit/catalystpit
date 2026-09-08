import { sql, and, eq, gte, gt, inArray, desc, isNotNull } from 'drizzle-orm';
import { db } from './db';
import { insiderTrades, congressTrades, fundHoldings, fundFilings } from './schema';

// Confluence engine — cross-references the three "smart money" datasets we already own (insiders,
// Congress, 13F) to find tickers where multiple signals STACK the same direction. dir='bull'
// (accumulation) or 'bear' (distribution). Computed on demand; the API caches the result.
//
// Sub-scores are rough-but-monotonic for v1 — ranking matters more than absolute values; tune later.
const WINDOW_DAYS = 90;

export async function computeConfluence(dir = 'bull') {
  const bull = dir !== 'bear';
  const action = bull ? 'BUY' : 'SELL';
  const since = sql`current_date - make_interval(days => ${WINDOW_DAYS})`;

  // ── 1) Insiders (Form 4) — open-market buys/sells in the window ──
  const insRows = await db.select({
    ticker: insiderTrades.ticker,
    val: sql`coalesce(sum(${insiderTrades.totalValue}), 0)`.mapWith(Number),
    execs: sql`count(distinct ${insiderTrades.executive})`.mapWith(Number),
  }).from(insiderTrades)
    .where(and(eq(insiderTrades.action, action), gt(insiderTrades.totalValue, 0), gte(insiderTrades.transactionDate, since)))
    .groupBy(insiderTrades.ticker);
  const ins = new Map(insRows.map((r) => [r.ticker, r]));

  // ── 2) Congress (STOCK Act) — purchases/sales in the window ──
  const conRows = await db.select({
    ticker: congressTrades.ticker,
    val: sql`coalesce(sum(${congressTrades.amountMid}), 0)`.mapWith(Number),
    members: sql`count(distinct ${congressTrades.memberSlug})`.mapWith(Number),
  }).from(congressTrades)
    .where(and(eq(congressTrades.action, action), isNotNull(congressTrades.ticker), gte(congressTrades.transactionDate, since)))
    .groupBy(congressTrades.ticker);
  const con = new Map(conRows.map((r) => [r.ticker, r]));

  // ── 3) Institutions (13F) — quarter-over-quarter accumulation/reduction ──
  const qRows = await db.select({ q: fundFilings.quarter }).from(fundFilings)
    .groupBy(fundFilings.quarter).orderBy(desc(fundFilings.quarter)).limit(2);
  const [q0, q1] = qRows.map((r) => r.q);
  const fund = new Map(); // ticker -> { acc, red }
  if (q0) {
    const holds = await db.select({ ticker: fundHoldings.ticker, cik: fundHoldings.cik, quarter: fundHoldings.quarter, shares: fundHoldings.shares })
      .from(fundHoldings)
      .where(and(inArray(fundHoldings.quarter, [q0, q1].filter(Boolean)), isNotNull(fundHoldings.ticker), eq(fundHoldings.putCall, '')));
    const byKey = new Map(); // `${ticker}|${cik}` -> { cur, prev }
    for (const h of holds) {
      const k = `${h.ticker}|${h.cik}`;
      const e = byKey.get(k) || { cur: 0, prev: 0 };
      if (h.quarter === q0) e.cur = h.shares || 0; else e.prev = h.shares || 0;
      byKey.set(k, e);
    }
    for (const [k, e] of byKey) {
      const ticker = k.split('|')[0];
      const f = fund.get(ticker) || { acc: 0, red: 0 };
      if (e.cur > e.prev) f.acc += 1;          // new or increased
      else if (e.cur < e.prev) f.red += 1;     // reduced or closed
      fund.set(ticker, f);
    }
  }

  // ── Merge + score ──
  const tickers = new Set([...ins.keys(), ...con.keys(), ...fund.keys()].filter(Boolean));
  const clamp = (n) => Math.max(0, Math.min(100, n));
  const list = [];
  for (const t of tickers) {
    const i = ins.get(t); const c = con.get(t); const f = fund.get(t);
    const insVal = i?.val || 0, execs = i?.execs || 0;
    const conVal = c?.val || 0, members = c?.members || 0;
    const netFunds = bull ? ((f?.acc || 0) - (f?.red || 0)) : ((f?.red || 0) - (f?.acc || 0));

    const insActive = execs >= 1 && insVal > 0;
    const conActive = members >= 1 && conVal > 0;
    const fundActive = netFunds > 0;
    const signals = (insActive ? 1 : 0) + (conActive ? 1 : 0) + (fundActive ? 1 : 0);
    if (signals < 2) continue;   // confluence = at least two aligned signals

    const insScore = clamp(execs * 20 + Math.min(60, (insVal / 250000) * 20));
    const conScore = clamp(members * 25 + Math.min(50, (conVal / 100000) * 20));
    const fundScore = clamp(netFunds * 18);
    const mult = signals === 3 ? 2.4 : 1.6;
    const score = Math.round(((insScore + conScore + fundScore) / 3) * mult);

    list.push({
      ticker: t, score, signals,
      insider: insActive ? { val: insVal, execs } : null,
      congress: conActive ? { val: conVal, members } : null,
      fund: fundActive ? { net: netFunds, acc: f?.acc || 0, red: f?.red || 0 } : null,
    });
  }
  list.sort((a, b) => b.score - a.score);
  return list.slice(0, 60);
}
