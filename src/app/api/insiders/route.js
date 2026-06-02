import { auth } from '@clerk/nextjs/server';
import { db } from '../../../lib/db';
import { insiderTrades } from '../../../lib/schema';
import { and, or, eq, gt, gte, ilike, inArray, desc, sql } from 'drizzle-orm';

export const runtime = 'nodejs';

// AUTH gate (sign-in, NOT tier — mirrors /api/news): signed-in users of ANY tier
// get the full set; signed-out get a FREE_PREVIEW_ROWS preview + lockedCount, with
// the locked rows never leaving the server. Response varies by auth → never CDN-cached.
const FREE_PREVIEW_ROWS = 10;
const NO_STORE = { 'Cache-Control': 'private, no-store' };

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
  transactions: {
    where: inArray(insiderTrades.action, ['BUY', 'SELL']),
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
    const { userId } = await auth();
    const loggedIn = !!userId;

    const { searchParams } = new URL(request.url);
    const ticker = searchParams.get('ticker')?.toUpperCase().trim() || null;
    const view = searchParams.get('view') || 'latest';
    const limitRaw = parseInt(searchParams.get('limit') ?? '200', 10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 200, 1), 1000);

    // Ticker drill-down — LEFT UNGATED. It's shared with the /ticker insider tab,
    // which has no sign-in CTA; capping it there would silently truncate that page.
    // (Consequence: a signed-out ticker SEARCH on /insiders bypasses the gate. Flagged.)
    if (ticker) {
      const trades = await db.select().from(insiderTrades)
        .where(eq(insiderTrades.ticker, ticker))
        .orderBy(desc(insiderTrades.filingDate), desc(insiderTrades.transactionDate))
        .limit(limit);
      console.log(`[insiders_api] ticker=${ticker} returned=${trades.length} loggedIn=${loggedIn}`);
      return Response.json({ view: 'ticker', ticker, count: trades.length, trades, loggedIn }, { headers: NO_STORE });
    }

    // Aggregate/summary views render for everyone so signed-out sees the page working.
    if (view === 'cluster_buys') {
      const payload = await clusterBuys();
      console.log(`[insiders_api] view=cluster_buys clusters=${payload.clusters.length} loggedIn=${loggedIn}`);
      return Response.json({ ...payload, loggedIn }, { headers: NO_STORE });
    }
    if (view === 'trends') {
      const payload = await trends();
      console.log(`[insiders_api] view=trends sentiment=${payload.sentiment.length} trending=${payload.trending.length} loggedIn=${loggedIn}`);
      return Response.json({ ...payload, loggedIn }, { headers: NO_STORE });
    }

    // Row/category views — AUTH-GATED. Signed-in: full. Signed-out: first 10 + lockedCount.
    const cfg = ROW_VIEWS[view] ?? ROW_VIEWS.latest;
    const resolvedView = ROW_VIEWS[view] ? view : 'latest';
    let q = db.select().from(insiderTrades);
    if (cfg.where) q = q.where(cfg.where);
    q = q.orderBy(...cfg.orderBy).limit(limit);
    const all = await q;
    const trades = loggedIn ? all : all.slice(0, FREE_PREVIEW_ROWS);
    const lockedCount = loggedIn ? 0 : Math.max(0, all.length - FREE_PREVIEW_ROWS);
    console.log(`[insiders_api] view=${resolvedView} returned=${trades.length} locked=${lockedCount} loggedIn=${loggedIn}`);
    return Response.json({ view: resolvedView, count: trades.length, trades, lockedCount, loggedIn }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[insiders_api] failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}
