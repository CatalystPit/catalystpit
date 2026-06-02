import { auth } from '@clerk/nextjs/server';
import { db } from '../../../lib/db';
import { congressTrades, congressTickerPrices } from '../../../lib/schema';
import { and, eq, desc, sql } from 'drizzle-orm';

export const runtime = 'nodejs';

// AUTH gate (sign-in, NOT tier — mirrors /api/news): signed-in users of ANY tier
// get the full set; signed-out get a FREE_PREVIEW_ROWS preview + lockedCount, with
// the locked rows never leaving the server. Response varies by auth → never CDN-cached.
const FREE_PREVIEW_ROWS = 10;
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// bioguide slug -> headshot; name-slug (unmatched member) -> null (initials avatar)
const photoUrl = (slug) =>
  /^[A-Z]\d{6}$/.test(slug || '')
    ? `https://unitedstates.github.io/images/congress/225x275/${slug}.jpg`
    : null;

// returnPct is null (NOT 0) unless BOTH prices exist — so a missing price renders
// "—" on the page and never collapses into a false "0.0%". A genuinely unchanged
// price yields a real 0. (null vs number keeps the two cases distinct.)
const computeReturn = (priceAtTrade, currentPrice) =>
  (priceAtTrade != null && currentPrice != null && priceAtTrade > 0)
    ? +(((currentPrice - priceAtTrade) / priceAtTrade) * 100).toFixed(1)
    : null;

// Columns shared by the detail + ticker trade tables (joined to current price).
const tradeCols = {
  id:               congressTrades.id,
  ticker:           congressTrades.ticker,
  assetDescription: congressTrades.assetDescription,
  owner:            congressTrades.owner,
  type:             congressTrades.type,
  action:           congressTrades.action,
  amountRange:      congressTrades.amountRange,
  amountMid:        congressTrades.amountMid,
  transactionDate:  congressTrades.transactionDate,
  disclosureDate:   congressTrades.disclosureDate,
  filingLagDays:    congressTrades.filingLagDays,
  priceAtTrade:     congressTrades.priceAtTrade,
  currentPrice:     congressTickerPrices.currentPrice,
  // member fields — needed by ticker view, where rows span members
  slug:             congressTrades.memberSlug,
  representative:   congressTrades.representative,
  party:            congressTrades.party,
  state:            congressTrades.state,
  chamber:          congressTrades.chamber,
};

const shapeTrade = (t) => ({ ...t, returnPct: computeReturn(t.priceAtTrade, t.currentPrice) });

const LIST_ORDER = {
  most_active: sql`count(*) desc`,
  top_volume:  sql`coalesce(sum(${congressTrades.amountMid}), 0) desc`,
  recent:      sql`max(${congressTrades.transactionDate}) desc nulls last`,
};

// LIST: one card per member (grouped by slug). Optional chamber/party filters.
async function listView({ view, chamber, party }) {
  const conds = [];
  if (chamber === 'senate' || chamber === 'house') conds.push(eq(congressTrades.chamber, chamber));
  if (party) conds.push(eq(congressTrades.party, party));

  const members = await db.select({
    slug:        congressTrades.memberSlug,
    name:        sql`max(${congressTrades.representative})`,
    party:       sql`max(${congressTrades.party})`,
    state:       sql`max(${congressTrades.state})`,
    chamber:     sql`max(${congressTrades.chamber})`,
    tradeCount:  sql`count(*)`.mapWith(Number),
    totalVolume: sql`coalesce(sum(${congressTrades.amountMid}), 0)`.mapWith(Number),
    lastTraded:  sql`max(${congressTrades.transactionDate})`,
    buys:        sql`count(*) filter (where ${congressTrades.action} = 'BUY')`.mapWith(Number),
    sells:       sql`count(*) filter (where ${congressTrades.action} = 'SELL')`.mapWith(Number),
  })
    .from(congressTrades)
    .where(conds.length ? and(...conds) : undefined)
    .groupBy(congressTrades.memberSlug)
    .orderBy(LIST_ORDER[view] || LIST_ORDER.most_active)
    .limit(600);

  return members.map(m => ({ ...m, photoUrl: photoUrl(m.slug) }));
}

// DETAIL: header aggregates + full trade history (return-since-trade per row).
async function detailView(slug) {
  const rows = await db.select(tradeCols)
    .from(congressTrades)
    .leftJoin(congressTickerPrices, eq(congressTickerPrices.ticker, congressTrades.ticker))
    .where(eq(congressTrades.memberSlug, slug))
    .orderBy(desc(congressTrades.transactionDate), desc(congressTrades.id))
    .limit(2000);

  if (!rows.length) return { view: 'detail', slug, member: null, trades: [] };

  const lags = rows.map(r => r.filingLagDays).filter(n => n != null);
  const member = {
    slug,
    name:            rows[0].representative,
    party:           rows[0].party,
    state:           rows[0].state,
    chamber:         rows[0].chamber,
    photoUrl:        photoUrl(slug),
    tradeCount:      rows.length,
    totalVolume:     rows.reduce((s, r) => s + (r.amountMid || 0), 0),
    lastTraded:      rows[0].transactionDate,
    distinctTickers: new Set(rows.map(r => r.ticker).filter(Boolean)).size,
    avgFilingLag:    lags.length ? Math.round(lags.reduce((a, b) => a + b, 0) / lags.length) : null,
  };
  return { view: 'detail', slug, member, trades: rows.map(shapeTrade) };
}

// TICKER drill-down: every member who traded a given ticker (mirrors /insiders).
async function tickerView(ticker) {
  const rows = await db.select(tradeCols)
    .from(congressTrades)
    .leftJoin(congressTickerPrices, eq(congressTickerPrices.ticker, congressTrades.ticker))
    .where(eq(congressTrades.ticker, ticker))
    .orderBy(desc(congressTrades.disclosureDate), desc(congressTrades.id))
    .limit(500);
  return { view: 'ticker', ticker, count: rows.length, trades: rows.map(shapeTrade) };
}

// FEED: flat most-recent individual trades (NOT grouped by member). For homepage
// teasers — no price join, no returnPct (homepage shows who-traded-what only).
async function feedView(limit) {
  const trades = await db.select({
    id:              congressTrades.id,
    ticker:          congressTrades.ticker,
    representative:  congressTrades.representative,
    party:           congressTrades.party,
    state:           congressTrades.state,
    memberSlug:      congressTrades.memberSlug,
    action:          congressTrades.action,
    amountRange:     congressTrades.amountRange,
    transactionDate: congressTrades.transactionDate,
  })
    .from(congressTrades)
    .orderBy(sql`${congressTrades.transactionDate} desc nulls last`, desc(congressTrades.id))
    .limit(limit);
  return { view: 'feed', count: trades.length, trades };
}

export async function GET(request) {
  try {
    const { userId } = await auth();
    const loggedIn = !!userId;

    const { searchParams } = new URL(request.url);
    const slug    = searchParams.get('slug')?.trim();
    const ticker  = searchParams.get('ticker')?.toUpperCase().trim();
    const view    = searchParams.get('view') || 'most_active';
    const chamber = searchParams.get('chamber') || null;
    const party   = searchParams.get('party') || null;
    const limit   = Math.min(Math.max(parseInt(searchParams.get('limit') ?? '10', 10) || 10, 1), 50);

    // Member detail — LEFT UNGATED. The /politicians/[slug] page shows a member's
    // full history with no sign-in CTA; capping would silently truncate it. (Flagged.)
    if (slug) {
      const payload = await detailView(slug);
      console.log(`[politicians_api] detail slug=${slug} trades=${payload.trades.length} loggedIn=${loggedIn}`);
      return Response.json({ ...payload, loggedIn }, { headers: NO_STORE });
    }
    // Ticker drill-down — LEFT UNGATED (shared with the /ticker government tab, no CTA). (Flagged.)
    if (ticker) {
      const payload = await tickerView(ticker);
      console.log(`[politicians_api] ticker=${ticker} trades=${payload.count} loggedIn=${loggedIn}`);
      return Response.json({ ...payload, loggedIn }, { headers: NO_STORE });
    }
    // Feed (homepage teaser) — AUTH-GATED. Signed-out capped to the preview.
    if (view === 'feed') {
      const payload = await feedView(limit);
      const trades = loggedIn ? payload.trades : payload.trades.slice(0, FREE_PREVIEW_ROWS);
      const lockedCount = loggedIn ? 0 : Math.max(0, payload.trades.length - FREE_PREVIEW_ROWS);
      console.log(`[politicians_api] feed trades=${trades.length} locked=${lockedCount} loggedIn=${loggedIn}`);
      return Response.json({ view: 'feed', count: trades.length, trades, lockedCount, loggedIn }, { headers: NO_STORE });
    }
    // Member list — AUTH-GATED. Signed-in: full. Signed-out: first 10 + lockedCount.
    const members = await listView({ view, chamber, party });
    const shown = loggedIn ? members : members.slice(0, FREE_PREVIEW_ROWS);
    const lockedCount = loggedIn ? 0 : Math.max(0, members.length - FREE_PREVIEW_ROWS);
    console.log(`[politicians_api] list view=${view} members=${shown.length} locked=${lockedCount} loggedIn=${loggedIn}`);
    return Response.json({ view, count: shown.length, members: shown, lockedCount, loggedIn }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[politicians_api] failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}
