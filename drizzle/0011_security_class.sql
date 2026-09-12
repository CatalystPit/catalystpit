-- Position-level security classification, so non-equities cannot contaminate stock rankings.
--
-- Grain is (cusip, class, put_call), which is the level a POSITION is actually described at. The
-- same CUSIP is legitimately common stock for one filer and a call option for another, so a table
-- keyed by CUSIP alone would have to pick one and be wrong for the other.
--
-- Derived only. fund_holdings is never modified, and this is safe to rebuild while the 13F backfill
-- is writing. Anything unresolved stays 'unknown', which keeps a security OUT of the rankings
-- without asserting anything false about it.
BEGIN;

CREATE TABLE IF NOT EXISTS security_position_class (
  cusip       text NOT NULL,
  cls         text NOT NULL DEFAULT '',
  put_call    text NOT NULL DEFAULT '',
  kind        text NOT NULL,        -- common|adr|etf_fund|debt|option|preferred|warrant|unit|right|other|unknown
  source      text NOT NULL,        -- 'put_call' | 'class_text' | 'asset_type' | 'none'
  confidence  text NOT NULL,        -- 'high' (the filing said so) | 'medium' (our own asset type) | 'none'
  rankable    boolean NOT NULL DEFAULT false,
  foreign_cins boolean NOT NULL DEFAULT false,
  evidence    text,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cusip, cls, put_call)
);

CREATE INDEX IF NOT EXISTS idx_secclass_rankable ON security_position_class (rankable);
CREATE INDEX IF NOT EXISTS idx_secclass_kind ON security_position_class (kind);

COMMIT;
