-- Calendar events get an owner (GitHub #238). GET /api/events returned every
-- event to every signed-in account, and the ones "prepare session" made carry
-- the session's agenda (the GM's Prep notes) in their description. From this
-- release an event is its creator's: non-admins list and read only their own,
-- and rows made before it (owner_id NULL) are left to admins.
--
-- Numbered 0009, not 0008: dev already has 0008__loop-leases.sql (#133).
--
-- The running code never reads owner_id, so the column can land first. The
-- UPDATE drops the agenda copied into those old events' descriptions; the
-- session row keeps it. Re-running either statement changes nothing.

BEGIN;

ALTER TABLE events ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES accounts(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS events_owner_id_idx ON events (owner_id);

UPDATE events e SET description = NULL
  FROM game_sessions s
 WHERE e.title = 'Tabletop Session: ' || s.title
   AND e.description = s.agenda;

COMMIT;
