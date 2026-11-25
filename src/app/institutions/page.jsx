import InstitutionsClient from './InstitutionsClient';
import { pageMeta } from '../../lib/seo';
import { readInstitutionsRoom } from '../../lib/rooms-server.mjs';

export const metadata = pageMeta({
  title: { absolute: "13F Filings · Institutional Holdings and Quarterly Changes · CatalystPit" },
  description: "What the biggest funds and managers hold, from quarterly SEC 13F filings, with holdings and quarter-over-quarter activity.",
  path: "/institutions",
});

// ── ⚠️ WHY THIS PAGE IS REGENERATED, AND WHY IT PUBLISHES LESS THAN THE OTHER ROOMS ────────
//
// Measured on production as Googlebot: 167 words, no rows, no links to a single one of the 10,013
// managers in the registry. But unlike the other rooms, the limit here is not the rendering — it is
// publicCap. A logged-OUT caller gets at most ten rows of any array, and a crawler is always
// logged out, so ten 13F filings is the honest ceiling for this page until the owner decides
// whether that directory should be crawlable at all. See lib/rooms-server.mjs.
//
// Those ten are chosen because they are the most citable thing in the room: organization,
// reporting period, disclosure date, holdings count, a link to our research and a link to the
// primary document on SEC EDGAR.
//
// ⚠️ A LITERAL, NOT THE IMPORTED CONSTANT — Next statically analyses this export at build time and
// an imported identifier is accepted and then silently ignored. ROOM_CACHE_SECONDS in
// lib/rooms-server.mjs remains the single source of truth; verify-rooms-ssr asserts they agree.
export const revalidate = 300;

export default async function InstitutionsPage() {
  // The free end-of-day cutoff and the logged-out row cap are both applied inside the reader, and
  // neither is optional there. Nothing on this page depends on who is asking.
  const initial = await readInstitutionsRoom({ now: Date.now() }).catch(() => null);
  return <InstitutionsClient initialLatest={initial?.filings ?? null} initialActivity={initial?.activity ?? null} />;
}
