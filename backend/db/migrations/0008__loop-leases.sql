-- Background loops run once per tick across backend tasks (GitHub #133).
--
-- Every backend task runs the same setInterval loops. One row per loop says
-- when its next run is due; a task runs a tick only if it moves next_due
-- forward first (utils/loopLease.ts), so two tasks, or the old and new task
-- of a deploy, can't both run the same tick.
--
--   alpaca-snapshot   server.ts, every 5 minutes
--   vault-pull        services/vaultSync.ts, every 10 minutes
--
-- Additive: a new table, nothing else touched. Rows are created on first claim.

BEGIN;

CREATE TABLE loop_leases (
  name        text PRIMARY KEY,
  next_due    timestamptz NOT NULL,
  claimed_at  timestamptz NOT NULL DEFAULT now()
);

COMMIT;
