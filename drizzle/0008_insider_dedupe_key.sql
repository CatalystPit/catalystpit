-- 0008_insider_dedupe_key.sql
-- Closes a duplicate hole in uq_insider_txn.
--
-- The unique index includes shares_owned_after, which is NULL whenever a filer
-- footnotes their post-transaction holding. Postgres treats NULLs as DISTINCT in a
-- unique index by default, so those rows never conflicted and the every-minute cron
-- re-inserted them on each pass — 22 groups / 43 extra rows had already accumulated
-- (one STEL transaction stored 12 times). ON CONFLICT could not help, because the
-- conflict never fired.
--
-- PG15+ gives us NULLS NOT DISTINCT, which makes the key behave the way the original
-- index intended. Deduplicate first, then rebuild the index.
--
-- Apply: node --env-file=.env.local scripts/apply-sql.mjs drizzle/0008_insider_dedupe_key.sql

BEGIN;

-- 1. Drop exact duplicates, keeping the earliest id in each group.
--    Partition over the FULL key, including shares_owned_after: any nullable column in
--    the key opens the same hole, and transaction_code / security_title / transaction_date
--    are nullable too (12 rows carry a null code). PARTITION BY groups NULLs together,
--    which is exactly the NULLS NOT DISTINCT semantics we are about to enforce.
WITH dupes AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY accession, transaction_date, transaction_code,
                        security_title, shares, price_per_share, shares_owned_after
           ORDER BY id
         ) AS rn
  FROM insider_trades
)
DELETE FROM insider_trades t
USING dupes d
WHERE t.id = d.id AND d.rn > 1;

-- 2. Rebuild the key so NULL == NULL for uniqueness purposes.
DROP INDEX IF EXISTS uq_insider_txn;
CREATE UNIQUE INDEX uq_insider_txn ON insider_trades
  USING btree (accession, transaction_date, transaction_code, security_title,
               shares, price_per_share, shares_owned_after)
  NULLS NOT DISTINCT;

COMMIT;
