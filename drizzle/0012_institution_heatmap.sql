-- Precomputed quarter-over-quarter institutional position changes, one row per ticker.
--
-- The live query joins two 1.3M-row quarters and takes seconds, so the page reads this instead.
-- Rebuilt by scripts/build-institution-heatmap.mjs, which applies every integrity guard we built:
-- rankable common/ADR only, per-filer value scale, row plausibility against market price, and funds
-- present in BOTH quarters. Rebuilding is how new backfill data reaches the page.
BEGIN;

CREATE TABLE IF NOT EXISTS institution_heatmap (
  quarter       date NOT NULL,
  prev_quarter  date NOT NULL,
  ticker        text NOT NULL,
  sector        text,                       -- NULL means unclassified; never guessed
  issuer        text,
  cur_shares    double precision NOT NULL,
  prev_shares   double precision NOT NULL,
  delta_shares  double precision NOT NULL,
  pct_change    double precision,           -- NULL when there was no prior position to compare
  cur_value     double precision NOT NULL,  -- scale-normalised, drives tile size
  funds         integer NOT NULL,
  is_new        boolean NOT NULL DEFAULT false,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (quarter, ticker)
);

CREATE INDEX IF NOT EXISTS idx_inst_heatmap_sector ON institution_heatmap (quarter, sector);
CREATE INDEX IF NOT EXISTS idx_inst_heatmap_value ON institution_heatmap (quarter, cur_value DESC);

-- What the aggregate had to leave out, so the UI can state its own coverage honestly rather than
-- implying the picture is complete.
CREATE TABLE IF NOT EXISTS institution_heatmap_meta (
  quarter            date PRIMARY KEY,
  prev_quarter       date NOT NULL,
  tickers            integer NOT NULL,
  sectored_tickers   integer NOT NULL,
  covered_value      double precision NOT NULL,
  excluded_value     double precision NOT NULL,   -- rankable but dropped by a guard
  unclassified_value double precision NOT NULL,   -- in the map, but with no sector
  funds_both         integer NOT NULL,
  funds_current      integer NOT NULL,
  computed_at        timestamptz NOT NULL DEFAULT now()
);

COMMIT;
