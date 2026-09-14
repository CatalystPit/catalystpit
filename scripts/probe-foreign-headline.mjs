// Inspect what the language detector flags, by source kind, to hunt false positives.
// Run: node --env-file=.env.local scripts/probe-foreign-headline.mjs [kind]
import { neon } from '@neondatabase/serverless';
import { materiallyNonEnglish } from '../src/lib/language.mjs';
const sql = neon(process.env.DATABASE_URL);
const want = process.argv[2] || 'sec';
const rows = await sql.query(`select seq, source, source_kind, headline, summary, display_ready, cluster_id
  from primary_events where published_at > now() - interval '30 days' order by published_at desc`);
let n = 0;
for (const r of rows) {
  const v = materiallyNonEnglish(r.headline, r.summary);
  if (!v.nonEnglish) continue;
  const isSec = r.source_kind === 'sec' || r.source === 'SEC';
  if (want === 'sec' ? !isSec : isSec) continue;
  n++;
  console.log(`seq ${r.seq} [${r.source}] vis=${r.display_ready} cluster=${r.cluster_id}`);
  console.log(`   ${r.headline}`);
  console.log(`   why: ${v.reason}`);
}
console.log(`\n${n} flagged in group "${want}"`);
