// Watches the Catalyst Pit headline rewrite queue drain and reports the final split.
//
// Read-only. It runs nothing and writes nothing — the production news-enrich cron does the work.
// Exits when the queue is drained, or when it stalls, so completion can be reported either way.
//
//   drained = no rewrite_pending row left with enrich_attempts < MAX (everything either rewritten
//             or genuinely exhausted, i.e. commentary with no factual event to state)
//
// Run: node --env-file=.env.local scripts/watch-headline-backfill.mjs

import postgres from 'postgres';

const POLL_MS = 5 * 60 * 1000;
const STALL_MIN = 45;        // the cron runs every minute; 45 idle minutes means it stopped
const MAX_HOURS = 12;
const MAX_ATTEMPTS = 3;

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const stamp = () => new Date().toISOString().slice(11, 19);

const state = async () => (await sql`
  select
    count(*) filter (where headline_status = 'original')                                    as original,
    count(*) filter (where headline_status = 'composed')                                    as composed,
    count(*) filter (where headline_status = 'rewrite_pending')                             as pending,
    count(*) filter (where headline_status = 'rewrite_pending' and enrich_attempts < ${MAX_ATTEMPTS}) as workable,
    count(*) filter (where headline_status = 'rewrite_pending' and enrich_attempts >= ${MAX_ATTEMPTS}) as exhausted
  from primary_events where source_kind <> 'sec'`)[0];

const start = Date.now();
let last = await state();
let lastProgressAt = Date.now();
console.log(`${stamp()} watching — workable=${last.workable} original=${last.original} exhausted=${last.exhausted}`);

let reason = null;
for (;;) {
  if (Number(last.workable) === 0) { reason = 'queue drained'; break; }
  if (Date.now() - start > MAX_HOURS * 3600e3) { reason = `hit the ${MAX_HOURS}h ceiling`; break; }

  await new Promise((r) => setTimeout(r, POLL_MS));
  const now = await state();
  if (Number(now.workable) !== Number(last.workable) || Number(now.original) !== Number(last.original)) {
    lastProgressAt = Date.now();
    console.log(`${stamp()} workable=${now.workable} (-${last.workable - now.workable})  original=${now.original} (+${now.original - last.original})  exhausted=${now.exhausted}`);
  } else if (Date.now() - lastProgressAt > STALL_MIN * 60e3) {
    reason = `no progress for ${STALL_MIN} minutes`;
    last = now;
    break;
  }
  last = now;
}

const f = await state();
const total = Number(f.original) + Number(f.composed) + Number(f.pending);
const pct = (n) => ((Number(n) / total) * 100).toFixed(1) + '%';
console.log(`\n${stamp()} HEADLINE BACKFILL COMPLETE — ${reason}`);
console.log(`  Catalyst Pit wording (original) : ${f.original}  ${pct(f.original)}`);
console.log(`  deterministic (composed)        : ${f.composed}  ${pct(f.composed)}`);
console.log(`  still publisher-worded (pending): ${f.pending}  ${pct(f.pending)}`);
console.log(`    of which exhausted, no event  : ${f.exhausted}`);
console.log(`  total non-SEC canonical events  : ${total}`);

// Provenance must be intact regardless of what the rewrites did.
const bad = (await sql`select count(*) n from primary_events
  where source_headline is null or original_url is null or source_name is null or raw is null`)[0];
console.log(`  rows missing raw provenance     : ${bad.n}`);
const sec = (await sql`select count(*) n from primary_events
  where source_kind='sec' and (headline <> source_headline or headline_status <> 'not_required')`)[0];
console.log(`  SEC rows altered                : ${sec.n}`);
await sql.end();
