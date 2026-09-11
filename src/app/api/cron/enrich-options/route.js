// Cron: price disclosed OPTION trades with real Polygon option-contract prices (leveraged return
// for the leaderboard). Polygon rate-limits option aggregates (~5/min), so this is deliberately
// small + frequent: it prices a few un-priced options per run and refreshes a few live ones.
import { db } from '../../../../lib/db';
import { congressTrades } from '../../../../lib/schema';
import { and, eq, or, ilike, isNull, isNotNull, sql } from 'drizzle-orm';
import { priceOption } from '../../../../lib/congress-options.mjs';

export const runtime = 'nodejs';
export const maxDuration = 60;

const CRON_SECRET = process.env.CRON_SECRET;
const K = process.env.POLYGON_API_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isOpt = or(ilike(congressTrades.assetType, '%option%'), eq(congressTrades.assetType, 'OP'));

async function priceAndStore(r, results) {
  try {
    const { occ, priceAtTrade, currentPrice } = await priceOption(
      { ticker: r.ticker, transactionDate: r.transactionDate, comment: r.comment, assetDescription: r.assetDescription }, K);
    await db.update(congressTrades)
      .set({ optionOcc: occ || '', optionPriceAtTrade: priceAtTrade ?? null, optionCurrentPrice: currentPrice ?? null, optionPricedAt: new Date() })
      .where(eq(congressTrades.id, r.id));
    if (occ && priceAtTrade != null && currentPrice != null) results.priced++;
    else results.miss++;
  } catch (e) { results.errors.push(`${r.id}:${e.message}`); }
}

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const results = { priced: 0, miss: 0, refreshed: 0, errors: [], ts: new Date().toISOString() };
  const cols = {
    id: congressTrades.id, ticker: congressTrades.ticker, transactionDate: congressTrades.transactionDate,
    comment: congressTrades.comment, assetDescription: congressTrades.assetDescription,
  };

  // 1) price never-attempted option trades (newest first)
  const todo = await db.select(cols).from(congressTrades)
    .where(and(isOpt, isNotNull(congressTrades.ticker), isNull(congressTrades.optionPricedAt)))
    .orderBy(sql`${congressTrades.transactionDate} desc nulls last`).limit(4);
  for (const r of todo) { await priceAndStore(r, results); await sleep(12500); }

  // 2) refresh a couple of already-priced live options (oldest refresh first) so current prices roll
  if (todo.length < 3) {
    const refresh = await db.select(cols).from(congressTrades)
      .where(and(isOpt, isNotNull(congressTrades.optionOcc), sql`${congressTrades.optionOcc} <> ''`, isNotNull(congressTrades.optionCurrentPrice)))
      .orderBy(sql`${congressTrades.optionPricedAt} asc nulls first`).limit(2);
    for (const r of refresh) { await priceAndStore(r, results); results.refreshed++; await sleep(12500); }
  }

  return Response.json(results, { status: 200 });
}
