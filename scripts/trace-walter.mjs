// Trace the newest WALTERBLOOMBERG event end to end: ingest -> canonical -> candidate -> X.
// Read-only. Run: node --env-file=.env.local scripts/trace-walter.mjs
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);

const walters = await sql.query(`
  select seq, source, headline, source_headline, headline_status, pipeline_status, importance,
         tickers, cluster_id, display_ready, source_type, summary,
         published_at::text pa, received_at::text ra, enriched_at::text ea
    from primary_events
   where source = 'WALTERBLOOMBERG'
   order by received_at desc limit 5`);

console.log('=== 5 NEWEST WALTER EVENTS ===');
for (const w of walters) {
  console.log(`seq ${w.seq}  received ${w.ra}  published ${w.pa}`);
  console.log(`   headline : ${w.headline}`);
  console.log(`   status   : ${w.headline_status} / ${w.pipeline_status}  imp=${w.importance} cluster=${w.cluster_id ?? 'none (canonical)'}`);
}

const newest = walters[0];
if (!newest) { console.log('no Walter events at all'); process.exit(0); }

// The canonical row: itself, or the cluster head it folded into.
const canonSeq = newest.cluster_id ?? newest.seq;
const [canon] = await sql.query(`
  select seq, headline, headline_status, importance, tickers, display_ready, published_at::text pa,
         source_count, summary
    from primary_events where seq = $1`, [String(canonSeq)]);

console.log('\n=== CANONICAL EVENT ===');
console.log(JSON.stringify(canon, null, 1));

console.log('\n=== X CANDIDATE ===');
const cands = await sql.query(`
  select id, event_seq, status, mode, reason, failure_reason, post_text, x_post_id, attempts,
         created_at::text ca, updated_at::text ua, posted_at::text pta
    from x_post_candidates where event_seq = $1`, [String(canonSeq)]);
console.log(cands.length ? JSON.stringify(cands, null, 1) : '  NO CANDIDATE ROW for this event');

console.log('\n=== DID THE CRON EVALUATE IT? ===');
// Any candidate row written after this event arrived proves a pass ran and saw the table.
const [after] = await sql.query(`
  select count(*)::int n, max(created_at)::text newest, string_agg(distinct mode, ',') modes
    from x_post_candidates where created_at > $1::timestamptz`, [newest.ra]);
console.log(`  candidate rows written since the event arrived: ${after.n}`);
console.log(`  newest candidate row: ${after.newest ?? 'none'}`);
console.log(`  modes stamped on them: ${after.modes ?? 'n/a'}`);

console.log('\n=== PRODUCTION RUNTIME MODE (from rows the server itself wrote) ===');
const modes = await sql.query(`
  select mode, count(*)::int n, max(created_at)::text newest
    from x_post_candidates group by 1 order by newest desc`);
for (const m of modes) console.log(`  mode=${m.mode}  rows=${m.n}  newest=${m.newest}`);

console.log('\n=== ANY X API ATTEMPT AT ALL? ===');
const [att] = await sql.query(`
  select count(*) filter (where x_post_id is not null)::int posted,
         count(*) filter (where attempts > 0)::int attempted,
         count(*) filter (where status = 'failed')::int failed,
         count(*) filter (where status = 'pending')::int pending
    from x_post_candidates`);
console.log(JSON.stringify(att));
for (const r of await sql.query(
  "select id, status, attempts, failure_reason, x_post_id from x_post_candidates where attempts > 0 or status in ('failed','posted') limit 10")) {
  console.log(' ', JSON.stringify(r));
}
