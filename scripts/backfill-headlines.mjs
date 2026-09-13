// Re-derives the USER-FACING headline for existing non-SEC events.
//
// Updates the canonical event IN PLACE — no row is created, no row is deleted, and no raw source
// field is touched. source_headline, source_name, original_url, source_uid, raw and cluster
// membership are all read-only here.
//
// Outcomes per row:
//   composed        a factual Catalyst Pit sentence was built from an unambiguous assertion
//   rewrite_pending nothing could be asserted without inventing it — the source's wording stands in,
//                   attributed on screen, and the row is queued for the model
//
// SEC and Nasdaq halts are excluded entirely: primary/mechanical data stays source-faithful.
//
// Run: node --env-file=.env.local scripts/backfill-headlines.mjs [--apply]

import postgres from 'postgres';
import { composeHeadline } from '../src/lib/headline-compose.mjs';
import { canonicalHeadline } from '../src/lib/news-normalize.mjs';

const APPLY = process.argv.includes('--apply');
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const rows = await sql`
  select seq, source, source_name, headline, source_headline, summary, tickers, headline_status
    from primary_events
   where source_kind <> 'sec' and source <> 'NASDAQ' and headline_status <> 'original'
   order by seq desc`;

console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} over ${rows.length} non-SEC events\n`);

let composed = 0, pending = 0, changed = 0;
const samples = [];
for (const r of rows) {
  const built = composeHeadline({ headline: r.source_headline, summary: r.summary, tickers: r.tickers });
  const status = built ? 'composed' : 'rewrite_pending';
  const headline = built
    ? canonicalHeadline(built.headline, r.tickers)
    : canonicalHeadline(r.source_headline, r.tickers);
  if (built) composed++; else pending++;

  if (r.headline !== headline || r.headline_status !== status) {
    changed++;
    if (built && samples.length < 12) samples.push({ src: r.source_headline, out: headline, t: built.type });
    if (APPLY) {
      await sql`
        update primary_events
           set headline = ${headline}, headline_status = ${status}
         where seq = ${r.seq}`;
    }
  }
}

console.log(`  composed (Catalyst Pit wording): ${composed}  (${(composed / rows.length * 100).toFixed(1)}%)`);
console.log(`  rewrite_pending (awaiting model): ${pending}  (${(pending / rows.length * 100).toFixed(1)}%)`);
console.log(`  rows ${APPLY ? 'updated' : 'that would change'}: ${changed}`);

if (samples.length) {
  console.log('\n  samples:');
  for (const s of samples) {
    console.log(`\n    [${s.t}]`);
    console.log(`      source: ${s.src.slice(0, 92)}`);
    console.log(`      CP    : ${s.out}`);
  }
}

// Provenance must be intact whatever happened above.
const bad = await sql`
  select count(*) n from primary_events
   where source_headline is null or original_url is null or source_name is null
      or source_uid is null or raw is null`;
console.log(`\n  rows missing any raw provenance field: ${bad[0].n}`);
await sql.end();
