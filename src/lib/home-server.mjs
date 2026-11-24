// ── WHAT THE SERVER READS TO RENDER THE FRONT DOOR ─────────────────────────
//
// ⚠️ TWO KEY READS. NO DATABASE, NO VENDOR API, NO SESSION.
//
// The homepage's research is already computed and cached: /api/cron/pit-snapshot writes
// `catalystpit:pit_snapshot` every ~15 minutes with the ranked stories, the insider filings, the
// congressional disclosures and the catalyst cards in one blob, and the consensus cron publishes
// the evidence board under its own versioned key. Both are session-less and identical for every
// visitor — the snapshot's own comment calls it "a session-less cron blob — every visitor gets the
// identical rows" — which is precisely what makes them safe to bake into shared HTML.
//
// So rendering the research on the server costs TWO KV GETs, and because app/page.jsx is
// incrementally regenerated rather than dynamic, those two reads happen once per revalidation
// window and not once per visitor. Nothing here is per-request work.
//
// ⚠️ WHAT IS DELIBERATELY NOT READ HERE:
//
//   prices          `ticker_tape` and `market_snapshot` exist and would be trivial to add. They
//                   are market-data-licensed figures, resolved per viewer by /api/quotes, which
//                   fails closed. They stay client-side. Baking a quote into cached public HTML is
//                   a licensing decision, not a rendering one, and this change does not make it.
//   anything per-request   nothing here runs per visitor. The 8-K read below is a database
//                   query, and it is here only because the page is REGENERATED: one indexed
//                   SELECT … LIMIT 12 per revalidation window, not one per request. See
//                   readHomeFilings for why withholding it was worse than reading it.
//   anything about the viewer   no auth(), no Clerk, no entitlement. The root layout avoids
//                   auth() on purpose (see its comment) so that 141 pages can stay static; this
//                   module must not undo that.
//
// ⚠️ EVERY FAILURE RETURNS null, NEVER A THROW AND NEVER AN EMPTY ARRAY DRESSED AS AN ANSWER. A
// missing or unreachable cache must degrade to exactly the behaviour that shipped before this
// change — the client fetches and fills the page in — rather than publishing "no insider filings"
// as a fact about the market. That is the same rule /api/eightk learned the hard way.

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// A page regeneration must not hang on a cache. If KV is slow, we publish the shell and the
// browser fills it in, which is strictly better than a stalled build or a timed-out render.
const KV_TIMEOUT_MS = 2500;

// The ISR window, repeated here because the fetch has to agree with it. See below.
export const HOME_CACHE_SECONDS = 300;

// ── ⚠️ `cache: 'no-store'` HERE MADE THE HOMEPAGE DYNAMIC, AND THAT IS NOT A DETAIL ─────────
//
// The first version of this file read KV with `cache: 'no-store'`, which is what every other read
// path in this repo correctly uses — and it reclassified `/` from a prerendered route to
// `ƒ server-rendered on demand`. Measured in the build output: `ƒ /`, no Revalidate column. An
// uncached fetch inside a server component opts the whole route out of static generation, so every
// visitor to the busiest URL on the site would have paid two KV round-trips before first byte.
// That is a performance regression introduced by an SEO change, which is the trade this work is
// explicitly not allowed to make.
//
// `next: { revalidate }` is the opposite instruction: cache the read for the same window the page
// is regenerated on, so the route stays prerendered and the blob is re-read once per window. The
// two numbers must stay equal — a longer fetch window would pin the page to a stale blob across
// regenerations, and a shorter one would do work the page cannot use.
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      signal: AbortSignal.timeout(KV_TIMEOUT_MS),
      next: { revalidate: HOME_CACHE_SECONDS },
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (d?.result == null) return null;
    if (typeof d.result !== 'string') return d.result;
    try { return JSON.parse(d.result); } catch { return null; }
  } catch { return null; }
}

/**
 * The homepage research blob, or null.
 *
 * Shape: `{ generatedAt, stories, catalysts, insiders, congress }` — see
 * app/api/cron/pit-snapshot/route.js, which is the only writer.
 */
export async function readPitSnapshot() {
  const snap = await kvGet('catalystpit:pit_snapshot');
  if (!snap || typeof snap !== 'object') return null;
  // The same test the client uses to decide whether the blob is usable, so the server and the
  // browser agree about when there is a snapshot at all.
  const usable = Array.isArray(snap.insiders) || Array.isArray(snap.stories);
  return usable ? snap : null;
}

/**
 * The top `limit` rows of the published consensus board, shaped exactly as /api/consensus-board
 * shapes them, or null when no board could be read.
 *
 * ⚠️ null AND [] MEAN DIFFERENT THINGS AND THE TEASER RENDERS THEM DIFFERENTLY. null is "we could
 * not read a board", which must leave the module in its loading state so the client's own fetch
 * decides; [] is "we read a board and nothing qualified", which is a real finding about the
 * market and says so in the reader's words.
 *
 * ⚠️ A READ NEVER COMPUTES — the route is emphatic about this and so is this function. It reads the
 * published key, then the last-known-good key, and gives up. It never triggers a rebuild: a
 * regenerating page is not a reader asking a question.
 */
export async function readConsensusTop(limit = 3) {
  // ⚠️ THE KEYS COME FROM materialization.mjs, THE TRANSPORT DOES NOT. The deployed methodology
  // version lives IN the key, which is what makes "a board built by the code running right now" a
  // structural guarantee rather than a comparison somebody has to remember — so the key functions
  // are imported, never re-derived here. Its own `kvGetJson` is not used because it reads with
  // `cache: 'no-store'`, which is right for a request-time read and would make this page dynamic;
  // see the note on kvGet above. Same keys, same fallback order, same fail-soft, cacheable read.
  const [{ boardKey, LAST_GOOD_KEY }, { displayFacts }] = await Promise.all([
    import('./consensus/materialization.mjs'),
    import('./consensus/board-display.mjs'),
  ]);
  const board = (await kvGet(boardKey())) || (await kvGet(LAST_GOOD_KEY));
  if (!board || !Array.isArray(board.rows)) return null;
  try {
    return board.rows.slice(0, limit).map(displayFacts);
  } catch {
    return null;
  }
}

/**
 * The canonical 8-K filings the front door shows, or [] — the same read /api/eightk serves.
 *
 * ⚠️ THIS WAS LEFT OUT OF THE FIRST VERSION OF THIS CHANGE, AND MEASURING PRODUCTION SHOWED WHY IT
 * COULD NOT BE. With no filings in the pool the server rendered Top Stories led by HPE/MarketWatch
 * while the hydrated page, which fetches them, led with "PSQH · Exchange removal from listing" — a
 * delisting notice, one of the labels deskSelection treats as exceptional. Both orderings were
 * correct for their own pool, which is the problem: the page a crawler reads and the page a reader
 * sees disagreed about what the day's biggest catalyst was, and the crawler's copy was missing a
 * company being removed from its exchange. Same pool, same desk, one answer.
 *
 * ⚠️ AND THIS DOES NOT REOPEN THE FILINGS-DOMINATE BUG. deskSelection splits 8-Ks by SEC item code:
 * on the run that prompted this, 10 of 12 were routine — Material agreement, Exec / board change,
 * Earnings — and stayed a floor beneath the reporting, while the one delisting notice led and the
 * module labelled itself "8-K FILINGS" for saying so. The hierarchy corrected at 1f9ff3fa decides
 * this, not the presence or absence of the data.
 *
 * ⚠️ ONE QUERY PER REVALIDATION, NOT PER VISITOR, AND NO DDL. `ensure: false` skips
 * ensureEightkTable's four CREATE … IF NOT EXISTS statements, which have no business running while
 * a public page is being generated. Any failure — unreachable database, missing table, a build
 * with no DATABASE_URL — returns [] and the page degrades to the journalism-only pool, which is
 * what it rendered before this function existed.
 */
export async function readHomeFilings(limit = 12) {
  try {
    const { recentEightK } = await import('./eightk.js');
    const list = await recentEightK({ materialOnly: true, limit, days: 7, ensure: false });
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
