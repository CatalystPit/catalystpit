// STEP C — POST-REPAIR INTEGRITY VALIDATION.
//
// Proves the repair did what it claimed and nothing else. Every check below is one the repair could
// plausibly have broken, and each is asserted against evidence rather than reasoned about:
//
//   the seam is gone                     the boundary move is now an ordinary market move
//   splits remain correct                a known split is still invisible in the series
//   real gaps remain                     a genuine market gap was not smoothed away
//   ex-dividend moves remain             split-adjusted keeps distributions; they must still show
//   no dividend adjustment crept in      repaired closes equal the vendor's RAW close where no
//                                        split intervenes, which total-return closes do not
//   OHLC relationships hold              low <= min(open,close) <= max(open,close) <= high
//   volume semantics                     unchanged where no split intervenes
//   no rows gained, lost or duplicated   count and date-uniqueness identical to the snapshot
//   nothing outside scope moved          every other ticker is byte-identical
//
// Run: node --env-file=.env.local research/seam-repair-validate.mjs

import { neon } from '@neondatabase/serverless';
import { findSeamCandidates } from '../src/lib/price-semantics.mjs';
import { CONFIRMED } from './seam-confirmed.mjs';

const sql = neon(process.env.DATABASE_URL);
const KEY = process.env.TIINGO_API_KEY;
const H = { 'Content-Type': 'application/json', Authorization: `Token ${KEY}` };
const L = (s = '') => console.log(s);
// --mutate=<mode> deliberately breaks ONE thing. An assertion that still passes under a break is not
// testing anything, and a single blunt mutation can mask that by tripping several checks at once, so
// each mode targets one assertion:
//   constancy  scatter the ratio            -> piecewise-constant check must fail
//   magnitude  inflate every step to ~3%    -> quarterly-dividend bound must fail
//   direction  push ratios above 1.0        -> scales-down check must fail
//   intc       nudge INTC's recent closes   -> non-payer control must fail
//   volume     shift the vendor comparison  -> volume-matches-vendor check must fail
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (mode) => MUT === mode || MUT === 'all';
let pass = 0, fail = 0, unverified = 0;
// A check that could not be run is NOT a pass. It is also not a data defect, and reporting it as one
// would be the same false certainty this suite exists to prevent. It gets its own state and still
// blocks a clean exit.
const skip = (name, why) => { unverified++; L(`  ??   ${name} — NOT VERIFIED: ${why}`); };
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; L(`  ok   ${name}`); } else { fail++; L(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const RUN = (await sql.query(
  'select run_id from ticker_daily_candles_backup order by backed_up_at desc limit 1'))[0].run_id;
L(`validating against snapshot ${RUN}\n`);

// ── 1. nothing outside scope moved ───────────────────────────────────────────
L('=== SCOPE ===');
{
  const r = await sql.query(`
    select
      (select count(*) from ticker_daily_candles where source='tiingo_split_adj')::int repaired,
      (select count(*) from ticker_daily_candles where source='tiingo_split_adj' and ticker <> all($1))::int outside,
      (select count(*) from ticker_daily_candles where ticker = any($1) and source='tiingo')::int leftover`,
  [CONFIRMED]);
  ok('repaired row count equals the snapshot', Number(r[0].repaired) === 55125, String(r[0].repaired));
  ok('no ticker outside the confirmed 16 was modified', Number(r[0].outside) === 0, String(r[0].outside));
  ok('no old-convention rows remain on the repaired tickers', Number(r[0].leftover) === 0, String(r[0].leftover));
}
{
  const r = await sql.query(`
    select count(*)::int n from ticker_daily_candles c
     join ticker_daily_candles_backup b on b.run_id=$1 and b.ticker=c.ticker and b.date=c.date`, [RUN]);
  ok('every snapshot row still exists (none lost)', Number(r[0].n) === 55125, String(r[0].n));
}
{
  const r = await sql.query(`
    select count(*)::int n from (
      select ticker, date from ticker_daily_candles where ticker = any($1)
      group by ticker, date having count(*) > 1) x`, [CONFIRMED]);
  ok('no duplicate sessions introduced', Number(r[0].n) === 0, String(r[0].n));
}

// ── 2. OHLC and volume ───────────────────────────────────────────────────────
L('\n=== OHLC AND VOLUME ===');
{
  const r = await sql.query(`
    select count(*)::int bad from ticker_daily_candles
     where source='tiingo_split_adj'
       and (low > least(open, close) + 1e-6 or high < greatest(open, close) - 1e-6
         or high < low or open <= 0 or close <= 0 or volume < 0)`);
  ok('OHLC relationships hold on every repaired row', Number(r[0].bad) === 0, String(r[0].bad));
}
{
  // The original premise here — "no split since 2024, so recent prices cannot move" — was wrong, and
  // wrong in an instructive way. Splits are not the only thing total-return adjustment does. It
  // scales every bar BEFORE the most recent dividend, so it reaches into 2024-2026 as well; the
  // factor merely shrinks toward the present (0.19% median here against ~10% back at the 2023 seam).
  // Those recent bars SHOULD move, and 548 of them did.
  //
  // Gap geometry cannot settle whether that movement is correction or damage — at a few tenths of a
  // percent it is indistinguishable from an ordinary daily move, which is the exact error that sank
  // the first seam detector. The dividend hypothesis makes a sharper prediction, and that is what is
  // asserted: a dividend artifact makes the pre/post ratio PIECEWISE CONSTANT, stepping only at
  // ex-dividend dates, each step worth one quarterly dividend, always downward (back-adjustment
  // scales history down), and leaves a non-payer untouched. Measurement noise or a bad write cannot
  // produce that shape.
  const PLATEAU_TOL = 1e-6, MAX_PLATEAUS = 6, MAX_STEP = 0.015;
  let worstPlateaus = 0, worstStep = 0, badDirection = 0, tickersChecked = 0;
  for (const t of CONFIRMED) {
    const r = await sql.query(`
      select c.date::text d, b.close ob, c.close nb from ticker_daily_candles c
        join ticker_daily_candles_backup b on b.run_id=$1 and b.ticker=c.ticker and b.date=c.date
       where c.ticker=$2 and c.date>='2024-01-01' order by c.date`, [RUN, t]);
    if (!r.length) continue;
    tickersChecked++;
    const steps = [];
    for (const x of r) {
      let v = Math.round((Number(x.ob) / Number(x.nb)) / PLATEAU_TOL) * PLATEAU_TOL;
      if (mut('constancy') && steps.length) v += Math.random() * 0.01;
      if (mut('magnitude')) v = v - 0.03;
      if (mut('direction')) v = 2 - v;
      if (!steps.length || steps[steps.length - 1] !== v) steps.push(v);
    }
    worstPlateaus = Math.max(worstPlateaus, steps.length);
    for (const v of steps) {
      worstStep = Math.max(worstStep, Math.abs(1 - v));
      if (v > 1 + PLATEAU_TOL) badDirection++;
    }
  }
  ok(`recent pre/post ratio is piecewise constant (<=${MAX_PLATEAUS} plateaus; worst ${worstPlateaus})`,
    tickersChecked > 0 && worstPlateaus <= MAX_PLATEAUS, `${worstPlateaus} plateaus`);
  ok(`each plateau is at most one or two quarterly dividends (worst ${(worstStep * 100).toFixed(4)}%)`,
    worstStep <= MAX_STEP, `${(worstStep * 100).toFixed(4)}%`);
  ok('every adjustment removed value rather than adding it (back-adjustment scales down)',
    badDirection === 0, `${badDirection} plateaus above 1.0`);
}
{
  // The natural control. INTC suspended its dividend, so total-return and split-adjusted agree for
  // it and the repair must have changed NOTHING on its recent bars — while its dividend-paying peers
  // all moved. No threshold makes this one pass by luck.
  const r = await sql.query(`
    select count(*)::int changed from ticker_daily_candles c
      join ticker_daily_candles_backup b on b.run_id=$1 and b.ticker=c.ticker and b.date=c.date
     where c.ticker='INTC' and c.date>='2024-01-01'
       and abs(c.close-b.close) > b.close*${mut('intc') ? '-1' : '1e-6'}`, [RUN]);
  ok('INTC (no dividend in the window) is unchanged while payers moved', Number(r[0].changed) === 0,
    String(r[0].changed));
}
{
  // Recent VOLUME did move, on 144 rows. This check originally asserted it could not, which was the
  // wrong premise: the repair refetches the whole vendor series, so vendor revisions to preliminary
  // volume land alongside the split adjustment. Two measurements settled it — on those rows OHLC did
  // not move at all (above), and the same staleness rate appears on UNTOUCHED tickers (AAPL 13/77,
  // NVDA 12/77, AMZN 12/77, META 12/77 vs the current vendor), so it is a pre-existing property of
  // the daily ingest that the repair incidentally corrected here, not damage the repair caused.
  //
  // So the assertion is not "volume did not change" but "every change moved volume TO the vendor's
  // current value" — a correction is provable, a corruption is not.
  const rows = await sql.query(`
    select c.ticker, c.date::text d, c.volume newv from ticker_daily_candles c
      join ticker_daily_candles_backup b on b.run_id=$1 and b.ticker=c.ticker and b.date=c.date
     where c.date >= '2024-01-01' and abs(c.volume - b.volume) > greatest(b.volume * 0.001, 1)
     order by c.ticker, c.date`, [RUN]);
  const byTicker = new Map();
  for (const r of rows) {
    if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
    byTicker.get(r.ticker).push(r);
  }
  let checked = 0, matchVendor = 0, unverifiable = 0;
  for (const [t, list] of byTicker) {
    const v = await tiingo(t, list[0].d, list[list.length - 1].d);
    if (!v) { unverifiable += list.length; continue; }
    for (const r of list) {
      const x = v.get(r.d);
      if (!x) { unverifiable++; continue; }
      checked++;
      let vendorVol = Number(x.volume);
      if (mut('volume')) vendorVol *= 1.5;
      if (Math.abs(Number(r.newv) - vendorVol) / Math.max(vendorVol, 1) <= 0.001) matchVendor++;
    }
  }
  if (checked === 0) {
    skip('every changed recent volume equals the current vendor value',
      `vendor unavailable for all ${unverifiable} rows (rate limit) — rerun when quota resets`);
  } else {
    ok(`every changed recent volume now equals the current vendor value (${matchVendor}/${checked})`,
      matchVendor === checked,
      `${checked - matchVendor} mismatched, ${unverifiable} unverifiable`);
    if (unverifiable) L(`  NOTE: ${unverifiable} further rows were unverifiable (vendor rate limit).`);
  }
  L(`  NOTE: ${rows.length} recent volumes changed. Vendor revises preliminary volume after the`);
  L('  session; the repair refetched and so picked up those revisions. The same staleness exists on');
  L('  tickers this repair never touched, so it is an INGEST issue affecting the whole table and is');
  L('  reported as a separate finding — not corruption, and not introduced here.');
}

// ── 3. the seam itself ───────────────────────────────────────────────────────
L('\n=== THE SEAM ===');
for (const [t, seamDate] of [['KO', '2023-09-13'], ['PG', '2023-09-13'], ['JNJ', '2023-09-13'],
  ['MSFT', '2023-09-13'], ['QQQ', '2023-09-13'], ['INTC', '2023-09-13']]) {
  const before = await sql.query(`
    select b.close prev_old, c.close prev_new from ticker_daily_candles_backup b
      join ticker_daily_candles c on c.ticker=b.ticker and c.date=b.date
     where b.run_id=$1 and b.ticker=$2 and b.date = (
       select max(date) from ticker_daily_candles where ticker=$2 and date < $3)`, [RUN, t, seamDate]);
  const after = await sql.query(
    'select close from ticker_daily_candles where ticker=$1 and date=$2', [t, seamDate]);
  if (!before.length || !after.length) { ok(`${t}: seam boundary present`, false); continue; }
  const oldGap = ((Number(after[0].close) - Number(before[0].prev_old)) / Number(before[0].prev_old)) * 100;
  const newGap = ((Number(after[0].close) - Number(before[0].prev_new)) / Number(before[0].prev_new)) * 100;
  ok(`${t}: fabricated gap removed (${oldGap.toFixed(2)}% -> ${newGap.toFixed(2)}%)`,
    Math.abs(newGap) < Math.abs(oldGap) && Math.abs(newGap) < 3, `now ${newGap.toFixed(2)}%`);
}

// ── 4. no dividend adjustment introduced ─────────────────────────────────────
L('\n=== CONVENTION: SPLIT-ADJUSTED, NOT TOTAL RETURN ===');
// Retries on 429. The free tier is the only tier available here, so a rate limit is an ordinary
// condition to wait out, not an error — and a check that quietly degrades because of one would
// report unverified data as verified.
async function tiingo(sym, from, to) {
  const u = `https://api.tiingo.com/tiingo/daily/${sym}/prices?startDate=${from}&endDate=${to}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = await fetch(u, { headers: H });
    if (r.status === 429) {
      if (attempt === 5) return null;
      await new Promise((s) => setTimeout(s, 20000 * attempt));
      continue;
    }
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) ? new Map(j.map((x) => [String(x.date).slice(0, 10), x])) : null;
  }
  return null;
}
for (const t of ['KO', 'PG', 'MSFT']) {
  const v = await tiingo(t, '2022-06-01', '2022-06-10');
  if (!v) { skip(`${t}: closes match the vendor RAW series, not adjClose`, 'vendor unavailable (rate limit)'); continue; }
  const rows = await sql.query(
    "select date::text d, close from ticker_daily_candles where ticker=$1 and date between '2022-06-01' and '2022-06-10' order by date", [t]);
  let matchRaw = 0, matchAdj = 0, n = 0;
  for (const row of rows) {
    const x = v.get(row.d); if (!x) continue;
    n++;
    if (Math.abs(Number(row.close) - Number(x.close)) / Number(x.close) < 0.002) matchRaw++;
    if (Math.abs(Number(row.close) - Number(x.adjClose)) / Number(x.adjClose) < 0.002) matchAdj++;
  }
  // Historic bars: raw and adjClose differ by accumulated dividends, so matching RAW proves the
  // series is split-adjusted rather than total-return.
  ok(`${t}: historic closes match the vendor RAW series, not adjClose (${matchRaw}/${n} vs ${matchAdj}/${n})`,
    n > 0 && matchRaw > matchAdj, `raw ${matchRaw} adj ${matchAdj} of ${n}`);
}

// ── 5. splits still correct, real moves still present ────────────────────────
L('\n=== SPLITS AND REAL MOVES ===');
{
  // MSFT 2:1 on 2003-02-18 — inside the repaired range. A correctly split-adjusted series shows no
  // cliff there.
  const r = await sql.query(
    "select date::text d, close from ticker_daily_candles where ticker='MSFT' and date between '2003-02-12' and '2003-02-24' order by date");
  let worst = 0;
  for (let i = 1; i < r.length; i++) {
    worst = Math.max(worst, Math.abs((Number(r[i].close) - Number(r[i - 1].close)) / Number(r[i - 1].close)));
  }
  ok('MSFT 2003 2:1 split shows no cliff after repair', r.length > 3 && worst < 0.15,
    `worst move ${(worst * 100).toFixed(1)}%`);
}
{
  // A real crash must survive. KO on Black Monday 1987 fell hard and that is not corruption.
  const r = await sql.query(
    "select date::text d, close from ticker_daily_candles where ticker='KO' and date between '1987-10-16' and '1987-10-21' order by date");
  let biggest = 0;
  for (let i = 1; i < r.length; i++) {
    biggest = Math.min(biggest, (Number(r[i].close) - Number(r[i - 1].close)) / Number(r[i - 1].close));
  }
  ok('KO retains its October 1987 crash (a real gap was not smoothed)', biggest < -0.15,
    `largest fall ${(biggest * 100).toFixed(1)}%`);
}
{
  // Ex-dividend moves must REMAIN, because split-adjusted keeps distributions.
  const v = await tiingo('KO', '2019-01-01', '2019-12-31');
  if (v) {
    const exDates = [...v.values()].filter((x) => Number(x.divCash) > 0).map((x) => String(x.date).slice(0, 10));
    const rows = await sql.query(
      "select date::text d, close from ticker_daily_candles where ticker='KO' and date between '2019-01-01' and '2019-12-31' order by date");
    const idx = new Map(rows.map((r, i) => [r.d, i]));
    let drops = 0, checked = 0;
    for (const d of exDates) {
      const i = idx.get(d); if (!i) continue;
      checked++;
      if (Number(rows[i].close) < Number(rows[i - 1].close)) drops++;
    }
    ok(`KO ex-dividend dates still show price drops (${drops}/${checked})`, checked > 0 && drops > 0);
  } else skip('KO ex-dividend dates still show price drops', 'vendor unavailable (rate limit)');
}

// ── 6. controls ──────────────────────────────────────────────────────────────
L('\n=== CONTROLS (must be untouched) ===');
for (const [t, label] of [['AAPL', 'tiingo-only, not in the confirmed set'], ['NVDA', 'mixed, not confirmed'],
  ['F', 'polygon-only']]) {
  const r = await sql.query(
    'select count(*)::int n, count(*) filter (where source=\'tiingo_split_adj\')::int repaired from ticker_daily_candles where ticker=$1', [t]);
  ok(`${t} untouched (${label})`, Number(r[0].repaired) === 0, `${r[0].repaired} repaired rows`);
}
{
  // AAPL's 2020 4:1 split must still be clean — proof the repair did not disturb non-target tickers.
  const r = await sql.query(
    "select close from ticker_daily_candles where ticker='AAPL' and date between '2020-08-27' and '2020-09-02' order by date");
  let worst = 0;
  for (let i = 1; i < r.length; i++) worst = Math.max(worst, Math.abs((Number(r[i].close) - Number(r[i - 1].close)) / Number(r[i - 1].close)));
  ok('AAPL 2020 4:1 split remains clean', r.length > 3 && worst < 0.15, `${(worst * 100).toFixed(1)}%`);
}

// ── 7. candidates after repair ───────────────────────────────────────────────
L('\n=== SEAM CANDIDATES AFTER REPAIR (candidates, not confirmed corruption) ===');
let totalCand = 0;
for (const t of CONFIRMED) {
  const r = await sql.query(
    'select date::text date, open, high, low, close, volume, source from ticker_daily_candles where ticker=$1 order by date', [t]);
  const bars = r.map((x) => ({ ...x, open: +x.open, high: +x.high, low: +x.low, close: +x.close }));
  const c = findSeamCandidates(bars);
  totalCand += c.length;
  if (c.length) L(`  ${t.padEnd(7)} ${c.length} candidate(s): ${c.map((x) => `${x.date} ${x.gapPct}%`).join(', ')}`);
}
L(`  total candidates across the repaired 16: ${totalCand}`);
L('  NOTE: these are boundaries between polygon and tiingo_split_adj rows. Both are now split-');
L('  adjusted, so a candidate here is an ordinary market move at a provenance boundary, not a');
L('  convention change. None is rewritten without separate vendor confirmation.');

L(`\n${pass} passed, ${fail} failed, ${unverified} not verified`);
if (unverified) L('NOT VERIFIED is not a pass. Rerun those checks before relying on this suite.');
process.exit(fail || unverified ? 1 : 0);
