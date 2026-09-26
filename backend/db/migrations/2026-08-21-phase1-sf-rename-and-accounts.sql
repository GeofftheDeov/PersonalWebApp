-- ============================================================================
-- 2026-08-21 — Unified account model, Phase 1 (DDL only)
--
-- GitHub #33 · Paperclip MUR-319 · map MUR-314 · plan UNIFIED_ACCOUNT_PLAN.md
--   §2.1 rename, §2.2 accounts, §2.3 account_source_links, §2.7 person_outbox
--
-- Pure DDL. No rows move. Reversible — see the rollback block at the bottom.
--
-- APPLIED: Neon dev branch br-lucky-mud-ajmpdx8u, 2026-08-21. 22 statements,
-- all successful. Prod still runs personal-web-app-task-definition:79 with the
-- mongo:5.0 sidecar; the prod cutover has to land before any of this reaches
-- prod.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------- extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- friend typeahead (Phase 4)
CREATE EXTENSION IF NOT EXISTS citext;    -- case-insensitive email; kills the
                                          -- ^email$ /i regex seq-scan in login

-- ------------------------------------------------------------------- rename
-- Postgres tracks FKs, indexes and triggers by OID, so every inbound FK follows
-- its table automatically:
--   sf_contacts.account_id      -> sf_accounts(id)   [wanted: SF Contact -> Account]
--   opportunities.account_id    -> sf_accounts(id)   [wanted: SF Opportunity -> Account]
--   campaign_members.*          -> sf_leads / sf_contacts / sf_accounts   [rewritten in Phase 3]
--   campaign_invites.from_user/to_user  -> sf_users(id)                   [rewritten in Phase 3]
--   api_key_vault.user_id, cloud_claw_sessions.user_id -> sf_users(id)    [rewritten in Phase 3]
ALTER TABLE users    RENAME TO sf_users;
ALTER TABLE leads    RENAME TO sf_leads;
ALTER TABLE contacts RENAME TO sf_contacts;
ALTER TABLE accounts RENAME TO sf_accounts;

-- Constraint and index names do NOT follow a table rename, and index names are
-- unique per schema. The renamed table keeps `accounts_pkey`, which collides
-- with the primary key of the new `accounts` table created below — CREATE TABLE
-- accounts fails without this block. Rename every auto-named constraint and
-- index on the four tables to its sf_* form.
DO $$
DECLARE
  m record;
  r record;
  newname text;
BEGIN
  FOR m IN
    SELECT * FROM (VALUES
      ('users','sf_users'), ('leads','sf_leads'),
      ('contacts','sf_contacts'), ('accounts','sf_accounts')
    ) AS v(oldname, newtable)
  LOOP
    -- constraints (PK / FK / UNIQUE / CHECK); renames the backing index too
    FOR r IN
      SELECT conname FROM pg_constraint
      WHERE conrelid = m.newtable::regclass
        AND conname LIKE m.oldname || '\_%'
    LOOP
      newname := m.newtable || substring(r.conname from length(m.oldname) + 1);
      EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
                     m.newtable, r.conname, newname);
    END LOOP;

    -- plain indexes that do not back a constraint
    FOR r IN
      SELECT c.relname FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE i.indrelid = m.newtable::regclass
        AND c.relname LIKE m.oldname || '\_%'
        AND NOT EXISTS (SELECT 1 FROM pg_constraint pc WHERE pc.conindid = c.oid)
    LOOP
      newname := m.newtable || substring(r.relname from length(m.oldname) + 1);
      EXECUTE format('ALTER INDEX %I RENAME TO %I', r.relname, newname);
    END LOOP;
  END LOOP;
END $$;

ALTER TRIGGER trg_users_updated ON sf_users RENAME TO trg_sf_users_updated;

-- ------------------------------------------------------- the accounts table
-- §2.2. No DEFAULT gen_random_uuid(): ids are supplied by the Phase 2 merge,
-- where the winning source row donates its UUID (map decision, revised
-- 2026-08-15). A missing id is a Phase 2 bug and should fail loudly.
CREATE TABLE accounts (
  id                        uuid PRIMARY KEY,

  -- ---- auth (app-owned) ----
  email                     citext,
  password                  text,
  is_verified               boolean NOT NULL DEFAULT false,
  email_verification_token  text,
  reset_password_token      text,
  reset_password_expires    timestamptz,

  -- app authorization -- NOT the Salesforce profile below
  app_role                  text NOT NULL DEFAULT 'user'
                              CHECK (app_role IN ('user','admin')),
  app_role_source           text NOT NULL DEFAULT 'sf'
                              CHECK (app_role_source IN ('sf','manual')),

  -- ---- identity / display (app-owned) ----
  name                      text,
  first_name                text,
  last_name                 text,
  handle                    text,
  user_number               text,
  user_digit                text,
  profile_picture           text,
  favorite_games            text[] NOT NULL DEFAULT '{}',
  discord_id                text,
  discord_handle            text,
  friends                   uuid[] NOT NULL DEFAULT '{}',
  is_active                 boolean NOT NULL DEFAULT true,

  -- ---- CRM (Salesforce-owned) ----
  phone                     text,
  company                   text,
  industry                  text,
  website                   text,
  address                   text,
  lead_status               text,
  sf_profile                text,   -- SF User.Profile.Name verbatim, read-only mirror

  -- ---- provenance ----
  sf_object                 text CHECK (sf_object IN ('Lead','Contact','Account','User')),
  sf_id                     text,
  sf_record_type_id         text,
  sf_record_type_name       text,
  sf_last_synced_at         timestamptz,
  sf_last_pushed_at         timestamptz,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_accounts_updated BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX ux_accounts_email  ON accounts (email)                      WHERE email IS NOT NULL;
CREATE UNIQUE INDEX ux_accounts_sf     ON accounts (sf_object, sf_id)           WHERE sf_id IS NOT NULL;
CREATE UNIQUE INDEX ux_accounts_handle ON accounts (lower(handle), user_number) WHERE handle IS NOT NULL;

CREATE INDEX idx_accounts_handle_trgm ON accounts USING gin (lower(handle) gin_trgm_ops);
CREATE INDEX idx_accounts_name_trgm   ON accounts USING gin (
  lower(coalesce(name, first_name || ' ' || last_name)) gin_trgm_ops
);

-- ------------------------------------------------------------ source links
-- §2.3. Keeps legacy ids resolvable forever: accounts.id = $1, else
-- account_source_links.account_id WHERE source_id = $1.
CREATE TABLE account_source_links (
  source_table text NOT NULL
    CHECK (source_table IN ('sf_users','sf_leads','sf_contacts','sf_accounts')),
  source_id    uuid NOT NULL,
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sf_object    text,
  sf_id        text,
  is_primary   boolean NOT NULL DEFAULT false,   -- true = this row donated its UUID
  linked_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_table, source_id)
);
CREATE INDEX idx_asl_account       ON account_source_links (account_id);
CREATE UNIQUE INDEX ux_asl_primary ON account_source_links (account_id) WHERE is_primary;

-- ----------------------------------------------------------------- outbox
-- §2.7. Table lands now so Phase 2 can be written against it. The enqueue
-- trigger and the BullMQ drain arrive in Phase 3. Poll, don't LISTEN — the dev
-- DATABASE_URL is a PgBouncer pooler and LISTEN/NOTIFY is session-scoped.
CREATE TABLE person_outbox (
  id           bigserial PRIMARY KEY,
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  op           text NOT NULL CHECK (op IN ('create','update')),
  payload      jsonb NOT NULL,        -- changed app/shared fields only, SF API names
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','in_flight','done','failed')),
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX idx_person_outbox_pending ON person_outbox (created_at)
  WHERE status = 'pending';

COMMIT;

-- ============================================================================
-- Rollback (no data has moved, so this is complete):
--
-- BEGIN;
--   DROP TABLE IF EXISTS person_outbox;
--   DROP TABLE IF EXISTS account_source_links;
--   DROP TABLE IF EXISTS accounts;
--   ALTER TRIGGER trg_sf_users_updated ON sf_users RENAME TO trg_users_updated;
--   ALTER TABLE sf_accounts RENAME TO accounts;
--   ALTER TABLE sf_contacts RENAME TO contacts;
--   ALTER TABLE sf_leads    RENAME TO leads;
--   ALTER TABLE sf_users    RENAME TO users;
--   -- then re-run the DO block above with the pairs reversed to restore the
--   -- constraint and index names.
-- COMMIT;
-- ============================================================================
