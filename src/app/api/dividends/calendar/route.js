import { calendarRange, calendarCount, dividendSyncState } from '../../../../lib/dividends/dividend-store';
import { dividendsVisible, dividendsDisplayMode } from '../../../../lib/dividends/providers/index.mjs';
import { dividendYieldPct } from '../../../../lib/dividends/dividend-event.mjs';

// THE DIVIDEND CALENDAR API.
//
// One indexed date-range query over stored events, plus a join to metadata a cron already maintains.
// No provider call, no aggregation, no per-ticker lookup — the calendar is a read.
//
// PUBLICLY CACHEABLE, because every viewer gets the same answer: this is market data, not a
// tier-sliced board, so the CDN can hold it and the origin sees one request per window per minute.
//
// ⚠️ The data behind it currently comes from a TEMPORARY development source whose production
// redistribution rights are unconfirmed, so the response is gated on DIVIDENDS_PUBLIC_ENABLED and
// returns an empty, explicit payload until that is settled.

export const runtime = 'nodejs';
export const maxDuration = 15;

// Five minutes at the edge, a day of stale-while-revalidate: the underlying table changes once a
// day, so this trades nothing for a page that is served from cache almost always.
const CACHE = { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=86400' };
const NO_STORE = { 'Cache-Control': 'private, no-store' };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (v, fallback) => (DAY.test(String(v || '')) ? String(v) : fallback);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** A price older than the screener's own refresh cadence cannot support a yield we would publish. */
const YIELD_MAX_STALE_DAYS = 5;

export async function GET(request) {
  try {
    const sp = new URL(request.url).searchParams;
    const today = new Date().toISOString().slice(0, 10);

    if (!dividendsVisible()) {
      // Deliberately a 200 with an explicit flag rather than a 404: the page renders a clear
      // "not yet available" state, and nothing downstream has to treat this as an error.
      return Response.json({
        enabled: false,
        reason: 'The dividend calendar is switched off pending a licensed market-data source.',
        events: [], total: 0, from: today, to: today, mode: 'ex',
      }, { headers: NO_STORE });
    }

    const mode = sp.get('mode') === 'payment' ? 'payment' : 'ex';
    const from = day(sp.get('from'), today);
    const to = day(sp.get('to'), from);
    // A window wider than a quarter is a data export, not a calendar.
    if (Date.parse(to) - Date.parse(from) > 120 * 86_400_000) {
      return Response.json({ error: 'Range too wide (max 120 days)' }, { status: 400, headers: NO_STORE });
    }

    const filters = {
      search: sp.get('q') || null,
      sector: sp.get('sector') || null,
      minYield: num(sp.get('minYield')),
      minAmount: num(sp.get('minAmount')),
      frequency: sp.get('frequency') != null && sp.get('frequency') !== '' ? num(sp.get('frequency')) : null,
      type: sp.get('type') || null,
      minMarketCap: num(sp.get('minMarketCap')),
      // Default: only securities Catalyst Pit covers, so every row links to a real ticker page.
      covered: sp.get('covered') !== 'all',
    };

    const [rows, total, sync] = await Promise.all([
      calendarRange({ from, to, mode, limit: num(sp.get('limit')) ?? 500, offset: num(sp.get('offset')) ?? 0, ...filters }),
      calendarCount({ from, to, mode, ...filters }),
      dividendSyncState(),
    ]);

    const events = rows.map((r) => {
      const price = num(r.price);
      const priceFresh = sync.updatedAt
        ? (Date.now() - Date.parse(sync.updatedAt)) < YIELD_MAX_STALE_DAYS * 86_400_000
        : false;
      return {
        ticker: r.ticker,
        company: r.company || null,
        sector: r.sector || null,
        marketCap: num(r.market_cap),
        exDividendDate: r.ex_dividend_date ? String(r.ex_dividend_date).slice(0, 10) : null,
        // Never inferred. A provider that has not published one leaves this null and the UI shows "—".
        paymentDate: r.payment_date ? String(r.payment_date).slice(0, 10) : null,
        recordDate: r.record_date ? String(r.record_date).slice(0, 10) : null,
        declarationDate: r.declaration_date ? String(r.declaration_date).slice(0, 10) : null,
        cashAmount: num(r.cash_amount),
        currency: r.currency || null,
        dividendType: r.dividend_type || 'unknown',
        frequency: r.frequency == null ? null : Number(r.frequency),
        annualizedAmount: num(r.annualized_amount),
        // Computed from the price we already store, and omitted entirely when that price is stale or
        // absent. A yield is a number people size positions with.
        yieldPct: priceFresh ? dividendYieldPct(r.annualized_amount, price) : null,
      };
    });

    return Response.json({
      enabled: true, mode, from, to, total, events,
      // 'prelaunch' means real data from a TEMPORARY source, not cleared for public redistribution.
      display: dividendsDisplayMode(),
      asOf: sync.updatedAt, source: 'scheduled-ingest',
    }, { headers: CACHE });
  } catch (e) {
    console.log(`[dividend-calendar] ${e.message}`);
    return Response.json({ enabled: true, events: [], total: 0, error: 'unavailable' }, { status: 200, headers: NO_STORE });
  }
}
