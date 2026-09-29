// TASK 13 — POLITICIAN / CONGRESS FINAL QA. Measurement only; writes nothing.
//
//   node --env-file=.env.local scripts/audit-congress-qa.mjs
//
// Each section is one of the thirteen launch checks. Numbers come from the live table; where only the
// source disclosure can settle a question, the House/Senate filing is named so it can be opened.
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const S = (s) => console.log(`\n${'─'.repeat(74)}\n${s}\n${'─'.repeat(74)}`);
const one = async (q) => (await q)[0];

S('1. DATA LOADS — population and freshness');
console.log(await one(sql`SELECT
  count(*)::int rows,
  count(DISTINCT member_slug)::int members,
  count(DISTINCT ticker)::int tickers,
  min(transaction_date)::text first_tx, max(transaction_date)::text last_tx,
  min(disclosure_date)::text first_disc, max(disclosure_date)::text last_disc,
  max(inserted_at)::text last_ingest FROM congress_trades`));
console.log('by chamber:', await sql`SELECT chamber, count(*)::int n FROM congress_trades GROUP BY 1 ORDER BY 2 DESC`);

S('2. POLITICIAN IDENTITY MAPPING');
console.log(await one(sql`SELECT
  count(*)::int rows,
  count(*) FILTER (WHERE member_slug IS NULL)::int unresolved_member,
  count(*) FILTER (WHERE representative IS NULL OR representative = '')::int no_display_name,
  count(*) FILTER (WHERE party IS NULL)::int no_party,
  count(*) FILTER (WHERE state IS NULL)::int no_state,
  count(DISTINCT member_slug)::int distinct_slugs FROM congress_trades`));
// ⚠️ ONE SLUG MUST MEAN ONE PERSON. Two display names under one slug is a collision that would put
// another member's trades on a politician's page.
console.log('slugs carrying more than one display name:', await sql`
  SELECT member_slug, count(DISTINCT representative)::int names, string_agg(DISTINCT representative, ' | ') AS list
    FROM congress_trades WHERE member_slug IS NOT NULL
   GROUP BY 1 HAVING count(DISTINCT representative) > 1 ORDER BY 2 DESC LIMIT 8`);
// And the reverse: one person under two slugs splits their history across two pages.
console.log('display names carrying more than one slug:', await sql`
  SELECT representative, count(DISTINCT member_slug)::int slugs, string_agg(DISTINCT member_slug, ' | ') AS list
    FROM congress_trades WHERE member_slug IS NOT NULL AND representative IS NOT NULL
   GROUP BY 1 HAVING count(DISTINCT member_slug) > 1 ORDER BY 2 DESC LIMIT 8`);
console.log('party values in use:', await sql`SELECT party, count(*)::int n FROM congress_trades GROUP BY 1 ORDER BY 2 DESC`);

S('3. SECURITY / TICKER IDENTITY');
console.log(await one(sql`SELECT
  count(*)::int rows,
  count(*) FILTER (WHERE ticker IS NULL)::int no_ticker,
  count(*) FILTER (WHERE ticker IS NOT NULL)::int with_ticker,
  count(*) FILTER (WHERE ticker IS NOT NULL AND ticker !~ '^[A-Z][A-Z0-9.-]{0,9}$')::int malformed_ticker
  FROM congress_trades`));
console.log('malformed ticker strings:', await sql`
  SELECT ticker, count(*)::int n, min(asset_description) AS example FROM congress_trades
   WHERE ticker IS NOT NULL AND ticker !~ '^[A-Z][A-Z0-9.-]{0,9}$' GROUP BY 1 ORDER BY 2 DESC LIMIT 10`);
// ⚠️ A TICKER WE CANNOT CORROBORATE is a wrong association waiting to happen. Checked against the
// symbol universe we hold data for rather than against a shape test.
console.log('tickers not present in any first-party table:', await sql`
  SELECT c.ticker, count(*)::int n, min(c.asset_description) example
    FROM congress_trades c
   WHERE c.ticker IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM screener_stocks s WHERE s.ticker = c.ticker)
     AND NOT EXISTS (SELECT 1 FROM ticker_daily_candles d WHERE d.ticker = c.ticker)
     AND NOT EXISTS (SELECT 1 FROM security_identity i WHERE i.ticker = c.ticker)
   GROUP BY 1 ORDER BY 2 DESC LIMIT 12`);

S('4+5. DO TRANSACTIONS BELONG TO THE RIGHT PERSON AND SECURITY?');
// ⚠️ THE ASSET DESCRIPTION IS THE SOURCE'S OWN WORDS. If a row's ticker disagrees with the company
// named in its description, the association is wrong. Compared against the issuer name we hold.
console.log('rows whose ticker maps to a company the description never mentions:', await one(sql`
  WITH j AS (
    SELECT c.ticker, c.asset_description,
           coalesce(s.company, i.name) AS company
      FROM congress_trades c
      LEFT JOIN screener_stocks s ON s.ticker = c.ticker
      LEFT JOIN security_identity i ON i.ticker = c.ticker
     WHERE c.ticker IS NOT NULL AND c.asset_description IS NOT NULL)
  SELECT count(*)::int checked,
         count(*) FILTER (WHERE company IS NOT NULL
           AND position(lower(split_part(regexp_replace(company, '[^A-Za-z ]', '', 'g'), ' ', 1)) in lower(asset_description)) = 0
         )::int first_word_absent
    FROM j WHERE company IS NOT NULL`));
console.log('examples where the company first word is absent from the description:', await sql`
  SELECT c.ticker, coalesce(s.company, i.name) company, c.asset_description, count(*)::int n
    FROM congress_trades c
    LEFT JOIN screener_stocks s ON s.ticker = c.ticker
    LEFT JOIN security_identity i ON i.ticker = c.ticker
   WHERE c.ticker IS NOT NULL AND c.asset_description IS NOT NULL
     AND coalesce(s.company, i.name) IS NOT NULL
     AND position(lower(split_part(regexp_replace(coalesce(s.company, i.name), '[^A-Za-z ]', '', 'g'), ' ', 1)) in lower(c.asset_description)) = 0
   GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 12`);

S('6. THE TWO CLOCKS — transaction date vs disclosure date');
console.log(await one(sql`SELECT
  count(*)::int rows,
  count(*) FILTER (WHERE transaction_date IS NULL)::int no_tx_date,
  count(*) FILTER (WHERE disclosure_date IS NULL)::int no_disclosure_date,
  count(*) FILTER (WHERE transaction_date > disclosure_date)::int disclosed_before_traded,
  count(*) FILTER (WHERE transaction_date > current_date)::int future_tx,
  count(*) FILTER (WHERE disclosure_date > current_date)::int future_disclosure,
  count(*) FILTER (WHERE filing_lag_days IS NULL)::int no_lag,
  count(*) FILTER (WHERE filing_lag_days < 0)::int negative_lag,
  round(avg(filing_lag_days)::numeric,1) avg_lag,
  max(filing_lag_days)::int max_lag FROM congress_trades`));
console.log('⚠️ filing_lag_days must equal disclosure - transaction:', await one(sql`
  SELECT count(*)::int mismatched FROM congress_trades
   WHERE transaction_date IS NOT NULL AND filing_lag_days IS NOT NULL
     AND filing_lag_days <> (disclosure_date - transaction_date)`));

S('7. BUY / SELL / EXCHANGE CLASSIFICATION');
console.log(await sql`SELECT action, count(*)::int n FROM congress_trades GROUP BY 1 ORDER BY 2 DESC`);
console.log('raw source type → normalized action (a disagreement is a misclassification):', await sql`
  SELECT type, action, count(*)::int n FROM congress_trades GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20`);

S('8. AMOUNT RANGES AND VALUES');
console.log(await one(sql`SELECT
  count(*)::int rows,
  count(*) FILTER (WHERE amount_range IS NULL OR amount_range = '')::int no_range,
  count(*) FILTER (WHERE amount_min IS NULL)::int no_min,
  count(*) FILTER (WHERE amount_mid IS NULL)::int no_mid,
  count(*) FILTER (WHERE amount_min < 0 OR amount_max < 0 OR amount_mid < 0)::int negative,
  count(*) FILTER (WHERE amount_max IS NOT NULL AND amount_min > amount_max)::int min_above_max,
  count(*) FILTER (WHERE amount_max IS NOT NULL AND (amount_mid < amount_min OR amount_mid > amount_max))::int mid_outside_range,
  count(*) FILTER (WHERE amount_max IS NULL)::int open_ended
  FROM congress_trades`));
console.log('the ranges in use, with their parsed bounds:', await sql`
  SELECT amount_range, count(*)::int n, min(amount_min) lo, max(amount_max) hi, min(amount_mid) mid
    FROM congress_trades GROUP BY 1 ORDER BY 2 DESC LIMIT 14`);

S('9+10. DUPLICATES AND AMENDMENTS');
console.log(await one(sql`SELECT
  count(*)::int rows,
  count(DISTINCT tx_hash)::int distinct_hashes,
  count(*) - count(DISTINCT tx_hash) AS duplicate_hash_rows FROM congress_trades`));
// ⚠️ THE DEDUP KEY IS A SYNTHETIC HASH. If two rows agree on every published field but differ in the
// hash, the hash is not covering what a reader sees and the page shows the same trade twice.
console.log('same member+ticker+dates+range+owner appearing more than once:', await one(sql`
  SELECT count(*)::int duplicate_groups FROM (
    SELECT member_slug, ticker, transaction_date, disclosure_date, amount_range, action, owner, asset_description
      FROM congress_trades GROUP BY 1,2,3,4,5,6,7,8 HAVING count(*) > 1) t`));
console.log('worst examples:', await sql`
  SELECT representative, ticker, transaction_date::text tx, disclosure_date::text disc, amount_range, action, count(*)::int n
    FROM congress_trades GROUP BY 1,2,3,4,5,6 HAVING count(*) > 1 ORDER BY 7 DESC LIMIT 8`);

S('11. GARBAGE TICKER ASSOCIATIONS');
// Non-equity assets must not carry an equity ticker.
console.log(await sql`
  SELECT asset_type, count(*)::int n, count(*) FILTER (WHERE ticker IS NOT NULL)::int with_ticker
    FROM congress_trades GROUP BY 1 ORDER BY 2 DESC LIMIT 14`);

S('12. SURFACES — do the pages have what they need?');
console.log('members with at least one trade and a slug (the /politicians/[slug] universe):', await one(sql`
  SELECT count(DISTINCT member_slug)::int pages FROM congress_trades WHERE member_slug IS NOT NULL`));
console.log('roster coverage:', await one(sql`SELECT
  (SELECT count(*)::int FROM congress_members) roster_rows,
  (SELECT count(DISTINCT member_slug)::int FROM congress_trades WHERE member_slug IS NOT NULL) slugs_in_trades,
  (SELECT count(*)::int FROM congress_trades c WHERE c.member_slug IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM congress_members m WHERE m.slug = c.member_slug)) trades_with_no_roster_row`));
console.log('\ntop members by row count (for spot-checking):', await sql`
  SELECT representative, member_slug, chamber, party, state, count(*)::int n, max(disclosure_date)::text latest
    FROM congress_trades GROUP BY 1,2,3,4,5 ORDER BY 6 DESC LIMIT 8`);
