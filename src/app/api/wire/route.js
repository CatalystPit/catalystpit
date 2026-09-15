import { canonicalWire } from '../../../lib/primary-events';
import { decorate } from '../../../lib/wire-sources.server.mjs';

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
// Pit Wire rows are CATALYST PIT events, not a republished feed of somebody else's headlines, so the
// upstream publisher's identity does not cross the wire to the browser at all. That is a deliberate
// step past "don't render it": a name left in the JSON is a name in devtools, and the whole product
// claim is that the trader reads one canonical event and never has to think about which of eighty
// feeds happened to find it.
//
// Nothing is lost. primary_events still holds source, source_name, source_uid, source_headline,
// original_url, raw, cluster membership, published_at and received_at for every record, and the
// engine, the dedupe and every internal tool read them exactly as before. This strips the RESPONSE.
//
// `wireGroup` survives because the Sources filter needs it, and it is a category ("Breaking Wires",
// "PR Wires"), never an outlet. `source_count` survives because "+3" tells the trader this event was
// corroborated, without saying by whom.
//
// SEC IS THE EXCEPTION, untouched by design: a filing must say SEC and must link to the filing.
// `summary` goes with them. The tape does not render it — a row is one scannable line — and it is
// by far the biggest carrier of the publisher back into the payload: audited against live rows it
// held "according to a document seen by Bloomberg", "(Source: Bloomberg)", and in one case a slab of
// a publisher's raw <span property="schema:name"> markup. It is still read server-side, before this
// runs, by the noise and event-type classifiers, and it is still on primary_events.
// ── public view model ────────────────────────────────────────────────────────
// AN EXPLICIT WHITELIST, not a blacklist. The route used to spread the decorated DB row and delete a
// handful of publisher fields, which meant every column added to primary_events would have started
// appearing in the public JSON automatically. Audited live, that shipped nine pipeline fields —
// first_seen_at, last_seen_at, received_at, enriched_at, headline_status, facts, source_kind,
// source_type and market_cap — none of which the client reads, and which together advertised our
// ingestion latency, our enrichment lag and the internal states of the rewrite queue.
//
// Anything not named below does not leave the server. Adding a field here has to be a decision.
const PUBLIC_FIELDS = [
  'seq',             // cursor + React key + update merge — see the note below
  'headline',
  'published_at',    // the ONLY timestamp. It is the event's own, not ours.
  'tickers',
  'category',
  'importance',
  'source_count',    // renders the "·3" corroboration badge; says how many, never who
  'wireType', 'wireCategory', 'wireGroup', 'wireCap', 'wireNoise',   // filter facets
];

// WHY `seq` STAYS. It is a DB sequence and the audit flagged it, but it is load-bearing in three
// places at once: it is the live-tail cursor (?since=<seq>, and the client derives its own cursor by
// taking the max seq it has seen), it is the React key for every row, and it is the join key that
// merges an enrichment update into the row already on screen instead of appending a duplicate.
// Making it opaque means changing the cursor protocol, which is the one part of Pit Wire that must
// not break — so it is deliberately left for a separate, properly tested change rather than folded
// into a hardening pass. What it reveals is event volume, not sources, feeds or credentials.
//
// SEC rows keep their attribution. A filing must say SEC and must link to the filing — that is
// deliberate public attribution, not a leak, and removing it would misrepresent the source.
const SEC_FIELDS = ['source', 'source_name', 'original_url', 'source_kind'];

function present(ev) {
  const out = {};
  for (const k of PUBLIC_FIELDS) if (ev[k] !== undefined) out[k] = ev[k];
  if (ev.source_kind === 'sec') for (const k of SEC_FIELDS) if (ev[k] !== undefined) out[k] = ev[k];
  return out;
}

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
    const events = rows.map(decorate).map(present);
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
