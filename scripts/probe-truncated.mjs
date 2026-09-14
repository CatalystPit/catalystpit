// Audit canonical headlines for engine-side truncation: a stored headline that ends mid-phrase.
// Run: node --env-file=.env.local scripts/probe-truncated.mjs [days]
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const days = Number(process.argv[2] || 30);

const rows = await sql.query(`
  select seq, source, source_kind, headline, source_headline, headline_status, importance,
         display_ready, cluster_id, length(headline) len
    from primary_events
   where published_at > now() - ($1 || ' days')::interval
   order by published_at desc`, [String(days)]);

const ell = rows.filter((r) => /[…]$|\.\.\.$/.test(String(r.headline || '').trim()));
console.log(`scanned ${rows.length} events over ${days} days`);
console.log(`headlines ending in an ellipsis: ${ell.length}`);
console.log(`  of those display-ready canonical: ${ell.filter((r) => r.display_ready && !r.cluster_id).length}`);
console.log(`  HIGH or CRITICAL: ${ell.filter((r) => r.importance >= 2).length}`);

const byLen = {};
for (const r of ell) byLen[r.len] = (byLen[r.len] || 0) + 1;
console.log('  stored length histogram:', JSON.stringify(byLen));

console.log('\n── examples ──');
for (const r of ell.slice(0, 14)) {
  console.log(`  seq ${r.seq} imp=${r.importance} status=${r.headline_status} len=${r.len}`);
  console.log(`    stored: ${r.headline}`);
  console.log(`    source: ${String(r.source_headline || '').slice(0, 220)}`);
}
