import DividendsClient from './DividendsClient';
import { pageMeta } from '../../lib/seo';
import { calendarRange, calendarCount, calendarSectorCounts, dividendSyncState } from '../../lib/dividends/dividend-store';
import { dividendsVisible, dividendsDisplayMode } from '../../lib/dividends/providers/index.mjs';
import { dividendYieldPct } from '../../lib/dividends/dividend-event.mjs';

export const metadata = pageMeta({
  title: { absolute: 'Dividend Calendar · Upcoming Ex-Dividend and Payment Dates · CatalystPit' },
  description: 'Announced dividends across the market: ex-dividend dates, payment dates, amounts and frequency. Confirmed events only — never estimated.',
  path: '/dividends',
});

// ONE PAGE, ONE ROUTE. Deliberately not a URL per day or per ticker: a calendar that generates
// thousands of near-identical pages is index bloat, and the useful thing to crawl is this one.

// ── ⚠️ THIS WAS `dynamic = 'force-dynamic'`, AND IT WAS THE LAST ROOM STILL ANSWERING no-store ──
//
// Measured on production as Googlebot: this page already server-renders its research properly —
// 4,958 words and 298 links to /ticker/, more than any other room — and it paid for all of it on
// EVERY request, with `x-vercel-cache: MISS` on an immediate repeat. Four queries and a 300-row
// render answered every crawl of the heaviest page in the product.
//
// Three things had to be true before this could become a shared copy, and each was checked rather
// than assumed:
//
//   1. NOTHING HERE IS ENTITLED. The calendar is public and unauthenticated — no auth(), no tier,
//      no lockedCount — so one cached copy reaches exactly the audience the per-request copy did.
//      `yieldPct` is derived from the store's own price, already behind its own 5-day `fresh`
//      guard, and is already served to every anonymous visitor. Caching it changes WHEN it is
//      computed, not WHO may see it.
//   2. THE COMMERCIAL GATE STILL WORKS. dividendsDisplayMode() reads DIVIDENDS_PUBLIC_ENABLED, and
//      that switch already required a redeploy to take effect — Vercel bakes env vars into a
//      deployment, so a dashboard change never reached the running function either way. A redeploy
//      rebuilds this page, so the kill switch is exactly as immediate as it was before.
//   3. THE DAY BOUNDARY CANNOT GO STALE UNNOTICED. `today` is computed at generation time, so for
//      up to one window after UTC midnight a cached copy would open on yesterday. DividendsClient
//      deliberately does NOT refetch on mount — "the server already rendered the opening week" —
//      so nothing would have corrected it. It now self-heals that one case, and only that case.
//
// The window matches the other rooms (lib/rooms-server.mjs) and is far shorter than the dividend
// sync cadence that writes what this reads, which is the rule /api/market was corrected to follow:
// a TTL may be shorter than the write cadence but never longer.
export const revalidate = 300;

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
  const enabled = dividendsVisible();
  const display = dividendsDisplayMode();
  const today = iso(new Date());
  const to = shift(today, 7);

  if (!enabled) {
    return <DividendsClient enabled={false} display={display} initial={{ events: [], total: 0, from: today, to, mode: 'ex' }} />;
  }

  let initial = { events: [], total: 0, from: today, to, mode: 'ex', asOf: null };
  try {
    // The facet is fetched with the first paint for the same reason the rows are: a dropdown that
    // acquires its counts only after a client round trip shows "All sectors" with no numbers for
    // the first second, and then renumbers itself under the reader.
    const [rows, total, sectors, sync] = await Promise.all([
      calendarRange({ from: today, to, limit: 300 }),
      calendarCount({ from: today, to }),
      calendarSectorCounts({ from: today, to }),
      dividendSyncState(),
    ]);
    const fresh = sync.updatedAt ? (Date.now() - Date.parse(sync.updatedAt)) < 5 * 86_400_000 : false;
    initial = {
      from: today, to, mode: 'ex', total, sectors, asOf: sync.updatedAt,
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

  return <DividendsClient enabled display={display} initial={initial} />;
}
