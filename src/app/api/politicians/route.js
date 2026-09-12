import { auth } from '@clerk/nextjs/server';
import { db } from '../../../lib/db';
import { congressTrades, congressTickerPrices } from '../../../lib/schema';
import { and, eq, desc, sql, or, ilike } from 'drizzle-orm';
import { resolveUserTier } from '../../../lib/entitlements';
import { leaderboardView, photoUrl, LB_WINDOWS, shapeTrade, computeReturn, tradeCols } from '../../../lib/congress-overview';

export const runtime = 'nodejs';

// AUTH gate (sign-in, NOT tier — mirrors /api/news): signed-in users of ANY tier
// get the full set; signed-out get a FREE_PREVIEW_ROWS preview + lockedCount, with
// the locked rows never leaving the server. Response varies by auth → never CDN-cached.
const FREE_PREVIEW_ROWS = 10;
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// bioguide slug -> headshot; name-slug (unmatched member) -> null (initials avatar)

// returnPct is null (NOT 0) unless BOTH prices exist — so a missing price renders
// "—" on the page and never collapses into a false "0.0%". A genuinely unchanged
// price yields a real 0. (null vs number keeps the two cases distinct.)
// computeReturn + shapeTrade now live in lib/congress-overview so the detail page, the ticker
// view and the new transactions API all derive option and share fields identically.

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

// LEADERBOARD: "Best Traders in Congress" — each member's SIZE-WEIGHTED return across their
// PURCHASES that we can price (priceAtTrade + current_price), i.e. "if you'd copied their buys
// and held to today." Weighted by amount so a $1M buy counts more than a $1k one. A sample-size
// floor (min priced buys) keeps a lucky single trade from topping the board.
// leaderboardView now lives in lib/congress-overview so the Politicians page and the Congress
// overview cannot drift apart. Two copies of a ranking method is how the Form 4 parser ended up
// with two divergent implementations.

// AUTOCOMPLETE: member name typeahead → top matches by trade activity. Public (names only),
// ungated — drives the /politicians search box. Matches full display name + first/last.
async function searchView(q) {
  const like = `%${q.replace(/[%_\\]/g, '')}%`;
  const rows = await db.select({
    slug:    congressTrades.memberSlug,
    name:    sql`max(${congressTrades.representative})`,
    party:   sql`max(${congressTrades.party})`,
    state:   sql`max(${congressTrades.state})`,
    chamber: sql`max(${congressTrades.chamber})`,
    trades:  sql`count(*)`.mapWith(Number),
  })
    .from(congressTrades)
    .where(or(
      ilike(congressTrades.representative, like),
      ilike(congressTrades.lastName, like),
      ilike(congressTrades.firstName, like),
    ))
    .groupBy(congressTrades.memberSlug)
    .orderBy(sql`count(*) desc`)
    .limit(8);
  return rows.map((m) => ({ slug: m.slug, name: m.name, party: m.party, state: m.state, chamber: m.chamber, trades: m.trades, photoUrl: photoUrl(m.slug) }));
}

// DETAIL: header aggregates + full trade history (return-since-trade per row).
// withTrades:false returns ONLY the member header, computed as SQL aggregates. The detail page
// now pages its trades through /api/congress-trades, so pulling up to 2,000 rows here purely to
// count them and average a lag was the last place a heavy filer's history hit the server in bulk.
async function detailView(slug, { withTrades = true } = {}) {
  if (!withTrades) {
    const [agg] = await db.select({
      name: sql`max(${congressTrades.representative})`,
      party: sql`max(${congressTrades.party})`,
      state: sql`max(${congressTrades.state})`,
      chamber: sql`max(${congressTrades.chamber})`,
      tradeCount: sql`count(*)`.mapWith(Number),
      totalVolume: sql`coalesce(sum(${congressTrades.amountMid}), 0)`.mapWith(Number),
      lastTraded: sql`max(${congressTrades.transactionDate})`,
      distinctTickers: sql`count(distinct ${congressTrades.ticker})`.mapWith(Number),
      avgFilingLag: sql`round(avg(${congressTrades.filingLagDays}))`.mapWith(Number),
    }).from(congressTrades).where(eq(congressTrades.memberSlug, slug));
    if (!agg || !agg.tradeCount) return { view: 'detail', slug, member: null, trades: [] };
    return { view: 'detail', slug, member: { slug, photoUrl: photoUrl(slug), ...agg }, trades: [] };
  }
  return detailViewFull(slug);
}

async function detailViewFull(slug) {
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
    const { searchParams } = new URL(request.url);

    // AUTOCOMPLETE (public, ungated) — return before auth/tier work for a fast typeahead.
    const ac = searchParams.get('ac');
    if (ac != null) {
      const q = ac.trim();
      if (q.length < 2) return Response.json({ results: [] }, { headers: NO_STORE });
      return Response.json({ results: await searchView(q) }, { headers: NO_STORE });
    }

    const { userId } = await auth();
    const loggedIn = !!userId;
    const tier = await resolveUserTier();
    const isPro = tier === 'pro' || tier === 'elite';   // Pro gate (not just sign-in) for feed + list

    const slug    = searchParams.get('slug')?.trim();
    const ticker  = searchParams.get('ticker')?.toUpperCase().trim();
    const view    = searchParams.get('view') || 'most_active';
    const chamber = searchParams.get('chamber') || null;
    const party   = searchParams.get('party') || null;
    const limit   = Math.min(Math.max(parseInt(searchParams.get('limit') ?? '10', 10) || 10, 1), 50);

    // Member detail — LEFT UNGATED. The /politicians/[slug] page shows a member's
    // full history with no sign-in CTA; capping would silently truncate it. (Flagged.)
    if (slug) {
      const payload = await detailView(slug, { withTrades: searchParams.get('trades') !== '0' });
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
      const trades = isPro ? payload.trades : payload.trades.slice(0, FREE_PREVIEW_ROWS);
      const lockedCount = isPro ? 0 : Math.max(0, payload.trades.length - FREE_PREVIEW_ROWS);
      console.log(`[politicians_api] feed trades=${trades.length} locked=${lockedCount} tier=${tier}`);
      return Response.json({ view: 'feed', count: trades.length, trades, lockedCount, tier, loggedIn }, { headers: NO_STORE });
    }
    // Leaderboard — "Best Traders in Congress". Gated like the list (top preview free).
    if (view === 'leaderboard') {
      const min = Math.min(Math.max(parseInt(searchParams.get('min') ?? '5', 10) || 5, 1), 50);
      const window = searchParams.get('window') || '1y';
      const { list, meta } = await leaderboardView({ chamber, party, min, window });
      const shown = isPro ? list : list.slice(0, FREE_PREVIEW_ROWS);
      const lockedCount = isPro ? 0 : Math.max(0, list.length - FREE_PREVIEW_ROWS);
      console.log(`[politicians_api] leaderboard members=${shown.length} window=${window} locked=${lockedCount} tier=${tier}`);
      return Response.json({ view: 'leaderboard', window, count: shown.length, members: shown, meta, lockedCount, tier, loggedIn }, { headers: NO_STORE });
    }
    // Member list — AUTH-GATED. Signed-in: full. Signed-out: first 10 + lockedCount.
    const members = await listView({ view, chamber, party });
    const shown = isPro ? members : members.slice(0, FREE_PREVIEW_ROWS);
    const lockedCount = isPro ? 0 : Math.max(0, members.length - FREE_PREVIEW_ROWS);
    console.log(`[politicians_api] list view=${view} members=${shown.length} locked=${lockedCount} tier=${tier}`);
    return Response.json({ view, count: shown.length, members: shown, lockedCount, tier, loggedIn }, { headers: NO_STORE });
  } catch (e) {
    console.log(`[politicians_api] failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}
