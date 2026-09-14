-- Story continuity for the X account.
--
-- Pit Wire and the X account have different jobs. Pit Wire is a complete tape, and a developing
-- story legitimately produces many canonical events there — the Saudi pipeline attack produced 35
-- publishable ones in six days. The X account is a public brand, and posting 35 variations of one
-- story would read as broken. This is X-ONLY state: canonical dedupe is untouched and still sees
-- every one of those events.
--
--   story_key   the story a post belongs to, assigned by the X story guard
--   post_facts  the verified figures already published for that story, so a follow-up can be
--               required to carry something materially new rather than a rewording
--
-- Persisted rather than held in memory because the guard has to survive deployments and separate
-- cron invocations: a serverless function that forgets what it posted is a function that repeats.

BEGIN;

ALTER TABLE x_post_candidates ADD COLUMN IF NOT EXISTS story_key  text;
ALTER TABLE x_post_candidates ADD COLUMN IF NOT EXISTS post_facts text;

CREATE INDEX IF NOT EXISTS idx_x_candidates_story
  ON x_post_candidates (story_key, created_at DESC)
  WHERE story_key IS NOT NULL AND status IN ('dry_run', 'pending', 'posted');

COMMIT;
