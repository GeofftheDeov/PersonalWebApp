-- Phase 3 (#35), slice 2: additive schema for the cutover. Plan §3.5.
--
-- Everything here is invisible to the running app: new columns nothing reads
-- yet, and foreign keys that only tighten constraints already satisfied by the
-- slice-1 remap. The old campaign_members columns stay until the cutover has
-- soaked; dropping them is its own migration.
--
-- Requires 2026-09-09-phase3-remap-person-refs.sql to have run first. The FK
-- additions below are what make that ordering load-bearing: a single stale id
-- in friend_requests would fail this migration rather than the app.

BEGIN;

-- ── campaign_members: one person column instead of four ─────────────────────
-- Membership always points at a real account (plan §3.5); the "no account yet"
-- state moves to campaign_invites.to_email below.
ALTER TABLE campaign_members
  ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES accounts(id) ON DELETE CASCADE;

-- Backfill 1: rows carrying a landing-table id. After slice 1 those ids may be
-- either a winner (already an accounts.id) or a merged-away source row, so go
-- through account_source_links, which covers both.
UPDATE campaign_members m
   SET person_id = COALESCE(a.id, l.account_id)
  FROM (SELECT id, COALESCE(lead_id, contact_id, account_id) AS src
          FROM campaign_members
         WHERE person_id IS NULL
           AND COALESCE(lead_id, contact_id, account_id) IS NOT NULL) pick
  LEFT JOIN accounts a ON a.id = pick.src
  LEFT JOIN account_source_links l ON l.source_id = pick.src
 WHERE m.id = pick.id
   AND COALESCE(a.id, l.account_id) IS NOT NULL;

-- Backfill 2: the email-only rows. campaignRoutes' `else` branch writes these
-- whenever the campaign creator is a User -- it sets `email` and no person
-- column at all -- which is why the Game Master of a campaign can be exactly
-- the row this backfill has the least to work with. #27 counted zero of these
-- on dev, but the code path that makes them is still live until slice 4.
UPDATE campaign_members m
   SET person_id = a.id
  FROM accounts a
 WHERE m.person_id IS NULL
   AND m.email IS NOT NULL
   AND a.email = m.email::citext;

CREATE INDEX IF NOT EXISTS idx_campaign_members_person
  ON campaign_members (person_id);

-- ── campaign_invites: invites hold the pre-account state ────────────────────
ALTER TABLE campaign_invites RENAME COLUMN from_user TO from_account_id;
ALTER TABLE campaign_invites RENAME COLUMN to_user   TO to_account_id;

ALTER TABLE campaign_invites
  ALTER COLUMN to_account_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS to_email citext;

ALTER TABLE campaign_invites
  ADD CONSTRAINT campaign_invites_from_fk
    FOREIGN KEY (from_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  ADD CONSTRAINT campaign_invites_to_fk
    FOREIGN KEY (to_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  ADD CONSTRAINT campaign_invites_target
    CHECK (to_account_id IS NOT NULL OR to_email IS NOT NULL);

-- Registration binds pending email invites to the new account (slice 4).
CREATE INDEX IF NOT EXISTS idx_campaign_invites_email
  ON campaign_invites (to_email) WHERE to_account_id IS NULL AND status = 'pending';

-- ── friend_requests: real foreign keys ──────────────────────────────────────
-- These were dropped in #42 because a person could live in any of four tables
-- and no FK could name them all. One table, so the constraint comes back.
ALTER TABLE friend_requests
  ADD CONSTRAINT friend_requests_from_fk
    FOREIGN KEY (from_user) REFERENCES accounts(id) ON DELETE CASCADE,
  ADD CONSTRAINT friend_requests_to_fk
    FOREIGN KEY (to_user) REFERENCES accounts(id) ON DELETE CASCADE;

-- notifications, characters, player_sessions and messages stay FK-less for now:
-- the remap made them consistent, but adding constraints there was not part of
-- the agreed slice. Revisit once the cutover has soaked.

-- ── staff-only integrations: sf_users -> accounts ───────────────────────────
-- The two deliberate sf_users FKs. Their owner genuinely is a Salesforce User,
-- but after the cutover that person is an account like everyone else.
-- Defensive remap first: on dev the single sf_users row won its group, so its
-- id already IS an accounts.id and this rewrites nothing. It would matter if an
-- sf_users row ever lost a merge.
UPDATE api_key_vault v SET user_id = l.account_id
  FROM account_source_links l
 WHERE l.source_id = v.user_id
   AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = v.user_id);
UPDATE cloud_claw_sessions s SET user_id = l.account_id
  FROM account_source_links l
 WHERE l.source_id = s.user_id
   AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = s.user_id);

ALTER TABLE api_key_vault DROP CONSTRAINT IF EXISTS api_key_vault_user_id_fkey;
ALTER TABLE api_key_vault
  ADD CONSTRAINT api_key_vault_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE;

ALTER TABLE cloud_claw_sessions DROP CONSTRAINT IF EXISTS cloud_claw_sessions_user_id_fkey;
ALTER TABLE cloud_claw_sessions
  ADD CONSTRAINT cloud_claw_sessions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE;

-- ── assert, loudly ──────────────────────────────────────────────────────────
DO $$
DECLARE n int; detail text;
BEGIN
  SELECT count(*) INTO n FROM campaign_members WHERE person_id IS NULL;
  IF n > 0 THEN
    SELECT string_agg(format('id=%s campaign=%s email=%s status=%s',
                             id, campaign_id, coalesce(email,'-'), coalesce(status,'-')), '; ')
      INTO detail FROM campaign_members WHERE person_id IS NULL;
    RAISE EXCEPTION 'phase3: % campaign_members row(s) resolve to no account -> %', n, detail;
  END IF;

  -- Two membership rows for one person in one campaign is a real ambiguity --
  -- which status wins, Game Master or Player? That is a decision for a human,
  -- so surface it rather than picking one here.
  SELECT count(*) INTO n FROM (
    SELECT campaign_id, person_id FROM campaign_members
     GROUP BY 1,2 HAVING count(*) > 1) d;
  IF n > 0 THEN
    SELECT string_agg(format('campaign=%s person=%s rows=%s', campaign_id, person_id, c), '; ')
      INTO detail
      FROM (SELECT campaign_id, person_id, count(*) AS c FROM campaign_members
             GROUP BY 1,2 HAVING count(*) > 1) d;
    RAISE EXCEPTION 'phase3: % duplicate campaign membership(s) after backfill -> %', n, detail;
  END IF;
END $$;

COMMIT;
