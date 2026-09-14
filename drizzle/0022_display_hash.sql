-- Dedupe on the headline the TRADER actually sees, not only on the one the source wrote.
--
-- The five existing dedupe layers all run at ingest, against the publisher's wording. That leaves
-- two holes, both of which reached production and both of which a trader reads as the same event
-- printed twice:
--
--   1. MULTILINGUAL WIRE RELEASES. GlobeNewswire and PR Newswire publish one announcement in four
--      languages, each with its own release id and its own slug, so neither the URL layer nor the
--      text layers can see the relationship. Then enrichment translates all four into the SAME
--      English sentence. Live examples: "Pan Global wins bid for Salamón gold project rights in
--      Spain" stood as FOUR canonical events (release ids 3360972/3360973/3360974 in fr/de/en/es),
--      and "Aitech introduces C165 rugged single board computer" as another four.
--
--   2. CONVERGENCE AFTER REWRITING. Two outlets word an event differently enough to miss the 0.60
--      shingle threshold, and Catalyst Pit then rewrites both into identical text. "Sam Altman says
--      OpenAI going public in 2026 would be ill-advised" stood as three canonical events from Yahoo
--      (twice) and TechCrunch.
--
-- display_hash is normHash() of the DISPLAY headline, maintained at ingest and rewritten whenever
-- enrichment changes the headline. Two canonical events that would render the same words inside the
-- 36-hour proximity window now collapse — which is the guarantee the tape needs stated as a fact
-- about the data, not as a filter in React.
--
-- The proximity gate still applies and is what keeps this safe: the Fed publishes "Federal Reserve
-- issues FOMC statement" verbatim eight times a year, and those must stay eight events.
--
-- Nothing is deleted. A folded row keeps its own headline, URL, uid, raw payload and timestamps and
-- is reachable by cluster_id, exactly as every other folded record already is.

BEGIN;

ALTER TABLE primary_events ADD COLUMN IF NOT EXISTS display_hash text;

-- Partial: only canonical rows are ever dedupe candidates, and that is the vast majority of lookups.
CREATE INDEX IF NOT EXISTS idx_primary_events_display_hash
  ON primary_events (display_hash, published_at DESC)
  WHERE cluster_id IS NULL AND display_hash IS NOT NULL;

COMMIT;
