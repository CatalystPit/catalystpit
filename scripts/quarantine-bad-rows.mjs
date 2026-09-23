// scripts/quarantine-bad-rows.mjs
//
// Sweeps rows that were ingested BEFORE the validation layer existed and moves the
// malformed ones into insider_quarantine. Nothing is destroyed: every column of the
// original row is copied into quarantine.parsed as JSON along with its SEC URL, so any
// row can be inspected and replayed.
//
//   node --env-file=.env.local scripts/quarantine-bad-rows.mjs --dry-run
//   node --env-file=.env.local scripts/quarantine-bad-rows.mjs
//
// Rules mirror src/lib/form4.mjs so new ingestion and old data are judged identically.

import { neon } from '@neondatabase/serverless';

const DRY = process.argv.includes('--dry-run');
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
const sql = neon(process.env.DATABASE_URL);

// Each rule: a WHERE clause and the reason code it records. Ordered most-specific first;
// a row is swept by the first rule that matches it.
const RULES = [
  {
    reason: 'NO_TICKER',
    why: 'non-listed filer stored under a placeholder symbol - pollutes every ticker aggregate',
    where: `ticker IS NULL OR upper(btrim(ticker)) IN ('N/A','NA','NONE','NULL','-','--','','N.A.')`,
  },
  {
    reason: 'UNKNOWN_TXN_CODE',
    why: 'no SEC transaction code, so the row cannot be classified as buy, sell or neither',
    where: `transaction_code IS NULL OR btrim(transaction_code) = ''`,
  },
  {
    // ⚠️ THIS RULE DID NOT MIRROR form4.mjs, AND RUNNING IT WOULD HAVE DESTROYED REAL DATA.
    //
    // The parser quarantines a zero price ONLY when the filer DISCLOSED zero
    // (`pricePerShare === 0 && row.priceDisclosed`). A price that was simply not stated
    // numerically is a genuine transaction — form4.mjs: "filers routinely footnote it instead
    // ('purchased for $0.80 per Unit', 'in lieu of cash compensation'). Discarding those threw
    // away genuine purchases that had perfectly valid share counts."
    //
    // `priceDisclosed` is a parse-time fact and is NOT a column on insider_trades, so this sweep
    // could not test it and dropped the condition entirely — making it strictly harsher than the
    // ingest rule it claims to mirror. Measured before running: all 1,005 matching rows carry
    // footnotes, 719 of them are BUYS, and together they account for $0.00B of value. Sweeping
    // them would have removed 719 real insider purchases and corrected nothing.
    //
    // The presence of a footnote is the closest proxy the stored data allows for "the price was
    // explained rather than declared zero", so it is required here. A disclosed $0 with no
    // footnote remains sweepable.
    reason: 'ZERO_PRICE_OPEN_MARKET',
    why: 'P/S disclosed at $0 with no explanatory footnote - a data error, not a footnoted price',
    where: `transaction_code IN ('P','S') AND shares > 0 AND price_per_share = 0
            AND (footnotes IS NULL OR btrim(footnotes) = '')`,
  },
  {
    reason: 'ABSURD_PRICE',
    why: 'price above $1,000,000/share exceeds any real US security',
    where: `price_per_share > 1000000`,
  },
  {
    reason: 'ABSURD_SHARES',
    why: 'share count exceeds any real issuer',
    where: `shares > 50000000000`,
  },
  {
    // A fixed price ceiling cannot catch unit errors on cheap securities: REBN was filed
    // at $180,000/share against a real market price of $0.70-$0.85, and YPF at $7,983
    // against $54.61 (pesos, not dollars). Both sailed under a $1M ceiling while adding
    // billions to the totals. Comparing against our own daily candles is the real test.
    //
    // Only the ABOVE-market direction is sweptable. Filing far BELOW market is routinely
    // legitimate - an option exercise prices at strike, not at market - so those are left
    // alone rather than destroying good rows to catch a few bad ones.
    reason: 'MARKET_PRICE_MISMATCH',
    why: 'filed price >20x the actual market close around the transaction date (unit/currency error)',
    where: `price_per_share > 0 AND EXISTS (
              SELECT 1 FROM ticker_daily_candles c
               WHERE c.ticker = insider_trades.ticker
                 AND c.date BETWEEN insider_trades.transaction_date - 10 AND insider_trades.transaction_date + 10
              HAVING percentile_cont(0.5) WITHIN GROUP (ORDER BY c.close) > 0
                 AND insider_trades.price_per_share > percentile_cont(0.5) WITHIN GROUP (ORDER BY c.close) * 20
            )`,
  },
  {
    // The strongest plausibility test we have, and the one that catches what price
    // ceilings and candle windows both miss: nobody transacts several times the whole
    // company. REBN filed $23.65B against a $6M market cap; SVRE $115.10B against $6M.
    // Thin candle coverage (only ~10% of rows have a close within 10 days) is exactly
    // why this backstop is needed.
    //
    // 5x is deliberately generous - a stale market_cap on a shell mid-reverse-merger
    // should not sweep a real filing. Anything tripping 5x is arithmetically impossible,
    // not merely unusual.
    reason: 'EXCEEDS_ISSUER_VALUE',
    why: 'single transaction exceeds 5x the issuer market cap - arithmetically impossible',
    where: `EXISTS (SELECT 1 FROM screener_stocks s
                     WHERE s.ticker = insider_trades.ticker
                       AND s.market_cap > 0
                       AND insider_trades.total_value > s.market_cap * 5)`,
  },
  {
    // ⚠️ THE GAP BOTH RULES ABOVE SHARE: THEY NEED EXTERNAL DATA.
    //
    // MARKET_PRICE_MISMATCH needs a candle within +/-10 days; EXCEEDS_ISSUER_VALUE needs a
    // screener_stocks row. A ticker with neither is invisible to both, and that is not a rare
    // corner: measured after the first sweep, the four largest surviving rows were all on tickers
    // absent from screener_stocks, led by MYNZ at $258.83B.
    //
    // This rule needs neither. Within ONE ticker, a filed price fifty times that ticker's own
    // median filed price is a unit or decimal error, because the same security cannot trade at
    // both. Measured: TZUP $225,000 against its own median of $3.70 (60,811x), AREB $202,387
    // against $1.01 (201,280x), GNL $726,946 against $9.38 (77,500x).
    //
    // ⚠️ VERIFIED NOT TO TOUCH LARGE LEGITIMATE FILINGS, which is the risk a blunt size threshold
    // would carry. Genmab's real $7.36B acquisition of Merus (MRUS, 75.8M shares at $97) and Musk's
    // real $7.09B TSLA option exercise both sit at their tickers' normal price levels and are NOT
    // swept — confirmed at 0 rows each before this rule was added.
    //
    // The >=5 priced filings floor is load-bearing: with fewer, a corrupt row can be half the
    // sample and poison the median it is measured against. MYNZ has exactly two priced rows, one
    // of them corrupt, giving a median of $201,000 — so it is correctly excluded here and left for
    // a human rather than judged against a number its own bad row created.
    reason: 'PRICE_INCONSISTENT_WITHIN_TICKER',
    why: 'filed price >50x this ticker own median filed price - unit/decimal error, needs no market data',
    where: `price_per_share > 0 AND EXISTS (
              SELECT 1 FROM insider_trades p
               WHERE p.ticker = insider_trades.ticker AND p.price_per_share > 0
              HAVING count(*) >= 5
                 AND percentile_cont(0.5) WITHIN GROUP (ORDER BY p.price_per_share) > 0
                 AND insider_trades.price_per_share >
                     percentile_cont(0.5) WITHIN GROUP (ORDER BY p.price_per_share) * 50
            )`,
  },
  {
    reason: 'VALUE_INCONSISTENT',
    why: 'stored total_value does not equal shares x price - would corrupt dollar sums',
    where: `abs(total_value - shares * price_per_share) > greatest(1, shares * price_per_share * 1e-6)`,
  },
  {
    reason: 'NEGATIVE_OWNERSHIP',
    why: 'negative post-transaction holding',
    where: `shares_owned_after < 0`,
  },
];

(async () => {
  let sweptTotal = 0, valueRemoved = 0;
  const already = new Set();

  for (const rule of RULES) {
    // Exclude anything an earlier rule already claimed, so counts don't double-count.
    const guard = already.size ? ` AND id NOT IN (${[...already].join(',')})` : '';
    const rows = await sql.query(
      `SELECT * FROM insider_trades WHERE (${rule.where})${guard}`,
    );
    if (!rows.length) { console.log(`${rule.reason.padEnd(24)} 0`); continue; }

    const val = rows.reduce((a, r) => a + (Number(r.total_value) || 0), 0);
    console.log(`${rule.reason.padEnd(24)} ${String(rows.length).padStart(5)} rows   $${(val / 1e9).toFixed(2)}B   ${rule.why}`);
    rows.forEach((r) => already.add(r.id));

    if (!DRY) {
      for (const r of rows) {
        await sql.query(
          `INSERT INTO insider_quarantine (accession, issuer_cik, owner_cik, ticker, filing_date, reason, detail, parsed, raw_url)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT DO NOTHING`,
          [r.accession, r.issuer_cik, r.owner_cik, r.ticker, r.filing_date, rule.reason,
           `swept from insider_trades id=${r.id}: ${rule.why}`, JSON.stringify(r),
           r.filing_url || `https://www.sec.gov/Archives/edgar/data/${r.issuer_cik || ''}`],
        );
      }
      // Delete only after the copy is committed, in id batches.
      const ids = rows.map((r) => r.id);
      for (let i = 0; i < ids.length; i += 500) {
        await sql.query(`DELETE FROM insider_trades WHERE id = ANY($1::bigint[])`, [ids.slice(i, i + 500)]);
      }
    }
    sweptTotal += rows.length; valueRemoved += val;
  }

  console.log(`\n${DRY ? '[dry run] would sweep' : 'swept'} ${sweptTotal} rows  ($${(valueRemoved / 1e9).toFixed(2)}B of phantom value removed from aggregates)`);
  if (!DRY) {
    const r = await sql.query(`SELECT count(*)::int n FROM insider_trades`);
    const q = await sql.query(`SELECT count(*)::int n FROM insider_quarantine`);
    console.log(`insider_trades now ${r[0].n} rows; insider_quarantine holds ${q[0].n}`);
  }
})();
