-- Event-level trusted-source evidence.
--
-- THE BUG. Facebook qualification was decided by which copy of a story happened to arrive FIRST.
-- insertEvents queues Facebook only for a trusted source's own row and only when that row is
-- canonical, so when Walter Bloomberg reported a story another wire had already filed seconds
-- earlier, his copy folded into the existing canonical event and the trusted-source path vanished
-- with it. The Standard Chartered Fed story was lost exactly that way.
--
-- Trust is a property of the EVENT, not of whichever copy arrived first, so it is recorded on the
-- canonical row:
--   trusted_source    the first trusted source observed anywhere in the event's cluster
--   trusted_seen_at   when that evidence arrived (may be after the event was created)
--
-- Additive and nullable: existing code ignores both columns.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE primary_events ADD COLUMN IF NOT EXISTS trusted_source  text;
ALTER TABLE primary_events ADD COLUMN IF NOT EXISTS trusted_seen_at timestamptz;

-- The Facebook trusted-evidence scan: canonical events carrying trust evidence, newest first.
CREATE INDEX IF NOT EXISTS idx_primary_events_trusted_evidence
  ON primary_events (trusted_seen_at DESC)
  WHERE cluster_id IS NULL AND trusted_source IS NOT NULL;

-- Backfill is deliberately PROSPECTIVE for publishing: the column is filled in for existing clusters
-- so provenance reads correctly, but the scan only considers evidence seen inside its freshness
-- window, so nothing historical can post now.
UPDATE primary_events c
   SET trusted_source = m.source,
       trusted_seen_at = COALESCE(c.trusted_seen_at, m.received_at)
  FROM (
    SELECT DISTINCT ON (head) head, source, received_at
      FROM (
        SELECT seq AS head, source, received_at FROM primary_events WHERE cluster_id IS NULL
        UNION ALL
        SELECT cluster_id AS head, source, received_at FROM primary_events WHERE cluster_id IS NOT NULL
      ) s
     WHERE source = 'WALTERBLOOMBERG'
     ORDER BY head, received_at ASC
  ) m
 WHERE c.seq = m.head
   AND c.cluster_id IS NULL
   AND c.trusted_source IS NULL;

COMMIT;
