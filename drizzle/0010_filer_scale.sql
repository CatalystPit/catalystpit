-- Per-filer value-scale detection for 13F holdings.
--
-- 13F filers disagree about units. Most report `value` in whole dollars, but a minority still
-- report THOUSANDS, the pre-2023 convention. Measured on 2026-06-30: of 2,498 funds with 20 or more
-- priced positions, 131 (5.2 percent) have a median implied price one thousandth of the real one.
-- That is 22,959 positions in a single quarter, and it is enough to wreck any aggregate built on
-- value, portfolio weight, or a share sum that filters on value.
--
-- This table records a VERDICT about each filing. It never modifies fund_holdings: the SEC-reported
-- numbers stay exactly as filed, and consumers multiply by scale_factor at read time. Anything we
-- cannot determine confidently is left null and must be treated as unknown, not as 1.
--
-- Written by scripts/detect-filer-scale.mjs, which is safe to re-run while the 13F backfill is
-- writing: it only reads fund_holdings and upserts here.

BEGIN;

CREATE TABLE IF NOT EXISTS fund_filing_scale (
  cik           text NOT NULL,
  quarter       date NOT NULL,
  scale_factor  double precision,     -- multiply `value` by this to get dollars. NULL = undetermined
  method        text NOT NULL,        -- 'dollars' | 'thousands' | 'inflated' | 'indeterminate' | 'insufficient_sample'
  confidence    text NOT NULL,        -- 'high' | 'none'
  median_ratio  double precision,     -- median of (value/shares) / market close at quarter end
  sample_size   integer NOT NULL DEFAULT 0,
  iqr_ratio     double precision,     -- spread of the sample; a wide spread means the median is not a unit signal
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cik, quarter)
);

CREATE INDEX IF NOT EXISTS idx_filer_scale_method ON fund_filing_scale (method);

COMMIT;
