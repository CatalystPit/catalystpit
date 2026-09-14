// Re-score stored importance with the current scorer.
//
// The impact badge is computed at INGEST, so a scorer improvement only reaches new rows. The macro
// dimension exists because a live production event — Saudi Arabia's East-West pipeline taken
// offline by a drone attack — scored 0 from all eight sources that reported it and disappeared from
// Market Moving. Those rows have to be re-scored or the fix is invisible on the tape that prompted it.
//
// Only importance changes. No headline, no provenance, no cluster, no SEC row is touched, and the
// canonical head of a cluster takes the highest score in its cluster so a merged event is ranked by
// the best-worded report of it.
//
// Run: node --env-file=.env.local scripts/rescore-impact.mjs [--apply] [--days=N]

import postgres from 'postgres';
import { scoreImportance, IMPORTANCE_LABEL } from '../src/lib/news-normalize.mjs';

const APPLY = process.argv.includes('--apply');
const DAYS = Number((process.argv.find((a) => a.startsWith('--days=')) || '').slice(7)) || 14;
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const rows = await sql`select seq, source, source_type, headline, summary, tickers, importance, cluster_id
  from primary_events
 where source_kind <> 'sec' and published_at > now() - (${DAYS} || ' days')::interval`;
console.log(`scoring ${rows.length} rows from the last ${DAYS} days`);

const changes = [];
for (const r of rows) {
  const next = scoreImportance({ headline: r.headline, summary: r.summary, source: r.source,
    sourceType: r.source_type, tickers: r.tickers || [] });
  if (next !== r.importance) changes.push({ seq: r.seq, from: r.importance, to: next, headline: r.headline });
}
const up = changes.filter((c) => c.to > c.from), down = changes.filter((c) => c.to < c.from);
console.log(`  changed: ${changes.length}  (raised ${up.length}, lowered ${down.length})`);
console.log(`  newly CRITICAL: ${up.filter((c) => c.to === 3).length} | newly HIGH: ${up.filter((c) => c.to === 2).length}`);
for (const c of up.filter((x) => x.to === 3).slice(0, 12))
  console.log(`   ${IMPORTANCE_LABEL[c.from]} -> CRITICAL  ${JSON.stringify(c.headline).slice(0, 86)}`);

if (!APPLY) { console.log('\n  DRY RUN — re-run with --apply.'); await sql.end(); process.exit(0); }

for (let i = 0; i < changes.length; i += 500) {
  const batch = changes.slice(i, i + 500);
  await sql`update primary_events p set importance = v.imp::smallint
    from (values ${sql(batch.map((c) => [c.seq, c.to]))}) as v(seq, imp)
    where p.seq = v.seq::bigint`;
  process.stdout.write(`\r  written: ${Math.min(i + 500, changes.length)}/${changes.length}`);
}
console.log('');

// A canonical head represents its whole cluster, so it carries the cluster's best score.
const heads = await sql`update primary_events h
   set importance = m.best
  from (select cluster_id, max(importance) best from primary_events
         where cluster_id is not null group by cluster_id) m
 where h.seq = m.cluster_id and h.importance < m.best and h.source_kind <> 'sec'
 returning h.seq`;
console.log(`  canonical heads raised to their cluster's best score: ${heads.length}`);

const sec = await sql`select count(*) n, count(*) filter (where headline <> source_headline) altered
  from primary_events where source_kind = 'sec'`;
console.log(`  SEC untouched: ${sec[0].n} rows, ${sec[0].altered} altered`);
const dist = await sql`select importance, count(*) n from primary_events
  where source_kind <> 'sec' and published_at > now() - (${DAYS} || ' days')::interval group by 1 order by 1 desc`;
console.log(`  distribution now: ${dist.map((d) => `${IMPORTANCE_LABEL[d.importance]}=${d.n}`).join(' ')}`);
await sql.end();
