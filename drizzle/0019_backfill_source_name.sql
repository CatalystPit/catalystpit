-- Backfill source_name on the agency rows that predate the column.
--
-- 0017 set source_name for SEC and NASDAQ but left the agency rows null, so those events carried
-- their source CODE with no display name. The requirement is that every row preserves the original
-- source name for traceability, so this fills them from the same values the registry now emits.
-- Display names only — no headline, URL, timestamp or raw payload is touched.

BEGIN;

UPDATE primary_events SET source_name = CASE source
    WHEN 'FED' THEN 'Federal Reserve'
    WHEN 'FDA' THEN 'FDA'
    WHEN 'FTC' THEN 'FTC'
    WHEN 'DOJ' THEN 'Justice Department'
    WHEN 'EIA' THEN 'EIA'
    ELSE source
  END
 WHERE source_name IS NULL;

COMMIT;
