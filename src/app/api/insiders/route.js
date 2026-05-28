import { db } from '../../../lib/db';
import { insiderTrades } from '../../../lib/schema';
import { and, or, eq, gt, gte, ilike, inArray, desc, sql } from 'drizzle-orm';

export const runtime = 'nodejs';

// Row-views: WHERE + ORDER BY, rendered in the trade table. Keyed by ?view=.
const ROW_VIEWS = {
  latest: {
    where: null,
    orderBy: [desc(insiderTrades.filingDate), desc(insiderTrades.id)],
  },
  buying: {
    where: eq(insiderTrades.action, 'BUY'),
    orderBy: [desc(insiderTrades.filingDate), desc(insiderTrades.totalValue)],
  },
  selling: {
    where: eq(insiderTrades.action, 'SELL'),
    orderBy: [desc(insiderTrades.filingDate), desc(insiderTrades.totalValue)],
  },
  ceo: {
    where: and(
      eq(insiderTrades.action, 'BUY'),
      or(ilike(insiderTrades.title, '%chief executive%'), ilike(insiderTrades.title, '%CEO%')),
    ),
    orderBy: [desc(insiderTrades.filingDate), desc(insiderTrades.totalValue)],
  },
  top: {
    where: and(inArray(insiderTrades.action, ['BUY', 'SELL']), gt(insiderTrades.totalValue, 0)),
    orderBy: [desc(insiderTrades.totalValue)],
  },
  significant: {
    where: gte(insiderTrades.totalValue, 1000000),
    orderBy: [desc(insiderTrades.filingDate), desc(insiderTrades.totalValue)],
  },
};

async function clusterBuys() {
  const clusters = await db
    .select({
      ticker:     insiderTrades.ticker,
      company:    sql`max(${insiderTrades.company})`,
      buyers:     sql`count(distinct ${insiderTrades.executive})`.mapWith(Number),
      trades:     sql`count(*)`.mapWith(Number),
      totalValue: sql`sum(${insiderTrades.totalValue})`.mapWith(Number),
      firstBuy:   sql`min(${insiderTrades.transactionDate})`,
      lastBuy:    sql`max(${insiderTrades.transactionDate})`,
    })
    .from(insiderTrades)
    .where(and(
      eq(insiderTrades.action, 'BUY'),
      sql`${insiderTrades.transactionDate} >= current_date - interval '30 days'`,
    ))
    .groupBy(insiderTrades.ticker)
    .having(sql`count(distinct ${insiderTrades.executive}) >= 3`)
    .orderBy(sql`count(distinct ${insiderTrades.executive}) desc`, sql`sum(${insiderTrades.totalValue}) desc`)
    .limit(50);
  return { view: 'cluster_buys', clusters };
}

async function trends() {
  const sentiment = await db
    .select({
      date:  insiderTrades.filingDate,
      buys:  sql`count(*) filter (where ${insiderTrades.action} = 'BUY')`.mapWith(Number),
      sells: sql`count(*) filter (where ${insiderTrades.action} = 'SELL')`.mapWith(Number),
    })
    .from(insiderTrades)
    .where(sql`${insiderTrades.filingDate} >= current_date - interval '90 days'`)
    .groupBy(insiderTrades.filingDate)
    .orderBy(insiderTrades.filingDate);

  const trending = await db
    .select({
      ticker:  insiderTrades.ticker,
      company: sql`max(${insiderTrades.company})`,
      trades:  sql`count(*)`.mapWith(Number),
      buys:    sql`count(*) filter (where ${insiderTrades.action} = 'BUY')`.mapWith(Number),
      sells:   sql`count(*) filter (where ${insiderTrades.action} = 'SELL')`.mapWith(Number),
    })
    .from(insiderTrades)
    .where(sql`${insiderTrades.filingDate} >= current_date - interval '7 days'`)
    .groupBy(insiderTrades.ticker)
    .orderBy(sql`count(*) desc`)
    .limit(20);

  return { view: 'trends', sentiment, trending };
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const ticker = searchParams.get('ticker')?.toUpperCase().trim() || null;
    const view = searchParams.get('view') || 'latest';
    const limitRaw = parseInt(searchParams.get('limit') ?? '200', 10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 200, 1), 1000);

    // Ticker drill-down overrides any view.
    if (ticker) {
      const trades = await db.select().from(insiderTrades)
        .where(eq(insiderTrades.ticker, ticker))
        .orderBy(desc(insiderTrades.filingDate), desc(insiderTrades.transactionDate))
        .limit(limit);
      console.log(`[insiders_api] ticker=${ticker} returned=${trades.length}`);
      return Response.json({ view: 'ticker', ticker, count: trades.length, trades });
    }

    if (view === 'cluster_buys') {
      const payload = await clusterBuys();
      console.log(`[insiders_api] view=cluster_buys clusters=${payload.clusters.length}`);
      return Response.json(payload);
    }
    if (view === 'trends') {
      const payload = await trends();
      console.log(`[insiders_api] view=trends sentiment=${payload.sentiment.length} trending=${payload.trending.length}`);
      return Response.json(payload);
    }

    const cfg = ROW_VIEWS[view] ?? ROW_VIEWS.latest;
    const resolvedView = ROW_VIEWS[view] ? view : 'latest';
    let q = db.select().from(insiderTrades);
    if (cfg.where) q = q.where(cfg.where);
    q = q.orderBy(...cfg.orderBy).limit(limit);
    const trades = await q;
    console.log(`[insiders_api] view=${resolvedView} returned=${trades.length}`);
    return Response.json({ view: resolvedView, count: trades.length, trades });
  } catch (e) {
    console.log(`[insiders_api] failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
