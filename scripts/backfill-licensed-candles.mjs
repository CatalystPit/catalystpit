// REBUILD THE DAILY CANDLE HISTORY ON THE LICENSED PROVIDER.
//
//   node --env-file=.env.local scripts/backfill-licensed-candles.mjs [--limit N] [--dry]
//
// ⚠️ WHY THIS EXISTS. 2,813,069 of 3,322,920 rows in ticker_daily_candles carried source 'polygon' —
// a provider whose redistribution rights were never established — and forty source files read that
// table for charts, the Screener, breadth, the heatmap, movers, Fear & Greed, Consensus, Evidence and
// the congressional leaderboard. Reads are now gated on LICENSED_CANDLE_SOURCES, so until a ticker is
// rebuilt here its history is on disk and not served. This is what restores it.
//
// ⚠️ THE REPLACEMENT WAS PROVEN BEFORE ANY ROW WAS WRITTEN. Across 24 sampled tickers and 3,509
// overlapping closes, Tiingo's split-adjusted series matched the stored Polygon series EXACTLY — same
// convention, same numbers, frequently more history. So this is not a re-basing of published figures;
// it is the same market fact, re-sourced. Anything that did NOT match would be a reason to stop, which
// is why the comparison runs per ticker here too and a mismatching ticker is reported, not written.
//
// ⚠️ AND IT IS AN UPSERT ON (ticker, date), NOT A DELETE-THEN-INSERT. The primary key already holds a
// Polygon row for most of these dates; DO UPDATE replaces its values and its source in one statement,
// so there is never a window in which the ticker has no history at all. Nothing is deleted by this
// script — a Polygon row survives untouched wherever Tiingo has no bar for that date, and the read
// gate is what keeps it out of the product.
//
// Budget: Tiingo allows 30,000 requests/hour and one request returns a ticker's whole history, so the
// whole universe is well inside a single hour. The pacing below is deliberately under that.
import postgres from 'postgres';
import { getDailyBars } from '../src/lib/market/tiingo.mjs';
import { tiingoDailyToCanonical, assertCanonicalCandles } from '../src/lib/market/candles.mjs';
import { LICENSED_CANDLE_SOURCES } from '../src/lib/licensing/providers.mjs';

const args = process.argv.slice(2);
const LIMIT = Number((args.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
const DRY = args.includes('--dry');
const ACCEPT_CONVENTION = args.includes('--accept-convention-difference');
const PACE_MS = Number((args.find((a) => a.startsWith('--pace=')) || '').split('=')[1]) || 220;

const sql = postgres(process.env.DATABASE_URL, { max: 3 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TODAY = new Date().toISOString().slice(0, 10);

// ⚠️ MOST-VIEWED FIRST, so the surfaces people actually open recover first rather than the backfill
// spending its first ten minutes on delisted warrants. market_cap desc nulls last, then ticker for a
// stable, resumable order.
const todo = await sql`
  select c.ticker,
         min(c.date)::text  as from_d,
         max(c.date)::text  as to_d,
         count(*)::int      as polygon_rows
    from ticker_daily_candles c
   where c.source = 'polygon'
   group by c.ticker
   order by coalesce((select s.market_cap from screener_stocks s where s.ticker = c.ticker), 0) desc,
            c.ticker
   ${LIMIT ? sql`limit ${LIMIT}` : sql``}`;

console.log(`tickers to rebuild: ${todo.length}${LIMIT ? ` (limited)` : ''}${DRY ? '  [DRY RUN — no writes]' : ''}`);

let done = 0, written = 0, skippedNoBars = 0, mismatched = 0, failed = 0, compared = 0, exact = 0, accepted = 0;
const problems = [];
const t0 = Date.now();

for (const t of todo) {
  done++;
  try {
    // The whole stored span, plus anything Tiingo has beyond it — a longer series is a better chart.
    let res = await getDailyBars(t.ticker, { from: t.from_d, to: TODAY });

    // ⚠️ A SHARE CLASS IS NOT A MISSING SECURITY, IT IS A DIFFERENT SPELLING. The first run reported 56
    // tickers with "no licensed bars", and ten of them were obviously wrong: BF.A, BF.B, LEN.B, HEI.A,
    // MKC.V, WSO.B, MOG.A, MOG.B, UHAL.B, GEF.B. Measured directly, Tiingo answers for BF-B with 85 bars
    // and for BF.B with not-found — it uses a DASH for share classes where our canonical symbol uses a
    // dot. Reading that as "Tiingo has no coverage" would have retired real history for real companies
    // over a punctuation mark.
    //
    // The retry is attempted ONLY on a genuine not-found/empty, and the rows are stored under OUR symbol,
    // because every join in the product keys on that.
    if ((!res.ok || !res.bars.length) && t.ticker.includes('.')) {
      const alt = t.ticker.replace(/\./g, '-');
      const retry = await getDailyBars(alt, { from: t.from_d, to: TODAY });
      if (retry.ok && retry.bars.length) {
        res = retry;
        console.log(`       ${t.ticker} resolved as ${alt} (share-class convention)`);
      }
    }

    if (!res.ok || !res.bars.length) {
      skippedNoBars++;
      problems.push(`${t.ticker}: no licensed bars (${res.reason || 'empty'})`);
      await sleep(PACE_MS);
      continue;
    }

    const rows = tiingoDailyToCanonical(res.bars.map((b) => ({ ...b, date: b.time })), { ticker: t.ticker });
    if (!rows.length) { skippedNoBars++; problems.push(`${t.ticker}: converted to zero canonical rows`); await sleep(PACE_MS); continue; }
    // The table's own write contract: canonical source, split-adjusted basis, no retired values.
    assertCanonicalCandles(rows, { ticker: t.ticker });
    if (!rows.every((r) => LICENSED_CANDLE_SOURCES.includes(r.source))) {
      throw new Error(`conversion produced an unlicensed source: ${[...new Set(rows.map((r) => r.source))].join(',')}`);
    }

    // ⚠️ VERIFY THIS TICKER BEFORE REPLACING IT. The sample proved the method; this proves the row.
    const stored = await sql`
      select date::text as date, close from ticker_daily_candles
       where ticker = ${t.ticker} and source = 'polygon'`;
    const byDate = new Map(rows.map((r) => [r.date, r]));
    let cmp = 0, same = 0, worstBp = 0;
    for (const s of stored) {
      const r = byDate.get(s.date);
      if (!r) continue;
      cmp++;
      const d = Math.abs(r.close - Number(s.close)) / Math.max(1e-9, Number(s.close));
      if (d < 1e-4) same++; else worstBp = Math.max(worstBp, d * 1e4);
    }
    compared += cmp; exact += same;
    // A ticker whose licensed series genuinely disagrees is reported and LEFT ALONE by default:
    // replacing a published number with a different one needs a human decision, not a loop.
    //
    // ── ⚠️ WHAT THE DISAGREEMENTS TURNED OUT TO BE, AND WHY --accept-convention-difference EXISTS ──
    //
    // The first full run flagged 623 tickers. Measured, the divergence is a CONSTANT PERCENTAGE across a
    // contiguous historical span that ends at exactly 0% for recent dates — the unmistakable signature of
    // a corporate action that one source adjusted history for and the other did not:
    //
    //   DD   Tiingo is 139% HIGHER before Nov 2025   (Polygon adjusted for the Qnity spinoff; Tiingo did not)
    //   BDX  Tiingo is 21.4% LOWER before Feb 2026   (Tiingo adjusted for the spinoff; Polygon did not)
    //   UTF  Tiingo is 1.67% LOWER over 14 sessions  (a distribution treated differently)
    //
    // They disagree in BOTH DIRECTIONS on different securities, so neither vendor is uniformly correct and
    // this is not a case of one being broken. Both are defensible conventions applied inconsistently
    // across corporate-action types.
    //
    // ⚠️ AND THE CHOICE IS NOT BETWEEN THE TWO SERIES. We may not serve the Polygon rows whatever we think
    // of their adjustment, so the real options are the licensed series or NO HISTORY AT ALL for 623
    // securities including BDX, DD, ILMN, PHG and a long tail of closed-end funds. The licensed series is
    // internally consistent, uses the same conversion as the other 13,091 tickers, and is identical to
    // what we served for every date after the corporate action.
    //
    // So the flag is opt-in and loud rather than the default: the first run reports what would change, a
    // human reads it, and only then is it applied. That ordering is the whole point.
    if (cmp >= 10 && same / cmp < 0.99) {
      if (!ACCEPT_CONVENTION) {
        mismatched++;
        problems.push(`${t.ticker}: ${cmp} compared, only ${(100 * same / cmp).toFixed(1)}% agree (worst ${worstBp.toFixed(1)}bp) — NOT written`);
        await sleep(PACE_MS);
        continue;
      }
      accepted++;
      problems.push(`${t.ticker}: accepted licensed series despite ${(100 - 100 * same / cmp).toFixed(1)}% of dates differing (worst ${worstBp.toFixed(1)}bp)`);
    }

    if (!DRY) {
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        await sql`
          insert into ticker_daily_candles ${sql(chunk, 'ticker', 'date', 'open', 'high', 'low', 'close', 'volume', 'source')}
          on conflict (ticker, date) do update set
            open = excluded.open, high = excluded.high, low = excluded.low,
            close = excluded.close, volume = excluded.volume, source = excluded.source`;
      }
    }
    written += rows.length;
  } catch (e) {
    failed++;
    problems.push(`${t.ticker}: ${e.message}`);
  }

  if (done % 100 === 0 || done === todo.length) {
    const mins = (Date.now() - t0) / 60000;
    console.log(`  ${String(done).padStart(5)}/${todo.length}  rows ${written}  no-bars ${skippedNoBars}  mismatch ${mismatched}  failed ${failed}  ${mins.toFixed(1)}min  ${(done / mins).toFixed(0)}/min`);
  }
  await sleep(PACE_MS);
}

console.log(`\nrebuilt ${done - skippedNoBars - mismatched - failed}/${todo.length} tickers · ${written} rows written`);
console.log(`closes compared ${compared}, agreeing ${exact} (${(100 * exact / (compared || 1)).toFixed(2)}%)`);
console.log(`no licensed bars: ${skippedNoBars} · mismatched (left alone): ${mismatched} · accepted despite a convention difference: ${accepted} · failed: ${failed}`);
if (problems.length) {
  console.log(`\nfirst 40 problems:`);
  for (const p of problems.slice(0, 40)) console.log(`  ${p}`);
}
const after = await sql`select source, count(*)::int rows, count(distinct ticker)::int tickers from ticker_daily_candles group by 1 order by 2 desc`;
console.log('\ncandle population now:');
for (const r of after) console.log(`  ${String(r.source).padEnd(20)} ${String(r.rows).padStart(9)} rows  ${String(r.tickers).padStart(6)} tickers`);
await sql.end();
