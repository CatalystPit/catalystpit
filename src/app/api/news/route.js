import { auth } from '@clerk/nextjs/server';
// ⚠️ IMPORT WHAT LINE 81 ACTUALLY CALLS. This read `{ impactOf, IMPACT_RANK }` — the two names the
// inline rankOf/.sort() block used before 1d5ca543 replaced it with rankByImpact(). That commit
// swapped the call and left the import, so the route threw ReferenceError: rankByImpact is not
// defined on EVERY request, and had been 500ing in production ever since. The two old names were
// dead by then; both are gone.
import { rankByImpact } from '../../../lib/impact';
// The canonical 8-K reader and the canonical ticker grammar — the main column consumes the
// existing catalyst infrastructure rather than growing a second interpretation of a filing.
import { recentEightK } from '../../../lib/eightk';
import { filingsToStories } from '../../../lib/news-filings.mjs';

export const runtime = 'nodejs';

// Dedicated, AUTH-VARYING news route. Reads the SAME KV key /api/claude reads for
// top_stories (catalystpit:top_stories), with the identical Upstash client +
// double-JSON-parse handling, but gates the article set server-side by LOGIN STATE
// (not tier — news is a commodity; a free login is the beta-funnel hook). Signed-in
// users of ANY tier get the full feed; signed-out users get the teaser. /api/claude
// stays public + CDN-cached (s-maxage) for the homepage; THIS route varies per user
// and MUST NOT be CDN-cached — Cache-Control: private, no-store.
//
// NOTE: this gate is intentionally AUTH-based, distinct from the Bulls/Bears gate
// which is correctly TIER-based (resolveUserTier). Two different gates by design.

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const SIGNED_OUT_ROW_COUNT = 5;                       // hero (1) + 5 rows for signed-out visitors
const SIGNED_OUT_VISIBLE = 1 + SIGNED_OUT_ROW_COUNT;  // first 6 raw elements

// Mirrors /api/claude's kvGet (same Upstash REST client). cache:'no-store' so the
// per-user route never serves a stale shared fetch result after a cron refresh.
async function kvGet(key) {
  const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    cache: 'no-store',
  });
  const data = await res.json();
  return data.result;
}

export async function GET() {
  // Auth state only — logged-in-or-not, NOT tier. Signed-out → userId null (auth() does not throw).
  const { userId } = await auth();
  const loggedIn = !!userId;

  let raw = [];
  let source = 'empty';
  let lastRefresh = null;
  try {
    let val = await kvGet('catalystpit:top_stories');
    lastRefresh = await kvGet('catalystpit:last_refresh');
    // Copy /api/claude's parse handling: Upstash returns a string; may be double-encoded.
    if (typeof val === 'string') { try { val = JSON.parse(val); } catch { val = null; } }
    if (typeof val === 'string') { try { val = JSON.parse(val); } catch { val = null; } }
    if (Array.isArray(val) && val.length) { raw = val; source = 'cache'; }
  } catch { /* KV error → treat as empty, never throw */ }

  // Press-release wires (separate un-enriched pool) — appended AFTER the enriched stories so the
  // hero stays a curated story. Each carries its own `source`, filtered client-side in NewsFeed.
  let wire = [];
  try {
    let w = await kvGet('catalystpit:wire_news');
    if (typeof w === 'string') { try { w = JSON.parse(w); } catch { w = null; } }
    if (typeof w === 'string') { try { w = JSON.parse(w); } catch { w = null; } }
    if (Array.isArray(w) && w.length) wire = w;
  } catch { /* wires optional — never break the feed */ }

  // ⚠️ THE HERO MUST EARN ITS PLACE, BECAUSE THE CURATED POOL IS ROUTINELY ABSENT.
  //
  // `catalystpit:top_stories` is written with a 4-hour TTL by /api/refresh-content, whose cron is
  // `0 13-21 * * 1-5` — weekdays only. From Friday ~21:00 UTC until Monday 13:00 UTC the key has
  // expired and there is nothing enriched to be first, so "append the wires after the curated
  // stories" silently became "the wires ARE the feed" for roughly 64 hours a week. Measured on a
  // Sunday: 36 wire items, 1 high-impact, 35 routine, and the hero was a German-language PR
  // Newswire release about a factory opening, followed by its own French translation.
  //
  // So the ordering is stated rather than assumed. Enriched stories still outrank wires — when
  // curation exists it leads, exactly as before — and WITHIN each tier the material items come
  // first, using the same impactOf() the feed's own "High impact" filter already uses. Recency
  // breaks ties, so this is a re-ranking of what we already had, not a new editorial layer and
  // not a filter: nothing is dropped, and the routine items are all still there, lower down.
  //
  // This matters most for signed-out visitors, who only ever receive the first six elements —
  // client-side sorting could never have reached a material story that sat at index 20.
  // Curated still outranks wire, which is preserved by ranking each pool on its own and
  // concatenating. rankByImpact is the shared desk — the homepage snapshot cron calls the same
  // function, so the front door and the news river cannot order the same pool differently.
  // ─── MATERIAL ISSUER 8-Ks JOIN THE MAIN COLUMN ──────────────────────────────
  //
  // ⚠️ THE HIGH IMPACT TAB COULD NOT WORK BEFORE THIS, AND NOT BECAUSE THE THRESHOLD WAS WRONG.
  // Measured against the live payload: 6 stories, 0 with a ticker, therefore 0 HIGH. impactOf's
  // rule (A) requires a RESOLVED TICKER plus a material company event, and the curated/wire pools
  // are publisher headlines that mostly carry no ticker at all. So the filter was correct and the
  // pool was simply incapable of satisfying it — the issuer catalysts were sitting on a different
  // route, feeding only the rails. The fix is to give the column events that genuinely qualify,
  // never to relax what qualifying means.
  //
  // ⚠️ materialOnly, AND THE CANONICAL CLASSIFIER DECIDES IT. `material` is set by ingest from
  // classifyItems() against the SEC item codes; this route does not re-interpret a filing. An 8-K
  // that the existing engine calls non-material never arrives here, so nothing becomes HIGH
  // merely by being an 8-K.
  //
  // impactOf then reaches 'high' honestly: category 'SEC' makes issuerFiling true, and the row
  // carries a real ticker. No threshold moved, no item was hand-marked.
  let filings = [];
  try {
    filings = filingsToStories(await recentEightK({ materialOnly: true, limit: 40, days: 7 }));
  } catch { /* the filings table is optional to the feed — never break the river */ }

  // A story already linking to the same filing document is the same event twice.
  const filingUrls = new Set(filings.map((f) => f.url).filter(Boolean));
  const notAlreadyFiled = (s) => !(s?.url && filingUrls.has(s.url));
  raw = raw.filter(notAlreadyFiled);
  wire = wire.filter(notAlreadyFiled);

  // Filings lead, then curated stories, then wires — each pool ranked on its own so the existing
  // curated-outranks-wire guarantee is untouched and only a new, more material tier is added
  // above it. Nothing is dropped; the routine items are all still there, lower down.
  raw = [...rankByImpact(filings), ...rankByImpact(raw), ...rankByImpact(wire)];

  // Slice the ranked array (element 0 is now the most material story available) so NewsFeed's
  // existing client-side normalization works unchanged. Signed-in users get the full feed;
  // signed-out get the teaser and the locked rows never ship.
  const data = loggedIn ? raw : raw.slice(0, SIGNED_OUT_VISIBLE);
  const lockedCount = loggedIn ? 0 : Math.max(0, raw.length - SIGNED_OUT_VISIBLE);

  return Response.json(
    {
      data, lockedCount, loggedIn, source, lastRefresh,
      // How the feed was actually composed. `curatedCount: 0` is the signature of the expired
      // top_stories key — the difference between "quiet news day" and "the enrichment job has not
      // run since Friday", which was previously indistinguishable from outside.
      // `raw` now carries three tiers, so curated is what is left after the other two are taken
      // out — it must not silently start counting filings as curation.
      curatedCount: raw.length - wire.length - filings.length,
      wireCount: wire.length,
      filingCount: filings.length,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
