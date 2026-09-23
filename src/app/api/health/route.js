import { db } from '../../../lib/db';
import { sql } from 'drizzle-orm';
import { TRACKED_JOBS, readJobHeartbeats } from '../../../lib/job-heartbeat';

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

export async function GET() {
  const startedAt = Date.now();

  const checks = await Promise.all([
    // ── DATABASE ────────────────────────────────────────────────────────────
    probe('database', async () => {
      const r = await one(sql`select 1 as up`);
      return { ok: r.up === 1 };
    }),

    // ── FRESHNESS: is the newest record recent enough for the dataset's cadence ──
    probe('freshness.insiders', async () => {
      const r = await one(sql`select max(filing_date)::text d, count(*)::int n from insider_trades`);
      const age = hoursSince(r.d);
      return { ok: age != null && age < 96, newest: r.d, ageHours: age, rows: r.n };   // Form 4: weekdays
    }),
    probe('freshness.congress', async () => {
      const r = await one(sql`select max(disclosure_date)::text d, count(*)::int n from congress_trades`);
      const age = hoursSince(r.d);
      return { ok: age != null && age < 24 * 30, newest: r.d, ageHours: age, rows: r.n };  // disclosure is lumpy
    }),
    probe('freshness.institutions', async () => {
      const r = await one(sql`select max(quarter)::text q, max(filed_date)::text f, count(*)::int n from fund_filings`);
      return { ok: !!r.q, newestQuarter: r.q, newestFiled: r.f, filings: r.n };          // quarterly by nature
    }),
    probe('freshness.screener', async () => {
      const r = await one(sql`select max(updated_at)::text d, count(*)::int n from screener_stocks`);
      const age = hoursSince(r.d);
      return { ok: age != null && age < 48, newest: r.d, ageHours: age, rows: r.n };
    }),

    // ── COMPLETENESS: the invariants, not the exit codes ────────────────────
    probe('completeness.13f_aggregation', async () => {
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
    probe('completeness.13f_empty_filings', async () => {
      const r = await one(sql`
        select count(*)::int n from fund_filings f
         where not exists (select 1 from fund_holdings h where h.cik = f.cik and h.quarter = f.quarter)`);
      return { ok: r.n === 0, filingsWithNoHoldings: r.n };
    }),
    probe('completeness.13f_unresolved', async () => {
      const r = await one(sql`select count(*)::int n from institution_backfill_error where attempts >= 3`);
      return { ok: r.n < 25, abandonedFilers: r.n };
    }),

    // ── DATA QUALITY: boundaries we have already been burned by ─────────────
    probe('quality.public_tickers', async () => {
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
    probe('quality.classification', async () => {
      // An unclassified security is honest; an unclassified MARKET is a broken heatmap. Weight
      // matters more than count here — one unclassified megacap distorts the board more than fifty
      // microcaps.
      //
      // ⚠️ THE DENOMINATOR IS OPERATING COMPANIES, NOT EVERY LISTED SECURITY, AND THAT IS NOT A
      // RELAXATION. Sector here comes from the issuer's SEC SIC code. An ADR, a closed-end fund,
      // an ETF, an ETV and a warrant do not have one — not "missing", but structurally absent,
      // because none of them is an operating company with an industry. Counting them in the
      // denominator meant the check was permanently red for a reason no amount of work could
      // fix: 16.6% of market cap unclassified against an 8% bar, driven by 349 ADRs carrying
      // $12.6T — TSM, ASML, HSBC, BABA. A health check that can never go green is a broken alarm;
      // it trains you to ignore the light, and then it is not there when something real breaks.
      //
      // The threshold is UNCHANGED at 8%. What changed is that the check now measures the thing
      // it was always trying to measure — US operating companies missing a sector — which is
      // 5.1%. The excluded classes are reported beside it as their own number, so the ADR gap is
      // visible rather than quietly dropped, and no SIC code is invented for anything.
      const r = await one(sql`
        select count(*) filter (where not no_sic)::int operating,
               count(*) filter (where not no_sic and unclassified)::int operating_unclassified,
               coalesce(sum(market_cap) filter (where not no_sic), 0)::float8 operating_mcap,
               coalesce(sum(market_cap) filter (where not no_sic and unclassified), 0)::float8 operating_unclassified_mcap,
               count(*) filter (where no_sic)::int no_sic_securities,
               coalesce(sum(market_cap) filter (where no_sic), 0)::float8 no_sic_mcap
          from (
            select market_cap,
                   (sector is null or trim(sector) = '') as unclassified,
                   upper(coalesce(asset_type, '')) in
                     ('ADRC','FUND','ETF','ETV','WARRANT','UNIT','RIGHT','PREFERRED') as no_sic
              from screener_stocks where market_cap > 0
          ) s`);
      const pctCount = r.operating ? (100 * r.operating_unclassified) / r.operating : 0;
      const pctWeight = r.operating_mcap ? (100 * r.operating_unclassified_mcap) / r.operating_mcap : 0;
      return {
        ok: pctWeight < 8,
        scope: 'operating companies (ADRs, funds, ETFs, warrants excluded — no SIC by nature)',
        securities: r.operating, unclassified: r.operating_unclassified,
        pctByCount: Math.round(pctCount * 10) / 10, pctByWeight: Math.round(pctWeight * 10) / 10,
        // Reported, never hidden: the population the check deliberately does not police.
        excludedNoSic: { securities: r.no_sic_securities, mcapUsd: Math.round(r.no_sic_mcap) },
      };
    }),
    // ── ROLLOVER: is the heatmap on the session it should be on ─────────────
    //
    // ⚠️ THE ONE FAILURE THE FRESHNESS PROBES ABOVE CANNOT SEE. `freshness.screener` watches
    // screener_stocks.updated_at, which the same cron writes in an earlier step — so the screener
    // can look perfectly fresh while step 4b's candle insert wrote nothing. The heatmap then holds
    // on the previous completed session, correctly and indefinitely, and every other check is green.
    //
    // ⚠️ AND IT MUST NOT ALERT ON THE ORDINARY OVERNIGHT HOLD. Between the closing bell and the
    // next morning's load, yesterday's candles legitimately do not exist and the board is SUPPOSED
    // to be one session back. Only a session past its ingest deadline counts — see
    // heatmap-gate-health.mjs for where that deadline comes from.
    probe('heatmap.session_rollover', async () => {
      const { heatmapUniverse, canonicalSessionDate } = await import('../../../lib/heatmap/heatmap-store');
      const { assessRollover } = await import('../../../lib/heatmap/heatmap-gate-health.mjs');
      const universe = await heatmapUniverse(500);
      const canonical = await canonicalSessionDate(universe.map((u) => u.ticker));
      const a = assessRollover({ canonical });
      // Aggregate counts of our own universe — no tickers, no vendor names, no query text.
      return {
        ok: a.ok,
        state: a.state,
        canonicalSession: a.canonicalSession,
        expectedSession: a.expectedSession,
        candidateSession: a.candidateSession,
        candidateCoverage: a.candidateCoverage,
        previousCoverage: a.previousCoverage,
        requiredCoverage: a.requiredCoverage,
        ratioPct: a.ratio == null ? null : Math.round(a.ratio * 1000) / 10,
        quorumPct: Math.round(a.quorum * 100),
        overdueHours: a.overdueHours,
        universe: universe.length,
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
    probe('jobs.heartbeats', async () => {
      const beats = await readJobHeartbeats();
      const weekend = [0, 6].includes(new Date().getUTCDay());
      const out = TRACKED_JOBS.map((j) => {
        const b = beats.get(j.name) || null;
        const age = hoursSince(b?.last_success_at);
        // A weekday-only job is idle by design at the weekend, not late.
        const idleByDesign = !!j.weekdaysOnly && weekend;
        return {
          job: j.name, label: j.label,
          lastSuccess: b?.last_success_at ?? null,
          ageHours: age, maxAgeHours: j.maxAgeHours,
          consecutiveFailures: b?.consecutive_failures ?? null,
          note: b?.note ?? null,
          // `never` is not yet a failure: a heartbeat only exists once the job has run since this
          // shipped, and reporting a brand-new field as an outage would cry wolf on day one.
          state: b == null ? 'never' : idleByDesign ? 'idle_by_design'
            : age != null && age <= j.maxAgeHours ? 'ok' : 'late',
        };
      });
      const late = out.filter((j) => j.state === 'late');
      return { ok: late.length === 0, late: late.map((j) => j.job), jobs: out };
    }),
  ]);

  // Lifted out to its own top-level key as well as staying in `checks`: a stale heartbeat and a
  // stale dataset are different incidents with different responses, and the per-job detail is
  // what someone actually opens this endpoint to read.
  const jobs = checks.find((c) => c.name === 'jobs.heartbeats') ?? null;
  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  const slowest = [...checks].sort((a, b) => b.ms - a.ms)[0];

  return Response.json({
    ok: failed.length === 0,
    status: failed.length === 0 ? 'healthy' : 'degraded',
    failing: failed,
    dbSlowestProbeMs: slowest?.ms ?? null,
    totalMs: Date.now() - startedAt,
    at: new Date().toISOString(),
    checks,
    jobs,
  }, { status: failed.length === 0 ? 200 : 503, headers: NO_STORE });
}
