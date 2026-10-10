-- ============================================================================
-- 2026-10-03 — quest reminders (GitHub #91, part of #57)
--
-- One additive column. session_task_reminders (task, offset, due time, sent
-- at) already shipped with 2026-10-01-session-planning.sql, so it isn't
-- repeated here.
--
--   * session_tasks.due_anchor: the session start that due_at was last set
--     against. A quest's due time follows its session's start ("print the
--     handout" due an hour before the night stays an hour before it when the
--     night moves). Comparing due_anchor with game_sessions.date is what makes
--     that shift idempotent: an event delivered twice, or the reminder job and
--     the event both catching the same move, shifts a quest once. NULL means
--     the session had no night yet when the due time was set, so the quest
--     takes the session's start once there is one.
--
-- Backfill: a quest that already has a due time on a dated session is anchored
-- to that session's start. A quest with no due time is left unanchored, so it
-- picks up its session's start (the quests created while the night was still
-- being voted on). A due time the Game Master cleared on purpose looks the
-- same, and would also take the session's start; that's safe here because
-- quests (#90) ship together with this migration, so no such rows exist yet.
-- From now on a deliberate "no due time" is anchored and stays empty.
--
-- Apply BEFORE deploying the code that ships with it: the quest module writes
-- due_anchor.
--
-- Idempotent: safe to re-run.
-- ============================================================================

BEGIN;

ALTER TABLE session_tasks ADD COLUMN IF NOT EXISTS due_anchor timestamptz;

UPDATE session_tasks t
   SET due_anchor = s.date
  FROM game_sessions s
 WHERE s.id = t.session_id
   AND t.due_anchor IS NULL
   AND t.due_at IS NOT NULL
   AND s.date IS NOT NULL;

COMMIT;
