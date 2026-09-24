-- Phase 3 (#35), slice 6a: enqueue Salesforce write-backs from `accounts`.
-- Plan §2.6 (field ownership) and §2.7 (outbox).
--
-- This replaces the setImmediate postSave hooks that pushed to Salesforce from
-- inside the signup request — no retries, a half-created person whenever
-- Salesforce was unreachable, and nothing visible when it failed. Now a write to
-- a pushable column leaves a row here, and the nightly drain works through them
-- with backoff and a visible 'failed' state.
--
-- WHAT IS PUSHABLE (§2.6). Only five columns ever travel to Salesforce:
--   email                          app-owned: Neon wins, a change pushes to SF
--   name, first_name, last_name,   shared: last writer wins
--   phone
-- Everything else is either app-only (password, handle, friends, discord_*,
-- profile_picture, favorite_games, is_active, tokens, app_role, account_tier —
-- Salesforce never sees them) or Salesforce-owned (company, industry, website,
-- address, lead_status, sf_profile, sf_record_type_* — the app never writes them
-- back). A column not in the list below cannot enqueue anything.
--
-- WHAT THE PAYLOAD HOLDS. {"fields": ["email", "phone", ...]} — the NAMES of the
-- changed columns, not their values. Plan §2.7 sketches a value snapshot in
-- Salesforce API names; this deliberately differs:
--   * the drain is nightly, so a snapshot taken at 10am would push a value the
--     person changed again at 4pm. The worker reads current values at drain time.
--   * the API-name mapping is per object (a Lead has FirstName/LastName/Company,
--     an Account just Name), which belongs in testable TypeScript, not SQL.
--
-- ONE PENDING ROW PER PERSON. A person who edits their profile five times before
-- the drain gets one row whose field list is the union. That keeps the queue
-- proportional to people rather than keystrokes, and it is what lets the merge
-- ask a precise question — "has the app got an unsent change to THIS field?" —
-- when it decides whether Salesforce's value may overwrite the app's.
--
-- TWO THINGS NEVER ENQUEUE:
--   * sf_object = 'User'. sf_users is pull-only in both directions (§2.6):
--     creating a Salesforce User needs a Platform Event and a spare licence, and
--     the org has neither. A push could only fail.
--   * anything written while app.sync_in_progress = 'on'. The nightly merge and
--     the drain's own sf_id write-back set it with SET LOCAL; without the guard,
--     writing Salesforce's values into accounts would queue them straight back
--     to Salesforce. SET LOCAL is transaction-scoped, so it is safe behind the
--     PgBouncer pooler in dev's DATABASE_URL.
--
-- Requires the 2026-09-09 remap and schema-additions migrations.

BEGIN;

-- At most one PENDING row per person, so enqueues can coalesce with ON CONFLICT.
-- An in-flight row is deliberately outside it: a change made while a push is
-- running gets a fresh pending row and goes out on the next drain.
CREATE UNIQUE INDEX IF NOT EXISTS ux_person_outbox_one_pending
  ON person_outbox (account_id) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION enqueue_person_outbox() RETURNS trigger AS $$
DECLARE
  changed text[] := ARRAY[]::text[];
  new_op  text;
BEGIN
  -- Salesforce's own values arriving through the merge, or the drain writing an
  -- sf_id back. Re-queueing either would be a loop.
  IF coalesce(current_setting('app.sync_in_progress', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  -- Pull-only. Never create, never update.
  IF NEW.sf_object = 'User' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Only app-native people are created in Salesforce, and only as Leads
    -- (§2.8). A row that arrives with an sf_id already exists there.
    IF NEW.sf_id IS NOT NULL OR NEW.sf_object IS DISTINCT FROM 'Lead' THEN
      RETURN NEW;
    END IF;
    changed := ARRAY['email', 'first_name', 'last_name', 'name', 'phone'];
    new_op := 'create';
  ELSE
    IF NEW.email      IS DISTINCT FROM OLD.email      THEN changed := changed || 'email'::text;      END IF;
    IF NEW.first_name IS DISTINCT FROM OLD.first_name THEN changed := changed || 'first_name'::text; END IF;
    IF NEW.last_name  IS DISTINCT FROM OLD.last_name  THEN changed := changed || 'last_name'::text;  END IF;
    IF NEW.name       IS DISTINCT FROM OLD.name       THEN changed := changed || 'name'::text;       END IF;
    IF NEW.phone      IS DISTINCT FROM OLD.phone      THEN changed := changed || 'phone'::text;      END IF;
    IF cardinality(changed) = 0 THEN
      RETURN NEW;
    END IF;

    IF NEW.sf_id IS NULL THEN
      -- Not in Salesforce yet. Contacts and Accounts are update-only (§2.6), so
      -- a non-Lead with no sf_id has nowhere to go; do not queue a push that
      -- can only fail. For a Lead, this folds into its pending create.
      IF NEW.sf_object IS DISTINCT FROM 'Lead' THEN
        RETURN NEW;
      END IF;
      new_op := 'create';
    ELSE
      new_op := 'update';
    END IF;
  END IF;

  INSERT INTO person_outbox (account_id, op, payload)
  VALUES (NEW.id, new_op, jsonb_build_object('fields', to_jsonb(changed)))
  ON CONFLICT (account_id) WHERE status = 'pending'
  DO UPDATE SET
    -- A pending create stays a create: the person is still not in Salesforce.
    op = CASE WHEN person_outbox.op = 'create' OR EXCLUDED.op = 'create'
              THEN 'create' ELSE 'update' END,
    payload = jsonb_build_object('fields', (
      SELECT to_jsonb(array_agg(f ORDER BY f))
        FROM (SELECT jsonb_array_elements_text(person_outbox.payload -> 'fields') AS f
              UNION
              SELECT jsonb_array_elements_text(EXCLUDED.payload -> 'fields')) merged));

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_accounts_outbox ON accounts;

-- UPDATE OF limits invocation to statements that target a pushable column, so a
-- friend request, a login or a profile-picture change never even calls the
-- function. The IS DISTINCT FROM checks inside handle "targeted but unchanged".
CREATE TRIGGER trg_accounts_outbox
  AFTER INSERT OR UPDATE OF email, name, first_name, last_name, phone ON accounts
  FOR EACH ROW EXECUTE FUNCTION enqueue_person_outbox();

COMMENT ON COLUMN person_outbox.payload IS
  '{"fields": [...]}: names of changed pushable columns. The drain reads current values.';

COMMIT;
