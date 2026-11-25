import ScanClient from './ScanClient';
import { readScanRoom } from '../../lib/rooms-server.mjs';
import { pageMeta } from '../../lib/seo';

// ⚠️ THIS ROUTE WAS TELLING GOOGLE IT IS A DUPLICATE OF THE HOMEPAGE.
//
// Measured on production: /scan served `<link rel="canonical" href="https://www.catalystpit.com">`.
// Not a missing canonical — the WRONG one. The root layout sets `alternates: { canonical: '/' }`
// so that the homepage has one, and Next MERGES page metadata over the layout's; a page that
// exports a bare object without `alternates` inherits the layout's value verbatim. Every route
// that calls pageMeta overrides it. This was the one priority room that did not, so it nominated
// the front page as the canonical version of itself, which is an instruction never to index it.
//
// The title was doubly branded for the same reason — "Pit Scan — Catalyst Pit · CatalystPit",
// because the layout's `template: '%s · CatalystPit'` appends the brand to a non-absolute title
// that already contained it.
export const metadata = pageMeta({
  title: { absolute: "Pit Scan · Today's Biggest Stock Movers and the Evidence Behind Them · CatalystPit" },
  description: 'What is moving in the US market today and what the public evidence says about it: '
    + 'SEC filings, insider buying, Congressional trades and news attached to each mover.',
  path: '/scan',
});

// ── ⚠️ WHY THIS PAGE IS REGENERATED AND NOT RENDERED PER REQUEST ───────
//
// Measured on production as Googlebot: 189 words and no links to any of the companies the boards
// rank. The basis was never the problem — these boards have always shown the last completed
// session to everyone, stated once at the top and again on every row — they were simply arriving
// after JavaScript.
//
// readScanRoom states `realtime: false` rather than resolving an entitlement, so no auth() runs
// here and the realtime snapshot path is never reached; the override can only narrow. An entitled
// reader's own refresh still replaces these boards with a live one the moment it lands.
//
// ⚠️ A LITERAL, NOT THE IMPORTED CONSTANT — Next statically analyses this export at build time
// and an imported identifier is accepted and then silently ignored. ROOM_CACHE_SECONDS in
// lib/rooms-server.mjs remains the single source of truth; verify-rooms-ssr asserts they agree.
export const revalidate = 300;

export default async function ScanPage() {
  const initialBoards = await readScanRoom().catch(() => null);
  return <ScanClient initialBoards={initialBoards} />;
}
