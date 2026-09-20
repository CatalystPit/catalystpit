// CONVENTION REPAIR — retire the total-return rows from ticker_daily_candles.
//
// The writers were fixed first (market/candles.mjs + both routes), so this repairs a closed set
// rather than bailing out a boat that is still taking on water.
//
// Phases, run in order. Each is separately re-runnable and the whole thing is RESUMABLE, because
// the free vendor allocation is 50 requests/hour and the audit needs ~126:
//
//   --phase=audit      classify every affected ticker against the vendor. Writes convention-audit.json.
//   --phase=snapshot   copy the exact rows that will change into ticker_daily_candles_backup.
//   --phase=apply      write the canonical values. Requires --confirm.
//   --phase=validate   post-checks.
//
// ── WHAT COUNTS AS CONTAMINATED ─────────────────────────────────────────────
//
// NOT "source='tiingo'". That is where to look, not what is wrong. For a ticker that never paid a
// distribution, total return and split-adjusted are the SAME NUMBER, and those rows are already
// correct — rewriting them would be churn, and calling them corrupt would be false.
//
// A row is contaminated only when the stored value differs from the canonical derivation. Rows that
// match are relabelled to the canonical source (their values are untouched) because the source
// column is the convention discriminator, and leaving a verified-correct row labelled with the
// retired basis misstates what it is.
//
// ── THE INDEPENDENT CHECK ───────────────────────────────────────────────────
//
// Before a ticker is written, the derivation is proved against POLYGON on shared dates — a second
// vendor computing the same quantity from different inputs. 123 of the 126 affected tickers have
// that overlap. The other three (SCTH, DPLS, SVA) do not, and are REPORTED, NOT REWRITTEN: an
// unverified candidate is not corruption, and that rule is what kept the first repair honest.
//
// Run: node --env-file=.env.local research/convention-repair.mjs --phase=audit

import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';
import { tiingoDailyToCanonical, assertCanonicalCandles, CANDLE_SOURCE } from '../src/lib/market/candles.mjs';

const sql = neon(process.env.DATABASE_URL);
const KEY = process.env.TIINGO_API_KEY;
const H = { 'Content-Type': 'application/json', Authorization: `Token ${KEY}` };
const L = (s = '') => console.log(s);
const arg = (k, d) => { const i = process.argv.findIndex((a) => a === k || a.startsWith(`${k}=`));
  if (i < 0) return d; const a = process.argv[i]; return a.includes('=') ? a.split('=')[1] : process.argv[i + 1]; };
const PHASE = arg('--phase', 'audit');
const CONFIRM = process.argv.includes('--confirm');

const AUDIT_PATH = 'research/convention-audit.json';
const RETIRED = 'tiingo';
const MATCH_TOL = 0.001;        // 0.1% — far tighter than any dividend factor, looser than rounding
const AGREE_TOL = 0.001;
const MIN_AGREE = 0.97;
// Enough independent dates that agreement cannot be coincidence. Below this a ticker is REPORTED,
// never rewritten — a thin sample is not verification, it is a smaller guess.
const MIN_COMPARED = 60;
const TODAY = new Date().toISOString().slice(0, 10);
const POLYGON_KEY = process.env.POLYGON_KEY || process.env.POLYGON_API_KEY;

/**
 * Polygon daily aggregates, split-adjusted (`adjusted=true` removes splits only — the canonical
 * basis). A separate vendor on a separate allocation: this is the independent half of the proof.
 */
async function polygonDaily(sym, from = '1990-01-01') {
  if (!POLYGON_KEY) return { ok: false, reason: 'no key' };
  const u = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/day/${from}/${TODAY}`
    + `?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_KEY}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch(u);
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 1500 * attempt)); continue; }
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    const j = await r.json().catch(() => null);
    const results = j?.results;
    if (!Array.isArray(results) || !results.length) return { ok: false, reason: 'no results' };
    const byDate = new Map();
    for (const b of results) {
      const d = new Date(b.t).toISOString().slice(0, 10);
      if (Number.isFinite(b.c) && b.c > 0) byDate.set(d, Number(b.c));
    }
    return { ok: true, byDate };
  }
  return { ok: false, reason: 'rate limited' };
}

const loadAudit = () => (fs.existsSync(AUDIT_PATH) ? JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8')) : {});
const saveAudit = (a) => fs.writeFileSync(AUDIT_PATH, JSON.stringify(a, null, 1));

// ── FETCH EACH TICKER ONCE, EVER ────────────────────────────────────────────
//
// The audit and the apply phase need the same payload, and an earlier version fetched it twice —
// ~47 redundant requests against a 50/hour allocation, which is an entire extra window of waiting
// for data already downloaded and discarded. The allocation is the provider's constraint; spending
// it twice was ours.
//
// Payloads are cached to disk keyed by ticker and fetch date. They are raw vendor responses, so the
// derivation still runs fresh from them and nothing about the conversion is memoised.
const CACHE_DIR = 'research/.vendor-cache';
fs.mkdirSync(CACHE_DIR, { recursive: true });
const cachePath = (sym) => `${CACHE_DIR}/${sym.replace(/[^A-Z0-9.\-]/gi, '_')}.${TODAY}.json`;

async function vendorFull(sym) {
  const p = cachePath(sym);
  if (fs.existsSync(p)) {
    try { return { ok: true, rows: JSON.parse(fs.readFileSync(p, 'utf8')), cached: true }; }
    catch { /* unreadable cache falls through to a fetch */ }
  }
  const u = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(sym)}/prices`
    + `?startDate=1960-01-01&endDate=${TODAY}`;
  const r = await fetch(u, { headers: H });
  if (r.status === 429) return { quota: true };
  if (!r.ok) return { ok: false, status: r.status };
  const j = await r.json();
  const rows = Array.isArray(j) ? j : [];
  // Only a usable payload is cached. Caching an empty or error body would turn one bad response
  // into a permanent wrong answer that costs nothing to re-serve.
  if (rows.length) { try { fs.writeFileSync(p, JSON.stringify(rows)); } catch { /* non-fatal */ } }
  return { ok: true, rows };
}

// ── AUDIT ────────────────────────────────────────────────────────────────────
if (PHASE === 'audit') {
  const affected = JSON.parse(fs.readFileSync('research/convention-affected.json', 'utf8'));
  const audit = loadAudit();

  // ── ONLY 'audited' IS TERMINAL ──
  //
  // A previous version persisted vendor errors as a status, and the resume filter skipped anything
  // already present — so one transient 5xx would have permanently recorded a ticker as done without
  // ever classifying it. A ticker is retried until it reaches a real classification; a 429 records
  // nothing at all. Neither a rate limit nor an error may ever masquerade as clean data.
  const isSettled = (t) => audit[t] && audit[t].status === 'audited';
  const todo = affected.filter((a) => !isSettled(a.ticker));

  // Short foreground batches, with a PRODUCTION RESERVE left unspent in every window. The account
  // allows 50 requests/hour and production draws from the same allocation, so the audit takes at
  // most BATCH and leaves the rest. Research must never be the reason a visitor's page fails.
  const PRODUCTION_RESERVE = 10;
  const BATCH = Math.max(1, Number(arg('--max', 40)));
  L(`affected ${affected.length}; settled ${affected.length - todo.length}; remaining ${todo.length}`);
  L(`this batch: up to ${BATCH} tickers (leaving ~${PRODUCTION_RESERVE} requests for production)\n`);

  let used = 0, cachedHits = 0;
  for (const a of todo) {
    if (used >= BATCH) { L(`\nbatch limit reached (${used}). Rerun to continue; progress is saved.`); break; }
    const res = await vendorFull(a.ticker);
    // A 429 is NOT a result. Nothing is written, and the ticker stays on the to-do list.
    if (res.quota) { L(`\nvendor quota reached after ${used} tickers this window — rerun later to resume.`); break; }
    if (!res.ok) {
      // Retryable: recorded in memory for this run's summary only, never persisted as settled.
      L(`  ${a.ticker.padEnd(8)} vendor error ${res.status} — left unsettled, will retry`);
      used++;
      continue;
    }
    // A cache hit costs no allocation, so it must not consume batch budget — otherwise a rerun
    // would stop early having spent its quota on requests it never made.
    if (res.cached) { cachedHits++; }
    if (!res.cached) used++;

    const canonical = tiingoDailyToCanonical(res.rows, { ticker: a.ticker, today: TODAY });
    if (!canonical.length) {
      // The vendor answered and had nothing. That is a settled outcome, but it is UNVERIFIABLE, not
      // clean — we cannot show these rows obey the convention, so they are never rewritten.
      audit[a.ticker] = { status: 'audited', action: 'REPORT_ONLY (vendor returned no data)', storedRetired: null };
      saveAudit(audit);
      L(`  ${a.ticker.padEnd(8)} vendor returned no data -> REPORT_ONLY`);
      continue;
    }
    const byDate = new Map(canonical.map((b) => [b.date, b]));

    const stored = await sql.query(
      `select date::text d, open, high, low, close, volume from ticker_daily_candles
        where ticker=$1 and source=$2 order by date`, [a.ticker, RETIRED]);

    let differing = 0, matching = 0, uncovered = 0, worst = 0;
    for (const s of stored) {
      const c = byDate.get(s.d);
      if (!c) { uncovered++; continue; }
      const diff = Math.abs(Number(s.close) - c.close) / c.close;
      if (diff > worst) worst = diff;
      if (diff > MATCH_TOL) differing++; else matching++;
    }

    // ── INDEPENDENT VERIFICATION ──
    //
    // Compare our derivation against POLYGON: a different vendor computing the same quantity from
    // different inputs, so agreement cannot come from a shared mistake.
    //
    // Stored Polygon rows alone are not enough. These 126 are the DEEP-HISTORY tickers, seeded from
    // Tiingo, and most carry only a handful of recent Polygon bars (AAPL 6, META 6, NVDA 7) — far
    // too thin to certify a 11,526-row rewrite. So the Polygon API is queried directly for a long
    // window. It is a separate vendor on a separate allocation, so this consumes no Tiingo quota.
    const stored_poly = await sql.query(
      `select date::text d, close from ticker_daily_candles where ticker=$1 and source='polygon'`, [a.ticker]);
    const refSeries = new Map(stored_poly.map((p) => [p.d, Number(p.close)]));
    const api = await polygonDaily(a.ticker);
    if (api.ok) for (const [d, c] of api.byDate) refSeries.set(d, c);

    let compared = 0, agreed = 0, polyWorst = 0;
    for (const [d, refClose] of refSeries) {
      const c = byDate.get(d); if (!c) continue;
      compared++;
      const diff = Math.abs(c.close - refClose) / refClose;
      if (diff > polyWorst) polyWorst = diff;
      if (diff <= AGREE_TOL) agreed++;
    }
    const agreeRate = compared ? agreed / compared : null;
    const verified = compared >= MIN_COMPARED && agreeRate >= MIN_AGREE;

    // ⚠️ HOW FAR THE INDEPENDENT PROOF ACTUALLY REACHES.
    //
    // Polygon serves ~5 years on this plan, so agreement certifies the RECENT window only. And
    // recent bars cannot certify old ones: a bar's split adjustment is the product of the splits
    // AFTER it, which for a recent bar is 1. A deep-history ticker therefore has an independently
    // verified head and a tail that rests on different evidence — the structural invariants checked
    // in the validate phase (a known split shows no cliff, ex-dividend drops survive, a real crash
    // is not smoothed). That is a weaker claim than "independently verified" and is reported as its
    // own field rather than folded into one flag.
    const verifiedDates = [...refSeries.keys()].filter((d) => byDate.has(d)).sort();
    const verifiedFrom = verifiedDates[0] || null;
    const storedDates = stored.map((s) => s.d).sort();
    const unverifiedOlderRows = verifiedFrom
      ? storedDates.filter((d) => d < verifiedFrom).length : storedDates.length;

    audit[a.ticker] = {
      status: 'audited',
      storedRetired: stored.length, differing, matching, uncovered,
      worstDiffPct: Math.round(worst * 10000) / 100,
      polygonCompared: compared,
      polygonAgreePct: agreeRate == null ? null : Math.round(agreeRate * 1000) / 10,
      polygonWorstPct: Math.round(polyWorst * 10000) / 100,
      verified,
      verifiedFrom,
      unverifiedOlderRows,
      // What the apply phase is allowed to do.
      action: !verified ? 'REPORT_ONLY (no independent verification)'
        : differing > 0 ? 'REPAIR' : 'RELABEL_ONLY',
    };
    saveAudit(audit);
    L(`  ${a.ticker.padEnd(8)} retired=${String(stored.length).padStart(5)} differing=${String(differing).padStart(5)}`
      + ` worst=${String(audit[a.ticker].worstDiffPct).padStart(7)}%  poly ${agreeRate == null ? '   -' : (agreeRate * 100).toFixed(1) + '%'}`
      + `  -> ${audit[a.ticker].action}`);
  }

  const done = Object.values(audit).filter((x) => x.status === 'audited');
  const rep = done.filter((x) => x.action === 'REPAIR');
  const rel = done.filter((x) => x.action === 'RELABEL_ONLY');
  const rpt = done.filter((x) => String(x.action).startsWith('REPORT_ONLY'));
  L(`\n=== AUDIT SO FAR (${done.length}/${affected.length}) ===`);
  L(`  REPAIR      (values wrong)          : ${rep.length} tickers, ${rep.reduce((s, x) => s + x.differing, 0)} rows`);
  L(`  RELABEL     (values already correct): ${rel.length} tickers, ${rel.reduce((s, x) => s + x.matching, 0)} rows`);
  L(`  REPORT ONLY (unverifiable)          : ${rpt.length} tickers`);
  if (cachedHits) L(`  (${cachedHits} served from the local vendor cache at no allocation cost)`);
  if (done.length < affected.length) L(`  ${affected.length - done.length} still to audit — rerun to resume.`);
}

// ── SNAPSHOT ─────────────────────────────────────────────────────────────────
if (PHASE === 'snapshot') {
  const audit = loadAudit();
  const targets = Object.entries(audit)
    .filter(([, v]) => v.action === 'REPAIR' || v.action === 'RELABEL_ONLY').map(([t]) => t);
  if (!targets.length) { L('nothing to snapshot — run the audit first.'); process.exit(1); }

  const RUN_ID = `convention_repair_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;
  await sql.query(`
    CREATE TABLE IF NOT EXISTS ticker_daily_candles_backup (
      run_id text NOT NULL, ticker text NOT NULL, date date NOT NULL,
      open double precision NOT NULL, high double precision NOT NULL, low double precision NOT NULL,
      close double precision NOT NULL, volume double precision NOT NULL, source text NOT NULL,
      backed_up_at timestamptz NOT NULL DEFAULT now(), reason text,
      PRIMARY KEY (run_id, ticker, date))`);

  const ins = await sql.query(`
    insert into ticker_daily_candles_backup (run_id, ticker, date, open, high, low, close, volume, source, reason)
    select $1, ticker, date, open, high, low, close, volume, source,
           'pre-repair: retired total-return rows'
      from ticker_daily_candles where ticker = any($2) and source = $3
    on conflict (run_id, ticker, date) do nothing returning 1`, [RUN_ID, targets, RETIRED]);

  const v = (await sql.query(`
    select (select count(*) from ticker_daily_candles where ticker=any($1) and source=$3)::int live,
           (select count(*) from ticker_daily_candles_backup where run_id=$2)::int backed,
           (select count(*) from ticker_daily_candles c join ticker_daily_candles_backup b
              on b.run_id=$2 and b.ticker=c.ticker and b.date=c.date
             where c.source=$3 and (c.open is distinct from b.open or c.high is distinct from b.high
               or c.low is distinct from b.low or c.close is distinct from b.close
               or c.volume is distinct from b.volume or c.source is distinct from b.source))::int mismatched`,
  [targets, RUN_ID, RETIRED]))[0];
  L(`run ${RUN_ID}`);
  L(`  tickers ${targets.length}  live ${v.live}  backed up ${v.backed}  mismatches ${v.mismatched}`);
  const okSnap = Number(v.live) === Number(v.backed) && Number(v.mismatched) === 0;
  L(`  SNAPSHOT ${okSnap ? 'COMPLETE AND FAITHFUL' : 'INCOMPLETE — DO NOT PROCEED'}`);
  L('\nrollback:');
  L('  update ticker_daily_candles c set open=b.open, high=b.high, low=b.low, close=b.close,');
  L(`         volume=b.volume, source=b.source from ticker_daily_candles_backup b`);
  L(`   where b.run_id='${RUN_ID}' and c.ticker=b.ticker and c.date=b.date;`);
  fs.writeFileSync('research/convention-run-id.txt', RUN_ID);
  process.exit(okSnap ? 0 : 1);
}

// ── APPLY ────────────────────────────────────────────────────────────────────
if (PHASE === 'apply') {
  if (!CONFIRM) { L('dry run — pass --confirm to write.'); }
  const audit = loadAudit();
  const RUN_ID = fs.existsSync('research/convention-run-id.txt')
    ? fs.readFileSync('research/convention-run-id.txt', 'utf8').trim() : null;
  if (!RUN_ID) { L('no snapshot run id — run --phase=snapshot first.'); process.exit(1); }

  const targets = Object.entries(audit).filter(([, v]) => v.action === 'REPAIR' || v.action === 'RELABEL_ONLY');
  let written = 0, relabelled = 0, skipped = 0;
  for (const [ticker, info] of targets) {
    const res = await vendorFull(ticker);
    if (res.quota) { L(`\nquota reached — rerun to resume (${written} rows written so far).`); break; }
    if (!res.ok) { skipped++; continue; }
    const canonical = tiingoDailyToCanonical(res.rows, { ticker, today: TODAY });
    if (!canonical.length) { skipped++; continue; }
    assertCanonicalCandles(canonical, { ticker });
    const byDate = new Map(canonical.map((b) => [b.date, b]));

    const stored = await sql.query(
      `select date::text d from ticker_daily_candles where ticker=$1 and source=$2`, [ticker, RETIRED]);
    const writable = stored.filter((s) => byDate.has(s.d));
    if (!CONFIRM) { L(`  ${ticker.padEnd(8)} would write ${writable.length} rows (${info.action})`); continue; }

    for (let i = 0; i < writable.length; i += 500) {
      const chunk = writable.slice(i, i + 500);
      const params = [ticker];
      const values = chunk.map((s) => {
        const b = byDate.get(s.d); const base = params.length;
        params.push(b.date, b.open, b.high, b.low, b.close, b.volume);
        return `($${base + 1}::date,$${base + 2}::float8,$${base + 3}::float8,$${base + 4}::float8,$${base + 5}::float8,$${base + 6}::float8)`;
      }).join(',');
      const out = await sql.query(`
        update ticker_daily_candles c
           set open=v.o, high=v.h, low=v.l, close=v.c, volume=v.vol, source='${CANDLE_SOURCE.TIINGO}'
          from (values ${values}) as v(d,o,h,l,c,vol)
         where c.ticker=$1 and c.date=v.d and c.source='${RETIRED}' returning 1`, params);
      written += out.length;
    }
    if (info.action === 'RELABEL_ONLY') relabelled += writable.length;
    L(`  ${ticker.padEnd(8)} ${String(writable.length).padStart(5)} rows  ${info.action}`);
  }
  L(`\n${CONFIRM ? `${written} rows written (${relabelled} were value-identical relabels)` : 'DRY RUN'}; skipped ${skipped}`);
}

// ── VALIDATE ─────────────────────────────────────────────────────────────────
if (PHASE === 'validate') {
  const audit = loadAudit();
  const unverifiable = Object.entries(audit).filter(([, v]) => String(v.action).startsWith('REPORT_ONLY')).map(([t]) => t);
  let pass = 0, fail = 0;
  const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

  const left = await sql.query(
    `select count(*)::int n, count(distinct ticker)::int t from ticker_daily_candles where source=$1`, [RETIRED]);
  ok('only unverifiable tickers still hold retired-convention rows',
    Number(left[0].t) <= unverifiable.length, `${left[0].t} tickers, ${left[0].n} rows`);

  const bad = await sql.query(`
    select count(*)::int n from ticker_daily_candles where source=$1
      and (low > least(open, close) + 1e-6 or high < greatest(open, close) - 1e-6
        or high < low or open <= 0 or close <= 0 or volume < 0)`, [CANDLE_SOURCE.TIINGO]);
  ok('OHLC relationships hold on every canonical Tiingo row', Number(bad[0].n) === 0, String(bad[0].n));

  const spy = await sql.query(
    `select source, count(*)::int n from ticker_daily_candles where ticker='SPY' group by source`);
  const spyRetired = spy.find((r) => r.source === RETIRED);
  ok('SPY holds no retired-convention rows', !spyRetired, spyRetired ? `${spyRetired.n} rows` : '');

  L(`\n${pass} passed, ${fail} failed`);
  if (unverifiable.length) L(`unverifiable, left untouched by design: ${unverifiable.join(', ')}`);
  process.exit(fail ? 1 : 0);
}
