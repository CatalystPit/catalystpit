// PIPELINE LIVENESS — do the daily research clocks actually tick, and can we tell?
//
// ── THE FAILURE THIS EXISTS TO CATCH ────────────────────────────────────────
//
// Freshness is not liveness. On a Sunday every SEC-derived dataset is correctly three days old,
// which is indistinguishable from an ingest that has been throwing since Friday. Form 4's cron
// even returns HTTP 200 on failure by design, so a permanently broken insider feed looked healthy
// from outside. The heartbeats in lib/job-heartbeat.js record that a job RAN, separately from what
// it found, and these assertions keep that wiring honest.
//
// Runs offline by default (structure only). With DATABASE_URL it additionally asserts the LIVE
// last-success age of every tracked job:
//
//   node scripts/verify-pipelines.mjs                       # structure
//   node --env-file=.env.local scripts/verify-pipelines.mjs # structure + live heartbeats
//
// Run with --mutate=<mode> to confirm an assertion actually fails when the rule is broken.

import fs from 'node:fs';
import path from 'node:path';

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const ROOT = new URL('..', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, ROOT), 'utf8');

// lib/job-heartbeat.js imports ./db, which drags in the Clerk/Next server runtime, so TRACKED_JOBS
// is read out of the source and evaluated on its own — the same approach verify-launch-integrity
// uses for ALERT_TYPES. This asserts against the real table, not a copy that can drift.
function trackedJobs() {
  const src = read('src/lib/job-heartbeat.js');
  const start = src.indexOf('export const TRACKED_JOBS = Object.freeze([');
  if (start < 0) throw new Error('TRACKED_JOBS not found');
  const open = src.indexOf('[', start);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']' && --depth === 0) { end = i + 1; break; }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`return ${src.slice(open, end)}`)();
}

const JOBS = trackedJobs();
const heartbeatLib = read('src/lib/job-heartbeat.js');
const vercel = JSON.parse(read('vercel.json'));

// Every file that could plausibly record a heartbeat.
function allApiSources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|jsx)$/.test(e.name)) out.push({ p, s: fs.readFileSync(p, 'utf8') });
    }
  };
  walk(path.join(new URL(ROOT).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'src/app/api'));
  return out;
}
const API = allApiSources();
const ALL_API_SRC = API.map((f) => f.s).join('\n');

L('=== EVERY TRACKED JOB IS ACTUALLY WIRED ===');
{
  ok('there are tracked jobs at all', JOBS.length >= 8, String(JOBS.length));
  for (const j of JOBS) {
    // A job in the table with no call site is a heartbeat that will read "never" forever and be
    // quietly explained away as "that one just hasn't run yet".
    const wired = new RegExp(`recordJobRun\\(\\s*['"\`]${j.name}['"\`]`).test(ALL_API_SRC);
    ok(`${j.name} records a heartbeat somewhere`, mut('unwired') ? false : wired);
  }
  // And the reverse: a call site naming a job that is not tracked never gets read.
  const called = [...ALL_API_SRC.matchAll(/recordJobRun\(\s*['"`]([a-z0-9-]+)['"`]/g)].map((m) => m[1]);
  const names = new Set(JOBS.map((j) => j.name));
  const orphan = [...new Set(called)].filter((c) => !names.has(c));
  ok('no heartbeat is written under an untracked name',
    mut('orphan') ? false : orphan.length === 0, orphan.join(', '));
}

L('\n=== EVERY TRACKED JOB HAS A CRON THAT COULD TICK IT ===');
{
  const paths = (vercel.crons || []).map((c) => c.path);
  // job name → the cron path(s) that drive it. A job with no schedule cannot have a heartbeat.
  const DRIVEN_BY = {
    form4: ['/api/refresh?form4=1'],
    eightk: ['/api/cron/eightk'],
    'congress-sync': ['/api/cron/congress-sync'],
    institutions: ['/api/cron/institutions-universe'],
    'consensus-board': ['/api/cron/consensus-board'],
    quotes: ['/api/refresh'],
    alerts: ['/api/cron/alerts'],
    'insider-alerts': ['/api/cron/insider-alerts'],
    'refresh-content': ['/api/refresh-content'],
  };
  for (const j of JOBS) {
    const want = DRIVEN_BY[j.name] || [];
    ok(`${j.name} is on the cron schedule`,
      mut('nocron') ? false : want.length > 0 && want.some((w) => paths.includes(w)),
      want.join(','));
  }
}

L('\n=== THE SILENCE BUDGETS ARE SANE ===');
{
  for (const j of JOBS) {
    ok(`${j.name} declares a positive window`, Number.isFinite(j.maxAgeHours) && j.maxAgeHours > 0);
  }
  // ⚠️ A WINDOW MUST BE LONGER THAN THE CRON INTERVAL, or the job is "late" between every run.
  const perMinute = JOBS.filter((j) => ['form4', 'quotes'].includes(j.name));
  ok('per-minute jobs still get an hour of grace',
    perMinute.every((j) => j.maxAgeHours >= 1), JSON.stringify(perMinute.map((j) => [j.name, j.maxAgeHours])));
  // 13F is quarterly by nature — a tight window here would page every week for nothing.
  const inst = JOBS.find((j) => j.name === 'institutions');
  ok('13F gets a day, because it is quarterly by nature',
    mut('tight13f') ? false : inst.maxAgeHours >= 24, String(inst?.maxAgeHours));
  // Weekday-only crons must be declared, or a Sunday check reports them as broken.
  const weekdayOnly = JOBS.filter((j) => j.weekdaysOnly).map((j) => j.name);
  ok('weekday-only jobs are marked as such',
    mut('unmarked') ? false : weekdayOnly.includes('alerts') && weekdayOnly.includes('refresh-content'),
    weekdayOnly.join(', '));
}

L('\n=== A HEARTBEAT CAN NEVER BREAK THE JOB IT DESCRIBES ===');
{
  // Bookkeeping must not turn a successful ingest into a 500.
  ok('recordJobRun swallows its own errors',
    mut('throws') ? false : /catch \(e\) \{\s*\n\s*console\.log\(`\[heartbeat\]/.test(heartbeatLib));
  ok('…and only a successful run moves the success clock',
    /last_success_at = case when \$\{!!ok\} then now\(\) else feed_state\.last_success_at end/.test(heartbeatLib));
  ok('…while a failure increments the failure count',
    /consecutive_failures = case when \$\{!!ok\} then 0 else feed_state\.consecutive_failures \+ 1 end/.test(heartbeatLib));
  // It reuses the existing table rather than inventing a second source of truth.
  ok('heartbeats live in the existing feed_state table',
    mut('newtable') ? false : /insert into feed_state/.test(heartbeatLib));
  ok('…namespaced so they cannot collide with a feed key',
    /export const jobKey = \(name\) => `job:/.test(heartbeatLib));

  // ⚠️ THE FORM 4 CRON RETURNS 200 ON FAILURE BY DESIGN. The heartbeat is the ONLY record of that
  // failure, so it must not be skipped in the catch.
  const refresh = read('src/app/api/refresh/route.js');
  // The 200-on-failure return, and the failure heartbeat that must precede it in the same catch.
  const ret200 = refresh.indexOf("return Response.json({ form4: true, error: e.message }, { status: 200 })");
  const failBeat = refresh.indexOf("recordJobRun('form4', { ok: false");
  ok('a failing Form 4 run records a FAILED heartbeat despite answering 200',
    mut('silentform4') ? false : failBeat > 0 && ret200 > failBeat && (ret200 - failBeat) < 400,
    `beat@${failBeat} return@${ret200}`);
}

L('\n=== /api/health REPORTS LIVENESS SEPARATELY FROM FRESHNESS ===');
{
  const health = read('src/app/api/health/route.js');
  ok('health reads the heartbeats', /readJobHeartbeats\(\)/.test(health));
  ok('…and reports them as their own block',
    mut('foldedin') ? false : /\n    jobs,\n/.test(health));
  // A weekday-only job at the weekend is idle, not late — otherwise the check cries wolf every
  // Saturday and gets ignored by Monday.
  ok('a weekday-only job is idle-by-design at the weekend',
    mut('cryingwolf') ? false : /idle_by_design/.test(health) && /getUTCDay\(\)/.test(health));
  ok('…and a job that has never run is not reported as an outage',
    /state: b == null \? 'never'/.test(health));
}

L('\n=== THE NEWS FEED RANKS BEFORE IT SLICES ===');
{
  // The curated pool expires nightly and all weekend, which silently made the raw PR wire the
  // hero. Signed-out visitors only ever receive the first six elements, so the ranking has to
  // happen server-side — client-side sorting could never reach a story sitting at index 20.
  const news = read('src/app/api/news/route.js');
  const rankAt = news.indexOf('rankOf');
  const sliceAt = news.indexOf('raw.slice(0, SIGNED_OUT_VISIBLE)');
  ok('the feed is ranked by impact', mut('noranking') ? false : rankAt > 0);
  ok('…before the signed-out slice', mut('slicefirst') ? false : rankAt > 0 && rankAt < sliceAt);
  ok('…using the same impactOf the High-impact filter uses',
    /from '\.\.\/\.\.\/\.\.\/lib\/impact'/.test(news));
  ok('curated stories still outrank the wire',
    mut('wirefirst') ? false : /x\.tier - y\.tier/.test(news));
  // ⚠️ RANKING, NOT FILTERING. Nothing may be dropped — the routine items stay, lower down.
  ok('nothing is filtered out of the feed',
    mut('drops') ? false : !/\.filter\(\s*\(?a\)?\s*=>\s*impactOf/.test(news));
  ok('the payload says how the feed was composed',
    /curatedCount:/.test(news) && /wireCount:/.test(news));
}

// ── LIVE HEARTBEAT AGES (only with DATABASE_URL) ────────────────────────────
if (process.env.DATABASE_URL) {
  L('\n=== LIVE: EVERY CLOCK TICKED INSIDE ITS WINDOW ===');
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql.query(
    `select feed_key, last_success_at, consecutive_failures, note from feed_state where feed_key like 'job:%'`);
  const beats = new Map(rows.map((r) => [String(r.feed_key).replace(/^job:/, ''), r]));
  const weekend = [0, 6].includes(new Date().getUTCDay());

  for (const j of JOBS) {
    const b = beats.get(j.name);
    if (!b) {
      // Not a failure: the heartbeat only exists once the job has run since this shipped.
      L(`  --   ${j.name} has no heartbeat yet (not deployed long enough)`);
      continue;
    }
    const age = (Date.now() - new Date(b.last_success_at).getTime()) / 36e5;
    if (j.weekdaysOnly && weekend) {
      L(`  --   ${j.name} idle by design (weekday-only cron, today is a weekend)`);
      continue;
    }
    ok(`${j.name} succeeded within ${j.maxAgeHours}h`,
      Number.isFinite(age) && age <= j.maxAgeHours, `${age.toFixed(1)}h ago`);
  }
} else {
  L('\n(skipping live heartbeat ages — no DATABASE_URL; run with --env-file=.env.local)');
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
