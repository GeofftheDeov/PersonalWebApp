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

ALTER TABLE friend_requests DROP CONSTRAINT IF EXISTS friend_requests_from_user_fkey;
ALTER TABLE friend_requests DROP CONSTRAINT IF EXISTS friend_requests_to_user_fkey;
ALTER TABLE notifications   DROP CONSTRAINT IF EXISTS notifications_user_id_fkey;
ALTER TABLE characters      DROP CONSTRAINT IF EXISTS characters_player_id_fkey;
ALTER TABLE player_sessions DROP CONSTRAINT IF EXISTS player_sessions_player_id_fkey;
