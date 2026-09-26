-- 2026-08-14 — drop foreign keys that assume every "person" is a User.
--
-- PersonalWebApp treats User, Lead, Contact and Account as interchangeable
-- people (see backend/utils/personUtils.ts: findPersonById / modelForType).
-- Mongo never enforced the reference, so cross-type friend requests, bell
-- notifications and characters all worked. The Postgres port added FKs to
-- users(id) / accounts(id), which made those flows fail at runtime for any
-- signed-in person who is not a User:
--
--   insert or update on table "friend_requests" violates foreign key
--   constraint "friend_requests_from_user_fkey"
--
-- Symptoms: friend requests could not be sent or accepted; the recipient's
-- bell notification silently failed (notify() swallows its errors); character
-- creation only worked when the player happened to be an Account.
--
-- Existence of the referenced person is enforced in the data layer, which
-- already resolves ids across all four tables. Trade-off: deleting a person no
-- longer cascades these rows, so they must be cleaned up by the application.
--
-- ---------------------------------------------------------------------------
-- History (GitHub #42): this was authored on 2026-08-14 and run by hand
-- against the Neon dev branch, but the commit never left the laptop, so the
-- repo — and therefore any database built from schema.sql, including the Neon
-- production branch — never got it. Re-authored here so the promotion has a
-- record to run. It is a no-op against dev (DROP ... IF EXISTS).
--
-- Order relative to the Phase 1 rename does not matter. These constraints live
-- on friend_requests / notifications / characters / player_sessions, none of
-- which Phase 1 renames, and Phase 1's constraint-rename block only touches
-- constraints whose conrelid is one of the four sf_* tables. The names below
-- are correct before and after it. Run this one first anyway, per #42, so the
-- fix that unblocks friend requests lands before the larger migration.
--
-- campaign_invites is included, reversing the original note on e71113ae. That
-- note said the invite flow was "User-only in code", so widening the schema
-- would only move the failure. It was describing the bug, not the design:
-- anyone can be invited to a campaign whatever table they live in (Geoff,
-- 2026-08-22). campaign_members has been polymorphic all along (lead_id /
-- contact_id / account_id), getAuthorizedCampaignIds already matches on any of
-- them, and the invite picker offers your friends list — which is a polymorphic
-- uuid[]. inviteRoutes.ts was the sole holdout and is fixed alongside this.
--
-- api_key_vault.user_id and cloud_claw_sessions.user_id keep their FKs to
-- sf_users. Those are not person references in the polymorphic sense — they are
-- staff-only integrations (the key vault, the Cloud Claw console) whose owner
-- genuinely is a Salesforce User. Phase 3 (#35) repoints them at accounts(id).
-- ---------------------------------------------------------------------------

ALTER TABLE friend_requests   DROP CONSTRAINT IF EXISTS friend_requests_from_user_fkey;
ALTER TABLE friend_requests   DROP CONSTRAINT IF EXISTS friend_requests_to_user_fkey;
ALTER TABLE notifications     DROP CONSTRAINT IF EXISTS notifications_user_id_fkey;
ALTER TABLE characters        DROP CONSTRAINT IF EXISTS characters_player_id_fkey;
ALTER TABLE player_sessions   DROP CONSTRAINT IF EXISTS player_sessions_player_id_fkey;
ALTER TABLE campaign_invites  DROP CONSTRAINT IF EXISTS campaign_invites_from_user_fkey;
ALTER TABLE campaign_invites  DROP CONSTRAINT IF EXISTS campaign_invites_to_user_fkey;
