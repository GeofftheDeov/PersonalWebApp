-- Alpaca snapshots for every wallet, not just Cloud-Claw's.
--
-- The 5-minute snapshot loop used to record only the Cloud-Claw paper account
-- (the server's ALPACA_API_KEY env keys), so the dashboard's position chart was
-- empty for the admin's own paper and live wallets (keys from the Profile page
-- vault). Each row now says which wallet it is, and for the vault wallets whose
-- keys it was taken with.
--
-- Additive: existing rows are all Cloud-Claw snapshots and take the default.
-- Apply BEFORE deploying the code that writes these columns; until then the
-- loop's inserts fail (logged, not fatal) and the chart's query errors.

BEGIN;

ALTER TABLE alpaca_snapshots
  ADD COLUMN IF NOT EXISTS wallet text NOT NULL DEFAULT 'cloudclaw'
    CHECK (wallet IN ('cloudclaw', 'paper', 'live')),
  -- Owner of the vault keys; NULL for cloudclaw, whose keys belong to the server.
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES accounts(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_alpaca_snapshots_wallet_ts
  ON alpaca_snapshots (wallet, user_id, ts);

COMMIT;
