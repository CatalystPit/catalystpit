import { pageMeta } from '../../lib/seo';
import InsidersClient from './InsidersClient';
import { readInsidersRoom } from '../../lib/rooms-server.mjs';

// Server wrapper: a 'use client' file cannot export metadata, so the page's own title,
// description and canonical live here and the interactive component sits alongside.
export const metadata = pageMeta({
  // ⚠️ THE TITLES NAMED THE ROOM, NOT THE SEARCH. "Politicians" and "Institutions" are our own
  // navigation labels; nobody types them into a search box. The non-branded phrases these three
  // rooms actually answer are "insider trading tracker", "congress stock trades" and "13F
  // filings", and each of those is literally what the page already shows. No claim is added here
  // and no page changed — only the words a reader uses to look for it.
  title: "Insider Trading Tracker · SEC Form 4 Buys and Sells",
  description: "Open-market insider buys and sells from SEC Form 4 filings, with cluster buys, CEO and CFO activity, and dollar values by company and sector.",
  path: "/insiders",
});

// ── ⚠️ WHY THIS PAGE IS REGENERATED AND NOT RENDERED PER REQUEST ───────────
//
// The first screen is now rendered on the server, which costs one indexed SELECT and one COUNT.
// Dynamic rendering would put both in front of first byte for every visitor and every crawler —
// and this room is 19,750 ticker pages' worth of internal linking, so it is crawled hard.
// Incremental regeneration keeps the HTML served from the edge exactly as it was, with the two
// queries happening on one background regeneration per window. That is the same trade the ticker
// pages were fixed to make, where the measured result was 673 ms → 80 ms at the median.
//
// ⚠️ A LITERAL, NOT THE IMPORTED CONSTANT — Next statically analyses this export at build time and
// an imported identifier is accepted and then silently ignored. ROOM_CACHE_SECONDS in
// lib/rooms-server.mjs remains the single source of truth; verify-rooms-ssr asserts they agree.
export const revalidate = 300;

export default async function Page() {
  // ⚠️ THE FREE-TIER CUTOFF IS APPLIED INSIDE THE READER, NOT HERE, AND NOT OPTIONALLY.
  // See readInsidersRoom: shared HTML is read by everyone, so it carries what everyone is entitled
  // to. Nothing on this page depends on who is asking — no auth(), no cookies, no headers — which
  // is what makes one cached copy correct rather than a leak.
  const initialData = await readInsidersRoom({ now: Date.now() }).catch(() => null);
  return <InsidersClient initialData={initialData} />;
}
