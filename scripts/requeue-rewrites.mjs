// Returns the whole rewrite backlog to the enrichment queue.
//
// Two things happen, both idempotent:
//   1. Legacy 'normalized' rows — the old label for "cleaned the publisher's sentence" — become
//      rewrite_pending, because that is what they actually are.
//   2. Every non-SEC rewrite_pending row is re-queued and has its attempt counter cleared, since
//      the attempts it burned were spent on an API with no credits, not on a real judgement.
//
// Touches pipeline_status, headline_status and enrich_attempts only. No headline is rewritten, no
// raw source field is read or written, no SEC row is eligible.
//
// Run: node --env-file=.env.local scripts/requeue-rewrites.mjs [--apply]

import postgres from 'postgres';

const APPLY = process.argv.includes('--apply');
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const MAX_REWRITE_ATTEMPTS = 3;

const count = async (where) => Number((await sql`select count(*) n from primary_events where ${where}`)[0].n);

const snapshot = async (label) => {
  console.log(`\n=== ${label} ===`);
  for (const r of await sql`select headline_status, pipeline_status, count(*) n
      from primary_events where source_kind <> 'sec' group by 1,2 order by 3 desc`)
    console.log(`  ${String(r.headline_status).padEnd(18)} ${String(r.pipeline_status).padEnd(9)} ${r.n}`);
  const pending = await count(sql`headline_status = 'rewrite_pending' and source_kind <> 'sec'`);
  const reachable = await count(sql`headline_status = 'rewrite_pending' and source_kind <> 'sec' and enrich_attempts < ${MAX_REWRITE_ATTEMPTS}`);
  console.log(`  rewrite_pending: ${pending}  ·  reachable by the queue: ${reachable}  (${pending ? (reachable / pending * 100).toFixed(1) : '0'}%)`);
  return { pending, reachable };
};

const before = await snapshot('BEFORE');

if (APPLY) {
  const legacy = await sql`
    update primary_events set headline_status = 'rewrite_pending'
     where source_kind <> 'sec' and headline_status = 'normalized'
    returning seq`;
  console.log(`\n  legacy 'normalized' relabelled: ${legacy.length}`);

  const requeued = await sql`
    update primary_events set pipeline_status = 'pending', enrich_attempts = 0
     where source_kind <> 'sec' and headline_status = 'rewrite_pending'
    returning seq`;
  console.log(`  re-queued with attempts cleared: ${requeued.length}`);
} else {
  console.log('\n  DRY RUN — pass --apply to write');
}

const after = await snapshot(APPLY ? 'AFTER' : 'WOULD BECOME');

console.log('\n=== SAFETY ===');
console.log('  SEC rows touched              :', await count(sql`source_kind = 'sec' and pipeline_status <> 'ready'`));
console.log('  SEC not not_required          :', await count(sql`source_kind = 'sec' and headline_status <> 'not_required'`));
console.log('  rows missing source_headline  :', await count(sql`source_headline is null`));
console.log('  rows missing original_url     :', await count(sql`original_url is null`));
console.log('  rows missing raw payload      :', await count(sql`raw is null`));
console.log('  composed rows preserved       :', await count(sql`headline_status = 'composed'`));

if (APPLY && after.pending !== after.reachable) {
  console.error(`\n  FAIL: ${after.pending - after.reachable} pending rows are still unreachable`);
  await sql.end();
  process.exit(1);
}
await sql.end();
