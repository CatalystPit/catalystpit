import MarketsClient from './MarketsClient';
import { pageMeta } from '../../lib/seo';
import { readMarketsRoom } from '../../lib/rooms-server.mjs';

export const metadata = pageMeta({
  // The same literal-backslash defect as /news, from the same unnecessary escape.
  title: { absolute: "Market Catalysts Today · Stocks With Fresh SEC Filings and Congress Trades · CatalystPit" },
  description: "What is moving by catalyst today: companies with fresh SEC filings, Congressional trades and headlines, grouped by the evidence that put them on the list.",
  path: "/markets",
});

// ── ⚠️ WHY THIS PAGE IS REGENERATED AND NOT RENDERED PER REQUEST ───────────
//
// Measured on production as Googlebot: 113 words, no rows, and not one link to any of the companies
// it names — the room navigated by onClick + router.push, which works for a reader and is invisible
// to a crawler.
//
// There is no market-data decision to make here, which is what makes this the simplest of the
// rooms: the catalyst board carries no last-sale and no prices by design. One cached KV read per
// revalidation window, no session, no provider call.
//
// ⚠️ A LITERAL, NOT THE IMPORTED CONSTANT — Next statically analyses this export at build time and
// an imported identifier is accepted and then silently ignored. ROOM_CACHE_SECONDS in
// lib/rooms-server.mjs remains the single source of truth; verify-rooms-ssr asserts they agree.
export const revalidate = 300;

export default async function MarketsPage() {
  // null on any failure, and the client's own fetch still owns the outcome — an unreadable snapshot
  // degrades to exactly what shipped before this change.
  const initialSnap = await readMarketsRoom().catch(() => null);
  return <MarketsClient initialSnap={initialSnap} />;
}
