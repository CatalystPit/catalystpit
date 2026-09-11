import { auth } from '@clerk/nextjs/server';
import { db } from '../../../lib/db';
import { insiderTrades } from '../../../lib/schema';
import { and, or, eq, gt, gte, ilike, inArray, desc, sql } from 'drizzle-orm';
import { resolveUserTier } from '../../../lib/entitlements';

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
    // P or S and value ≥ $1M, OR an open-market buy ≥ $100k. Excludes OTHER grants.
    where: or(
      and(inArray(insiderTrades.action, ['BUY', 'SELL']), gte(insiderTrades.totalValue, 1000000)),
      and(eq(insiderTrades.action, 'BUY'),                gte(insiderTrades.totalValue, 100000)),
    ),
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
    const view = searchParams.get('view') || 'buying';
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
    // Screener params layered on top of the selected view's own WHERE.
    const num = (k) => { const n = parseInt(searchParams.get(k) ?? '', 10); return Number.isFinite(n) ? n : null; };
    const days = num('days');
    const minValue = num('minValue'), maxValue = num('maxValue');
    const minPrice = num('minPrice'), maxPrice = num('maxPrice');
    const maxDelay = num('maxDelay');                          // filing delay (days) ceiling
    const name = searchParams.get('name')?.trim() || null;    // insider-name search
    const role = searchParams.get('role')?.trim() || null;    // title bucket
    const txn = searchParams.get('txn')?.trim() || null;      // transaction-type bucket
    const dateField = searchParams.get('dateField') === 'filing' ? insiderTrades.filingDate : insiderTrades.transactionDate;

    // Title buckets → ILIKE patterns (a title often lists several roles).
    const ROLE_PATTERNS = {
      ceo: ['%chief executive%', '%CEO%'], cfo: ['%chief financial%', '%CFO%'],
      coo: ['%chief operating%', '%COO%'], president: ['%president%'],
      chairman: ['%chair%'], director: ['%director%'], vp: ['%vice president%', '% VP%', '%VP %'],
      tenpct: ['%10%', '%ten percent%'],
    };
    // Transaction-type buckets → SEC Form-4 codes.
    const TXN_CODES = {
      purchase: ['P'], sale: ['S'], grant: ['A'], gift: ['G'], tax: ['F'],
      exercise: ['M'], conversion: ['C'], derivative: ['C', 'M'],
    };

    const cfg = ROW_VIEWS[view] ?? ROW_VIEWS.latest;
    const resolvedView = ROW_VIEWS[view] ? view : 'latest';
    const conds = [];
    if (cfg.where) conds.push(cfg.where);
    if (days && days > 0) conds.push(sql`${dateField} >= current_date - make_interval(days => ${days})`);
    if (minValue && minValue > 0) conds.push(gte(insiderTrades.totalValue, minValue));
    if (maxValue && maxValue > 0) conds.push(sql`${insiderTrades.totalValue} <= ${maxValue}`);
    if (minPrice && minPrice > 0) conds.push(gte(insiderTrades.pricePerShare, minPrice));
    if (maxPrice && maxPrice > 0) conds.push(sql`${insiderTrades.pricePerShare} <= ${maxPrice}`);
    if (maxDelay && maxDelay > 0) conds.push(sql`(${insiderTrades.filingDate} - ${insiderTrades.transactionDate}) <= ${maxDelay}`);
    if (name) conds.push(ilike(insiderTrades.executive, `%${name.replace(/[%_\\]/g, '')}%`));
    if (role && ROLE_PATTERNS[role]) conds.push(or(...ROLE_PATTERNS[role].map((p) => ilike(insiderTrades.title, p))));
    if (txn && TXN_CODES[txn]) conds.push(inArray(insiderTrades.transactionCode, TXN_CODES[txn]));
    let q = db.select().from(insiderTrades);
    if (conds.length) q = q.where(conds.length === 1 ? conds[0] : and(...conds));
    q = q.orderBy(...cfg.orderBy).limit(limit);
    const all = await q;
    // Pro gate (not just sign-in): Free (incl. signed-in) sees a preview; Pro/Elite get the full set.
    const tier = await resolveUserTier();
    const isPro = tier === 'pro' || tier === 'elite';
    const trades = isPro ? all : all.slice(0, FREE_PREVIEW_ROWS);
    let lockedCount = 0;
    if (!isPro) {
      // True total for the view (unbounded by the display `limit`) so the upsell count is honest.
      let fullCount = all.length;
      try {
        const cntWhere = conds.length ? (conds.length === 1 ? conds[0] : and(...conds)) : undefined;
        let cq = db.select({ n: sql`count(*)`.mapWith(Number) }).from(insiderTrades);
        if (cntWhere) cq = cq.where(cntWhere);
        const [{ n }] = await cq;
        fullCount = n;
      } catch { /* fall back to fetched length */ }
      lockedCount = Math.max(0, fullCount - FREE_PREVIEW_ROWS);
    }
    console.log(`[insiders_api] view=${resolvedView} returned=${trades.length} locked=${lockedCount} tier=${tier}`);
    return Response.json({ view: resolvedView, count: trades.length, trades, lockedCount, tier, loggedIn }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[insiders_api] failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}
