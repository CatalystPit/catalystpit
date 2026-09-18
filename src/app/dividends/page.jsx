import DividendsClient from './DividendsClient';
import { pageMeta } from '../../lib/seo';
import { calendarRange, calendarCount, dividendSyncState } from '../../lib/dividends/dividend-store';
import { dividendsPublicEnabled } from '../../lib/dividends/providers/index.mjs';
import { dividendYieldPct } from '../../lib/dividends/dividend-event.mjs';

export const metadata = pageMeta({
  title: { absolute: 'Dividend Calendar · Upcoming Ex-Dividend and Payment Dates · CatalystPit' },
  description: 'Announced dividends across the market: ex-dividend dates, payment dates, amounts and frequency. Confirmed events only — never estimated.',
  path: '/dividends',
});

// ONE PAGE, ONE ROUTE. Deliberately not a URL per day or per ticker: a calendar that generates
// thousands of near-identical pages is index bloat, and the useful thing to crawl is this one.
export const dynamic = 'force-dynamic';

const iso = (d) => d.toISOString().slice(0, 10);
const shift = (base, days) => { const d = new Date(`${base}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return iso(d); };

/**
 * SERVER-RENDERED FIRST PAINT.
 *
 * The initial week is read straight from the store — no HTTP hop back into our own API, no client
 * waterfall — so the table is in the HTML for a crawler and for the reader's first frame. The client
 * component takes over for tabs, filters and the date/payment toggles.
 */
export default async function DividendsPage() {
  const enabled = dividendsPublicEnabled();
  const today = iso(new Date());
  const to = shift(today, 7);

  if (!enabled) {
    return <DividendsClient enabled={false} initial={{ events: [], total: 0, from: today, to, mode: 'ex' }} />;
  }

  let initial = { events: [], total: 0, from: today, to, mode: 'ex', asOf: null };
  try {
    const [rows, total, sync] = await Promise.all([
      calendarRange({ from: today, to, limit: 300 }),
      calendarCount({ from: today, to }),
      dividendSyncState(),
    ]);
    const fresh = sync.updatedAt ? (Date.now() - Date.parse(sync.updatedAt)) < 5 * 86_400_000 : false;
    initial = {
      from: today, to, mode: 'ex', total, asOf: sync.updatedAt,
      events: rows.map((r) => ({
        ticker: r.ticker,
        company: r.company || null,
        sector: r.sector || null,
        marketCap: r.market_cap == null ? null : Number(r.market_cap),
        exDividendDate: r.ex_dividend_date ? String(r.ex_dividend_date).slice(0, 10) : null,
        paymentDate: r.payment_date ? String(r.payment_date).slice(0, 10) : null,
        cashAmount: r.cash_amount == null ? null : Number(r.cash_amount),
        currency: r.currency || null,
        dividendType: r.dividend_type || 'unknown',
        frequency: r.frequency == null ? null : Number(r.frequency),
        annualizedAmount: r.annualized_amount == null ? null : Number(r.annualized_amount),
        yieldPct: fresh ? dividendYieldPct(r.annualized_amount, r.price) : null,
      })),
    };
  } catch {
    // A failed first paint is an empty table the client will refill, not a broken page.
  }

  return <DividendsClient enabled initial={initial} />;
}
