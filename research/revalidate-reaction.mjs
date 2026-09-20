// STEP D — REVALIDATE MARKET REACTION AGAINST THE REPAIRED PRICES.
//
// The repair changed closes on 16 tickers, and Market Reaction is a pure function OF those closes.
// So every reaction number on those tickers has moved. This measures by how much, on the real
// public moments the product actually renders — not on synthetic dates.
//
// ── HOW "BEFORE" IS RECONSTRUCTED ───────────────────────────────────────────
//
// The pre-repair series is not re-fetched from a vendor; it is rebuilt from the snapshot table,
// which holds the exact rows production served before the migration. Where the snapshot has a bar,
// its close is used; everywhere else the live close is used (those rows never changed). So "before"
// is production's own former output, and any difference reported here is attributable to the repair
// alone rather than to vendor drift.
//
// computeReaction is imported, not reimplemented. The anchor rule is the subtle part of this
// feature and a second copy of it would validate the copy rather than the product.
//
// Run: node --env-file=.env.local research/revalidate-reaction.mjs

import { neon } from '@neondatabase/serverless';
import { computeReaction, HORIZONS } from '../src/lib/evidence/reaction.mjs';
import fs2 from 'node:fs';

// The set to revalidate is whatever the CURRENT repair actually touched, read from the audit — not
// the earlier hard-coded 16. Hard-coding it again would silently skip newly repaired tickers,
// including SPY.
const audit = JSON.parse(fs2.readFileSync('research/convention-audit.json', 'utf8'));
const CONFIRMED = Object.entries(audit)
  .filter(([, v]) => v.action === 'REPAIR' || v.action === 'RELABEL_ONLY')
  .map(([t]) => t);

const sql = neon(process.env.DATABASE_URL);
const L = (s = '') => console.log(s);
// Which snapshot defines 'before'. Defaults to the newest, but the newest is not always the
// substantive one — a later small fix-up run would otherwise make this comparison vacuous.
const RUN = process.env.REPAIR_RUN_ID || (await sql.query(
  'select run_id from ticker_daily_candles_backup order by backed_up_at desc limit 1'))[0].run_id;

const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);

// ── THE BENCHMARK IS PART OF THE REPAIR, NOT A FIXED POINT ──────────────────
//
// An earlier version of this script asserted SPY had ZERO repaired rows and used it as an invariant.
// That assumption was wrong and it mattered: SPY was itself on the retired total-return basis for
// 7,845 rows, so benchmark-relative numbers were subtracting a total-return benchmark leg from a
// split-adjusted stock leg. Two conventions in one subtraction.
//
// So BOTH legs move here, and both are reconstructed before/after from the snapshot. The relative
// figure is only meaningful once each leg is on the same basis, which is what the check below
// proves rather than assumes.
const spyLive = await sql.query(
  "select date::text date, close, source from ticker_daily_candles where ticker='SPY' order by date");
const spyBack = await sql.query(
  'select date::text date, close from ticker_daily_candles_backup where run_id=$1 and ticker=$2', [RUN, 'SPY']);
const spyBm = new Map(spyBack.map((b) => [b.date, Number(b.close)]));

const benchAfter = new Map(spyLive.map((b) => [b.date, Number(b.close)]));
const benchBefore = new Map(spyLive.map((b) => [b.date, spyBm.has(b.date) ? spyBm.get(b.date) : Number(b.close)]));

const spySrc = [...new Set(spyLive.map((b) => b.source))];
const spyRetired = spyLive.filter((b) => b.source === 'tiingo').length;
L(`benchmark SPY: ${spyLive.length} bars, sources [${spySrc.join(', ')}]`);
L(`  rows still on the retired total-return basis: ${spyRetired}  ${spyRetired === 0 ? '(canonical)' : '*** NOT CANONICAL ***'}`);
L(`  benchmark bars whose value changed in this repair: ${spyBack.length}\n`);
if (spyRetired !== 0) {
  L('ABORT: the benchmark is not on the canonical convention, so benchmark-relative numbers cannot');
  L('be verified as compatible. Repair SPY before running this.');
  process.exit(1);
}

L(`${'ticker'.padEnd(7)} ${'events'.padStart(6)} ${'reactions'.padStart(9)} ${'changed'.padStart(8)}`
  + ` ${'max Δpp'.padStart(8)} ${'med Δpp'.padStart(8)}  horizons affected`);

const allDeltas = [];
const relDeltas = [];
const perHorizon = Object.fromEntries(HORIZONS.map((h) => [h, []]));
const perHorizonRel = Object.fromEntries(HORIZONS.map((h) => [h, []]));
let relSignFlips = 0;
let signFlips = 0, totalReactions = 0, totalChanged = 0, anchorMoved = 0;
const bigMoves = [];

for (const ticker of CONFIRMED) {
  const live = await sql.query(
    'select date::text date, close from ticker_daily_candles where ticker=$1 order by date', [ticker]);
  const back = await sql.query(
    'select date::text date, close from ticker_daily_candles_backup where run_id=$1 and ticker=$2',
    [RUN, ticker]);
  const bm = new Map(back.map((b) => [b.date, Number(b.close)]));

  const after = live.map((b) => ({ date: b.date, close: Number(b.close) }));
  const before = live.map((b) => ({ date: b.date, close: bm.has(b.date) ? bm.get(b.date) : Number(b.close) }));

  const breaksRes = await sql.query(
    'select break_date::text d from ticker_price_breaks where ticker=$1', [ticker]).catch(() => []);
  const breaks = (breaksRes || []).map((r) => r.d);

  // Real public moments, exactly the PIT columns the timeline uses.
  const ev = [];
  for (const [q, col] of [
    ['select distinct filing_date::text t from insider_trades where ticker=$1 and total_value > 0', 'f4'],
    ['select distinct filed_at t from eightk_filings where ticker=$1', '8k'],
    ['select distinct disclosure_date::text t from congress_trades where ticker=$1', 'congress'],
  ]) {
    const r = await sql.query(q, [ticker]).catch(() => []);
    for (const x of (r || [])) if (x.t) ev.push({ publicTime: x.t, kind: col });
  }

  let reactions = 0, changed = 0;
  const deltas = [];
  const horizonsHit = new Set();

  for (const e of ev) {
    // Each side uses ITS OWN benchmark. Pairing the repaired stock leg with the old benchmark leg
    // would measure a state that never existed in production and never will.
    const a = computeReaction({ publicTime: e.publicTime, bars: after, benchBars: benchAfter, breaks });
    const b = computeReaction({ publicTime: e.publicTime, bars: before, benchBars: benchBefore, breaks });
    if (!a || !b) continue;
    reactions++;
    // The anchor is chosen by DATE, and the repair changed no dates. If an anchor moved, the repair
    // altered the shape of the series and not just its values — which would be a defect.
    if (a.anchorDate !== b.anchorDate) anchorMoved++;
    let tickerChanged = false;
    for (const h of HORIZONS) {
      const ha = a.horizons[h], hb = b.horizons[h];
      if (!ha || !hb) continue;
      const d = Math.abs(ha.return - hb.return);
      // Benchmark-relative is tracked SEPARATELY. It is the figure the benchmark defect actually
      // corrupted, and it can move even where the absolute return does not — so folding the two
      // together would hide exactly the thing this rerun exists to measure.
      if (Number.isFinite(ha.relative) && Number.isFinite(hb.relative)) {
        const dr = Math.abs(ha.relative - hb.relative);
        if (dr > 0.05) {
          relDeltas.push(dr); perHorizonRel[h].push(dr);
          if (Math.sign(ha.relative) !== Math.sign(hb.relative)) relSignFlips++;
        }
      }
      if (d > 0.05) {
        tickerChanged = true;
        horizonsHit.add(h);
        deltas.push(d); allDeltas.push(d); perHorizon[h].push(d);
        if (Math.sign(ha.return) !== Math.sign(hb.return)) signFlips++;
        if (d >= 1.0) bigMoves.push({ ticker, t: String(e.publicTime).slice(0, 10), h, before: hb.return, after: ha.return });
      }
    }
    if (tickerChanged) changed++;
  }
  totalReactions += reactions; totalChanged += changed;
  L(`${ticker.padEnd(7)} ${String(ev.length).padStart(6)} ${String(reactions).padStart(9)}`
    + ` ${String(changed).padStart(8)} ${(deltas.length ? Math.max(...deltas).toFixed(2) : '-').padStart(8)}`
    + ` ${(deltas.length ? med(deltas).toFixed(2) : '-').padStart(8)}  ${[...horizonsHit].sort((x, y) => x - y).join(', ') || '-'}`);
}

L(`\n=== SUMMARY ===`);
L(`  reactions computed on repaired tickers : ${totalReactions}`);
L(`  reactions whose numbers changed        : ${totalChanged}`
  + ` (${totalReactions ? ((totalChanged / totalReactions) * 100).toFixed(1) : 0}%)`);
L(`  anchors that moved to a different date : ${anchorMoved}  (must be 0 — dates were not touched)`);
L(`  horizon values that changed            : ${allDeltas.length}`);
if (allDeltas.length) {
  L(`  change in percentage points            : median ${med(allDeltas).toFixed(3)}pp,`
    + ` max ${Math.max(...allDeltas).toFixed(3)}pp`);
  L('\n  by horizon (trading sessions):');
  for (const h of HORIZONS) {
    const a = perHorizon[h];
    L(`    ${String(h).padStart(3)}d  ${String(a.length).padStart(5)} changed`
      + `  median ${a.length ? med(a).toFixed(3) : '-'}pp  max ${a.length ? Math.max(...a).toFixed(3) : '-'}pp`);
  }
}
L(`\n  sign flips, ABSOLUTE return: ${signFlips}`);

// ── BENCHMARK-RELATIVE ──
// The figure the benchmark defect actually corrupted. It is reported separately because it can move
// where the absolute return does not: before the repair the stock leg was split-adjusted while the
// SPY leg was total-return, so the subtraction mixed two conventions.
L('\n=== BENCHMARK-RELATIVE ===');
L(`  relative values that changed : ${relDeltas.length}`);
if (relDeltas.length) {
  L(`  change in percentage points  : median ${med(relDeltas).toFixed(3)}pp, max ${Math.max(...relDeltas).toFixed(3)}pp`);
  for (const h of HORIZONS) {
    const r = perHorizonRel[h];
    L(`    ${String(h).padStart(3)}d  ${String(r.length).padStart(5)} changed`
      + `  median ${r.length ? med(r).toFixed(3) : '-'}pp  max ${r.length ? Math.max(...r).toFixed(3) : '-'}pp`);
  }
}
L(`  sign flips, RELATIVE: ${relSignFlips}`);
if (bigMoves.length) {
  L(`\n  changes of 1pp or more (${bigMoves.length}) — the ones a user could actually notice:`);
  for (const m of bigMoves.slice(0, 15)) {
    L(`    ${m.ticker.padEnd(7)} ${m.t}  ${String(m.h).padStart(3)}d   ${m.before.toFixed(1)}% -> ${m.after.toFixed(1)}%`);
  }
  if (bigMoves.length > 15) L(`    ... ${bigMoves.length - 15} more`);
}
L('\nDirection of correctness: the "before" numbers were computed on a total-return series, which');
L('inflates historic returns by the dividends paid since. The "after" numbers are split-adjusted,');
L('which is the convention this feature requires. Every difference above is the removal of a');
L('dividend that was previously being reported as price movement.');
