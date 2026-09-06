import { db } from '../../../../lib/db';
import { insiderTrades, congressTrades } from '../../../../lib/schema';
import { and, eq, inArray, desc, sql } from 'drizzle-orm';

export const runtime = 'nodejs';
export const maxDuration = 60;

const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
const KV_BASE = 'https://powerful-grouper-86116.upstash.io';
const SNAPSHOT_TTL = 24 * 60 * 60;   // 24h — survives nights/weekends; rebuilt every ~15 min

async function kvGet(key) {
  try {
    const r = await fetch(`${KV_BASE}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d?.result) return null;
    try { return JSON.parse(d.result); } catch { return d.result; }
  } catch { return null; }
}
async function kvSet(key, value, ttl) {
  await fetch(`${KV_BASE}/set/${encodeURIComponent(key)}?ex=${ttl}`, {
    method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' }, body: value,
  });
}

const fmtVal = (n) => {
  const v = Number(n);
  if (!v || isNaN(v)) return '—';
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toLocaleString('en-US')}`;
};

// Insider teaser: recent open-market P/S, value floor (≥$100k, relax $25k), capped 10.
async function buildInsiders() {
  const rows = await db.select({
    ticker: insiderTrades.ticker, executive: insiderTrades.executive, title: insiderTrades.title,
    action: insiderTrades.action, totalValue: insiderTrades.totalValue, filingDate: insiderTrades.filingDate,
  }).from(insiderTrades)
    .where(inArray(insiderTrades.action, ['BUY', 'SELL']))
    .orderBy(desc(insiderTrades.filingDate), desc(insiderTrades.totalValue))
    .limit(40);
  const hi = rows.filter(r => Number(r.totalValue) >= 100000);
  const pick = hi.length >= 5 ? hi : rows.filter(r => Number(r.totalValue) >= 25000);
  return pick.slice(0, 10);
}

// Cluster buys: ≥3 distinct insiders, same ticker, 30d.
async function buildClusters() {
  return db.select({
    ticker: insiderTrades.ticker,
    buyers: sql`count(distinct ${insiderTrades.executive})`.mapWith(Number),
    totalValue: sql`sum(${insiderTrades.totalValue})`.mapWith(Number),
    lastBuy: sql`max(${insiderTrades.transactionDate})`,
  }).from(insiderTrades)
    .where(and(eq(insiderTrades.action, 'BUY'), sql`${insiderTrades.transactionDate} >= current_date - interval '30 days'`))
    .groupBy(insiderTrades.ticker)
    .having(sql`count(distinct ${insiderTrades.executive}) >= 3`)
    .orderBy(sql`count(distinct ${insiderTrades.executive}) desc`, sql`sum(${insiderTrades.totalValue}) desc`)
    .limit(5);
}

// Congress teaser: 3 newest trades (flat feed, mirrors /api/politicians?view=feed).
async function buildCongress() {
  return db.select({
    ticker: congressTrades.ticker, representative: congressTrades.representative, party: congressTrades.party,
    state: congressTrades.state, memberSlug: congressTrades.memberSlug, action: congressTrades.action,
    amountRange: congressTrades.amountRange, transactionDate: congressTrades.transactionDate,
  }).from(congressTrades)
    .orderBy(sql`${congressTrades.transactionDate} desc nulls last`, desc(congressTrades.id))
    .limit(3);
}

// NEVER WHITE: if there's no enriched news, synthesize headlines from real filings.
function storyFallback(insiders) {
  return insiders.filter(i => i.action === 'BUY' || i.action === 'SELL').slice(0, 5).map(i => ({
    title: `${i.ticker}: ${i.executive || 'Insider'} ${i.action === 'BUY' ? 'bought' : 'sold'} ${fmtVal(i.totalValue)}`,
    source: 'SEC Form 4', published: null, category: 'SEC', ticker: i.ticker, summary: '', image_url: null,
    url: `/ticker/${i.ticker}`,
  }));
}

function buildCatalysts(insiders, clusters, congress) {
  const topBuys = insiders.filter(i => i.action === 'BUY').sort((a, b) => Number(b.totalValue) - Number(a.totalValue));
  const out = [];
  if (topBuys[0]) out.push({ kind: 'BUY', label: 'LARGEST OPEN-MARKET BUY', sym: topBuys[0].ticker, line: `${topBuys[0].executive || 'Insider'} bought`, value: fmtVal(topBuys[0].totalValue), date: topBuys[0].filingDate });
  if (clusters[0]) out.push({ kind: 'BUY', label: 'CLUSTER BUY · 30D', sym: clusters[0].ticker, line: `${clusters[0].buyers} insiders bought`, value: fmtVal(clusters[0].totalValue), date: clusters[0].lastBuy });
  if (congress[0]) out.push({ kind: congress[0].action === 'BUY' ? 'BUY' : congress[0].action === 'SELL' ? 'SELL' : 'OTHER', label: 'LATEST CONGRESS TRADE', sym: congress[0].ticker, line: `${congress[0].representative} ${congress[0].action === 'BUY' ? 'bought' : congress[0].action === 'SELL' ? 'sold' : 'traded'}`, value: congress[0].amountRange || '—', date: congress[0].transactionDate });
  if (topBuys[1]) out.push({ kind: 'BUY', label: 'OPEN-MARKET BUY', sym: topBuys[1].ticker, line: `${topBuys[1].executive || 'Insider'} bought`, value: fmtVal(topBuys[1].totalValue), date: topBuys[1].filingDate });
  return out;
}

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const startedAt = new Date().toISOString();
  const failed = [];
  const safe = async (label, fn, fallback) => {
    try { return await fn(); }
    catch (e) { console.error(`[pit_snapshot] ${label} failed: ${e.message}`); failed.push({ [label]: e.message }); return fallback; }
  };

  const [insiders, clusters, congress, storiesRaw] = await Promise.all([
    safe('insiders', buildInsiders, []),
    safe('clusters', buildClusters, []),
    safe('congress', buildCongress, []),
    safe('stories',  () => kvGet('catalystpit:top_stories'), null),
  ]);

  const hasNews = Array.isArray(storiesRaw) && storiesRaw.length > 0;
  const stories = hasNews ? storiesRaw.slice(0, 12) : storyFallback(insiders);
  const catalysts = buildCatalysts(insiders, clusters, congress);

  const snapshot = { generatedAt: startedAt, stories, catalysts, insiders, congress, earnings: [] };
  await safe('kv_write', () => kvSet('catalystpit:pit_snapshot', JSON.stringify(snapshot), SNAPSHOT_TTL), null);

  const summary = { generatedAt: startedAt, stories: stories.length, catalysts: catalysts.length,
    insiders: insiders.length, congress: congress.length,
    storiesSource: hasNews ? 'news' : 'filings-fallback', failed };
  console.log(`[pit_snapshot] ${JSON.stringify(summary)}`);
  return Response.json(summary, { status: failed.length ? 207 : 200 });
}
