-- Agentic OS, slice 2: the skill-run queue behind the /admin/briefs run buttons.
--
-- Heavy skills run on Geoff's PC on the Claude subscription, not in this
-- container. The admin page enqueues a row; scripts/runner.ps1 in the Obsidian
-- vault polls POST /api/runner/claim over HTTPS (Redis is VPC-only), runs the
-- skill locally and reports back to POST /api/runner/runs/:id/complete. The
-- output itself reaches the app through the vault (Obsidian Git -> GitHub ->
-- the vault pull loop), so this table records only what ran and how it ended.
--
-- `skill` is free text here on purpose: the allowlists live in code, on both
-- ends — services/agentRuns.ts decides what may be enqueued, and the runner
-- decides what it will execute, so a row can never make the PC run anything
-- the runner doesn't already know.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_runs (
  id            bigserial PRIMARY KEY,
  skill         text NOT NULL,
  status        text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','succeeded','failed')),
  requested_by  text,          -- accounts.id of the admin who pressed the button
  requested_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at    timestamptz,
  finished_at   timestamptz,
  runner        text,          -- which machine claimed it (COMPUTERNAME)
  summary       text,          -- one line from the runner, e.g. brief status
  output_path   text           -- vault-relative, e.g. outputs/briefs/2026-09-26.md
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_queued
  ON agent_runs (requested_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_agent_runs_recent
  ON agent_runs (requested_at DESC);

COMMIT;
