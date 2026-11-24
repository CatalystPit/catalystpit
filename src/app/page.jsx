import { pageMeta } from '../lib/seo';
import { buildHomeModel } from '../lib/home-model.mjs';
import { readPitSnapshot, readConsensusTop, readHomeFilings } from '../lib/home-server.mjs';
import HomeClient from './HomeClient';

// Server wrapper: a 'use client' file cannot export metadata, so the page's own title,
// description and canonical live here and the interactive component sits alongside.
export const metadata = pageMeta({
  title: { absolute: "CatalystPit · Insider Trades, Congress Trades & Market Catalysts" },
  description: "Track insider buying, Congressional stock trades, institutional 13F activity and SEC filings as they happen. Every catalyst, before the bell.",
  path: "/",
});

// ── ⚠️ WHY THIS PAGE IS REGENERATED AND NOT RENDERED PER REQUEST ───────────
//
// Reading the cached snapshot makes this page no longer purely static, and there are two ways for
// that to land. Dynamic rendering would put two KV round-trips in front of first byte for every
// visitor on the busiest URL on the site — the opposite of the outcome this work is for.
// Incremental regeneration keeps the page PREREGENERATED: the HTML is served from the edge exactly
// as it was before, and the two reads happen on one background regeneration per window.
//
// 300 seconds, chosen against the writer rather than guessed: /api/cron/pit-snapshot rebuilds the
// blob every ~15 minutes, so a five-minute window can never serve HTML more than one generation
// behind the data, and the same rule /api/market was corrected to follow — a TTL may be shorter
// than the write cadence but never longer — holds here too.
//
// ⚠️ NOTHING ON THIS PAGE DEPENDS ON WHO IS ASKING, AND THAT IS WHAT MAKES ONE SHARED COPY SAFE.
// No auth(), no cookies, no headers. The snapshot is a session-less cron blob and the consensus
// board is free for every visitor; entitlement-bearing surfaces — quotes, the Pro gates, the
// watchlist, the teaser states — are all client components that resolve per viewer after
// hydration, exactly as they did before. If anything on this page ever needs the session, it must
// not be resolved here.
// ⚠️ A LITERAL, NOT THE IMPORTED CONSTANT. Next statically analyses this export at build time and
// an imported identifier is not a literal it can read — it was accepted here and then ignored.
// HOME_CACHE_SECONDS is still the single source of truth: verify-home-ssr asserts the two agree.
export const revalidate = 300;

export default async function Page() {
  // ⚠️ ONE FAILURE MUST NOT COST THE OTHER, AND NEITHER MAY COST THE PAGE. Both readers return
  // null on any problem and are settled independently, so a missing consensus board still ships a
  // page full of insider and congressional research, and a total cache outage degrades to exactly
  // the behaviour that shipped before this change: the shell, filled in by the client's own fetch.
  const [snap, consensus, filings] = await Promise.all([
    readPitSnapshot().catch(() => null),
    readConsensusTop(3).catch(() => null),
    readHomeFilings(12).catch(() => []),
  ]);

  // ⚠️ THE SAME buildHomeModel THE BROWSER RUNS, AGAINST THE SAME BLOB. Not a server-side
  // approximation of the homepage — the homepage, rendered early. The clock is captured once here
  // so every age in the HTML is consistent with itself and with the copy React hydrates from.
  //
  // ⚠️ AND NO PRICES: tape and marketSnap are left out deliberately. See lib/home-server.mjs.
  const initialData = snap
    ? buildHomeModel({
      stories: snap.stories || [],
      insiderData: { trades: snap.insiders || [] },
      politicianData: { trades: snap.congress || [] },
      snapCatalysts: snap.catalysts ?? null,
      usingSnapshot: true,
      // ⚠️ THE SAME FILINGS THE BROWSER FETCHES, so the crawler's copy of Top Stories and the
      // reader's copy cannot disagree about the day's biggest catalyst. See readHomeFilings.
      filings,
    }, { now: Date.now() })
    : null;

  return <HomeClient initialData={initialData} initialConsensus={consensus} />;
}
