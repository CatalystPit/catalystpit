// LAUNCH MONITORING — is the monitoring itself correct?
//
//   node --import ./scripts/lib/node-resolve-hook.mjs --env-file=.env.local scripts/verify-monitoring.mjs
//
// ⚠️ THE FAILURE THIS EXISTS FOR IS A HEARTBEAT NOBODY READS. market-breadth and score-conviction
// both called recordJobRun from the day they shipped and neither was ever added to TRACKED_JOBS, so
// the row was written, /api/health never looked at it, and either job could have been dead for a
// week while the dashboard stayed green. That is worse than no monitoring, because it looks like
// coverage. The first section below makes the two registers agree by construction.
//
// ⚠️ AND MONITORING MUST NOT BECOME THE OUTAGE. Every telemetry write in this codebase swallows its
// own error, because it describes work that has already finished — a logging failure that turned a
// completed payment into a Stripe retry loop would be a worse incident than the one it was meant to
// surface. That contract is asserted here rather than trusted.
import { readdirSync, readFileSync } from 'node:fs';
import { TRACKED_JOBS } from '../src/lib/job-heartbeat.js';
import { intervalOf } from '../src/lib/billing/events.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'https://www.catalystpit.com');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

function srcFiles(rel = '../src') {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(new URL(dir + '/', import.meta.url), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(`${dir}/${e.name}`);
      else if (/\.(jsx?|mjs)$/.test(e.name)) out.push(`${dir}/${e.name}`);
    }
  };
  walk(rel);
  return out;
}

L('⚠️ every heartbeat written is a heartbeat read, and the reverse');
{
  const files = srcFiles();
  const written = new Set();
  // ⚠️ THE NAME IS NOT ALWAYS AT THE CALL. Most routes wrap recordJobRun in a local `beat()` helper
  // so the swallow-and-truncate logic is written once; screener-technicals goes further and passes
  // the job name in, because it ticks TWO clocks — its own and market-breadth's, which it refreshes
  // as a ride-along. Scanning only for recordJobRun('name') reported that job as never fed while it
  // was being fed twice a day. So literals handed to either function count.
  for (const f of files) {
    const s = read(f);
    for (const m of s.matchAll(/(?:recordJobRun|beat)\(\s*'([a-z0-9-]+)'/g)) written.add(m[1]);
  }
  const tracked = new Set(TRACKED_JOBS.map((j) => j.name));

  // ⚠️ THE BUG, BOTH WAYS ROUND. A name written but not tracked is an invisible job. A name tracked
  // but never written reports `never` forever and trains whoever reads the page to ignore it.
  const unread = [...written].filter((n) => !tracked.has(n));
  const unwritten = [...tracked].filter((n) => !written.has(n));
  ok('⚠️ no job records a heartbeat that nothing reads', unread.length === 0, unread.join(', '));
  ok('⚠️ no tracked job is missing the call that would feed it', unwritten.length === 0, unwritten.join(', '));
  ok('the registry is not empty and covers the launch-critical pipelines', tracked.size >= 20, String(tracked.size));

  for (const name of ['form4', 'eightk', 'quotes', 'primary-sources', 'screener', 'market-breadth', 'stripe-webhook']) {
    ok(`launch-critical job is tracked: ${name}`, tracked.has(name));
  }
}

L('⚠️ a cadence is per-pipeline, and an event-driven job has none');
{
  for (const j of TRACKED_JOBS) {
    if (j.eventDriven) {
      // ⚠️ AN EVENT-DRIVEN JOB WITH A MAX AGE WOULD REPORT A QUIET WEEK AS AN OUTAGE. The Stripe
      // webhook fires when somebody subscribes; at launch that may be days apart, and "no
      // subscriptions since Tuesday" is a fact about the market, not a broken endpoint.
      ok(`⚠️ ${j.name} is judged on failures, not on age`, j.maxAgeHours === undefined);
      continue;
    }
    ok(`${j.name} states its own expected cadence`,
      Number.isFinite(j.maxAgeHours) && j.maxAgeHours > 0, String(j.maxAgeHours));
  }
  // ⚠️ NOT ONE GLOBAL TIMEOUT. A minute-by-minute wire and a daily rebuild cannot share a threshold:
  // the daily job would flap or the wire could die for a day unnoticed.
  const ages = new Set(TRACKED_JOBS.filter((j) => !j.eventDriven).map((j) => j.maxAgeHours));
  ok('⚠️ thresholds are per-pipeline rather than one global number', ages.size >= 4, [...ages].join(','));
  ok('…the Pit Wire, which runs every minute, is not given a daily tolerance',
    TRACKED_JOBS.find((j) => j.name === 'primary-sources').maxAgeHours <= 3);
  ok('…and a daily rebuild is not held to an hourly one',
    TRACKED_JOBS.find((j) => j.name === 'screener').maxAgeHours >= 24);
}

L('⚠️ weekends and empty results are not outages');
{
  const hb = read('../src/lib/job-heartbeat.js');
  const health = read('../src/app/api/health/route.js');
  ok('⚠️ a weekday-only job is idle by design at the weekend, not late',
    /idleByDesign/.test(health) && /weekdaysOnly/.test(hb));
  ok('⚠️ a successful run with nothing to write still ticks the clock',
    /seen: 0` is a perfectly healthy|0 is healthy and expected/.test(hb));
  // The Pit Wire is the one most likely to be misread as dead on a quiet hour.
  ok('…and the wire says so where it records', /written: 0 IS A HEALTHY RUN/.test(read('../src/app/api/cron/primary-sources/route.js')));
}

L('⚠️ telemetry can never fail the work it describes');
{
  // ⚠️ THE GUARANTEE LIVES IN THE IMPLEMENTATION, NOT AT EACH CALL SITE — and asserting it per call
  // site was wrong. Several routes deliberately call recordJobRun bare, including the "started"
  // marker that fear-greed and consensus-board write BEFORE their work so a function killed at
  // maxDuration still leaves a trace. Those are correct precisely because recordJobRun cannot throw.
  // Requiring a wrapper around each one would have pushed noise into the routes to satisfy a test.
  const hb = read('../src/lib/job-heartbeat.js');
  const body = /export async function recordJobRun[\s\S]*?\n\}/.exec(hb)?.[0] || '';
  ok('⚠️ recordJobRun cannot throw, so no call site can be broken by it',
    /try \{/.test(body) && /\} catch \(e\) \{[\s\S]*console\.log\(`\[heartbeat\]/.test(body));
  ok('…and its contract is written down where the next person will look', /MUST NEVER FAIL ITS JOB/.test(hb));
  // The one place that wraps anyway is the Stripe path, where a throw would be worst.
  ok('⚠️ the webhook wraps it a second time regardless, being the costliest place to be wrong',
    /catch \{ \/\* bookkeeping only \*\/ \}/.test(read('../src/app/api/stripe/webhook/route.js')));

  const ev = read('../src/lib/billing/events.js');
  ok('⚠️ the billing recorder swallows its own error too', /catch \(e\) \{[\s\S]*console\.log\(`\[billing_events\]/.test(ev));
  ok('…and says why, so nobody "fixes" it into throwing', /SWALLOWED ON PURPOSE|never fail the webhook/i.test(ev));
}

L('⚠️ subscription truth is server-side and counted once');
{
  const hook = read('../src/app/api/stripe/webhook/route.js');
  const ev = read('../src/lib/billing/events.js');
  ok('the event log is keyed on the Stripe event id', /event_id\s+text primary key/.test(ev));
  // ⚠️ THE WHOLE POINT. Stripe delivers at-least-once and our own handler asks for retries, so the
  // same event arriving repeatedly is normal. Without this, every retry is a fresh "conversion".
  ok('⚠️ a duplicate delivery cannot be counted twice', /on conflict \(event_id\) do nothing/.test(ev));
  ok('⚠️ nothing client-side writes a subscription event',
    !srcFiles().some((f) => /components|app\/(?!api)/.test(f) && /recordBillingEvent/.test(read(f))));
  ok('the webhook records only after the signature is verified',
    hook.indexOf('verifySignature') < hook.indexOf('recordBillingEvent'));
  ok('⚠️ …and only after the entitlement is actually stamped',
    hook.indexOf('await setPlan(userId, plan, obj.customer)') < hook.indexOf('await observed(event, { userId, plan })'));
  ok('a failed refetch records a failure instead of a success',
    /observedFailure\(`checkout refetch failed/.test(hook) && /observedFailure\(`\$\{event\.type\} refetch failed/.test(hook));
  ok('⚠️ a 503 retry request does not log a billing event',
    !/observed\(event[\s\S]{0,120}refetch_failed/.test(hook));

  // Interval is read from the price Stripe billed, not from what we asked for.
  ok('monthly and annual are derived from the Stripe price',
    intervalOf({ items: { data: [{ price: { recurring: { interval: 'month' } } }] } }) === 'monthly'
    && intervalOf({ items: { data: [{ plan: { interval: 'year' } }] } }) === 'annual');
  // ⚠️ AN UNKNOWN INTERVAL IS NULL, NEVER THE COMMON ONE. A checkout.session carries no interval;
  // defaulting it to monthly would silently invent a plan mix.
  ok('⚠️ an object with no interval yields null, not a guess', intervalOf({}) === null);
}

L('⚠️ nothing sensitive is exposed');
{
  const health = read('../src/app/api/health/route.js');
  const metrics = read('../src/app/api/internal/metrics/route.js');
  ok('the public health endpoint returns aggregates, not rows',
    /Counts, ages and booleans|No sample rows/.test(health));
  ok('⚠️ conversion counts are NOT on the public health endpoint',
    !/billing_events|readBillingFunnel/.test(health));
  ok('⚠️ the metrics endpoint authorises before it reads anything',
    metrics.indexOf("status: 401") < metrics.indexOf('readBillingFunnel('));
  ok('⚠️ its secret is read from a header, never a query string',
    /authorization'\) === `Bearer \$\{CRON_SECRET\}`/.test(metrics) && !/searchParams\.get\('(key|secret|token)'\)/.test(metrics));
  ok('an empty CRON_SECRET cannot authorise by accident', /!!CRON_SECRET && bearer/.test(metrics));
}

L('production');
{
  const r = await fetch(`${BASE}/api/health`, { headers: { 'cache-control': 'no-cache' } }).catch(() => null);
  if (!r) { ok('reachable', false, 'no response'); }
  else {
    const j = await r.json().catch(() => null);
    ok('/api/health responds', !!j && typeof j.ok === 'boolean', `HTTP ${r.status}`);
    ok('…and reports per-job state', Array.isArray(j?.jobs?.jobs) && j.jobs.jobs.length > 0);
    // ⚠️ THE SHAPE A HUMAN ACTUALLY READS AT 3AM.
    const sample = j?.jobs?.jobs?.[0] || {};
    ok('…with last success, age and its own threshold on every job',
      'lastSuccess' in sample && 'ageHours' in sample && 'maxAgeHours' in sample && 'state' in sample);
    const states = new Set((j?.jobs?.jobs || []).map((x) => x.state));
    ok('…using a closed set of states', [...states].every((s) => ['ok', 'late', 'never', 'idle_by_design', 'failing'].includes(s)), [...states].join(','));
    // ⚠️ NO SECRETS, NO STACK TRACES, NO VENDOR INTERNALS in a publicly reachable document.
    const body = JSON.stringify(j);
    const leak = /postgres:\/\/|sk_live|sk_test|whsec_|Bearer |DATABASE_URL|neon\.tech|[a-z0-9]{32,}\b|at [A-Za-z$_]+ \(/.exec(body);
    ok('⚠️ the public health document leaks nothing', !leak, leak ? leak[0].slice(0, 40) : '');
    console.log(`  status=${j?.status} failing=${JSON.stringify(j?.failing)} late=${JSON.stringify(j?.jobs?.late)}`);
  }

  const m = await fetch(`${BASE}/api/internal/metrics`).catch(() => null);
  ok('⚠️ the metrics endpoint refuses an unauthenticated caller', m?.status === 401, `HTTP ${m?.status}`);
  const mb = await m?.json().catch(() => ({}));
  ok('…and its refusal says nothing else', JSON.stringify(mb || {}) === '{"error":"unauthorized"}', JSON.stringify(mb));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
