import { Suspense } from 'react';
import ScreenerClient from './ScreenerClient';
import { pageMeta } from '../../lib/seo';
import { readScreenerRoom } from '../../lib/rooms-server.mjs';

export const metadata = pageMeta({
  title: { absolute: "Stock Screener · CatalystPit" },
  description: "Screen the market by Catalyst Pit evidence markers, technicals, price, and volume. A fast, composable stock screener.",
  path: "/screener",
});

// ── ⚠️ FOUR WORDS. THAT WAS THE MEASUREMENT, AND IT WAS THE WORST ROOM IN THE PRODUCT ──────
//
// Fetched from production as Googlebot with no JavaScript, /screener served FOUR words of body
// text — on a page advertised in our own sitemap at priority 0.7, aimed at one of the
// highest-volume non-branded phrases in the category. Every row, every column and every number
// arrived in an effect.
//
// ⚠️ WHY THE ROWS MAY BE PUBLISHED. screener_stocks carries previous-session closing values written
// from ticker_daily_candles, which is the basis a guest or a crawler may be shown. The per-viewer
// delayed and real-time overlay is unchanged and still client-side: ScreenerClient paints over
// these cells from /api/quotes once it knows who is asking. Nothing delayed or real-time is
// rendered here, so nothing of either can be cached here.
//
// ⚠️ A LITERAL, NOT THE IMPORTED CONSTANT — Next statically analyses this export at build time and
// an imported identifier is accepted and then silently ignored. ROOM_CACHE_SECONDS in
// lib/rooms-server.mjs remains the single source of truth; verify-rooms-ssr asserts they agree.
export const revalidate = 300;

export default async function ScreenerPage() {
  // null on any failure, and the client's own screen still owns the outcome. Note that null is NOT
  // rendered as an empty result: with no initial data the component stays in its loading state, so
  // the page never tells a reader "No stocks match these filters" on the strength of a failed read.
  const initialData = await readScreenerRoom().catch(() => null);
  return (
    <Suspense fallback={null}>
      <ScreenerClient initialData={initialData} />
    </Suspense>
  );
}
