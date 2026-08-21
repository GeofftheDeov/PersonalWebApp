-- ============================================================
-- PersonalWebApp — PostgreSQL schema (MongoDB → Postgres migration)
-- Target: Neon (PostgreSQL 15+). Apply with: psql $DATABASE_URL -f schema.sql
-- Conventions:
--   * uuid PKs via gen_random_uuid() (built-in, PG13+)
--   * snake_case columns; timestamptz everywhere
--   * mongoose enums -> CHECK constraints (easier to evolve than SQL enums)
--   * document-shaped payloads -> jsonb
-- ============================================================

-- ---------- extensions ----------
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- friend typeahead (Phase 4)
CREATE EXTENSION IF NOT EXISTS citext;    -- case-insensitive email

-- ---------- shared trigger for updated_at ----------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Salesforce landing tables (sf_users / sf_accounts / sf_contacts / sf_leads)
--
-- Phase 1 of the unified account model (GitHub #33, Paperclip MUR-319) renamed
-- these from users/accounts/contacts/leads. They are now LANDING tables: the
-- nightly Salesforce pull writes into them and nothing else does. The app reads
-- and writes the single `accounts` table further down.
--
-- Salesforce's own relationships stay pointed here on purpose:
--   sf_contacts.account_id      -> sf_accounts(id)   (SF Contact -> Account)
--   opportunities.account_id    -> sf_accounts(id)   (SF Opportunity -> Account)
-- The app-facing references still pointing at landing tables
-- (campaign_members.*, campaign_invites.*, api_key_vault.user_id,
-- cloud_claw_sessions.user_id) are rewritten to accounts(id) in Phase 3.
-- ============================================================

CREATE TABLE sf_users (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text,
  email                     text,
  phone                     text,
  handle                    text,
  password                  text NOT NULL,
  reset_password_token      text,
  reset_password_expires    timestamptz,
  is_verified               boolean NOT NULL DEFAULT false,
  email_verification_token  text,
  role                      text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  user_number               text,
  user_digit                text,
  sf_id                     text,
  discord_id                text,
  discord_handle            text,
  profile_picture           text,
  favorite_games            text[] NOT NULL DEFAULT '{}',
  friends                   uuid[] NOT NULL DEFAULT '{}',
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_sf_users_updated BEFORE UPDATE ON sf_users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sf_accounts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text NOT NULL,
  email                     text,
  password                  text,
  reset_password_token      text,
  reset_password_expires    timestamptz,
  is_verified               boolean NOT NULL DEFAULT false,
  email_verification_token  text,
  industry                  text,
  company                   text,
  website                   text,
  handle                    text,
  phone                     text,
  address                   text,
  user_number               text,
  user_digit                text,
  sf_id                     text,
  sf_record_type_id         text,
  sf_record_type_name       text,
  profile_picture           text,
  favorite_games            text[] NOT NULL DEFAULT '{}',
  friends                   uuid[] NOT NULL DEFAULT '{}',
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sf_contacts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text NOT NULL,
  email                     text,
  password                  text,
  is_verified               boolean NOT NULL DEFAULT false,
  email_verification_token  text,
  reset_password_token      text,
  reset_password_expires    timestamptz,
  phone                     text,
  handle                    text,
  role                      text,
  account_id                uuid REFERENCES sf_accounts(id) ON DELETE SET NULL,
  user_number               text,
  user_digit                text,
  notes                     text,
  sf_id                     text,
  profile_picture           text,
  favorite_games            text[] NOT NULL DEFAULT '{}',
  friends                   uuid[] NOT NULL DEFAULT '{}',
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sf_leads (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name                text NOT NULL,
  last_name                 text NOT NULL,
  email                     text,
  password                  text NOT NULL,
  reset_password_token      text,
  reset_password_expires    timestamptz,
  is_verified               boolean NOT NULL DEFAULT false,
  email_verification_token  text,
  company                   text,
  handle                    text,
  phone                     text,
  status                    text NOT NULL DEFAULT 'New'
                              CHECK (status IN ('New','Contacted','Qualified','Lost','Converted')),
  source                    text NOT NULL DEFAULT 'Web App',
  user_number               text,
  user_digit                text,
  sf_lead_id                text,
  sf_record_type_id         text,
  sf_record_type_name       text,
  profile_picture           text,
  favorite_games            text[] NOT NULL DEFAULT '{}',
  friends                   uuid[] NOT NULL DEFAULT '{}',
  created_at                timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Unified account model — the app's single person table
-- Phase 1 (GitHub #33 / Paperclip MUR-319), plan UNIFIED_ACCOUNT_PLAN.md
-- §2.2 accounts, §2.3 account_source_links, §2.7 person_outbox.
-- Empty until the Phase 2 backfill (GitHub #34) merges the landing tables in.
-- ============================================================

-- NOTE: no DEFAULT gen_random_uuid() on id. Ids are supplied by the Phase 2
-- merge, where the winning source row donates its UUID so existing references
-- to that row need no remap. A missing id is a Phase 2 bug and should fail
-- loudly rather than silently mint an unreferenced person.
CREATE TABLE accounts (
  id                        uuid PRIMARY KEY,

  -- ---- auth (app-owned) ----
  email                     citext,
  password                  text,
  is_verified               boolean NOT NULL DEFAULT false,
  email_verification_token  text,
  reset_password_token      text,
  reset_password_expires    timestamptz,

  -- Two axes, deliberately two columns (GitHub #28):
  --   app_role     -- CAN YOU DO IT. Gates the admin portal and
  --                   getAuthorizedCampaignIds. Derived from sf_profile
  --                   through sf_profile_role_map, User-sourced rows only.
  --   account_tier -- WHAT HAVE YOU PAID FOR. Gates supporter-only surface.
  --                   Derived from sf_object through sf_object_tier_map.
  -- Collapsing them would repeat the bug #28 was opened to fix: a tier change
  -- could then move somebody's admin access.
  app_role                  text NOT NULL DEFAULT 'user'
                              CHECK (app_role IN ('user','admin')),
  app_role_source           text NOT NULL DEFAULT 'sf'
                              CHECK (app_role_source IN ('sf','manual')),
  account_tier              text NOT NULL DEFAULT 'free'
                              CHECK (account_tier IN ('free','member','patron')),
  account_tier_source       text NOT NULL DEFAULT 'sf'
                              CHECK (account_tier_source IN ('sf','manual')),

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

-- typeahead: prefix + fuzzy on handle, and on name for the friend search
CREATE INDEX idx_accounts_handle_trgm ON accounts USING gin (lower(handle) gin_trgm_ops);
CREATE INDEX idx_accounts_name_trgm   ON accounts USING gin (
  lower(coalesce(name, first_name || ' ' || last_name)) gin_trgm_ops
);

-- Keeps legacy ids resolvable forever: accounts.id = $1, else
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

-- Salesforce write-back queue. The enqueue trigger on accounts and the BullMQ
-- drain arrive in Phase 3; the table lands now so Phase 2 can target it.
-- Poll, don't LISTEN -- the dev DATABASE_URL is a PgBouncer pooler and
-- LISTEN/NOTIFY is session-scoped.
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

-- ---------- the two source maps (GitHub #28 / Paperclip MUR-321) ----------

-- Salesforce Profile -> app_role. A table, not an inline string comparison:
-- SF admins add Profiles and this will grow. Anything NOT listed here resolves
-- to 'user' -- default deny, so a new Profile appearing in the org can never
-- grant admin by accident. Profile exists only on the Salesforce User object,
-- so this map can only ever affect User-sourced accounts.
CREATE TABLE sf_profile_role_map (
  sf_profile text PRIMARY KEY,
  app_role   text NOT NULL CHECK (app_role IN ('user','admin')),
  note       text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_sf_profile_role_map_updated BEFORE UPDATE ON sf_profile_role_map
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO sf_profile_role_map (sf_profile, app_role, note) VALUES
  ('System Administrator', 'admin', 'The only Profile in the org with an assigned User (board, 2026-08-21).');

-- sObject -> account_tier. Also a table rather than a constant: the tier policy
-- is expected to move as the paid tiers develop, and that should be an UPDATE
-- rather than a deploy.
CREATE TABLE sf_object_tier_map (
  sf_object    text PRIMARY KEY CHECK (sf_object IN ('Lead','Contact','Account','User')),
  account_tier text NOT NULL CHECK (account_tier IN ('free','member','patron')),
  note         text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_sf_object_tier_map_updated BEFORE UPDATE ON sf_object_tier_map
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO sf_object_tier_map (sf_object, account_tier, note) VALUES
  ('Lead',    'free',   'Signed up, no relationship with the site yet. New app signups land here.'),
  ('Contact', 'member', 'Known to the site but has not funded it.'),
  ('Account', 'patron', 'Has donated to keep the site running.'),
  ('User',    'patron', 'Salesforce User - staff. Treated as patron so a tier gate never locks out an operator.');

-- ============================================================
-- Social graph
-- ============================================================

-- NOTE: the cross-collection `friends: [ObjectId]` arrays are kept as
-- `friends uuid[]` columns on all four landing tables (see above) and on
-- accounts. They are polymorphic (ids may point at any person table), matching
-- the existing $addToSet/$pull usage in friendRoutes. Normalizing into a
-- friendships join table is GitHub #38, folded into the Phase 2 backfill.

CREATE TABLE friend_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user   uuid NOT NULL REFERENCES sf_users(id) ON DELETE CASCADE,
  to_user     uuid NOT NULL REFERENCES sf_users(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_friend_requests_to ON friend_requests (to_user, status);

-- ============================================================
-- Tabletop / game-night domain
-- ============================================================

CREATE TABLE campaigns (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title              text NOT NULL,
  description        text,
  status             text NOT NULL DEFAULT 'Not Started'
                       CHECK (status IN ('Not Started','In Progress','Completed')),
  start_date         timestamptz,
  end_date           timestamptz,
  discord_guild_id   text,
  discord_channel_id text,
  sf_id              text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaign_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id     uuid REFERENCES sf_leads(id)    ON DELETE SET NULL,
  contact_id  uuid REFERENCES sf_contacts(id) ON DELETE SET NULL,
  account_id  uuid REFERENCES sf_accounts(id) ON DELETE SET NULL,
  email       text,
  phone       text,
  first_name  text,
  last_name   text,
  status      text,
  joined_at   timestamptz DEFAULT now(),
  sf_id       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_campaign_members_campaign ON campaign_members (campaign_id);

CREATE TABLE campaign_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  from_user   uuid NOT NULL REFERENCES sf_users(id) ON DELETE CASCADE,
  to_user     uuid NOT NULL REFERENCES sf_users(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_campaign_invites_to ON campaign_invites (to_user);
CREATE INDEX idx_campaign_invites_lookup ON campaign_invites (campaign_id, to_user, status);

CREATE TABLE dungeons (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  description  text,
  level        integer,
  is_completed boolean NOT NULL DEFAULT false,
  sf_id        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE characters (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  player_id  uuid NOT NULL REFERENCES sf_accounts(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  dungeon_id  uuid REFERENCES dungeons(id)  ON DELETE SET NULL,
  game_type  text,
  class      text,
  level      integer NOT NULL DEFAULT 1,
  is_dead    boolean NOT NULL DEFAULT false,
  sf_id      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_characters_player ON characters (player_id);

CREATE TABLE game_sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title                text NOT NULL,
  campaign_id          uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  date                 timestamptz NOT NULL DEFAULT now(),
  end_date             timestamptz,
  location             text,
  is_online            boolean NOT NULL DEFAULT false,
  agenda               text,
  summary              text,
  vod_url              text,
  discord_event_id     text,
  google_event_id      text,
  google_calendar_link text,
  sf_id                text,
  -- { sentAt, responses: [{ playerId, name, ready, respondedAt }] }
  ready_check          jsonb,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_game_sessions_campaign ON game_sessions (campaign_id);

CREATE TABLE player_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  session_id  uuid NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  player_id   uuid NOT NULL REFERENCES sf_accounts(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  sf_id       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE encounters (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  difficulty  text NOT NULL DEFAULT 'Medium' CHECK (difficulty IN ('Easy','Medium','Hard','Deadly')),
  type        text NOT NULL DEFAULT 'Combat' CHECK (type IN ('Combat','Social','Exploration','Other')),
  session_id  uuid REFERENCES game_sessions(id) ON DELETE SET NULL,
  dungeon_id  uuid REFERENCES dungeons(id) ON DELETE SET NULL,
  sf_id       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Productivity / CRM
-- ============================================================

CREATE TABLE events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  description text,
  status      text NOT NULL DEFAULT 'Not Started'
                CHECK (status IN ('Not Started','In Progress','Completed')),
  start_date  timestamptz,
  end_date    timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title               text NOT NULL,
  description         text,
  status              text NOT NULL DEFAULT 'Not Started'
                        CHECK (status IN ('Not Started','In Progress','Completed')),
  due_date            timestamptz,
  sf_id               text,
  sf_record_type_id   text,
  sf_record_type_name text,
  sf_last_synced      timestamptz,
  notion_page_id      text,
  notion_last_synced  timestamptz,
  owner_id            text,
  owner_name          text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE opportunities (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  amount     numeric(14,2),
  stage      text NOT NULL DEFAULT 'Probe' CHECK (stage IN ('Probe','Negotiate','Closed Won','Closed Lost')),
  close_date timestamptz,
  account_id uuid REFERENCES sf_accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Messaging & notifications
-- ============================================================

CREATE TABLE messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  event_id     uuid REFERENCES events(id) ON DELETE SET NULL,
  dm_key       text,          -- "<idA>:<idB>" sorted participant ids (DMs)
  recipient    text,          -- user id (DMs only)
  sender_id    text NOT NULL, -- person id (may reference any person table)
  sender_name  text NOT NULL,
  sender_email text NOT NULL,
  body         text NOT NULL CHECK (char_length(body) <= 4000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (campaign_id IS NOT NULL OR dm_key IS NOT NULL)
);
CREATE INDEX idx_messages_campaign_created ON messages (campaign_id, created_at DESC);
CREATE INDEX idx_messages_dm_created       ON messages (dm_key, created_at DESC);

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES sf_users(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('friend_request','campaign_invite','message','system')),
  title       text NOT NULL,
  body        text,
  link        text,
  source_key  text,
  meta        jsonb,
  count       integer NOT NULL DEFAULT 1,
  read        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_bell   ON notifications (user_id, read, created_at DESC);
CREATE INDEX idx_notifications_dedupe ON notifications (user_id, type, source_key, read);

-- ============================================================
-- Integrations / trading
-- ============================================================

CREATE TABLE api_key_vault (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES sf_users(id) ON DELETE CASCADE,
  provider         text NOT NULL,
  label            text NOT NULL DEFAULT '',
  encrypted_key_id text NOT NULL,
  encrypted_secret text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);
CREATE TRIGGER trg_api_key_vault_updated BEFORE UPDATE ON api_key_vault
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE alpaca_snapshots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts           timestamptz NOT NULL DEFAULT now(),
  equity       numeric(14,2) NOT NULL DEFAULT 0,
  last_equity  numeric(14,2) NOT NULL DEFAULT 0,
  cash         numeric(14,2) NOT NULL DEFAULT 0,
  buying_power numeric(14,2) NOT NULL DEFAULT 0,
  day_pl       numeric(14,2) NOT NULL DEFAULT 0,
  -- [{ symbol, qty, market_value, unrealized_pl, current_price }]
  positions    jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_alpaca_snapshots_ts ON alpaca_snapshots (ts);

CREATE TABLE cloud_claw_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL UNIQUE REFERENCES sf_users(id) ON DELETE CASCADE,
  -- [{ role: 'user'|'assistant', content }]
  messages   jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_cloud_claw_updated BEFORE UPDATE ON cloud_claw_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
