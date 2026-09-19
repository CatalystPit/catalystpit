// UNATTENDED 13F HISTORICAL BACKFILL — the overnight runner.
//
// Wraps the SAME ingestion the bounded script uses (`ingestFiler` from institutions-universe.js).
// There is no second crawler here and no second parse: this file only decides how long to keep
// going and what to do when something goes wrong.
//
//   node --env-file=.env.local --import ./scripts/real-db-register.mjs \
//     scripts/backfill-13f-run.mjs --cutoff 2024-09-30 --hours 20
//
// ── WHY A RUNNER RATHER THAN A LONGER BUDGET ─────────────────────────────────
//
// The bounded script stops on two things that are not actually failures: its own time budget, and an
// SEC 403. Neither is a reason to abandon a multi-hour job — the first is arbitrary and the second
// is a cooldown. This keeps going through both, and stops only for reasons that genuinely mean
// "continuing is unsafe or pointless".
//
// ── SEC SAFETY IS UNCHANGED ──────────────────────────────────────────────────
//
// Request pacing, the identified User-Agent, the per-quarter sleeps and the 403 cooldown all belong
// to institutions-universe.js and are NOT touched.
//
// ONE process, and a pool of WORKERS=3 filers in flight. That is ~1.8 requests/second against SEC's
// published 10/s guidance — under a fifth of it. Concurrency 1 measured 0.6 req/s and a 35-hour ETA
// while spending almost all of its time waiting on a socket, which is idle time rather than
// politeness. The pool is deliberately small and capped at 4: finishing correctly matters more than
// finishing sooner, and a 403 would cost far more than the time saved. If one ever occurs, the right
// response is `--workers 1`, not a bigger pool.
//
// ── FAILURES ARE RECORDED, NOT SWALLOWED ─────────────────────────────────────
//
// One malformed filing must not end a 9,000-filer job, but it must not vanish either. Per-filer
// failures go to `institution_backfill_error` with the message and a retry count, so a permanent
// problem can be investigated afterwards instead of being inferred from a hole in the data.

import { neon } from '@neondatabase/serverless';
import { ingestFiler, secBlocked } from '../src/lib/institutions-universe.js';

const sql = neon(process.env.DATABASE_URL);
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const CUTOFF = argOf('cutoff', '2024-09-30');
const HOURS = parseFloat(argOf('hours', '20'));
const CHUNK = parseInt(argOf('chunk', '150'), 10);       // filers re-queried per checkpoint
const SEC_WAIT_MS = 16 * 60 * 1000;                       // the 403 cooldown, plus a minute
const MAX_CONSECUTIVE_EMPTY = 3;
const WORKERS = Math.max(1, Math.min(4, parseInt(argOf('workers', '3'), 10) || 3));

const t0 = Date.now();
const deadline = t0 + HOURS * 3_600_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mins = () => ((Date.now() - t0) / 60_000).toFixed(1);

await sql`
  create table if not exists institution_backfill_error (
    cik text not null, cutoff date not null, message text, attempts integer not null default 1,
    first_at timestamptz not null default now(), last_at timestamptz not null default now(),
    primary key (cik, cutoff))`;

// ── "ASKED SEC, THERE IS NOTHING THERE" IS A RESULT, AND IT HAS TO BE RECORDED ──
//
// Without this table the run cannot terminate. The queue is "filers with no filing at or before the
// cutoff", and a filer that never filed a 13F-HR before the cutoff can never leave it: the query
// returns the same 300 every chunk, forever, and the remaining 9,000 are never reached. Measured on
// a 20-filer sample of the queue, 8 had no 2024-09-30 filing at SEC at all — not an edge case, 40%
// of the work.
//
// A row here means the filer's own submissions index was read and it genuinely has nothing at or
// before the cutoff. That is a FACT ABOUT SEC'S DATA, not a failure and not a skip, and it is why it
// lives apart from institution_backfill_error. It is only ever written after a clean pass: any
// unreadable quarter sends the filer to the error table to be retried instead.
await sql`
  create table if not exists institution_backfill_done (
    cik text not null, cutoff date not null, quarters integer not null default 0,
    checked_at timestamptz not null default now(),
    primary key (cik, cutoff))`;

const REPORT_EVERY_MS = 120_000;
let lastReport = Date.now();
const stats = { filers: 0, quarters: 0, skipped: 0, unreadable: 0, emptyAtSec: 0, holdings: 0, retryable: 0, permanent: 0, secBlocks: 0, chunks: 0 };

console.log(`13F overnight backfill — cutoff ${CUTOFF}, up to ${HOURS}h, chunks of ${CHUNK}`);
console.log(`started ${new Date().toISOString()}\n`);

let consecutiveEmpty = 0;

while (Date.now() < deadline) {
  // THE CHECKPOINT IS THE DATABASE. Each chunk re-asks which filers still lack anything at or before
  // the cutoff, so an interrupted run loses at most the filer in flight and never repeats a quarter
  // it already stored.
  // ⚠️ ORDERED BY `institutions.filing_count`, NOT by aggregating fund_holdings.
  //
  // The first version ranked filers with `(select cik, count(*) from fund_holdings group by cik)`.
  // That aggregates the WHOLE holdings table — 11.3M rows and growing with every chunk this job
  // writes — and it ran once per chunk. It was the real cause of the throughput decay from 9 to 4.6
  // filers/min, and once the table passed ~11M rows it stopped returning at all: the run sat for five
  // minutes without a single write. `filing_count` is maintained on the registry by ingestFiler
  // itself and is one indexed read.
  // ⚠️ THE INDEX HINT ORDERS THE QUEUE, AND ONLY THAT. See build-13f-index-hint.mjs.
  //
  // `filing_count` alone sorted this queue exactly backwards. It scores a filer by how many quarters
  // we ALREADY have, so the top entry was a fund with seven stored quarters running 2024-12-31 →
  // 2026-06-30 and no 2024-09-30 at all — a perfect score for being the least able to supply the
  // quarter this run exists to fetch. Meanwhile 1,616 of the 9,725 todo filers never filed a 13F-HR
  // in 2024Q4 or 2025Q1 and cannot produce it at any position in the queue.
  //
  // `hinted` says the filer appears in SEC's full-index for one of those quarters, so it was active
  // when the missing data was filed. It decides ORDER only: every filer is still crawled, and the
  // period of report still comes from the filer's own submissions JSON inside ingestFiler. No
  // quarter is ever inferred from the index.
  const todo = await sql`
    select i.cik, coalesce(i.filing_count, 0)::int weight,
           exists (select 1 from institution_index_hint h where h.cik = i.cik) hinted
      from institutions i
     where not exists (select 1 from fund_filings f where f.cik = i.cik and f.quarter <= ${CUTOFF}::date)
       and not exists (
         -- Already asked SEC and it has nothing at or before the cutoff. Without this the queue
         -- never drains: such a filer can never satisfy the condition above.
         select 1 from institution_backfill_done d
          where d.cik = i.cik and d.cutoff = ${CUTOFF}::date)
       and not exists (
         -- Skip filers that have failed repeatedly: three attempts is enough to distinguish a
         -- transient blip from a filer whose filings we cannot parse.
         select 1 from institution_backfill_error e
          where e.cik = i.cik and e.cutoff = ${CUTOFF}::date and e.attempts >= 3)
     order by hinted desc, coalesce(i.filing_count, 0) desc
     limit ${CHUNK}`;

  if (!todo.length) {
    consecutiveEmpty += 1;
    if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) {
      console.log(`\nno filers left for cutoff ${CUTOFF} — backfill COMPLETE at ${mins()} min`);
      break;
    }
    await sleep(5000);
    continue;
  }
  consecutiveEmpty = 0;
  stats.chunks += 1;

  // ── A SMALL WORKER POOL ──────────────────────────────────────────────────
  //
  // Measured at concurrency 1: ~5-9 filers/min, which is roughly 0.6 requests/second and an ETA of
  // 35 hours. The bottleneck is SEC round-trip LATENCY, not our pacing — the database answers a
  // per-filer lookup in 142ms and its statistics are fresh, so the process spends almost all of its
  // time waiting on a socket.
  //
  // WORKERS is deliberately small. At 3 the request rate is about 1.8/s against SEC's published
  // 10/s guidance — under a fifth of it — and every existing protection is untouched: the same
  // per-accession sleeps, the same identified User-Agent, the same 403 cooldown, and still ONE
  // process. This is not aggressive crawling; it is not leaving the connection idle between
  // round trips. A block would cost far more than the time saved, so if one ever occurs the right
  // response is to drop back to 1, not to push higher.
  const queue = [...todo];
  const worker = async () => {
    for (;;) {
      if (Date.now() >= deadline) return;
      // The shared cooldown is checked by every worker, so a 403 pauses the whole pool rather than
      // letting two of them keep hammering a blocked endpoint.
      while (secBlocked()) {
        if (Date.now() >= deadline) return;
        stats.secBlocks += 1;
        console.log(`[${mins()}m] SEC cooldown — waiting ${(SEC_WAIT_MS / 60000).toFixed(0)} min (block #${stats.secBlocks})`);
        await sleep(SEC_WAIT_MS);
      }
      const f = queue.shift();
      if (!f) return;

      try {
        const r = await ingestFiler(f.cik, CUTOFF, { skipUnchanged: true });
        stats.skipped += r.skipped || 0;
        stats.quarters += r.quarters || 0;
        stats.holdings += r.stored || 0;
        stats.filers += 1;
        const unresolved = r.unresolved || [];
        // ⚠️ THE COMPLETION MARKER FOLLOWS `status`, NEVER A COUNT.
        //
        // The bug this guards against is a run reporting success while having skipped real filings,
        // so the decision to write "done" must key off the ingest's own verdict about whether the
        // work happened — not off "did anything go wrong that we happened to count".
        if (r.status === 'failed' || r.error) { await recordError(f.cik, r.error || 'failed'); stats.permanent += 1; }
        else if (r.status === 'partial') {
          // Named quarters could not be resolved, with a reason each. Recorded, NOT marked done, so
          // the next chunk retries — three attempts before the filer is given up on.
          stats.unreadable += unresolved.length;
          await recordError(f.cik, `partial — ${unresolved.map((u) => `${u.quarter}:${u.reason}`).join(' ')}`);
        } else {
          // status === 'complete'. Mark it done whether or not it yielded anything: "SEC has nothing
          // for this filer at or before the cutoff" is a real answer, and it must be recorded or the
          // queue hands the same filer back every chunk. It is only reachable when every quarter was
          // stored or was already stored unchanged.
          await markDone(f.cik, r.quarters || 0);
          if (!r.quarters) stats.emptyAtSec += 1;
        }
      } catch (e) {
        stats.retryable += 1;
        await recordError(f.cik, e.message);
        if (stats.retryable <= 5) console.log(`  [${mins()}m] ${f.cik}: ${String(e.message).slice(0, 100)}`);
        await sleep(2000);
      }

      // TIME-BASED, NOT COUNT-BASED. `stats.filers % 50 === 0` races across workers — three of them
      // incrementing can step straight over the boundary, and an 18-hour unattended run then prints
      // nothing at all and looks stalled when it is working fine.
      if (Date.now() - lastReport > REPORT_EVERY_MS) {
        lastReport = Date.now();
        const rate = stats.filers / ((Date.now() - t0) / 60000);
        const left = await remaining();
        const eta = rate > 0 ? (left / rate / 60).toFixed(1) : '?';
        console.log(`[${mins()}m] ${stats.filers} filers · ${stats.quarters} quarters · ` +
          `${stats.holdings.toLocaleString()} holdings · ${stats.skipped} unchanged · ` +
          `${stats.emptyAtSec} empty-at-SEC · ${stats.unreadable} unreadable · ` +
          `${rate.toFixed(1)}/min · ${left} left · ETA ${eta}h`);
      }
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, () => worker()));
}

// Written ONLY after a pass with nothing unreadable, so "done" always means the filer's submissions
// index was actually read end to end — never that a fetch failed quietly.
async function markDone(cik, quarters) {
  try {
    await sql`
      insert into institution_backfill_done (cik, cutoff, quarters)
      values (${String(cik)}, ${CUTOFF}::date, ${Number(quarters) || 0})
      on conflict (cik, cutoff) do update set quarters = excluded.quarters, checked_at = now()`;
  } catch { /* never let bookkeeping end the run */ }
}

async function recordError(cik, message) {
  try {
    await sql`
      insert into institution_backfill_error (cik, cutoff, message, attempts)
      values (${String(cik)}, ${CUTOFF}::date, ${String(message).slice(0, 500)}, 1)
      on conflict (cik, cutoff) do update set
        attempts = institution_backfill_error.attempts + 1,
        message = excluded.message, last_at = now()`;
  } catch { /* never let error bookkeeping end the run */ }
}
async function remaining() {
  try {
    const r = await sql`
      select count(*)::int n from institutions i
       where not exists (select 1 from fund_filings f where f.cik = i.cik and f.quarter <= ${CUTOFF}::date)
         and not exists (select 1 from institution_backfill_done d
                          where d.cik = i.cik and d.cutoff = ${CUTOFF}::date)
         and not exists (select 1 from institution_backfill_error e
                          where e.cik = i.cik and e.cutoff = ${CUTOFF}::date and e.attempts >= 3)`;
    return r[0].n;
  } catch { return -1; }
}

console.log(`\n=== RUN SUMMARY (${mins()} min) ===`);
console.log(JSON.stringify(stats, null, 2));
console.log(`filers still to do: ${await remaining()}`);

console.log('\nquarter coverage:');
for (const r of await sql`
  select quarter::text q, count(distinct cik)::int funds, count(*)::int holdings, count(distinct ticker)::int tickers
    from fund_holdings group by 1 order by 1`)
  console.log(`  ${r.q}  funds=${String(r.funds).padStart(5)}  holdings=${String(r.holdings.toLocaleString()).padStart(11)}  tickers=${r.tickers}`);

const errs = await sql`
  select attempts, count(*)::int n from institution_backfill_error where cutoff = ${CUTOFF}::date group by 1 order by 1`;
console.log('\nrecorded failures by attempt count:', errs.length ? JSON.stringify(errs) : 'none');

// The three outcomes have to be separable in the log, because they mean completely different things:
// a filer that supplied quarters, a filer SEC genuinely has nothing for, and a filer we failed to
// read. Only the last is a hole in the dataset.
const [d] = await sql`
  select count(*)::int checked, count(*) filter (where quarters > 0)::int with_data,
         count(*) filter (where quarters = 0)::int empty_at_sec
    from institution_backfill_done where cutoff = ${CUTOFF}::date`;
console.log(`filers verified against SEC: ${d.checked} (${d.with_data} supplied quarters, ` +
  `${d.empty_at_sec} genuinely have nothing at or before ${CUTOFF})`);
