// Emit a line for every X post candidate that reaches a terminal state, so going live is observed
// rather than assumed. Covers BOTH outcomes: a post that went out, and a post that failed.
// Run: node --env-file=.env.local scripts/watch-x-posts.mjs
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const seen = new Set();
// Anything already terminal before the watch starts is history, not an event.
for (const r of await sql.query(
  "select id from x_post_candidates where x_post_id is not null or status in ('posted','failed')")) seen.add(String(r.id));
console.log(`watching; ${seen.size} candidates already terminal`);

for (;;) {
  try {
    const rows = await sql.query(`
      select id, status, x_post_id, failure_reason, post_text, attempts, mode
        from x_post_candidates
       where x_post_id is not null or status in ('posted','failed')
       order by updated_at asc nulls first`);
    for (const r of rows) {
      const id = String(r.id);
      if (seen.has(id)) continue;
      seen.add(id);
      if (r.x_post_id) console.log(`POSTED  id=${id} x=${r.x_post_id} [${r.mode}] ${String(r.post_text).slice(0, 110)}`);
      else console.log(`FAILED  id=${id} attempts=${r.attempts} reason=${r.failure_reason} :: ${String(r.post_text).slice(0, 80)}`);
    }
  } catch (e) { console.log(`watch error: ${String(e?.message || e).slice(0, 120)}`); }
  await sleep(45000);
}
