-- Agentic OS: each run records its usage and what started it (#137, spec #135).
--
-- Usage is what Claude Code reports for the run (its JSON result): the
-- API-equivalent cost in USD (subscription runs aren't billed; it's a
-- yardstick), input tokens (uncached + cache reads + cache writes), output
-- tokens, and the `claude -p` call's duration. The runner sends it on
-- POST /api/runner/runs/:id/complete; services/agentRuns.ts drops any field
-- that isn't a sane number. NULL means unknown, never zero.
--
-- `trigger` is what started the run: the RUN button on /admin/briefs, the
-- Task Scheduler (`scheduled`), or a hand-run wrapper (`manual`). Only button
-- runs go through the queue; the other two are recorded after they finish.
--
-- Additive: four nullable columns and one with a constant default. Existing
-- rows become button runs with no usage, and a runner that sends no usage
-- keeps working.

BEGIN;

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS cost_usd      numeric CHECK (cost_usd >= 0),
  ADD COLUMN IF NOT EXISTS input_tokens  bigint  CHECK (input_tokens >= 0),
  ADD COLUMN IF NOT EXISTS output_tokens bigint  CHECK (output_tokens >= 0),
  ADD COLUMN IF NOT EXISTS duration_ms   integer CHECK (duration_ms >= 0),
  ADD COLUMN IF NOT EXISTS trigger       text NOT NULL DEFAULT 'button'
    CHECK (trigger IN ('button','scheduled','manual'));

COMMIT;
