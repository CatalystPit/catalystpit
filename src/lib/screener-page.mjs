// ── THE SCREENER'S OPENING PAGE, FOR A READER WITH NO JAVASCRIPT ───────────
//
// ⚠️ MEASURED ON PRODUCTION AS GOOGLEBOT: /screener SERVED FOUR WORDS. Not four hundred — four.
// A page advertised in our own sitemap at priority 0.7, aimed at one of the highest-volume
// non-branded phrases in the category ("stock screener"), whose entire content arrived in an
// effect. It was the worst room in the product by a wide margin.
//
// ⚠️ WHY THIS IS EOD AND THEREFORE PUBLISHABLE. screener_stocks.price, .changePct and .volume are
// written by rebuildScreener FROM ticker_daily_candles — the schema says so ("price / volume (from
// candles — our warmed set)") and so does the market-cap derivation beside it ("the last LICENSED
// close"). They are previous-session closing values, which is exactly the basis that may be shown
// to a guest or a crawler. The per-viewer delayed and real-time overlay is a SEPARATE concern:
// ScreenerClient fetches /api/quotes after hydration and paints over these cells for an entitled
// reader. Nothing delayed and nothing real-time is rendered here, so nothing of either can be
// cached here.
//
// ⚠️ AND IT IS THE DEFAULT SCREEN, NOT A SECOND INTERPRETATION OF ONE. ScreenerClient opens with no
// filters, sort `insiderNet90d`, descending, page 0 — so the shape it renders first is exactly
// this. The ordering rule is the route's, imported rather than restated: SORT_MAP for the column,
// `nulls last` in both directions, and the ticker tiebreak that keeps pagination stable. The
// filter layer stays in the route, where it belongs: fifteen optional parameters are a property of
// a request, not of a shared page.
import { db } from './db';
import { screenerStocks } from './schema';
import { asc, sql } from 'drizzle-orm';
import { SORT_MAP } from './screener-filters';

/**
 * The sort the screener opens on.
 *
 * ⚠️ IT MUST EQUAL ScreenerClient's OWN useState DEFAULT or the server renders one ranking and the
 * browser's first render produces another — a hydration mismatch, which means React throws the
 * server's HTML away and the copy a crawler read is the one nobody checked. verify-rooms-ssr pins
 * the two together.
 */
export const SCREENER_DEFAULT_SORT = 'insiderNet90d';
export const SCREENER_DEFAULT_PAGE_SIZE = 50;

/**
 * The unfiltered first page of the screener, in /api/screener's own payload shape.
 *
 * ⚠️ NULLS LAST, AND THAT IS NOT A DETAIL. Postgres orders NULLS FIRST on DESC and drizzle's desc()
 * adds no NULLS clause, so every descending numeric sort this screener offered once returned a
 * first page that was 100% nulls — the default view buried its own ranking under 14,828 empty rows
 * while the largest disclosed net insider buying in the table sat on page 297 of 361. A null is
 * "we do not know", and an unknown must never outrank a known value in a ranking view.
 *
 * @returns {Promise<{rows: object[], total: number, page: number, pageSize: number, activeCount: number}|null>}
 */
export async function screenerDefaultPage({ pageSize = SCREENER_DEFAULT_PAGE_SIZE } = {}) {
  const sortCol = SORT_MAP[SCREENER_DEFAULT_SORT] || screenerStocks.marketCap;
  const [rows, counted] = await Promise.all([
    db.select().from(screenerStocks)
      .orderBy(sql`${sortCol} desc nulls last`, asc(screenerStocks.ticker))
      .limit(pageSize).offset(0),
    db.select({ n: sql`count(*)`.mapWith(Number) }).from(screenerStocks),
  ]);
  if (!rows.length) return null;
  return {
    rows,
    total: counted?.[0]?.n ?? rows.length,
    page: 0,
    pageSize,
    // No filters were applied, and saying so is what keeps the chip counter honest.
    activeCount: 0,
  };
}
