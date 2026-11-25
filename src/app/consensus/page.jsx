import ConsensusClient from './ConsensusClient';
import { pageMeta } from '../../lib/seo';
import { readConsensusRoom } from '../../lib/rooms-server.mjs';

export const metadata = pageMeta({
  // ⚠️ THIS DESCRIBED A PRODUCT THAT NO LONGER EXISTS. "Where Smart Money Is Stacking" and
  // "all buying (or all selling)" are the old confluence pitch: one direction, everyone agreeing.
  // The frozen Consensus surfaces DISAGREEMENT as readily as agreement — every row on the live
  // board today reads "Cross-source conflict" — so the old copy promised the opposite of what a
  // visitor finds, in the browser tab and in search results.
  title: { absolute: "Pit Consensus · Evidence Alignment and Conflict · CatalystPit" },
  description: "Where public evidence from insiders, Congress, institutions and SEC filings agrees — and where it conflicts. Evidence accounting, not a score.",
  path: "/consensus",
});

// ── ⚠️ WHY THIS PAGE IS REGENERATED AND NOT RENDERED PER REQUEST ───────────
//
// Reading the published board on the server makes this page no longer purely static, and there are
// two ways for that to land. Dynamic rendering would put a KV round-trip in front of first byte
// for every visitor; incremental regeneration keeps the HTML served from the edge exactly as it
// was, with the read happening on one background regeneration per window.
//
// ⚠️ A LITERAL, NOT THE IMPORTED CONSTANT. Next statically analyses this export at build time and
// an imported identifier is not a literal it can read — it is accepted and then silently ignored,
// which is how 19,750 ticker pages stayed uncacheable through a deploy that looked correct.
// ROOM_CACHE_SECONDS in lib/rooms-server.mjs is still the single source of truth, and
// verify-rooms-ssr asserts the two agree.
export const revalidate = 300;

export default async function ConsensusPage() {
  // ⚠️ null ON ANY FAILURE, AND THE CLIENT STILL OWNS THE OUTCOME. A missing or unreachable board
  // degrades to exactly what shipped before this change — the component's own fetch, including its
  // separate handling of "degraded" versus "empty" versus "failed to load", three outcomes this
  // page is careful to keep apart. The server never publishes "no evidence" as a finding.
  const initialBoard = await readConsensusRoom().catch(() => null);
  return <ConsensusClient initialBoard={initialBoard} />;
}
