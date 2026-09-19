import { db } from '../../../lib/db';
import { sql } from 'drizzle-orm';

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
      const r = await one(sql`
        select count(*)::int n from fund_filings f
         where f.holdings_count is distinct from (select count(*) from fund_holdings h where h.cik = f.cik and h.quarter = f.quarter)`);
      return { ok: r.n === 0, underAggregated: r.n };
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
      const r = await one(sql`
        select count(*)::int total,
               count(*) filter (where sector is null or trim(sector) = '')::int unclassified,
               coalesce(sum(market_cap), 0)::float8 mcap,
               coalesce(sum(market_cap) filter (where sector is null or trim(sector) = ''), 0)::float8 unclassified_mcap
          from screener_stocks where market_cap > 0`);
      const pctCount = r.total ? (100 * r.unclassified) / r.total : 0;
      const pctWeight = r.mcap ? (100 * r.unclassified_mcap) / r.mcap : 0;
      return {
        ok: pctWeight < 8,
        securities: r.total, unclassified: r.unclassified,
        pctByCount: Math.round(pctCount * 10) / 10, pctByWeight: Math.round(pctWeight * 10) / 10,
      };
    }),
  ]);

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
  }, { status: failed.length === 0 ? 200 : 503, headers: NO_STORE });
}
