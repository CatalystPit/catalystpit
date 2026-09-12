import { auth } from '@clerk/nextjs/server';
import { db } from '../../../lib/db';
import { insiderTrades } from '../../../lib/schema';
import { and, or, eq, gt, gte, ilike, inArray, desc, sql } from 'drizzle-orm';
import { resolveUserTier } from '../../../lib/entitlements';
import { ownershipChangePct as ownPctShared } from '../../../lib/insider-format';

export const runtime = 'nodejs';

// AUTH gate (sign-in, NOT tier — mirrors /api/news): signed-in users of ANY tier
// get the full set; signed-out get a FREE_PREVIEW_ROWS preview + lockedCount, with
// the locked rows never leaving the server. Response varies by auth → never CDN-cached.
const FREE_PREVIEW_ROWS = 10;
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// ── KV cache for the (heavier) aggregation endpoints — short TTL, they move slowly intra-day ──
const KV_URL = process.env.KV_REST_API_URL, KV_TOKEN = process.env.KV_REST_API_TOKEN;
async function kvGet(k) { if (!KV_URL) return null; try { const r = await fetch(`${KV_URL}/get/${encodeURIComponent(k)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } }); if (!r.ok) return null; const { result } = await r.json(); return result ? JSON.parse(result) : null; } catch { return null; } }
async function kvSet(k, v, ttl) { if (!KV_URL) return; try { await fetch(`${KV_URL}/set/${encodeURIComponent(k)}?EX=${ttl}`, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(v) }); } catch { /* non-fatal */ } }
const WINDOW_DAYS = { '7d': 7, '30d': 30, '90d': 90 };
const winDays = (w) => WINDOW_DAYS[w] || 30;
// Band NAMES are public (the UI shows them); the score ranges that produce them are not,
// and live only in lib/conviction.server.js.
const CONVICTION_BANDS = ['LOW', 'MODERATE', 'HIGH', 'VERY HIGH', 'EXTREME'];
const CEO_CFO_SQL = sql`(${insiderTrades.title} ilike '%chief executive%' or ${insiderTrades.title} ilike '%CEO%' or ${insiderTrades.title} ilike '%chief financial%' or ${insiderTrades.title} ilike '%CFO%')`;
// interval literal is from our own whitelist (winDays), never user input
const sinceWindow = (w) => sql.raw(`current_date - interval '${winDays(w)} days'`);

// Row-views: WHERE + ORDER BY, rendered in the trade table. Keyed by ?view=.
const ROW_VIEWS = {
  latest: {
    // Open-market only (P/S). Awards, gifts, tax-withholding, option exercises etc. are NOT trades —
    // they only surface here as 'all' or in an insider NAME search (labeled).
    where: inArray(insiderTrades.action, ['BUY', 'SELL']),
    orderBy: [desc(insiderTrades.filingDate), desc(insiderTrades.id)],
  },
  all: {
    // Raw firehose — EVERY Form 4 of every type (award/gift/tax/exercise/buy/sell), newest first.
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

// Common/known names → the SEC LEGAL-name fragment (SEC files legal names, not nicknames, so
// "Jensen" never matches "HUANG JEN HSUN"). Extend freely. Keys matched as substrings, lowercase.
const NAME_ALIASES = {
  'jensen': 'huang jen',          // Jensen Huang — NVDA
  'jamie dimon': 'dimon jam',     // JPMorgan
  'bill gates': 'gates william',
  'bob iger': 'iger robert',      // Disney
  'zuck': 'zuckerberg',
  'sundar': 'pichai sundar',      // Alphabet
  'satya': 'nadella satya',       // Microsoft
};

// AUTOCOMPLETE: distinct insiders (person = executive + company) matching the query, most-active
// first. Public + ungated, returns before auth for a fast typeahead — NOT 50 transaction rows.
async function searchView(q) {
  const clean = q.replace(/[%_\\]/g, '');
  const lower = clean.toLowerCase();
  const terms = [clean];
  for (const [alias, legal] of Object.entries(NAME_ALIASES)) if (lower.includes(alias)) terms.push(legal);
  const where = terms.length > 1
    ? or(...terms.map((t) => ilike(insiderTrades.executive, `%${t}%`)))
    : ilike(insiderTrades.executive, `%${clean}%`);
  const rows = await db.select({
    executive: insiderTrades.executive,
    ticker: insiderTrades.ticker,
    title: sql`max(${insiderTrades.title})`,
    company: sql`max(${insiderTrades.company})`,
    trades: sql`count(*)`.mapWith(Number),
  }).from(insiderTrades)
    .where(where)
    .groupBy(insiderTrades.executive, insiderTrades.ticker)
    .orderBy(sql`count(*) desc`)
    .limit(12);
  return rows;
}

// ── INSIDER MARKET PULSE — open-market only, cached per window ──
async function pulseView(window) {
  const key = `insider:pulse:${window}`;
  const cached = await kvGet(key); if (cached) return cached;
  const since = sinceWindow(window);
  const agg = (await db.execute(sql`
    SELECT coalesce(sum(total_value) filter (where action='BUY'),0) buy_val, count(*) filter (where action='BUY') buy_ct,
           coalesce(sum(total_value) filter (where action='SELL'),0) sell_val, count(*) filter (where action='SELL') sell_ct,
           count(distinct ticker) filter (where action='BUY') companies_buying,
           count(*) filter (where action='BUY' and (title ilike '%chief executive%' or title ilike '%CEO%' or title ilike '%chief financial%' or title ilike '%CFO%')) ceocfo_buys
    FROM insider_trades WHERE transaction_date >= ${since}`)).rows?.[0] || {};
  const clu = (await db.execute(sql`SELECT count(*) n FROM (SELECT ticker FROM insider_trades WHERE action='BUY' AND transaction_date >= ${since} GROUP BY ticker HAVING count(distinct executive) >= 3) x`)).rows?.[0] || {};
  const buyVal = +agg.buy_val || 0, sellVal = +agg.sell_val || 0;
  const out = { window, buyValue: buyVal, buyCount: +agg.buy_ct || 0, sellValue: sellVal, sellCount: +agg.sell_ct || 0,
    buySellRatio: sellVal > 0 ? +(buyVal / sellVal).toFixed(2) : null, companiesBuying: +agg.companies_buying || 0,
    ceoCfoBuys: +agg.ceocfo_buys || 0, clusterBuys: +clu.n || 0 };
  await kvSet(key, out, 300);
  return out;
}

// ── INSIDER ACTIVITY HEATMAP — per-ticker net open-market $, sector-grouped, cached ──
async function heatmapView(window, mode) {
  const key = `insider:heatmap:${window}`;
  let cells = await kvGet(key);
  if (!cells) {
    const since = sinceWindow(window);
    const res = await db.execute(sql`
      SELECT t.ticker, max(t.company) company, m.sector,
        coalesce(sum(t.total_value) filter (where t.action='BUY'),0) buys,
        coalesce(sum(t.total_value) filter (where t.action='SELL'),0) sells,
        count(distinct t.executive) insiders, max(t.total_value) largest
      FROM insider_trades t LEFT JOIN screener_meta m ON m.ticker = t.ticker
      WHERE t.action IN ('BUY','SELL') AND t.transaction_date >= ${since} AND t.total_value > 0
      GROUP BY t.ticker, m.sector HAVING coalesce(sum(t.total_value),0) > 0
      ORDER BY greatest(coalesce(sum(t.total_value) filter (where t.action='BUY'),0), coalesce(sum(t.total_value) filter (where t.action='SELL'),0)) DESC
      LIMIT 250`);
    cells = (res?.rows || []).map(r => ({ ticker: r.ticker, company: r.company, sector: r.sector || 'Other',
      buys: +r.buys || 0, sells: +r.sells || 0, net: (+r.buys || 0) - (+r.sells || 0), insiders: +r.insiders || 0, largest: +r.largest || 0 }));
    await kvSet(key, cells, 300);
  }
  return { window, mode: mode || 'net', cells };
}

// ── NOTABLE INSIDER ACTIVITY — highlights, cached per window ──
async function notableView(window) {
  const key = `insider:notable:${window}`;
  const cached = await kvGet(key); if (cached) return cached;
  const since = sinceWindow(window);
  const top = async (cond) => (await db.execute(sql`SELECT ticker, company, executive, title, total_value, shares, shares_owned_after, transaction_date FROM insider_trades WHERE ${cond} AND transaction_date >= ${since} ORDER BY total_value DESC LIMIT 1`)).rows?.[0] || null;
  const [ceoBuy, cfoBuy, bigBuy] = await Promise.all([
    top(sql`action='BUY' and (title ilike '%chief executive%' or title ilike '%CEO%')`),
    top(sql`action='BUY' and (title ilike '%chief financial%' or title ilike '%CFO%')`),
    top(sql`action='BUY'`),
  ]);
  const mostBuyers = (await db.execute(sql`SELECT ticker, max(company) company, count(distinct executive) insiders, sum(total_value) total FROM insider_trades WHERE action='BUY' AND transaction_date >= ${since} GROUP BY ticker HAVING count(distinct executive) >= 2 ORDER BY count(distinct executive) DESC, sum(total_value) DESC LIMIT 1`)).rows?.[0] || null;
  const bigCluster = (await db.execute(sql`SELECT ticker, max(company) company, count(distinct executive) insiders, sum(total_value) total FROM insider_trades WHERE action='BUY' AND transaction_date >= ${since} GROUP BY ticker HAVING count(distinct executive) >= 3 ORDER BY sum(total_value) DESC LIMIT 1`)).rows?.[0] || null;
  const ownInc = (await db.execute(sql`SELECT ticker, company, executive, title, total_value, (shares / nullif(shares_owned_after - shares, 0)) * 100 pct FROM insider_trades WHERE action='BUY' AND shares_owned_after > shares AND total_value > 25000 AND transaction_date >= ${since} ORDER BY pct DESC LIMIT 1`)).rows?.[0] || null;
  // Highest-conviction purchase in the window. Only score, band and approved tags leave
  // the server — the engine and its inputs stay in lib/conviction.server.js.
  const topConv = (await db.execute(sql`SELECT ticker, company, executive, title, total_value, transaction_date, conviction, conviction_band, conviction_tags FROM insider_trades WHERE conviction IS NOT NULL AND transaction_date >= ${since} ORDER BY conviction DESC, total_value DESC LIMIT 1`)).rows?.[0] || null;
  const t = (r, x = {}) => r ? { ticker: r.ticker, company: r.company, executive: r.executive, title: r.title, value: +r.total_value || 0, date: r.transaction_date, ...x } : null;
  const out = { window,
    largestCeoBuy: t(ceoBuy), largestCfoBuy: t(cfoBuy), largestPurchase: t(bigBuy),
    mostInsidersBuying: mostBuyers ? { ticker: mostBuyers.ticker, company: mostBuyers.company, insiders: +mostBuyers.insiders, value: +mostBuyers.total || 0 } : null,
    largestCluster: bigCluster ? { ticker: bigCluster.ticker, company: bigCluster.company, insiders: +bigCluster.insiders, value: +bigCluster.total || 0 } : null,
    highestConviction: topConv ? { ticker: topConv.ticker, company: topConv.company, executive: topConv.executive, title: topConv.title, value: +topConv.total_value || 0, date: topConv.transaction_date, conviction: Math.round(+topConv.conviction), band: topConv.conviction_band, tags: parseTags(topConv.conviction_tags) } : null,
        largestOwnershipIncrease: ownInc ? { ticker: ownInc.ticker, company: ownInc.company, executive: ownInc.executive, value: +ownInc.total_value || 0, pct: ownInc.pct != null ? +ownInc.pct : null } : null };
  await kvSet(key, out, 300);
  return out;
}

// Add the intelligence layer to a page of rows (bounded to the page — cheap, scales fine).
// firstOpenMarketBuy / monthsSincePriorBuy are computed from OUR history only — the UI must word
// them honestly ("in our available history") and never claim multi-year firsts until the backfill.
// conviction_tags is stored as a JSON array of APPROVED display strings. A malformed
// value must never break a row, so this degrades to an empty list.
function parseTags(v) {
  if (!v) return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a.slice(0, 6) : []; } catch { return []; }
}

async function enrichRows(rows) {
  // Canonical calc lives in lib/insider-format; this route no longer keeps its own copy.
  const shaped = rows.map((r) => ({ ...r,
    ceoCfo: /chief executive|\bCEO\b|chief financial|\bCFO\b/i.test(r.title || ''),
    openMarket: r.transactionCode === 'P' || r.transactionCode === 'S',
    // Unrounded on the wire. Rounding here threw away the sub-1% precision the shared
    // formatter needs, and left every consumer to invent its own rounding.
    ownershipChangePct: ownPctShared(r),
    // Conviction reaches the client as score + band + approved tags ONLY. The engine,
    // its weights and every intermediate factor stay server-side (lib/conviction.server.js).
    conviction: r.conviction == null ? null : Math.round(r.conviction),
    convictionBand: r.convictionBand ?? null,
    convictionTags: parseTags(r.convictionTags),
    // Prefer the precomputed context; these were a per-request history query before,
    // which is exactly the multi-year lookup that should never run per row.
    firstOpenMarketBuy: r.isFirstOmBuy === true,
    monthsSincePriorBuy: r.monthsSincePrevBuy == null ? null : Math.round(r.monthsSincePrevBuy),
  }));
  // Fallback only for rows the context job has not reached yet (it runs after each
  // backfill chunk). Once ctx_computed_at is set everywhere this does no work at all.
  const pRows = shaped.filter((r) => r.transactionCode === 'P' && r.ctxComputedAt == null);
  if (pRows.length) {
    const tks = [...new Set(pRows.map((r) => r.ticker))], exs = [...new Set(pRows.map((r) => r.executive))];
    const hist = await db.select({ executive: insiderTrades.executive, ticker: insiderTrades.ticker, date: insiderTrades.transactionDate })
      .from(insiderTrades).where(and(eq(insiderTrades.transactionCode, 'P'), inArray(insiderTrades.ticker, tks), inArray(insiderTrades.executive, exs)));
    const byKey = new Map();
    for (const h of hist) { const k = `${h.executive}|${h.ticker}`; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(h.date); }
    for (const r of pRows) {
      const prior = (byKey.get(`${r.executive}|${r.ticker}`) || []).filter((d) => d && d < r.transactionDate);
      r.firstOpenMarketBuy = prior.length === 0;
      if (prior.length) { const last = prior.sort().pop(); r.monthsSincePriorBuy = Math.max(0, Math.round((new Date(r.transactionDate) - new Date(last)) / (30 * 86400000))); }
    }
  }
  return shaped;
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);

    // Autocomplete — public, before auth (fast typeahead).
    const ac = searchParams.get('ac');
    if (ac != null) {
      const q = ac.trim();
      if (q.length < 2) return Response.json({ results: [] }, { headers: NO_STORE });
      return Response.json({ results: await searchView(q) }, { headers: NO_STORE });
    }

    const { userId } = await auth();
    const loggedIn = !!userId;

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
    const window = WINDOW_DAYS[searchParams.get('window')] ? searchParams.get('window') : '30d';
    if (view === 'pulse')   return Response.json({ ...(await pulseView(window)),   loggedIn }, { headers: NO_STORE });
    if (view === 'heatmap') return Response.json({ ...(await heatmapView(window, searchParams.get('mode'))), loggedIn }, { headers: NO_STORE });
    if (view === 'notable') return Response.json({ ...(await notableView(window)), loggedIn }, { headers: NO_STORE });
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
    const co = searchParams.get('co')?.toUpperCase().trim() || null;  // pin to a company (disambiguates same-name people)
    const role = searchParams.get('role')?.trim() || null;    // title bucket
    const txn = searchParams.get('txn')?.trim() || null;      // transaction-type bucket
    const sector = searchParams.get('sector')?.trim() || null; // sector (via screener_meta join)
    const dateField = searchParams.get('dateField') === 'filing' ? insiderTrades.filingDate : insiderTrades.transactionDate;
    // Intelligence filters (additive — never replace the existing controls).
    const openMarketF = searchParams.get('openMarket') === '1';
    const ceocfoF = searchParams.get('ceocfo') === '1';
    const clusterF = searchParams.get('cluster') === '1';
    const firstBuyF = searchParams.get('firstbuy') === '1';
    const tenb51F = searchParams.get('tenb51') === '1';
    const discretionaryF = searchParams.get('discretionary') === '1';
    // Conviction filter/sort. The client sends a THRESHOLD or a BAND NAME only — never a
    // weight, never a factor. Bands are resolved server-side, so the model can be
    // recalibrated (thresholds moved, weights retuned) with no API or UI change.
    const minConviction = num('minConviction');
    const bandF = searchParams.get('band')?.toUpperCase().trim() || null;
    const sortBy = searchParams.get('sort')?.trim() || null;

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
    // Sorting by conviction puts unscored rows LAST rather than dropping them: a grant or an
    // exercise has no conviction by design, and hiding it would silently change the view.
    const orderBy = sortBy === 'conviction'
      ? [sql`${insiderTrades.conviction} DESC NULLS LAST`, desc(insiderTrades.filingDate)]
      : cfg.orderBy;
    const conds = [];
    // Name search shows the insider's FULL history (awards/gifts/tax included, labeled). Browse views
    // apply their open-market WHERE. So skip the view filter only when searching a specific insider.
    if (cfg.where && !name) conds.push(cfg.where);
    if (days && days > 0) conds.push(sql`${dateField} >= current_date - make_interval(days => ${days})`);
    if (minValue && minValue > 0) conds.push(gte(insiderTrades.totalValue, minValue));
    if (maxValue && maxValue > 0) conds.push(sql`${insiderTrades.totalValue} <= ${maxValue}`);
    if (minPrice && minPrice > 0) conds.push(gte(insiderTrades.pricePerShare, minPrice));
    if (maxPrice && maxPrice > 0) conds.push(sql`${insiderTrades.pricePerShare} <= ${maxPrice}`);
    if (maxDelay && maxDelay > 0) conds.push(sql`(${insiderTrades.filingDate} - ${insiderTrades.transactionDate}) <= ${maxDelay}`);
    if (name) conds.push(ilike(insiderTrades.executive, `%${name.replace(/[%_\\]/g, '')}%`));
    if (co) conds.push(eq(insiderTrades.ticker, co));
    if (role && ROLE_PATTERNS[role]) conds.push(or(...ROLE_PATTERNS[role].map((p) => ilike(insiderTrades.title, p))));
    if (txn && TXN_CODES[txn]) conds.push(inArray(insiderTrades.transactionCode, TXN_CODES[txn]));
    // Sector via the screener_meta reference (already Polygon-populated) — subquery keeps the flat select.
    if (sector) conds.push(sql`${insiderTrades.ticker} IN (SELECT ticker FROM screener_meta WHERE sector = ${sector})`);
    if (openMarketF) conds.push(inArray(insiderTrades.action, ['BUY', 'SELL']));
    if (ceocfoF) conds.push(CEO_CFO_SQL);
    if (tenb51F) conds.push(eq(insiderTrades.rule10b5_1, true));
    if (discretionaryF) conds.push(eq(insiderTrades.rule10b5_1, false));
    // The client sends a flag, not a cutoff. Which bands count as "high conviction" is
    // decided here, so retuning the model cannot strand a hardcoded number in the UI.
    if (searchParams.get('highconv') === '1') conds.push(inArray(insiderTrades.convictionBand, ['HIGH', 'VERY HIGH', 'EXTREME']));
    if (clusterF) conds.push(sql`${insiderTrades.ticker} IN (SELECT ticker FROM insider_trades WHERE action='BUY' AND transaction_date >= current_date - interval '90 days' GROUP BY ticker HAVING count(distinct executive) >= 3)`);
    if (minConviction != null && minConviction > 0) conds.push(sql`${insiderTrades.conviction} >= ${minConviction}`);
    if (bandF && CONVICTION_BANDS.includes(bandF)) conds.push(eq(insiderTrades.convictionBand, bandF));
    if (firstBuyF) conds.push(sql`${insiderTrades.transactionCode} = 'P' AND NOT EXISTS (SELECT 1 FROM insider_trades e WHERE e.executive = ${insiderTrades.executive} AND e.ticker = ${insiderTrades.ticker} AND e.transaction_code = 'P' AND e.transaction_date < ${insiderTrades.transactionDate})`);

    const whereClause = conds.length ? (conds.length === 1 ? conds[0] : and(...conds)) : undefined;
    const tier = await resolveUserTier();
    const isPro = tier === 'pro' || tier === 'elite';

    // Server-side pagination (Pro). Free tier keeps the 10-row preview + lockedCount (unchanged).
    const pageSize = [25, 50, 100].includes(num('pageSize')) ? num('pageSize') : 50;
    const page = Math.max(0, num('page') || 0);

    let base = db.select().from(insiderTrades);
    if (whereClause) base = base.where(whereClause);
    let countQ = db.select({ n: sql`count(*)`.mapWith(Number) }).from(insiderTrades);
    if (whereClause) countQ = countQ.where(whereClause);

    if (isPro) {
      const rows = await base.orderBy(...orderBy).limit(pageSize).offset(page * pageSize);
      const [{ n: total }] = await countQ;
      const trades = await enrichRows(rows);
      return Response.json({ view: resolvedView, trades, page, pageSize, total, tier, loggedIn }, { headers: NO_STORE });
    }
    const preview = await base.orderBy(...orderBy).limit(FREE_PREVIEW_ROWS);
    let total = preview.length;
    try { const [{ n }] = await countQ; total = n; } catch { /* fall back */ }
    const trades = await enrichRows(preview);
    return Response.json({ view: resolvedView, trades, count: trades.length, lockedCount: Math.max(0, total - FREE_PREVIEW_ROWS), total, page: 0, pageSize: FREE_PREVIEW_ROWS, tier, loggedIn }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[insiders_api] failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}
