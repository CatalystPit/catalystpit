// TASK 14 — INSIDER / FORM 4 FINAL QA. Measurement only; writes nothing.
//
//   node --env-file=.env.local scripts/audit-insider-qa.mjs
//
// The thirteen launch checks, each answered from the live table. Where only the SEC document can
// settle a question, the accession is named so it can be opened.
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const S = (s) => console.log(`\n${'─'.repeat(74)}\n${s}\n${'─'.repeat(74)}`);
const one = async (q) => (await q)[0];

S('1. BACKFILL STATUS AND COVERAGE');
console.log(await one(sql`SELECT
  count(*)::int rows,
  count(DISTINCT accession)::int filings,
  count(DISTINCT ticker)::int tickers,
  count(DISTINCT owner_cik)::int insiders,
  min(filing_date)::text first_filing, max(filing_date)::text last_filing,
  min(transaction_date)::text first_tx, max(transaction_date)::text last_tx,
  max(inserted_at)::text last_ingest FROM insider_trades`));
console.log('rows by filing year:', await sql`
  SELECT date_part('year', filing_date)::int yr, count(*)::int rows, count(DISTINCT accession)::int filings
    FROM insider_trades GROUP BY 1 ORDER BY 1`);

S('2. FORM 4 PARSING — are the fields populated?');
console.log(await one(sql`SELECT
  count(*)::int rows,
  count(*) FILTER (WHERE transaction_code IS NULL OR transaction_code = '')::int no_code,
  count(*) FILTER (WHERE shares IS NULL)::int no_shares,
  count(*) FILTER (WHERE price_per_share IS NULL)::int no_price,
  count(*) FILTER (WHERE total_value IS NULL)::int no_value,
  count(*) FILTER (WHERE security_title IS NULL OR security_title = '')::int no_security,
  count(*) FILTER (WHERE filing_url IS NULL)::int no_url,
  count(*) FILTER (WHERE issuer_cik IS NULL)::int no_issuer_cik,
  count(*) FILTER (WHERE owner_cik IS NULL)::int no_owner_cik FROM insider_trades`));

S('3. TICKER / COMPANY IDENTITY');
console.log(await one(sql`SELECT
  count(*)::int rows,
  count(*) FILTER (WHERE ticker IS NULL OR ticker = '')::int no_ticker,
  count(*) FILTER (WHERE ticker !~ '^[A-Z][A-Z0-9.-]{0,9}$')::int malformed_ticker,
  count(*) FILTER (WHERE company IS NULL OR company = '')::int no_company FROM insider_trades`));
console.log('malformed ticker strings (a Form 4 symbol field is free text):', await sql`
  SELECT ticker, count(*)::int n, min(company) example FROM insider_trades
   WHERE ticker !~ '^[A-Z][A-Z0-9.-]{0,9}$' GROUP BY 1 ORDER BY 2 DESC LIMIT 10`);
// ⚠️ ONE TICKER MUST MEAN ONE ISSUER. Two issuer CIKs under one ticker is a page showing another
// company's filings.
console.log('tickers carrying more than one issuer CIK:', await sql`
  SELECT ticker, count(DISTINCT issuer_cik)::int ciks, string_agg(DISTINCT company, ' | ') AS companies
    FROM insider_trades WHERE issuer_cik IS NOT NULL
   GROUP BY 1 HAVING count(DISTINCT issuer_cik) > 1 ORDER BY 2 DESC LIMIT 8`);
console.log('issuer CIKs carrying more than one ticker (share classes, or a symbol change):', await sql`
  SELECT issuer_cik, count(DISTINCT ticker)::int tickers, string_agg(DISTINCT ticker, ' ') AS list, min(company) co
    FROM insider_trades WHERE issuer_cik IS NOT NULL
   GROUP BY 1 HAVING count(DISTINCT ticker) > 1 ORDER BY 2 DESC LIMIT 8`);

S('4. INSIDER IDENTITY');
console.log(await one(sql`SELECT
  count(*)::int rows,
  count(*) FILTER (WHERE executive IS NULL OR executive = '')::int no_name,
  count(DISTINCT owner_cik)::int distinct_ciks,
  count(DISTINCT executive)::int distinct_names FROM insider_trades`));
// One CIK is one person; several spellings of their name is normal, several PEOPLE is not.
console.log('owner CIKs with more than 3 name spellings:', await sql`
  SELECT owner_cik, count(DISTINCT executive)::int names, string_agg(DISTINCT executive, ' | ') AS list
    FROM insider_trades WHERE owner_cik IS NOT NULL
   GROUP BY 1 HAVING count(DISTINCT executive) > 3 ORDER BY 2 DESC LIMIT 6`);

S('5. TITLES AND RELATIONSHIPS');
console.log(await one(sql`SELECT
  count(*)::int rows,
  count(*) FILTER (WHERE coalesce(is_officer,false) OR coalesce(is_director,false)
                      OR coalesce(is_ten_pct_owner,false) OR coalesce(is_other_relation,false))::int any_relation,
  count(*) FILTER (WHERE NOT coalesce(is_officer,false) AND NOT coalesce(is_director,false)
                     AND NOT coalesce(is_ten_pct_owner,false) AND NOT coalesce(is_other_relation,false))::int no_relation,
  count(*) FILTER (WHERE coalesce(is_officer,false))::int officers,
  count(*) FILTER (WHERE coalesce(is_director,false))::int directors,
  count(*) FILTER (WHERE coalesce(is_ten_pct_owner,false))::int ten_pct,
  count(*) FILTER (WHERE title IS NULL OR title = '')::int no_title FROM insider_trades`));
console.log('the displayed titles:', await sql`
  SELECT title, count(*)::int n FROM insider_trades GROUP BY 1 ORDER BY 2 DESC LIMIT 10`);

S('6. ⚠️ TRANSACTION CLASSIFICATION — what may call itself a buy or a sell');
// SEC Form 4 Table I/II codes. P and S are the only OPEN-MARKET codes; everything else is a grant,
// an exercise, a conversion, a gift, a tax withholding or another non-market event.
console.log(await sql`
  SELECT transaction_code, action, count(*)::int n, count(DISTINCT ticker)::int tickers,
         count(*) FILTER (WHERE price_per_share > 0)::int priced
    FROM insider_trades GROUP BY 1,2 ORDER BY 3 DESC LIMIT 24`);
console.log('\n⚠️ non-P codes carrying action BUY, or non-S codes carrying action SELL:', await one(sql`
  SELECT count(*) FILTER (WHERE action = 'BUY'  AND transaction_code <> 'P')::int buy_not_p,
         count(*) FILTER (WHERE action = 'SELL' AND transaction_code <> 'S')::int sell_not_s,
         count(*) FILTER (WHERE transaction_code = 'P' AND action <> 'BUY')::int p_not_buy,
         count(*) FILTER (WHERE transaction_code = 'S' AND action <> 'SELL')::int s_not_sell
    FROM insider_trades`));
console.log('derivative vs non-derivative by code:', await sql`
  SELECT transaction_code, count(*) FILTER (WHERE coalesce(is_derivative,false))::int derivative,
         count(*) FILTER (WHERE NOT coalesce(is_derivative,false))::int common
    FROM insider_trades GROUP BY 1 ORDER BY 2 + 3 DESC LIMIT 10`);

S('7+8+9. SHARES, PRICE, VALUE');
console.log(await one(sql`SELECT
  count(*)::int rows,
  count(*) FILTER (WHERE shares < 0)::int negative_shares,
  count(*) FILTER (WHERE price_per_share < 0)::int negative_price,
  count(*) FILTER (WHERE total_value < 0)::int negative_value,
  count(*) FILTER (WHERE shares = 0)::int zero_shares,
  count(*) FILTER (WHERE price_per_share = 0)::int zero_price,
  count(*) FILTER (WHERE total_value = 0)::int zero_value FROM insider_trades`));
// ⚠️ total_value MUST BE shares × price. A second multiplication or a stale value is invisible
// otherwise.
console.log('⚠️ rows where total_value <> shares * price (tolerance 1%):', await one(sql`
  SELECT count(*)::int mismatched FROM insider_trades
   WHERE shares > 0 AND price_per_share > 0 AND total_value > 0
     AND abs(total_value - shares * price_per_share) > 0.01 * (shares * price_per_share)`));
console.log('   ...against the population that can be checked:', await one(sql`
  SELECT count(*)::int checkable FROM insider_trades WHERE shares > 0 AND price_per_share > 0 AND total_value > 0`));
console.log('implausible prices (a per-share price far outside any equity):', await sql`
  SELECT ticker, executive, transaction_code, shares, price_per_share, total_value, filing_date::text, accession
    FROM insider_trades WHERE price_per_share > 100000 ORDER BY price_per_share DESC LIMIT 5`);

S('10+11+12. FILING IDENTITY, DUPLICATES, AMENDMENTS');
console.log(await one(sql`SELECT
  count(*)::int rows,
  count(DISTINCT accession)::int accessions,
  count(*) FILTER (WHERE accession IS NULL OR accession = '')::int no_accession,
  count(*) FILTER (WHERE accession !~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$')::int malformed_accession,
  count(*) FILTER (WHERE coalesce(is_amendment,false))::int amendment_rows,
  count(DISTINCT accession) FILTER (WHERE coalesce(is_amendment,false))::int amendment_filings,
  count(*) FILTER (WHERE superseded_by IS NOT NULL)::int superseded_rows FROM insider_trades`));
// The insert's conflict target is the full transaction shape; a duplicate means it did not hold.
console.log('⚠️ duplicate transaction rows on the conflict key:', await one(sql`
  SELECT count(*)::int duplicate_groups FROM (
    SELECT accession, transaction_date, transaction_code, security_title, shares, price_per_share, shares_owned_after
      FROM insider_trades GROUP BY 1,2,3,4,5,6,7 HAVING count(*) > 1) t`));
console.log('one accession must belong to one issuer and one owner:', await one(sql`
  SELECT count(*)::int accessions_multi_issuer FROM (
    SELECT accession FROM insider_trades WHERE issuer_cik IS NOT NULL
     GROUP BY 1 HAVING count(DISTINCT issuer_cik) > 1) t`));
console.log('amendment lineage:', await sql`
  SELECT amend_link_basis, count(DISTINCT accession)::int filings FROM insider_trades
   WHERE coalesce(is_amendment,false) GROUP BY 1 ORDER BY 2 DESC`);

S('13. HEATMAP INPUTS');
console.log(await one(sql`SELECT
  (SELECT count(*)::int FROM insider_trades WHERE transaction_code = 'P' AND NOT coalesce(is_derivative,false)
     AND superseded_by IS NULL AND total_value > 0) open_market_buys,
  (SELECT count(*)::int FROM insider_trades WHERE transaction_code = 'S' AND NOT coalesce(is_derivative,false)
     AND superseded_by IS NULL AND total_value > 0) open_market_sells,
  (SELECT count(*)::int FROM insider_trades WHERE transaction_code NOT IN ('P','S')
     AND superseded_by IS NULL) non_market`));

S('CHRONOLOGY');
console.log(await one(sql`SELECT
  count(*) FILTER (WHERE transaction_date > filing_date)::int traded_after_filed,
  count(*) FILTER (WHERE filing_date > current_date)::int future_filing,
  count(*) FILTER (WHERE transaction_date > current_date)::int future_transaction,
  count(*) FILTER (WHERE filing_date - transaction_date > 365)::int filed_over_a_year_late
  FROM insider_trades`));

S('SPOT-CHECK SAMPLE — a cross-section for manual SEC comparison');
console.log(await sql`
  SELECT ticker, executive, left(title,22) title, transaction_code code, action,
         transaction_date::text tx, filing_date::text filed, shares, price_per_share px,
         round(total_value::numeric,0) val, accession
    FROM insider_trades
   WHERE superseded_by IS NULL AND shares > 0
     AND transaction_code IN ('P','S','A','M','F','G','C')
   ORDER BY random() LIMIT 12`);
