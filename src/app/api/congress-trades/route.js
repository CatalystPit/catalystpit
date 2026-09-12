import { auth } from '@clerk/nextjs/server';
import { db } from '../../../lib/db';
import { congressTrades } from '../../../lib/schema';
import { and, eq, gte, lte, or, ilike, sql, desc, asc, inArray } from 'drizzle-orm';
import { resolveUserTier } from '../../../lib/entitlements';
import { MAX_HISTORY_DAYS } from '../../../lib/congress-chart.mjs';

export const runtime = 'nodejs';

// Market-wide congressional transactions, filtered and paginated ON THE SERVER.
//
// The existing politician detail page loads every trade for a member and filters in the browser,
// which ships 700+ rows for a heavy filer. Nothing here sends more than one page, and every filter
// is applied in SQL so the count reflects the whole matching set rather than the current page.
//
// Gated the same way as the rest of Politicians: signed out sees a preview plus a locked count,
// and the locked rows never leave the server.

const FREE_PREVIEW_ROWS = 10;
const NO_STORE = { 'Cache-Control': 'private, no-store' };
const PAGE_SIZES = [25, 50, 100];

const SORTS = {
  transaction: congressTrades.transactionDate,
  disclosure: congressTrades.disclosureDate,
  amount: congressTrades.amountMid,        // ranking only; the UI always shows the disclosed range
  delay: congressTrades.filingLagDays,
  ticker: congressTrades.ticker,
  member: congressTrades.representative,
};

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const p = (k) => searchParams.get(k)?.trim() || null;
    const num = (k) => { const n = parseInt(searchParams.get(k) ?? '', 10); return Number.isFinite(n) ? n : null; };

    const conds = [
      // The 3 year cap is enforced here too, not just in the UI, and future-dated rows are excluded
      // (one filing carries a transaction date after its own disclosure date).
      sql`${congressTrades.transactionDate} >= CURRENT_DATE - ${sql.raw(`INTERVAL '${MAX_HISTORY_DAYS} days'`)}`,
      sql`${congressTrades.transactionDate} <= CURRENT_DATE`,
    ];

    const q = p('q');
    if (q) {
      const safe = `%${q.replace(/[%_\\]/g, '')}%`;
      conds.push(or(
        ilike(congressTrades.representative, safe),
        ilike(congressTrades.ticker, safe),
        ilike(congressTrades.assetDescription, safe),
      ));
    }
    const slug = p('slug');       if (slug) conds.push(eq(congressTrades.memberSlug, slug));
    const ticker = p('ticker');   if (ticker) conds.push(eq(congressTrades.ticker, ticker.toUpperCase()));
    const chamber = p('chamber'); if (chamber === 'house' || chamber === 'senate') conds.push(eq(congressTrades.chamber, chamber));
    const party = p('party');     if (party) conds.push(ilike(congressTrades.party, `${party}%`));
    const owner = p('owner');     if (owner) conds.push(ilike(congressTrades.owner, `${owner}%`));

    const action = p('action');
    if (action === 'buy') conds.push(eq(congressTrades.action, 'BUY'));
    else if (action === 'sell') conds.push(eq(congressTrades.action, 'SELL'));
    else if (action === 'other') conds.push(sql`${congressTrades.action} NOT IN ('BUY','SELL')`);

    // Value filters run against the disclosed bracket, not the midpoint: "at least $50,000" means
    // the filer disclosed a range whose ceiling reaches that, which is what a reader expects.
    const minValue = num('minValue'); if (minValue) conds.push(sql`coalesce(${congressTrades.amountMax}, ${congressTrades.amountMin}) >= ${minValue}`);
    const maxValue = num('maxValue'); if (maxValue) conds.push(sql`${congressTrades.amountMin} <= ${maxValue}`);

    const days = num('days'); if (days && days > 0) conds.push(sql`${congressTrades.transactionDate} >= CURRENT_DATE - make_interval(days => ${days})`);
    const from = p('from'); if (from) conds.push(gte(congressTrades.transactionDate, from));
    const to = p('to');     if (to) conds.push(lte(congressTrades.transactionDate, to));
    const maxDelay = num('maxDelay'); if (maxDelay) conds.push(sql`${congressTrades.filingLagDays} <= ${maxDelay}`);
    // Late under the STOCK Act's 45 day rule. A factual threshold from the statute.
    if (searchParams.get('late') === '1') conds.push(sql`${congressTrades.filingLagDays} > 45`);

    const where = conds.length === 1 ? conds[0] : and(...conds);

    const sortKey = SORTS[p('sort')] ? p('sort') : 'transaction';
    const dir = p('dir') === 'asc' ? asc : desc;
    const orderBy = [dir(SORTS[sortKey]), desc(congressTrades.id)];

    const pageSize = PAGE_SIZES.includes(num('pageSize')) ? num('pageSize') : 50;
    const page = Math.max(0, num('page') || 0);

    const tier = await resolveUserTier();
    const { userId } = await auth();
    const loggedIn = !!userId;

    const cols = {
      id: congressTrades.id,
      representative: congressTrades.representative,
      memberSlug: congressTrades.memberSlug,
      chamber: congressTrades.chamber,
      party: congressTrades.party,
      state: congressTrades.state,
      district: congressTrades.district,
      ticker: congressTrades.ticker,
      assetDescription: congressTrades.assetDescription,
      assetType: congressTrades.assetType,
      action: congressTrades.action,
      type: congressTrades.type,
      owner: congressTrades.owner,
      amountRange: congressTrades.amountRange,
      amountMin: congressTrades.amountMin,
      amountMax: congressTrades.amountMax,
      transactionDate: congressTrades.transactionDate,
      disclosureDate: congressTrades.disclosureDate,
      filingLagDays: congressTrades.filingLagDays,
      link: congressTrades.link,
    };

    const [{ n: total }] = await db.select({ n: sql`count(*)`.mapWith(Number) }).from(congressTrades).where(where);

    const take = loggedIn ? pageSize : FREE_PREVIEW_ROWS;
    const skip = loggedIn ? page * pageSize : 0;
    const trades = await db.select(cols).from(congressTrades).where(where).orderBy(...orderBy).limit(take).offset(skip);

    return Response.json({
      trades,
      total,
      page: loggedIn ? page : 0,
      pageSize: take,
      pages: Math.ceil(total / (loggedIn ? pageSize : FREE_PREVIEW_ROWS)),
      lockedCount: loggedIn ? 0 : Math.max(0, total - trades.length),
      sort: sortKey,
      dir: p('dir') === 'asc' ? 'asc' : 'desc',
      tier, loggedIn,
    }, { headers: NO_STORE });
  } catch (e) {
    console.error('[congress_trades]', e);
    return Response.json({ error: 'transactions unavailable' }, { status: 500 });
  }
}
