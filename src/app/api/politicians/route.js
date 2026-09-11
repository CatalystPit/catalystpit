import { auth } from '@clerk/nextjs/server';
import { db } from '../../../lib/db';
import { congressTrades, congressTickerPrices } from '../../../lib/schema';
import { and, eq, desc, sql, or, ilike } from 'drizzle-orm';
import { resolveUserTier } from '../../../lib/entitlements';

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
  currentPrice:     congressTickerPrices.currentPrice,
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
const shapeTrade = (t) => {
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
  return {
    ...t, returnPct: computeReturn(t.priceAtTrade, t.currentPrice),
    optionType, assetName,
    strike: strike ? strike.replace(/,/g, '') : null,
    expiration: expiration || null,
    contracts: contracts ? contracts.replace(/,/g, '') : null,
    shares: shares ? shares.replace(/,/g, '') : null,
    estShares,
  };
};

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
const LB_WINDOWS = { '3m': '3 months', '6m': '6 months', '1y': '1 year', '2y': '2 years' };  // 'all' → no window
async function leaderboardView({ chamber, party, min = 5, window = '1y' }) {
  const conds = [
    eq(congressTrades.action, 'BUY'),
    sql`${congressTrades.priceAtTrade} > 0`,
    sql`${congressTickerPrices.currentPrice} > 0`,
  ];
  // Time frame: count only buys whose trade date is within the window, so members are compared
  // over the SAME period (not penalizing/rewarding differing holding lengths). 'all' = no filter.
  const interval = window === 'all' ? null : (LB_WINDOWS[window] || '1 year');
  if (interval) conds.push(sql`${congressTrades.transactionDate} >= CURRENT_DATE - ${sql.raw(`INTERVAL '${interval}'`)}`);
  if (chamber === 'house' || chamber === 'senate') conds.push(eq(congressTrades.chamber, chamber));
  if (party) conds.push(eq(congressTrades.party, party));

  const rows = await db.select({
    slug:       congressTrades.memberSlug,
    name:       sql`max(${congressTrades.representative})`,
    party:      sql`max(${congressTrades.party})`,
    state:      sql`max(${congressTrades.state})`,
    chamber:    sql`max(${congressTrades.chamber})`,
    pricedBuys: sql`count(*)`.mapWith(Number),
    weight:     sql`coalesce(sum(${congressTrades.amountMid}), 0)`.mapWith(Number),
    wret:       sql`coalesce(sum(${congressTrades.amountMid} * (${congressTickerPrices.currentPrice} - ${congressTrades.priceAtTrade}) / ${congressTrades.priceAtTrade}), 0)`.mapWith(Number),
    wins:       sql`sum(case when ${congressTickerPrices.currentPrice} > ${congressTrades.priceAtTrade} then 1 else 0 end)`.mapWith(Number),
  })
    .from(congressTrades)
    .leftJoin(congressTickerPrices, eq(congressTickerPrices.ticker, congressTrades.ticker))
    .where(and(...conds))
    .groupBy(congressTrades.memberSlug)
    .having(sql`count(*) >= ${min}`);

  return rows
    .map((r) => ({
      slug: r.slug, name: r.name, party: r.party, state: r.state, chamber: r.chamber,
      photoUrl: photoUrl(r.slug),
      pricedBuys: r.pricedBuys,
      totalVolume: r.weight,
      returnPct: r.weight > 0 ? +((r.wret / r.weight) * 100).toFixed(1) : null,
      winRate: r.pricedBuys > 0 ? Math.round((r.wins / r.pricedBuys) * 100) : null,
    }))
    .filter((m) => m.returnPct != null)
    .sort((a, b) => b.returnPct - a.returnPct);
}

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
      const trades = isPro ? payload.trades : payload.trades.slice(0, FREE_PREVIEW_ROWS);
      const lockedCount = isPro ? 0 : Math.max(0, payload.trades.length - FREE_PREVIEW_ROWS);
      console.log(`[politicians_api] feed trades=${trades.length} locked=${lockedCount} tier=${tier}`);
      return Response.json({ view: 'feed', count: trades.length, trades, lockedCount, tier, loggedIn }, { headers: NO_STORE });
    }
    // Leaderboard — "Best Traders in Congress". Gated like the list (top preview free).
    if (view === 'leaderboard') {
      const min = Math.min(Math.max(parseInt(searchParams.get('min') ?? '5', 10) || 5, 1), 50);
      const window = searchParams.get('window') || '1y';
      const all = await leaderboardView({ chamber, party, min, window });
      const shown = isPro ? all : all.slice(0, FREE_PREVIEW_ROWS);
      const lockedCount = isPro ? 0 : Math.max(0, all.length - FREE_PREVIEW_ROWS);
      console.log(`[politicians_api] leaderboard members=${shown.length} window=${window} locked=${lockedCount} tier=${tier}`);
      return Response.json({ view: 'leaderboard', window, count: shown.length, members: shown, lockedCount, tier, loggedIn }, { headers: NO_STORE });
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
