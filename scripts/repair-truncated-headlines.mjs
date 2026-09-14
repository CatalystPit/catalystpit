// Repair canonical headlines the old character slice broke. Nothing is deleted: the headline is
// recomputed from the row's own source_headline with the completeness-aware shortener, so the
// repaired line is either a complete shortening or the complete original.
//
//   node --env-file=.env.local scripts/repair-truncated-headlines.mjs           # report
//   node --env-file=.env.local scripts/repair-truncated-headlines.mjs --apply
import { neon } from '@neondatabase/serverless';
import { canonicalHeadline, cleanHeadline, isCompletePhrase } from '../src/lib/news-normalize.mjs';
import { normHash } from '../src/lib/event-cluster.mjs';

const sql = neon(process.env.DATABASE_URL);
const apply = process.argv.includes('--apply');
const di = process.argv.indexOf('--days');
const days = Number(di >= 0 ? process.argv[di + 1] : 90) || 90;

const rows = await sql.query(`
  select seq, source, source_kind, headline, source_headline, tickers, headline_status,
         importance, display_ready, cluster_id
    from primary_events
   where published_at > now() - ($1 || ' days')::interval
     and (headline like '%…' or headline like '%...')
   order by published_at desc`, [String(days)]);

console.log(`truncated canonical headlines found: ${rows.length}`);
console.log(`  display-ready canonical : ${rows.filter((r) => r.display_ready && !r.cluster_id).length}`);
console.log(`  HIGH or CRITICAL        : ${rows.filter((r) => r.importance >= 2).length}`);

// A headline Catalyst Pit WROTE is never rebuilt from the publisher's words.
const AUTHORED = new Set(['original', 'composed']);
const plan = [];
for (const r of rows) {
  if (AUTHORED.has(r.headline_status)) continue;        // model wording, not the slice's doing
  const src = r.source_headline || r.headline;
  const fixed = canonicalHeadline(src, r.tickers || []);
  if (!fixed || fixed === r.headline) continue;
  plan.push({ ...r, fixed, complete: isCompletePhrase(fixed) });
}

const repairable = plan.filter((p) => p.complete);
const notFixable = plan.filter((p) => !p.complete);
console.log(`\nrepairable: ${repairable.length}   still incomplete after rebuild: ${notFixable.length}`);
for (const p of repairable.slice(0, 20)) {
  console.log(`  seq ${p.seq} imp=${p.importance}`);
  console.log(`    was: ${p.headline}`);
  console.log(`    now: ${p.fixed}`);
}
for (const p of notFixable.slice(0, 10)) console.log(`  UNFIXED seq ${p.seq}: ${p.fixed.slice(0, 120)}`);

if (!apply) { console.log('\nreport only — pass --apply'); process.exit(0); }
let n = 0;
for (const p of repairable) {
  await sql.query(
    `update primary_events set headline = $2, display_hash = $3, enriched_at = now() where seq = $1`,
    [p.seq, p.fixed, normHash(p.fixed) || null]);
  n++;
}
console.log(`\nrepaired ${n} headlines from their own source_headline. Provenance untouched.`);
