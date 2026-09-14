-- Canonical security identity for institutional aggregates.
--
-- 13F filers write the ticker field freely, so one security arrives under several spellings: a
-- share-class slash ("BRK/B"), an SEC footnote asterisk that leaked into the symbol ("EA*"), or an
-- identifier that is not an exchange symbol at all ("EXMOC" for Exxon Mobil). Those spellings have
-- no candle history, so the price join drops them and the security's real row understates its
-- institutional ownership — Exxon's heatmap row was built from 22% of the funds that hold it.
--
-- This table maps a dirty symbol to the canonical one. It is applied at READ TIME in the aggregate
-- build; fund_holdings and fund_filings keep exactly what the filer reported, so the mapping is
-- reversible and the raw SEC record is never rewritten.
--
-- EVERY row is evidenced, not guessed:
--   * cusip        the security identifier both spellings share
--   * implied vs close  median (value/shares) from the dirty symbol equals the canonical ticker's
--                  quarter-end close to the cent (ratio 1.000 for all nine rows)
--   * issuer       the filer-supplied issuer strings name the same company
--
-- NOTE on EA: the CUSIP-alias heuristic proposed EA* -> XESP, which would have been wrong. XESP is
-- itself a dirty symbol for the same CUSIP, and its three candle rows price it at $0.01-$0.06
-- against Electronic Arts' actual $205.04. Both EA* and XESP therefore fold into EA, which is the
-- real exchange symbol and carries 725 candles.

BEGIN;

CREATE TABLE IF NOT EXISTS ticker_canonical (
  raw_ticker       text PRIMARY KEY,
  canonical_ticker text NOT NULL,
  cusip            text NOT NULL,
  evidence         text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticker_canonical_canon ON ticker_canonical (canonical_ticker);

INSERT INTO ticker_canonical (raw_ticker, canonical_ticker, cusip, evidence) VALUES
  ('BRK/B',  'BRK.B', '084670702', 'share-class slash; CUSIP 084670702 Berkshire Hathaway Cl B; implied $500.39 = BRK.B close $500.39'),
  ('BRK/A',  'BRK.A', '084670108', 'share-class slash; CUSIP 084670108 Berkshire Hathaway Cl A; implied $748850 = BRK.A close $748850'),
  ('HEI/A',  'HEI.A', '422806208', 'share-class slash; CUSIP 422806208 Heico Cl A; implied $257.91 = HEI.A close $257.91'),
  ('EXMOC',  'XOM',   '30231G102', 'non-exchange identifier; CUSIP 30231G102 Exxon Mobil, issuer string "XOM"; implied $136.72 = XOM close $136.72'),
  ('EA*',    'EA',    '285512109', 'SEC footnote asterisk in symbol; CUSIP 285512109 Electronic Arts; implied $205.04 = EA close $205.04'),
  ('XESP',   'EA',    '285512109', 'non-exchange identifier for the same CUSIP 285512109 Electronic Arts; implied $205.04 = EA close $205.04; XESP own candles price $0.01-$0.06 and are not this security'),
  ('HONGBP', 'HON',   '438516106', 'non-exchange identifier; CUSIP 438516106 Honeywell International; implied $223.90 = HON close $223.90'),
  ('AZNN',   'AZN',   '046353108', 'non-exchange identifier; CUSIP 046353108 AstraZeneca sponsored ADR; implied $189.62 = AZN close $189.62'),
  ('HA7',    'NVRI',  '415864107', 'foreign listing code; CUSIP 415864107 Enviri Corp; implied $21.95 = NVRI close $21.95')
ON CONFLICT (raw_ticker) DO UPDATE
  SET canonical_ticker = excluded.canonical_ticker,
      cusip            = excluded.cusip,
      evidence         = excluded.evidence;

COMMIT;
