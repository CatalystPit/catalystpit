// Where the X auto-poster actually stands right now.
// Run: node --env-file=.env.local scripts/probe-x-status.mjs
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);

const [tot] = await sql.query(`select
    count(*)::int total,
    count(*) filter (where status = 'dry_run')::int dry_run,
    count(*) filter (where status = 'pending')::int pending,
    count(*) filter (where status = 'posted')::int posted,
    count(*) filter (where status = 'suppressed')::int suppressed,
    count(*) filter (where x_post_id is not null)::int with_x_id
  from x_post_candidates`);
console.log('candidates:', JSON.stringify(tot));
console.log(tot.with_x_id === 0 && tot.posted === 0
  ? 'ZERO posts have ever been sent to X.'
  : '*** SOMETHING WAS POSTED — investigate ***');

const [rate] = await sql.query(`select
    count(*)::int n,
    min(created_at)::date::text first_day,
    max(created_at)::date::text last_day,
    round(count(*)::numeric / greatest(1, (max(created_at)::date - min(created_at)::date) + 1), 2) per_day
  from x_post_candidates where status in ('dry_run','pending','posted')`);
console.log('\npublishable:', JSON.stringify(rate));

console.log('\nsuppression reasons:');
for (const r of await sql.query(`select failure_reason, count(*)::int n from x_post_candidates
   where status = 'suppressed' group by 1 order by n desc limit 12`)) {
  console.log(`  ${String(r.n).padStart(4)}  ${r.failure_reason}`);
}

console.log('\nlast 12 posts that WOULD have gone out:');
for (const r of await sql.query(`select post_text, shape, char_count, created_at::text ts
   from x_post_candidates where status in ('dry_run','pending') order by created_at desc limit 12`)) {
  console.log(`  [${r.shape}, ${r.char_count}c] ${r.post_text}`);
}
