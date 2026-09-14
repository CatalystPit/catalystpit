// Generate X post candidates from EXISTING canonical events, so the operator can see what Catalyst
// Pit would have posted before anything is ever sent.
//
// This is the same eligibility, wording and formatting path the cron uses — it imports the very
// same pure module — with the database access written directly so it can run from the shell. It
// NEVER contacts X: this file contains no reference to any X endpoint and no credential is read.
//
//   node --env-file=.env.local scripts/backfill-x-candidates.mjs [--days=N] [--apply]
//
// Without --apply it reports and writes nothing.

import postgres from 'postgres';
import { buildCandidate } from '../src/lib/x-autopost.mjs';

const APPLY = process.argv.includes('--apply');
const DAYS = Number((process.argv.find((a) => a.startsWith('--days=')) || '').slice(7)) || 7;
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const rows = await sql`
  select e.seq, e.headline, e.headline_status, e.importance, e.tickers, e.source_kind, e.published_at,
         array(select distinct m.source from primary_events m
                where m.seq = e.seq or m.cluster_id = e.seq) as sources
    from primary_events e
    left join x_post_candidates c on c.event_seq = e.seq
   where e.cluster_id is null
     and c.id is null
     and e.published_at > now() - (${DAYS} || ' days')::interval
     and (e.importance = 3 or exists (
           select 1 from primary_events w
            where (w.seq = e.seq or w.cluster_id = e.seq) and w.source = 'WALTERBLOOMBERG'))
   order by e.published_at desc`;

console.log(`canonical events matching the prefilter in ${DAYS} days: ${rows.length}`);

const made = [], blocked = {};
for (const ev of rows) {
  // No market-reaction reading: the only change figure held is a daily screener value hours to days
  // old, and presenting that as the reaction to a breaking event would be inventing a fact.
  const c = buildCandidate(ev, null);
  if (!c.eligible) { blocked[c.blocked] = (blocked[c.blocked] || 0) + 1; continue; }
  made.push({ ev, c });
}
console.log(`eligible: ${made.length}`);
console.log(`not eligible: ${JSON.stringify(blocked, null, 1)}`);

const byReason = {};
for (const { c } of made) byReason[c.reason] = (byReason[c.reason] || 0) + 1;
console.log(`by reason: ${JSON.stringify(byReason)}`);

const span = rows.length ? (Date.now() - new Date(rows.at(-1).published_at).getTime()) / 86400e3 : DAYS;
console.log(`\nobserved window: ${span.toFixed(2)} days  ->  ESTIMATED ${(made.length / Math.max(span, 0.01)).toFixed(1)} posts/day`);

console.log('\n--- what would have been posted (newest 25) ---');
for (const { ev, c } of made.slice(0, 25)) {
  console.log(`\n[${new Date(ev.published_at).toISOString().slice(5, 16).replace('T', ' ')}] ` +
    `${c.reason} | impact ${ev.importance} | ${c.chars} chars | ${c.shape}`);
  console.log(c.text.split('\n').map((l) => `   ${l}`).join('\n'));
}

if (!APPLY) { console.log('\nDRY REPORT — nothing written. Re-run with --apply to persist candidates.'); await sql.end(); process.exit(0); }

let created = 0;
for (const { ev, c } of made) {
  const ins = await sql`
    insert into x_post_candidates (event_seq, reason, post_text, char_count, shape, ticker, impact, mode, status)
    values (${ev.seq}, ${c.reason}, ${c.text}, ${c.chars}, ${c.shape},
            ${(ev.tickers || [])[0] ?? null}, ${ev.importance ?? null}, 'dry_run', 'dry_run')
    on conflict (event_seq) do nothing returning id`;
  if (ins.length) created++;
}
console.log(`\npersisted ${created} candidates (status dry_run). ZERO posts sent.`);
const total = (await sql`select count(*) n from x_post_candidates`)[0].n;
const live = (await sql`select count(*) n from x_post_candidates where x_post_id is not null`)[0].n;
console.log(`table now holds ${total} candidates, ${live} of which have an X post id (must be 0).`);
await sql.end();
