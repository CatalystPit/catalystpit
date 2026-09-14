// Decisive check that the READ-TIME language filter is live in production: find foreign rows that
// are still display_ready = true in the database (so only the deployed code can be hiding them),
// then confirm production's /api/wire does not return them.
// Run: node --env-file=.env.local scripts/probe-foreign-live.mjs
import { neon } from '@neondatabase/serverless';
import { materiallyNonEnglish } from '../src/lib/language.mjs';
const sql = neon(process.env.DATABASE_URL);

const rows = await sql.query(`select seq, headline, summary, display_ready, cluster_id
  from primary_events
 where published_at > now() - interval '3 hours' and cluster_id is null and display_ready
 order by published_at desc limit 400`);
const foreign = rows.filter((r) => materiallyNonEnglish(r.headline, r.summary).nonEnglish);
console.log(`display_ready foreign rows still in the DB (last 3h): ${foreign.length}`);
for (const f of foreign) console.log(`  seq ${f.seq}  ${f.headline.slice(0, 90)}`);

const r = await fetch('https://catalystpit.com/api/wire?limit=300', { cache: 'no-store' });
const served = new Set(((await r.json()).events || []).map((e) => String(e.seq)));
const leaked = foreign.filter((f) => served.has(String(f.seq)));
console.log(`\nof those, served by production /api/wire: ${leaked.length}`);
for (const f of leaked) console.log(`  LEAK seq ${f.seq}  ${f.headline.slice(0, 90)}`);
console.log(leaked.length === 0
  ? '\nread-time filter is live in production'
  : '\nread-time filter is NOT live in production');
process.exit(leaked.length ? 1 : 0);
