-- At most one queued-or-running run per skill (#172).
--
-- enqueueRun used to SELECT for an active run and then INSERT, so two requests
-- that raced (a RUN button press and a confirmed proposal, or two backend
-- tasks) could both pass the check and queue the same skill twice. This index
-- makes the database the judge: services/agentRuns.ts inserts with
-- ON CONFLICT DO NOTHING and returns the run that won.
--
-- A race before this migration may already have left two active runs of one
-- skill, which would stop the index from building. Keep one per skill (a
-- running run over a queued one, then the oldest, which is the one the runner
-- would claim first) and fail the rest.

BEGIN;

UPDATE agent_runs r
   SET status = 'failed', finished_at = now(),
       summary = 'duplicate of run ' || keep.id || ', removed by migration 0002'
  FROM (SELECT DISTINCT ON (skill) id, skill
          FROM agent_runs
         WHERE status IN ('queued','running')
         ORDER BY skill, (status = 'running') DESC, requested_at, id) keep
 WHERE r.skill = keep.skill
   AND r.id <> keep.id
   AND r.status IN ('queued','running');

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_one_active
  ON agent_runs (skill) WHERE status IN ('queued','running');

COMMIT;
