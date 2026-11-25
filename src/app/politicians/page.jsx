import PoliticiansList from './PoliticiansList';
import { pageMeta } from '../../lib/seo';
import { readPoliticiansRoom } from '../../lib/rooms-server.mjs';

export const metadata = pageMeta({
  title: { absolute: "Congress Stock Trades · STOCK Act Disclosures by Member · CatalystPit" },
  description: "Congressional stock trades disclosed under the STOCK Act. Track what House and Senate members are buying and selling, and how each trade has performed since.",
  path: "/politicians",
});

// ── ⚠️ WHY THIS PAGE IS REGENERATED AND NOT RENDERED PER REQUEST ───────────
//
// The member list is one grouped aggregate over congress_trades. Dynamic rendering would run it in
// front of first byte for every visitor and every crawler; incremental regeneration keeps the HTML
// served from the edge exactly as it was, with the query happening on one background regeneration
// per window.
//
// ⚠️ A LITERAL, NOT THE IMPORTED CONSTANT — Next statically analyses this export at build time and
// an imported identifier is accepted and then silently ignored. ROOM_CACHE_SECONDS in
// lib/rooms-server.mjs remains the single source of truth; verify-rooms-ssr asserts they agree.
export const revalidate = 300;

export default async function PoliticiansPage() {
  // ⚠️ THE FREE END-OF-DAY CUTOFF IS APPLIED INSIDE THE READER. Shared HTML is read by everyone, so
  // it carries what everyone is entitled to; a Pro reader's own fetch replaces it with their
  // fresher rows immediately after hydration. Nothing here depends on who is asking.
  const initialList = await readPoliticiansRoom({ now: Date.now() }).catch(() => null);
  return <PoliticiansList initialList={initialList} />;
}
