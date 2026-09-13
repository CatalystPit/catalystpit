import { canonicalWire } from '../../../lib/primary-events';
import { decorate } from '../../../lib/wire-taxonomy.mjs';

export const runtime = 'nodejs';

// Read-only canonical event stream for Pit Wire: ONE row per real-world event, newest first.
//
// This route READS the engine. It does not ingest, dedupe, classify-for-storage or touch SEC —
// the canonical-event engine remains the single source of truth, and every row here has already
// been deduped before it was ever visible.
//
// Two cursors, which is what lets Pit Wire stay live without re-downloading history:
//   ?since=<seq>          new events only  (WHERE seq > cursor) — the live tail and the reconnect
//                         recovery path, both the same query
//   ?updatedSince=<iso>   events the client already has whose enrichment improved since then;
//                         merged by seq so an update never becomes a second wire item
export async function GET(request) {
  try {
    const p = new URL(request.url).searchParams;
    const rows = await canonicalWire({
      since: p.get('since'),
      updatedSince: p.get('updatedSince'),
      limit: p.get('limit'),
      minImportance: p.get('minImportance'),
      category: p.get('category'),
      ticker: p.get('ticker'),
    });
    // Display facets are computed here rather than stored, so the filter vocabulary can evolve
    // without a migration and without touching a single ingested row.
    const events = rows.map(decorate);
    return Response.json(
      {
        events,
        count: events.length,
        // Highest seq seen, so the client's next poll asks only for what came after it.
        cursor: events.length ? Math.max(...events.map((e) => Number(e.seq))) : Number(p.get('since') || 0),
        serverTime: new Date().toISOString(),
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (e) {
    console.error('[wire]', e);
    return Response.json({ error: String(e?.message || e).slice(0, 200) }, { status: 500 });
  }
}
