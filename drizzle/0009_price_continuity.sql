-- Price-series continuity, so no surface computes a return across a break in the history.
--
-- Three causes were found live in ticker_daily_candles: a symbol retired and reassigned to a new
-- company (FIG closes at 23.83 as one security and opens at 115.50 as Figma), a reverse split not
-- applied consistently (LAZR steps 0.1884 -> 50.60 in one session, rendering a congressional trade
-- as +23,169.6 percent), and sub-penny quotes whose daily oscillation is granularity rather than
-- movement. None of this is fixable by adjusting prices, and guessing an adjustment would be
-- inventing data. The only honest response is to refuse the calculation and say so.
--
-- Written by scripts/scan-price-breaks.mjs. Detection lives in src/lib/price-continuity.mjs.

BEGIN;

-- One row per break. Kept for transparency: every refusal can be traced to a dated event with the
-- numbers that identified it, rather than to an opaque flag.
CREATE TABLE IF NOT EXISTS ticker_price_breaks (
  ticker       text NOT NULL,
  break_date   date NOT NULL,          -- first bar of the NEW segment
  kind         text NOT NULL,          -- 'level_shift' | 'listing_gap'
  ratio        double precision,       -- sustained level change across the step
  anomaly      double precision,       -- step size in units of this security's own 95th-pct daily move
  before_level double precision,
  after_level  double precision,
  gap_days     integer,
  PRIMARY KEY (ticker, break_date)
);

-- One row per scanned ticker. `last_break` is the whole rule at query time: a return anchored on or
-- before it spans a break and must not be shown; one anchored after it sits inside the current
-- segment and is safe. `usable = false` rejects the series as a whole.
CREATE TABLE IF NOT EXISTS ticker_price_quality (
  ticker      text PRIMARY KEY,
  usable      boolean NOT NULL DEFAULT true,
  reason      text,                    -- null | 'sub_penny' | 'too_many_breaks'
  last_break  date,
  break_count integer NOT NULL DEFAULT 0,
  bars        integer,
  level       double precision,        -- median close over the last year, for the sub-penny test
  scanned_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_quality_break ON ticker_price_quality (last_break);

COMMIT;
