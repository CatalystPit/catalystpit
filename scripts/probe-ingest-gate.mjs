// Did the language gate act on rows ingested AFTER it deployed? A foreign row received since the
// cutoff must have landed with display_ready = false. Any exception is printed in full, because the
// interesting case is WHY one got through, not that one did.
// Run: node --env-file=.env.local scripts/probe-ingest-gate.mjs "2026-09-14T16:00:00Z"
import { neon } from '@neondatabase/serverless';
import { materiallyNonEnglish } from '../src/lib/language.mjs';
const sql = neon(process.env.DATABASE_URL);
const cut = process.argv[2] || '2026-09-14T16:00:00Z';

const rows = await sql.query(
  `select seq, source, headline, source_headline, summary, display_ready, cluster_id,
          headline_status, received_at::text ra, first_seen_at::text fs, last_seen_at::text ls
     from primary_events where received_at > $1::timestamptz order by received_at desc`, [cut]);
const foreign = rows.filter((r) => materiallyNonEnglish(r.headline, r.summary).nonEnglish);
const leaked = foreign.filter((r) => r.display_ready);

console.log(`rows ingested since ${cut}: ${rows.length}`);
console.log(`  non-English among them : ${foreign.length}`);
console.log(`  of those, display_ready: ${leaked.length}`);
for (const f of foreign.slice(0, 12)) {
  console.log(`  ${f.display_ready ? 'LEAK ' : 'held '} first_seen=${f.fs} cluster=${f.cluster_id ?? '-'} `
    + `[${f.source}] ${f.headline.slice(0, 58)}`);
}
for (const f of leaked) {
  console.log(`\n--- why seq ${f.seq} got through ---`);
  console.log(`  first_seen ${f.fs}`);
  console.log(`  last_seen  ${f.ls}`);
  console.log(`  received   ${f.ra}`);
  console.log(`  status     ${f.headline_status}  cluster ${f.cluster_id}`);
  console.log(`  stored headline: ${f.headline}`);
  console.log(`  source headline: ${f.source_headline}`);
  console.log(`  detector on stored: ${JSON.stringify(materiallyNonEnglish(f.headline, f.summary))}`);
  console.log(`  detector on source: ${JSON.stringify(materiallyNonEnglish(f.source_headline, f.summary))}`);
}
if (!foreign.length) console.log('\nno foreign row ingested since the cutoff yet — gate unproven, not disproven');
else console.log(leaked.length === 0 ? '\ningest gate confirmed in production' : '\none or more rows got through');
