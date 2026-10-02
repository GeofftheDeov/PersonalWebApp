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
-- (campaign_members.*, api_key_vault.user_id, cloud_claw_sessions.user_id) are
-- rewritten to accounts(id) in Phase 3.
-- ============================================================

CREATE TABLE sf_users (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text,
  email                     text,
  phone                     text,
  handle                    text,
  -- Nullable since #35: passwords are app-owned and live on accounts. See the
  -- 2026-09-24 merge-support migration.
  password                  text,
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
  password                  text,          -- nullable since #35, as sf_users
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

-- Salesforce write-back queue (#35, plan §2.7). trg_accounts_outbox below
-- enqueues a row whenever a pushable column changes; the nightly drain in
-- jobs/personSync.ts works through them. Poll, don't LISTEN -- the dev
-- DATABASE_URL is a PgBouncer pooler and LISTEN/NOTIFY is session-scoped.
CREATE TABLE person_outbox (
  id           bigserial PRIMARY KEY,
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  op           text NOT NULL CHECK (op IN ('create','update')),
  payload      jsonb NOT NULL,        -- {"fields": [...]} changed pushable columns; values read at drain time
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','in_flight','done','failed')),
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX idx_person_outbox_pending ON person_outbox (created_at)
  WHERE status = 'pending';

-- At most one PENDING row per person, so enqueues coalesce (see the function).
CREATE UNIQUE INDEX ux_person_outbox_one_pending
  ON person_outbox (account_id) WHERE status = 'pending';

-- Enqueue on a change to one of the five pushable columns (§2.6). Never for
-- sf_object = 'User' (pull-only), never while app.sync_in_progress = 'on' (the
-- merge and the drain's own write-back). Full rationale in
-- db/migrations/2026-09-24-phase3-person-outbox-trigger.sql.
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

-- UPDATE OF limits invocation to statements that target a pushable column, so a
-- friend request, a login or a profile-picture change never even calls the
-- function. The IS DISTINCT FROM checks inside handle "targeted but unchanged".
CREATE TRIGGER trg_accounts_outbox
  AFTER INSERT OR UPDATE OF email, name, first_name, last_name, phone ON accounts
  FOR EACH ROW EXECUTE FUNCTION enqueue_person_outbox();

COMMENT ON COLUMN person_outbox.payload IS
  '{"fields": [...]}: names of changed pushable columns. The drain reads current values.';

-- Landing rows the nightly merge must never link or give an account (#27's test
-- lead). Rationale in db/migrations/2026-09-24-phase3-merge-support.sql.
CREATE TABLE account_merge_exclusions (
  source_table text NOT NULL
    CHECK (source_table IN ('sf_users','sf_leads','sf_contacts','sf_accounts')),
  source_id    uuid NOT NULL,
  reason       text NOT NULL,
  excluded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_table, source_id)
);

-- Ledger of person-sync runs: the admin UI's "last run", and the merge's
-- "since the last merge" cutoff for shared fields. Rationale in the same file.
CREATE TABLE person_sync_runs (
  id          bigserial PRIMARY KEY,
  step        text NOT NULL CHECK (step IN ('drain','pull','merge')),
  sf_object   text,          -- pull only: which object's records landed
  trigger     text NOT NULL DEFAULT 'schedule'
                CHECK (trigger IN ('schedule','manual','salesforce')),
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  ok          boolean NOT NULL,
  result      jsonb,
  error       text
);
CREATE INDEX idx_person_sync_runs_step
  ON person_sync_runs (step, finished_at DESC);

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
  -- #42 dropped these FKs because a person could live in any of four tables and
  -- no constraint could name them all. Phase 3 (#35) unified those into
  -- `accounts`, so the database can enforce existence again.
  from_user   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_user     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
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
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- Session planning (#57, migrations/2026-10-01-session-planning.sql).
  -- The owner controls the banner and the GM title. Separate from Game Master,
  -- and unchanged when the torch passes; NULL means admin-managed.
  owner_id           uuid REFERENCES accounts(id) ON DELETE SET NULL,
  gm_title           text NOT NULL DEFAULT 'Dungeon Master'
                       CHECK (char_length(btrim(gm_title)) BETWEEN 1 AND 40),
  quorum             integer CHECK (quorum >= 1),    -- NULL = the whole party
  table_link         text CHECK (char_length(table_link) <= 500),
  banner_key         text
);

CREATE TABLE campaign_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  -- Membership always points at a real account (#35, plan §3.5). The
  -- "invited but has no account yet" state lives on campaign_invites.to_email.
  person_id   uuid REFERENCES accounts(id) ON DELETE CASCADE,
  -- Superseded by person_id, kept until the cutover has soaked. Dropped, along
  -- with person_id's NOT NULL, in the final Phase 3 migration.
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
CREATE INDEX idx_campaign_members_person ON campaign_members (person_id);

CREATE TABLE campaign_invites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  -- Anyone can be invited to a campaign (#42). Since #35 everyone is an account,
  -- so the sender always has one and the FKs are back.
  from_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- ...but the invitee may not exist yet. Invite by handle sets to_account_id;
  -- invite by email for someone with no account sets to_email, and registration
  -- binds it. Exactly one of the two is required.
  to_account_id   uuid REFERENCES accounts(id) ON DELETE CASCADE,
  to_email        citext,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_invites_target
    CHECK (to_account_id IS NOT NULL OR to_email IS NOT NULL)
);
CREATE INDEX idx_campaign_invites_to ON campaign_invites (to_account_id);
CREATE INDEX idx_campaign_invites_lookup ON campaign_invites (campaign_id, to_account_id, status);
CREATE INDEX idx_campaign_invites_email ON campaign_invites (to_email)
  WHERE to_account_id IS NULL AND status = 'pending';

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
  -- Polymorphic person ref: User | Lead | Contact | Account (see personUtils.ts).
  -- No FK is possible; existence is enforced in the data layer. GitHub #42.
  player_id  uuid NOT NULL,
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

-- A saved place for a campaign (#57). Declared ahead of game_sessions, which
-- references it.
CREATE TABLE venues (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  -- Returned only to party members, and only while the venue is on a shortlist
  -- or confirmed for a session.
  address      text CHECK (char_length(address) <= 300),
  kind         text NOT NULL DEFAULT 'other' CHECK (kind IN ('home','store','other')),
  host_id      uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_by   uuid REFERENCES accounts(id) ON DELETE SET NULL,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_venues_campaign ON venues (campaign_id, last_used_at DESC NULLS LAST);

CREATE TABLE game_sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title                text NOT NULL,
  campaign_id          uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  -- NULL only while the night is being planned (or the session was cancelled
  -- first); see game_sessions_date_required.
  date                 timestamptz DEFAULT now(),
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
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- Session planning (#57). A session with a date fixed up front is simply
  -- 'scheduled'; 'planning' ones walk night -> venue -> food (in person) or
  -- night alone (online).
  status               text NOT NULL DEFAULT 'scheduled'
                         CHECK (status IN ('planning','scheduled','cancelled','completed')),
  -- Kickoff is the transition that creates the session, not a stage.
  planning_stage       text CHECK (planning_stage IN ('night','venue','food')),
  food_mode            text CHECK (food_mode IN ('potluck','provided')),
  food_owner_id        uuid REFERENCES accounts(id) ON DELETE SET NULL,
  host_id              uuid REFERENCES accounts(id) ON DELETE SET NULL,
  venue_id             uuid REFERENCES venues(id) ON DELETE SET NULL,
  -- One-session torch pass. A permanent pass swaps campaign_members.status.
  gm_override_id       uuid REFERENCES accounts(id) ON DELETE SET NULL,
  CONSTRAINT game_sessions_stage_matches_status
    CHECK ((status = 'planning') = (planning_stage IS NOT NULL)),
  CONSTRAINT game_sessions_date_required
    CHECK (date IS NOT NULL OR status IN ('planning','cancelled'))
);
CREATE INDEX idx_game_sessions_campaign ON game_sessions (campaign_id);

CREATE TABLE player_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  session_id  uuid NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  -- Polymorphic person ref: User | Lead | Contact | Account (see personUtils.ts).
  -- No FK is possible; existence is enforced in the data layer. GitHub #42.
  player_id   uuid NOT NULL,
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
-- Session planning (#57, migrations/2026-10-01-session-planning.sql)
--
-- Regular availability feeds the night vote; venues feed the venue vote;
-- quests are the to-dos planning hands out. venues is declared with the
-- tabletop tables above because game_sessions references it.
-- ============================================================

-- A weekly window in the person's own time zone. end_time earlier than
-- start_time means it crosses midnight ("Fri 9 pm - 1 am" is 5, 21:00, 01:00).
-- Weekday follows JS getDay() and Postgres EXTRACT(dow): 0 = Sunday.
CREATE TABLE availability_windows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time  time NOT NULL CHECK (start_time < '24:00'),
  end_time    time NOT NULL CHECK (end_time < '24:00'),
  time_zone   text NOT NULL CHECK (char_length(time_zone) BETWEEN 1 AND 64),  -- IANA
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_windows_nonempty CHECK (start_time <> end_time)
);
CREATE INDEX idx_availability_windows_person ON availability_windows (person_id);

-- "Out Oct 17" (unavailable) or "free this Tuesday only" (available).
CREATE TABLE availability_exceptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('unavailable','available')),
  note        text CHECK (char_length(note) <= 200),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_exceptions_range CHECK (ends_at > starts_at)
);
CREATE INDEX idx_availability_exceptions_person ON availability_exceptions (person_id, starts_at);

-- Busy time from an external calendar. No title column, on purpose: the party
-- sees free / busy and nothing more.
CREATE TABLE busy_blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source      text NOT NULL CHECK (source IN ('google','discord')),
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  external_id text,   -- Discord scheduled-event id; Google free/busy has none
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT busy_blocks_range CHECK (ends_at > starts_at)
);
CREATE INDEX idx_busy_blocks_person ON busy_blocks (person_id, starts_at);

-- The night vote and the venue vote. eligible_ids and quorum are snapshotted
-- when the poll opens. result: 'winner', 'tie' (closed, the GM picks) or
-- 'no_quorum' (the round failed; the GM re-shortlists).
CREATE TABLE polls (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        uuid NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('night','venue')),
  round             integer NOT NULL DEFAULT 1 CHECK (round >= 1),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  eligible_ids      uuid[] NOT NULL DEFAULT '{}',
  quorum            integer CHECK (quorum >= 1),
  result            text CHECK (result IN ('winner','tie','no_quorum')),
  closed_reason     text CHECK (closed_reason IN ('all_voted','gm_advanced','gm_reshortlisted','cancelled')),
  winning_option_id uuid,   -- FK added below, once poll_options exists
  opened_at         timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz,
  CONSTRAINT polls_round_unique UNIQUE (session_id, kind, round),
  CONSTRAINT polls_closed_shape CHECK (
    (status = 'open') = (closed_reason IS NULL) AND
    (status = 'open') = (closed_at IS NULL) AND
    (result IS NULL OR status = 'closed') AND
    ((result IS NOT DISTINCT FROM 'winner') = (winning_option_id IS NOT NULL)))
);
CREATE UNIQUE INDEX ux_polls_one_open ON polls (session_id) WHERE status = 'open';

CREATE TABLE poll_options (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id      uuid NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  starts_at    timestamptz,                      -- night option
  ends_at      timestamptz,
  venue_id     uuid REFERENCES venues(id),       -- venue option
  suggested_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT poll_options_id_poll_key UNIQUE (id, poll_id),
  CONSTRAINT poll_options_shape CHECK (
    (venue_id IS NULL AND starts_at IS NOT NULL AND ends_at > starts_at) OR
    (venue_id IS NOT NULL AND starts_at IS NULL AND ends_at IS NULL))
);
CREATE INDEX idx_poll_options_poll ON poll_options (poll_id);
CREATE UNIQUE INDEX ux_poll_options_venue ON poll_options (poll_id, venue_id)
  WHERE venue_id IS NOT NULL;
CREATE UNIQUE INDEX ux_poll_options_night ON poll_options (poll_id, starts_at, ends_at)
  WHERE venue_id IS NULL;

ALTER TABLE polls ADD CONSTRAINT polls_winning_option_fkey
  FOREIGN KEY (winning_option_id) REFERENCES poll_options(id);

-- A person has voted (even if they approved nothing) ...
CREATE TABLE poll_ballots (
  poll_id    uuid NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  person_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  cast_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, person_id)
);

-- ... and this is what they approved (night) or chose (venue).
CREATE TABLE poll_votes (
  poll_id    uuid NOT NULL,
  option_id  uuid NOT NULL,
  person_id  uuid NOT NULL,
  PRIMARY KEY (option_id, person_id),
  CONSTRAINT poll_votes_option_fkey FOREIGN KEY (option_id, poll_id)
    REFERENCES poll_options (id, poll_id) ON DELETE CASCADE,
  CONSTRAINT poll_votes_ballot_fkey FOREIGN KEY (poll_id, person_id)
    REFERENCES poll_ballots (poll_id, person_id) ON DELETE CASCADE
);
CREATE INDEX idx_poll_votes_poll ON poll_votes (poll_id, person_id);

-- Quests. assignee_id NULL is an unclaimed potluck slot; the quest module
-- requires an assignee for every other kind.
CREATE TABLE session_tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  assignee_id      uuid REFERENCES accounts(id) ON DELETE SET NULL,
  kind             text NOT NULL CHECK (kind IN ('host_prep','food','custom')),
  title            text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  notes            text CHECK (char_length(notes) <= 1000),
  due_at           timestamptz,    -- follows the session's start
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  reminder_offsets integer[] NOT NULL DEFAULT '{}'   -- minutes before due_at
                     CHECK (cardinality(reminder_offsets) <= 5
                            AND 0 <= ALL (reminder_offsets)
                            AND 20160 >= ALL (reminder_offsets)),
  created_by       uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);
CREATE INDEX idx_session_tasks_session  ON session_tasks (session_id);
CREATE INDEX idx_session_tasks_assignee ON session_tasks (assignee_id, status);
CREATE INDEX idx_session_tasks_due      ON session_tasks (due_at) WHERE status = 'open';

-- Sent reminders. Keyed on the due time they were sent for, so each offset
-- fires once per due time and moving the night re-arms it.
CREATE TABLE session_task_reminders (
  task_id        uuid NOT NULL REFERENCES session_tasks(id) ON DELETE CASCADE,
  offset_minutes integer NOT NULL,
  due_at         timestamptz NOT NULL,
  sent_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, offset_minutes, due_at)
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
  -- Polymorphic person ref: User | Lead | Contact | Account (see personUtils.ts).
  -- No FK is possible; existence is enforced in the data layer. GitHub #42.
  user_id     uuid NOT NULL,
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

-- NOTE: user_id here is NOT a polymorphic person ref, unlike the columns above.
-- The key vault and the Cloud Claw console are staff-only surfaces whose owner
-- genuinely is a Salesforce User, so the FK stays. Phase 3 (#35) repoints both
-- at accounts(id) along with the rest of the app-facing references.
CREATE TABLE api_key_vault (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Staff-only integration. Its owner genuinely is a Salesforce User, but
  -- since #35 that person is an account like everyone else.
  user_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
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
  -- Staff-only integration; see api_key_vault above. Repointed by #35.
  user_id    uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  -- [{ role: 'user'|'assistant', content }]
  messages   jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_cloud_claw_updated BEFORE UPDATE ON cloud_claw_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- Admin portal
-- ============================================================

-- Saved list views for the /db table browser (migrations/2026-09-25-admin-list-views.sql).
-- Shared by all admins; created_by is informational, not a person ref.
CREATE TABLE admin_list_views (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection  text NOT NULL,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  config      jsonb NOT NULL DEFAULT '{}',
  is_default  boolean NOT NULL DEFAULT false,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection, name)
);
CREATE UNIQUE INDEX uq_admin_list_views_default ON admin_list_views (collection) WHERE is_default;
CREATE TRIGGER trg_admin_list_views_updated BEFORE UPDATE ON admin_list_views
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- agentic OS: skill-run queue (migrations/2026-09-26-agent-runs.sql) ----------

CREATE TABLE agent_runs (
  id            bigserial PRIMARY KEY,
  skill         text NOT NULL,
  status        text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','succeeded','failed')),
  requested_by  text,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at    timestamptz,
  finished_at   timestamptz,
  runner        text,
  summary       text,
  output_path   text
);
CREATE INDEX idx_agent_runs_queued ON agent_runs (requested_at) WHERE status = 'queued';
CREATE INDEX idx_agent_runs_recent ON agent_runs (requested_at DESC);
