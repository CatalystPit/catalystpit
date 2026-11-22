// APPEND EACH COMPLETED SESSION'S LICENSED DAILY BAR. The job the pipeline assumed existed.
//
//   node --env-file=.env.local scripts/append-licensed-eod.mjs [--limit=N] [--pace=220] [--dry]
//
// ⚠️ THE GAP THIS FILLS, MEASURED. screener-data.js builds every price from licensedEod(), which reads
// the two most recent dates PRESENT in ticker_daily_candles and says so in its own comment: "the candle
// table is now the INPUT here rather than the output, and the Tiingo rebuild owns the writes."
//
// Nothing owns those writes. Candles are appended only as a side effect of a visitor opening
// /api/ticker or /api/chart-daily, so each session's coverage is however many distinct tickers somebody
// happened to look at. Measured per session: 353 tickers on 5 Nov, decaying monotonically to 112 on
// 20 Nov. The Screener therefore priced 2,577 of 18,019 rows. The historical table is intact —
// 14,422 tickers, 6.9M rows — so nothing was lost; it simply stopped being extended.
//
// backfill-licensed-candles.mjs could not do this: its queue selects tickers whose candles still carry
// an unlicensed source, and every one of those has been converted. It reports "0 to rebuild" and exits.
//
// ⚠️ REAL EOD BARS, NOT THE SNAPSHOT. getAllTickersSnapshot() would return the whole market in one
// request and is tempting, but it is an intraday tape: volume is null on the consolidated feed and its
// close is a last print rather than the official session bar. Writing those rows next to true EOD bars
// would put two conventions in one table under one source name, which is the shape of a fabricated
// price. getDailyBars is the same endpoint the existing history came from, so a bar appended here is
// indistinguishable from the ones already stored — because it is the same fact from the same place.
//
// ⚠️ UPSERT, NEVER DELETE. ON CONFLICT (ticker, date) DO UPDATE, so a re-run is idempotent and a
// partial run is resumable: the next run simply starts from wherever each ticker's history now ends.

import postgres from 'postgres';
import { getDailyBars } from '../src/lib/market/tiingo.mjs';
import { tiingoDailyToCanonical, assertCanonicalCandles } from '../src/lib/market/candles.mjs';
import { LICENSED_CANDLE_SOURCES } from '../src/lib/licensing/providers.mjs';

const args = process.argv.slice(2);
const LIMIT = Number((args.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
const PACE_MS = Number((args.find((a) => a.startsWith('--pace=')) || '').split('=')[1]) || 220;
const DRY = args.includes('--dry');
// The probe can be skipped when a caller knows a session happened (a manual catch-up run).
const NO_PROBE = args.includes('--no-probe');
// SPY: the most liquid symbol we track, so if it has no bar neither does the market.
const PROBE_TICKER = (args.find((a) => a.startsWith('--probe=')) || '').split('=')[1] || 'SPY';
const SOURCE = LICENSED_CANDLE_SOURCES[0];

const sql = postgres(process.env.DATABASE_URL, { max: 3 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TODAY = new Date().toISOString().slice(0, 10);

// ⚠️ MOST VALUABLE FIRST, so a run that is cut short has still restored the names people open. Ordered
// by the Screener's own market cap, nulls last, then ticker for a stable and resumable order.
//
// The candidate set is tickers that ALREADY have licensed history: this job extends a series, it does
// not decide which securities deserve one. A ticker Tiingo does not cover is not conjured into the
// table by asking for it again.
const todo = await sql`
  select c.ticker, max(c.date)::text as last_bar
    from ticker_daily_candles c
   where c.source = ${SOURCE}
   group by c.ticker
  having max(c.date)::text < ${TODAY}
   order by coalesce((select s.market_cap from screener_stocks s where s.ticker = c.ticker), -1) desc,
            c.ticker
   ${LIMIT ? sql`limit ${LIMIT}` : sql``}`;

// ⚠️ ONE-REQUEST SESSION PROBE. The todo query asks "is this ticker's last bar older than TODAY",
// which is true for the entire universe on a Sunday — so a nightly run would walk all 14,422 tickers
// and append nothing. Rather than carry an exchange holiday calendar (which must be maintained, and is
// wrong the first time the NYSE closes unexpectedly), ask the market: if the most liquid symbol we
// track has nothing newer than its last stored bar, there was no session. One request answers it for
// the whole universe and cannot go stale.
if (!NO_PROBE && todo.length) {
  const probeRow = await sql`
    select max(date)::text as last_bar from ticker_daily_candles
     where source = ${SOURCE} and ticker = ${PROBE_TICKER}`;
  const probeLast = probeRow[0]?.last_bar;
  if (probeLast) {
    const probeFrom = new Date(Date.parse(`${probeLast}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const probe = await getDailyBars(PROBE_TICKER, { from: probeFrom, to: TODAY });
    if (probe?.ok && Array.isArray(probe.bars) && probe.bars.length === 0) {
      console.log(`no new session: ${PROBE_TICKER} has nothing after ${probeLast}. Nothing to append.`);
      await sql.end();
      process.exit(0);
    }
    if (!probe?.ok) {
      // A failed probe is NOT a "no session" answer. Falling through is the safe direction: the run
      // proceeds and each ticker reports its own outcome, rather than a vendor blip silently
      // cancelling a night's maintenance.
      console.log(`probe inconclusive (${probe?.reason || 'unknown'}) — continuing with the full pass`);
    }
  }
}

console.log(`${todo.length} ticker(s) with licensed history not yet current as of ${TODAY}`);
if (DRY) {
  for (const t of todo.slice(0, 15)) console.log(`  ${t.ticker.padEnd(8)} last bar ${t.last_bar}`);
  console.log(DRY ? '\n(dry run — nothing written)' : '');
  await sql.end();
  process.exit(0);
}

let examined = 0, written = 0, upToDate = 0, noBars = 0, failed = 0, rowsWritten = 0;
const problems = [];

for (const t of todo) {
  examined += 1;
  try {
    // One day past the last stored bar through today. A weekend or holiday simply returns nothing,
    // which is "already current", not a failure.
    const from = new Date(Date.parse(`${t.last_bar}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    let res = await getDailyBars(t.ticker, { from, to: TODAY });

    // ⚠️ A SHARE CLASS IS NOT A MISSING SECURITY, IT IS A DIFFERENT SPELLING — the same correction the
    // full backfill carries. Tiingo uses a DASH where our canonical symbol uses a dot (BF-B vs BF.B),
    // so without this a punctuation mark reads as "no coverage". Rows are stored under OUR symbol,
    // because every join in the product keys on that.
    if ((!res.ok || !res.bars.length) && t.ticker.includes('.')) {
      const retry = await getDailyBars(t.ticker.replace(/\./g, '-'), { from, to: TODAY });
      if (retry.ok && retry.bars.length) res = retry;
    }

    // A FAILED CALL IS NOT AN UP-TO-DATE TICKER. Kept apart deliberately: the first version of this
    // script folded both into one counter and reported a clean no-op over 25 unchecked tickers.
    if (!res.ok) {
      failed += 1;
      problems.push(`${t.ticker}: request failed (${res.reason || 'no reason given'})`);
      await sleep(PACE_MS); continue;
    }
    // Genuinely nothing new — a weekend, a holiday, or a ticker Tiingo has stopped covering.
    if (!res.bars.length) { upToDate += 1; await sleep(PACE_MS); continue; }

    const rows = tiingoDailyToCanonical(res.bars.map((b) => ({ ...b, date: b.time })), { ticker: t.ticker });
    if (!rows.length) { noBars += 1; await sleep(PACE_MS); continue; }

    // ⚠️ THE SAME WRITE CONTRACT THE REST OF THE TABLE IS HELD TO — it throws rather than returning,
    // so it is caught below. A malformed bar here reaches charts, the Screener, breadth, the heatmap,
    // movers and Fear & Greed.
    assertCanonicalCandles(rows, { ticker: t.ticker });
    if (!rows.every((r) => LICENSED_CANDLE_SOURCES.includes(r.source))) {
      throw new Error(`conversion produced an unlicensed source: ${[...new Set(rows.map((r) => r.source))].join(',')}`);
    }

    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await sql`
        insert into ticker_daily_candles ${sql(chunk.map((r) => ({
          ticker: t.ticker, date: r.date, open: r.open, high: r.high, low: r.low,
          close: r.close, volume: r.volume, source: r.source,
        })), 'ticker', 'date', 'open', 'high', 'low', 'close', 'volume', 'source')}
        on conflict (ticker, date) do update
          set open = excluded.open, high = excluded.high, low = excluded.low,
              close = excluded.close, volume = excluded.volume, source = excluded.source`;
      rowsWritten += chunk.length;
    }
    written += 1;
    if (written % 250 === 0) {
      process.stdout.write(`\r  ${written} extended · ${upToDate} already current · ${examined}/${todo.length}`);
    }
  } catch (e) {
    failed += 1;
    problems.push(`${t.ticker}: ${String(e?.message || e).slice(0, 90)}`);
  }
  await sleep(PACE_MS);
}

console.log(`\n\nexamined ${examined} · extended ${written} · already current ${upToDate} · `
  + `no bars ${noBars} · failed ${failed} · ${rowsWritten} rows written`);
if (problems.length) {
  console.log(`\nfirst ${Math.min(20, problems.length)} problem(s):`);
  for (const p of problems.slice(0, 20)) console.log(`  ${p}`);
}

const after = await sql`
  select date::text as date, count(distinct ticker)::int tickers
    from ticker_daily_candles where source = ${SOURCE} and date > now() - interval '7 days'
   group by date order by date desc limit 5`;
console.log('\nlicensed coverage per recent session now:');
for (const r of after) console.log(`  ${r.date}  ${String(r.tickers).padStart(6)} tickers`);

await sql.end();
