import { db } from '../../../lib/db';
import { sql } from 'drizzle-orm';
import { TRACKED_JOBS, readJobHeartbeats } from '../../../lib/job-heartbeat';
import { TRADEABLE_ASSET_TYPES } from '../../../lib/heatmap/heatmap-universe.mjs';

export const runtime = 'nodejs';
export const maxDuration = 20;

// ONE CALL THAT ANSWERS "IS THE PRODUCT OK RIGHT NOW".
//
// Not an observability platform. A single page that answers the questions actually asked when
// something looks wrong: is the database up and is it slow, is each dataset fresh, did a pipeline
// finish or only stop, and are the data-quality boundaries we have already been burned by still
// holding.
//
// ── WHY FRESHNESS AND COMPLETENESS ARE SEPARATE ──────────────────────────────
//
// The 13F work established the failure this exists to catch: a job can exit cleanly having skipped
// real work. "Last run succeeded" is therefore not evidence of anything. So freshness (is the newest
// record recent enough) and completeness (do the invariants hold over what was written) are reported
// as different facts, and a dataset can be fresh and wrong.
//
// ── AGGREGATE ONLY ───────────────────────────────────────────────────────────
//
// Counts, ages and booleans. No sample rows, no error strings, no vendor names, no query text — a
// health endpoint that leaks the database's words is a different kind of incident. It follows the
// precedent already set by /api/institutions/status, which is public and aggregate for the same
// reason.

const NO_STORE = { 'Cache-Control': 'no-store' };

// Each check returns a small object and MUST NOT throw — one failing probe should not blind the
// other nine. A probe that fails reports itself as failed, which is information rather than silence.
async function probe(name, fn) {
  const t0 = Date.now();
  try { return { name, ...(await fn()), ms: Date.now() - t0 }; }
  catch { return { name, ok: false, error: 'probe_failed', ms: Date.now() - t0 }; }
}

const hoursSince = (d) => (d == null ? null : Math.round((Date.now() - new Date(d).getTime()) / 36e5 * 10) / 10);
const one = async (q) => (await db.execute(q)).rows?.[0] ?? {};

// ⚠️ THE DEEP CHECKS ARE OPT-IN, BECAUSE THIS ENDPOINT WAS TIMING OUT ON ITSELF.
//
// Measured in production: completeness.13f_aggregation alone took 5,115ms warm and pushed the whole
// request past maxDuration cold — three consecutive calls returned 504, 200 at 11.5s, and 200 at
// 4.2s. A health check that intermittently 504s is worse than none: it cannot be alerted on, because
// its own failure is indistinguishable from the outage it is supposed to report.
//
// The two expensive probes scan fund_filings and fund_holdings across quarters. They answer a real
// question — whether 13F aggregation silently under-wrote — but that is a question worth asking
// after the nightly job, not on every poll of "is the site up". Everything left in the default set
// totals well under a second.
//
// ⚠️ AND THE POINT IS LOAD, NOT ONLY LATENCY. Monitoring must not become a meaningful share of the
// database's work. A 5-second aggregate on every uptime ping is exactly that.
const DEEP_PROBES = new Set(['completeness.13f_aggregation', 'completeness.13f_empty_filings']);

export async function GET(request) {
  const startedAt = Date.now();
  const deep = new URL(request.url).searchParams.get('deep') === '1';

  // ⚠️ A SKIPPED PROBE IS REPORTED, NOT OMITTED. Silently dropping it would make the default
  // response look like a full check that passed, which is how "we monitor that" becomes false.
  const run = (name, fn) => (DEEP_PROBES.has(name) && !deep
    ? Promise.resolve({ name, ok: true, skipped: 'deep_only', ms: 0 })
    : probe(name, fn));

  const all = await Promise.all([
    // ── DATABASE ────────────────────────────────────────────────────────────
    run('database', async () => {
      const r = await one(sql`select 1 as up`);
      return { ok: r.up === 1 };
    }),

    // ── FRESHNESS: is the newest record recent enough for the dataset's cadence ──
    run('freshness.insiders', async () => {
      const r = await one(sql`select max(filing_date)::text d, count(*)::int n from insider_trades`);
      const age = hoursSince(r.d);
      return { ok: age != null && age < 96, newest: r.d, ageHours: age, rows: r.n };   // Form 4: weekdays
    }),
    run('freshness.congress', async () => {
      const r = await one(sql`select max(disclosure_date)::text d, count(*)::int n from congress_trades`);
      const age = hoursSince(r.d);
      return { ok: age != null && age < 24 * 30, newest: r.d, ageHours: age, rows: r.n };  // disclosure is lumpy
    }),
    run('freshness.institutions', async () => {
      const r = await one(sql`select max(quarter)::text q, max(filed_date)::text f, count(*)::int n from fund_filings`);
      return { ok: !!r.q, newestQuarter: r.q, newestFiled: r.f, filings: r.n };          // quarterly by nature
    }),
    run('freshness.screener', async () => {
      const r = await one(sql`select max(updated_at)::text d, count(*)::int n from screener_stocks`);
      const age = hoursSince(r.d);
      return { ok: age != null && age < 48, newest: r.d, ageHours: age, rows: r.n };
    }),

    // ── COMPLETENESS: the invariants, not the exit codes ────────────────────
    run('completeness.13f_aggregation', async () => {
      // Filings whose declared count disagrees with stored rows were written by the pre-aggregation
      // path and carry one sub-account line instead of the security's total.
      //
      // ⚠️ BOUNDED TO RECENT QUARTERS ON PURPOSE. Unbounded, this correlated subquery scans all
      // 67k filings against 18M holdings and measured 6.3 SECONDS — a health check that expensive
      // becomes its own load problem the moment anything polls it, which is a self-inflicted
      // outage. New writes land in recent quarters, so a regression appears there first; the full
      // history is checked by scripts/audit-13f-history.mjs, which is where an exhaustive sweep
      // belongs. This trades completeness for a probe that is safe to call often, and says so.
      const r = await one(sql`
        select count(*)::int n from fund_filings f
         where f.quarter >= (select max(quarter) from fund_filings) - interval '6 months'
           and f.holdings_count is distinct from (select count(*) from fund_holdings h where h.cik = f.cik and h.quarter = f.quarter)`);
      return { ok: r.n === 0, underAggregatedRecent: r.n, scope: 'last 2 quarters' };
    }),
    run('completeness.13f_empty_filings', async () => {
      const r = await one(sql`
        select count(*)::int n from fund_filings f
         where not exists (select 1 from fund_holdings h where h.cik = f.cik and h.quarter = f.quarter)`);
      return { ok: r.n === 0, filingsWithNoHoldings: r.n };
    }),
    run('completeness.13f_unresolved', async () => {
      const r = await one(sql`select count(*)::int n from institution_backfill_error where attempts >= 3`);
      return { ok: r.n < 25, abandonedFilers: r.n };
    }),

    // ── DATA QUALITY: boundaries we have already been burned by ─────────────
    run('quality.public_tickers', async () => {
      // "NONE" reached the homepage as a ticker. It is a filing's issuerTradingSymbol for an
      // unlisted issuer, and it must never be promoted to a ticker-facing surface again.
      const r = await one(sql`
        select (select count(*) from screener_stocks
                 where upper(trim(ticker)) in ('NONE','NULL','N/A','UNKNOWN','UNDEFINED'))::int screener,
               (select count(*) from insider_trades
                 where upper(trim(ticker)) in ('NONE','NULL','N/A','UNKNOWN','UNDEFINED')
                   and filing_date > now() - interval '7 days')::int recent_insiders`);
      return { ok: r.screener === 0, screenerPlaceholders: r.screener, recentInsiderPlaceholders: r.recent_insiders };
    }),
    run('quality.classification', async () => {
      // ⚠️ THE DENOMINATOR IS NOW THE UNIVERSE THE HEATMAP ACTUALLY DRAWS, AND THE OLD ONE HID A
      // REAL OUTAGE FOR MONTHS.
      //
      // This probe used to exclude ADRC from its denominator, on the reasoning that a depositary
      // receipt is not an operating company with a SIC. That reasoning was wrong on the facts —
      // foreign issuers file 20-F and EDGAR assigns them a SIC exactly like a domestic filer — and
      // the exclusion put the check in direct contradiction with the board it protects:
      // TRADEABLE_ASSET_TYPES is ['Stock','ADRC'], so the heatmap deliberately INCLUDES the
      // population the alarm was told to ignore.
      //
      // The result was an alarm that could not ring: 113 of the Top 500 rendered as "Other" — TSM,
      // HSBC, BABA, SAP, BP, NVS, SONY, UBS, ING, BHP — while this probe stayed green, because
      // every one of them was outside its denominator by construction. A check that excludes the
      // failure it exists to detect is not a lenient check, it is a decorative one.
      //
      // ⚠️ THE THRESHOLD IS UNCHANGED AT 8%. Nothing here was relaxed to go green; the measured
      // population was corrected and the coverage was actually repaired.
      const r = await one(sql`
        select count(*)::int securities,
               count(*) filter (where unclassified)::int unclassified,
               coalesce(sum(market_cap), 0)::float8 mcap,
               coalesce(sum(market_cap) filter (where unclassified), 0)::float8 unclassified_mcap,
               count(*) filter (where is_adr)::int adrs,
               count(*) filter (where is_adr and unclassified)::int adrs_unclassified
          from (
            select s.market_cap,
                   (coalesce(s.sector, m.sector) is null
                     or trim(coalesce(s.sector, m.sector)) = '') as unclassified,
                   upper(coalesce(m.asset_type, '')) = 'ADRC' as is_adr
              from screener_stocks s
              left join screener_meta m on m.ticker = s.ticker
             where coalesce(s.market_cap, m.market_cap) > 0
               and coalesce(m.asset_type, '') = any(${sql`${`{${TRADEABLE_ASSET_TYPES.join(',')}}`}::text[]`})
          ) x`);
      const pctCount = r.securities ? (100 * r.unclassified) / r.securities : 0;
      const pctWeight = r.mcap ? (100 * r.unclassified_mcap) / r.mcap : 0;
      return {
        ok: pctWeight < 8,
        scope: `heatmap-eligible securities (${TRADEABLE_ASSET_TYPES.join(', ')}) — the population the board draws`,
        securities: r.securities,
        unclassified: r.unclassified,
        pctByCount: Math.round(pctCount * 10) / 10,
        pctByWeight: Math.round(pctWeight * 10) / 10,
        // ⚠️ REPORTED SEPARATELY SO THE FOREIGN-ISSUER GAP IS VISIBLE AS ITSELF, not averaged into
        // a market-wide number where 113 unclassified megacaps could hide again.
        adrs: { total: r.adrs, unclassified: r.adrs_unclassified },
      };
    }),

    // ── LIVENESS: did each clock actually tick ────────────────────────────
    //
    // ⚠️ THIS IS THE QUESTION FRESHNESS CANNOT ANSWER. Every probe above asks how new the DATA
    // is, and on a Sunday every SEC-derived dataset is correctly three days old —
    // indistinguishable from an ingest that has been throwing since Friday. Proving the
    // difference used to mean fetching EDGAR by hand and comparing it to the table. The jobs now
    // record a heartbeat on every successful run (see lib/job-heartbeat.js), so a stopped clock
    // is visible within its own silence budget whether or not the source had anything to give.
    //
    // ⚠️ IN THE Promise.all, NOT AFTER IT. Awaited separately this added its round trip to the
    // END of an endpoint that already spends seconds in the 13F completeness probe, and pushed a
    // cold start past maxDuration into a 504 — a health check that goes down under load is worse
    // than none, because it reports an outage it caused. It costs nothing running alongside.
    run('jobs.heartbeats', async () => {
      const beats = await readJobHeartbeats();
      const weekend = [0, 6].includes(new Date().getUTCDay());
      const out = TRACKED_JOBS.map((j) => {
        const b = beats.get(j.name) || null;
        const age = hoursSince(b?.last_success_at);
        // A weekday-only job is idle by design at the weekend, not late.
        const idleByDesign = !!j.weekdaysOnly && weekend;
        const failures = Number(b?.consecutive_failures ?? 0);
        // ⚠️ AN EVENT-DRIVEN JOB IS NEVER LATE, ONLY BROKEN. It has no schedule to miss, so age
        // carries no information about its health — a quiet week is a quiet market, not an outage.
        // It is judged on whether the runs it DID have failed.
        const failing = j.eventDriven && failures > 0;
        return {
          job: j.name, label: j.label,
          lastSuccess: b?.last_success_at ?? null,
          ageHours: age, maxAgeHours: j.maxAgeHours ?? null,
          eventDriven: !!j.eventDriven,
          consecutiveFailures: b?.consecutive_failures ?? null,
          note: b?.note ?? null,
          // `never` is not yet a failure: a heartbeat only exists once the job has run since this
          // shipped, and reporting a brand-new field as an outage would cry wolf on day one.
          state: b == null ? 'never'
            : failing ? 'failing'
              : j.eventDriven ? 'ok'
                : idleByDesign ? 'idle_by_design'
                  : age != null && age <= j.maxAgeHours ? 'ok' : 'late',
        };
      });
      const late = out.filter((j) => j.state === 'late');
      const failing = out.filter((j) => j.state === 'failing');
      // ⚠️ `never` IS BENIGN FOREVER, WHICH IS A HOLE — so it is surfaced rather than buried.
      //
      // A job that has not run since its tracking shipped is indistinguishable from one that is
      // broken and has never run at all, and treating either as an outage would fire on every
      // deploy. So it stays out of `ok`, but it does NOT stay quiet: a name that is still here a
      // couple of days after launch is a job that is not running, and that is the one reading of
      // this list. It should be empty once every cadence has come round once.
      const neverRan = out.filter((j) => j.state === 'never');
      return {
        ok: late.length === 0 && failing.length === 0,
        late: late.map((j) => j.job),
        failing: failing.map((j) => j.job),
        neverRan: neverRan.map((j) => j.job),
        jobs: out,
      };
    }),
  ]);

  // Lifted out to its own top-level key as well as staying in `checks`: a stale heartbeat and a
  // stale dataset are different incidents with different responses, and the per-job detail is
  // what someone actually opens this endpoint to read.
  const checks = all;
  const jobs = checks.find((c) => c.name === 'jobs.heartbeats') ?? null;
  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  const slowest = [...checks].sort((a, b) => b.ms - a.ms)[0];

  return Response.json({
    ok: failed.length === 0,
    status: failed.length === 0 ? 'healthy' : 'degraded',
    failing: failed,
    // ⚠️ SAID OUT LOUD, so a green response is never mistaken for a complete one. Whoever reads this
    // at 3am needs to know which questions were not asked, and how to ask them.
    depth: deep ? 'deep' : 'default',
    skipped: checks.filter((c) => c.skipped).map((c) => c.name),
    deepHint: deep ? null : 'add ?deep=1 for the 13F completeness scans (several seconds)',
    dbSlowestProbeMs: slowest?.ms ?? null,
    totalMs: Date.now() - startedAt,
    at: new Date().toISOString(),
    checks,
    jobs,
  }, { status: failed.length === 0 ? 200 : 503, headers: NO_STORE });
}
