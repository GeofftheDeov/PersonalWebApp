-- Unified accounts, Phases 4 and 5 (#36, #37; plan §4.1–§4.6).
--
--   1. campaign_members.is_active / deactivated_at / deactivated_by: a GM can
--      take a player out of one campaign without deleting anything (§4.5,
--      #31). Reactivating is the one boolean back.
--   2. accounts.paperclip_user_id / paperclip_role: the person's Paperclip
--      identity (§4.6, #29). Access to /api/paperclip follows it.
--   3. Attendance (§4.4, #32): the GM confirms who came, pre-filled from the
--      ready check. game_sessions records that it was taken (so "nobody came"
--      differs from "not taken yet"), and player_sessions gets the uniqueness
--      and the account FK the upsert and the Phase 3 refactor allow.
--
-- Additive. The code running before this release reads none of the new
-- columns; every new campaign_members column defaults to "active".

BEGIN;

-- 1. Per-campaign deactivation
ALTER TABLE campaign_members
  ADD COLUMN IF NOT EXISTS is_active      boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz,
  ADD COLUMN IF NOT EXISTS deactivated_by uuid REFERENCES accounts(id) ON DELETE SET NULL;

-- 2. Paperclip identity link
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS paperclip_user_id text,
  ADD COLUMN IF NOT EXISTS paperclip_role    text;
CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_paperclip_user
  ON accounts (paperclip_user_id) WHERE paperclip_user_id IS NOT NULL;

-- 3. Attendance
ALTER TABLE game_sessions
  ADD COLUMN IF NOT EXISTS attendance_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS attendance_confirmed_by uuid REFERENCES accounts(id) ON DELETE SET NULL;

-- A person attends a session once. Rows synced from Salesforce could repeat
-- one; keep the earliest of each pair before the unique index goes on.
DELETE FROM player_sessions p
 USING player_sessions q
 WHERE p.session_id = q.session_id AND p.player_id = q.player_id
   AND (p.created_at, p.id) > (q.created_at, q.id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_player_sessions_session_player
  ON player_sessions (session_id, player_id);
CREATE INDEX IF NOT EXISTS idx_player_sessions_player ON player_sessions (player_id);

-- player_id has pointed at accounts since Phase 3 remapped it. NOT VALID: new
-- rows are checked from now on, without failing the deploy on an old row the
-- remap may have missed.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'player_sessions_player_id_fkey') THEN
    ALTER TABLE player_sessions
      ADD CONSTRAINT player_sessions_player_id_fkey
      FOREIGN KEY (player_id) REFERENCES accounts(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;

COMMIT;
