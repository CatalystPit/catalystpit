// Re-run the X dry run from scratch against the CORRECTED canonical headlines, then report it for
// editorial review. DRY RUN ONLY — this file has no path to X's API and never loads a credential.
//
// It mirrors generateCandidates() in x-publisher.js exactly: same eligibility SQL, same priors
// window, same pure buildCandidate(). The reason it is a script rather than the cron route is that
// the route needs CRON_SECRET, which is a Vercel secret and is not on this machine.
//
//   node --env-file=.env.local scripts/rerun-x-dryrun.mjs --reset        # wipe and regenerate
//   node --env-file=.env.local scripts/rerun-x-dryrun.mjs --report       # report only
import { neon } from '@neondatabase/serverless';
import { writeFileSync } from 'node:fs';
import { buildCandidate } from '../src/lib/x-autopost.mjs';

const sql = neon(process.env.DATABASE_URL);
const reset = process.argv.includes('--reset');
const hi = process.argv.indexOf('--hours');
const HOURS = Number(hi >= 0 ? process.argv[hi + 1] : 72) || 72;
const MODE = 'dry_run';                       // never anything else in this script

if (reset) {
  const old = await sql.query('select * from x_post_candidates');
  const path = `${process.env.TEMP || '.'}/x-candidates-backup-${Date.now()}.json`;
  writeFileSync(path, JSON.stringify(old, null, 1));
  console.log(`backed up ${old.length} existing candidates to ${path}`);
  await sql.query('delete from x_post_candidates');
  console.log('cleared x_post_candidates\n');
}

// ── generation, mirroring x-publisher.generateCandidates ─────────────────────
if (reset) {
  const rows = await sql.query(`
    select e.seq, e.headline, e.headline_status, e.importance, e.tickers, e.source_kind,
           e.published_at,
           array(select distinct m.source from primary_events m
                  where m.seq = e.seq or m.cluster_id = e.seq) as sources
      from primary_events e
      left join x_post_candidates c on c.event_seq = e.seq
     where e.cluster_id is null and c.id is null
       and e.published_at > now() - ($1 || ' hours')::interval
       and (e.importance = 3 or exists (
             select 1 from primary_events w
              where (w.seq = e.seq or w.cluster_id = e.seq) and w.source = 'WALTERBLOOMBERG'))
     order by e.published_at desc limit 2000`, [String(HOURS)]);

  const priors = [];
  let created = 0, suppressed = 0, waiting = 0, skipped = 0;
  const blocked = {};
  // Oldest first, so the story guard sees the same order the live pass would.
  for (const ev of [...rows].reverse()) {
    const c = buildCandidate(ev, null, Date.parse(ev.published_at), priors);
    if (!c.eligible) {
      if (c.blocked?.startsWith('awaiting')) waiting++; else skipped++;
      blocked[c.blocked || 'unknown'] = (blocked[c.blocked || 'unknown'] || 0) + 1;
      continue;
    }
    if (!c.publishable) {
      suppressed++;
      await sql.query(`insert into x_post_candidates
        (event_seq, reason, post_text, char_count, shape, ticker, impact, mode, status, failure_reason)
        values ($1,$2,$3,0,'suppressed',$4,$5,$6,'suppressed',$7) on conflict (event_seq) do nothing`,
      [ev.seq, c.reason, ev.headline ?? '', (ev.tickers || [])[0] ?? null, ev.importance ?? null, MODE, c.suppressed]);
      continue;
    }
    const ins = await sql.query(`insert into x_post_candidates
      (event_seq, reason, post_text, char_count, shape, ticker, impact, mode, status, story_key, post_facts)
      values ($1,$2,$3,$4,$5,$6,$7,$8,'dry_run',$9,$10)
      on conflict (event_seq) do nothing returning id`,
    [ev.seq, c.reason, c.text, c.chars, c.shape, (ev.tickers || [])[0] ?? null, ev.importance ?? null, MODE,
      c.storyKey ?? null, c.facts ?? null]);
    if (ins.length) {
      created++;
      priors.unshift({ headline: ev.headline, story_key: c.storyKey, post_facts: c.facts, created_at: ev.published_at });
    }
  }
  console.log(`evaluated ${rows.length} eligible-prefilter events over ${HOURS}h`);
  console.log(`  publishable ${created} · suppressed ${suppressed} · awaiting wording ${waiting} · not eligible ${skipped}`);
  console.log('  ineligibility:', JSON.stringify(blocked));
  console.log('');
}

// ── report ───────────────────────────────────────────────────────────────────
const [tot] = await sql.query(`select
   count(*)::int total,
   count(*) filter (where status in ('dry_run','pending'))::int publishable,
   count(*) filter (where status = 'suppressed')::int suppressed,
   count(*) filter (where x_post_id is not null)::int sent
  from x_post_candidates`);
console.log('=== TOTALS ===');
console.log(`  evaluated (rows written) : ${tot.total}`);
console.log(`  publishable              : ${tot.publishable}`);
console.log(`  suppressed               : ${tot.suppressed}`);
console.log(`  actually sent to X       : ${tot.sent}  ${tot.sent === 0 ? '(dry run holding)' : '*** INVESTIGATE ***'}`);

console.log('\n=== SUPPRESSION REASONS ===');
for (const r of await sql.query(`select failure_reason, count(*)::int n from x_post_candidates
   where status='suppressed' group by 1 order by n desc`)) {
  console.log(`  ${String(r.n).padStart(4)}  ${r.failure_reason}`);
}

// Steady state is measured against the EVENT clock, over whole hours of real arrivals — not the
// clock of this backfill pass, which wrote every row in one burst.
console.log('\n=== STEADY-STATE RATE (event clock, whole hours only) ===');
const [rate] = await sql.query(`
  with p as (
    select e.published_at
      from x_post_candidates c join primary_events e on e.seq = c.event_seq
     where c.status in ('dry_run','pending')
  )
  select count(*)::int n,
         min(published_at)::text first_ev, max(published_at)::text last_ev,
         round(extract(epoch from (max(published_at) - min(published_at))) / 3600.0, 2) span_h
    from p`);
const perDay = rate.span_h > 0 ? (rate.n / rate.span_h) * 24 : 0;
console.log(`  ${rate.n} publishable events spanning ${rate.span_h}h (${rate.first_ev} -> ${rate.last_ev})`);
console.log(`  = ${perDay.toFixed(1)} posts/day`);

console.log('\n=== EVERY POST FROM THE MOST RECENT 6 HOURS OF EVENTS ===');
const recent = await sql.query(`
  select c.post_text, c.shape, c.char_count, c.reason, c.ticker, c.impact, c.story_key,
         e.headline, e.published_at, e.source_count, e.seq,
         (select string_agg(distinct m.source, ',') from primary_events m
           where m.seq = e.seq or m.cluster_id = e.seq) sources
    from x_post_candidates c join primary_events e on e.seq = c.event_seq
   where c.status in ('dry_run','pending')
     and e.published_at > (select max(published_at) from primary_events) - interval '6 hours'
   order by e.published_at asc`);
console.log(`  ${recent.length} posts\n`);
for (const r of recent) {
  const t = new Date(r.published_at).toISOString().replace('T', ' ').slice(0, 16);
  console.log(`  ${t}Z  |  ${r.reason}  |  impact ${r.impact}  |  ticker ${r.ticker || '-'}  |  ${r.shape}`);
  console.log(`     event   : ${r.headline}`);
  console.log(`     TWEET   : ${r.post_text}`);
  console.log(`     (${r.char_count} chars, ${r.source_count} source${r.source_count === 1 ? '' : 's'}, story ${r.story_key || '-'})`);
  console.log('');
}
