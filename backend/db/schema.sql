-- ============================================================
-- PersonalWebApp — PostgreSQL schema (MongoDB → Postgres migration)
-- Target: Neon (PostgreSQL 15+). Apply with: psql $DATABASE_URL -f schema.sql
-- Conventions:
--   * uuid PKs via gen_random_uuid() (built-in, PG13+)
--   * snake_case columns; timestamptz everywhere
--   * mongoose enums -> CHECK constraints (easier to evolve than SQL enums)
--   * document-shaped payloads -> jsonb
-- ============================================================

-- ---------- shared trigger for updated_at ----------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Person-type tables (User / Account / Contact / Lead)
-- App-layer responsibilities (formerly mongoose hooks):
--   * bcrypt hashing, user_number/user_digit generation, Salesforce sync
-- ============================================================

CREATE TABLE users (
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
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE accounts (
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

CREATE TABLE contacts (
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
  account_id                uuid REFERENCES accounts(id) ON DELETE SET NULL,
  user_number               text,
  user_digit                text,
  notes                     text,
  sf_id                     text,
  profile_picture           text,
  favorite_games            text[] NOT NULL DEFAULT '{}',
  friends                   uuid[] NOT NULL DEFAULT '{}',
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE leads (
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
-- Social graph
-- ============================================================

-- NOTE: the cross-collection `friends: [ObjectId]` arrays are kept as
-- `friends uuid[]` columns on all four person tables (see above). They are
-- polymorphic (ids may point at users/accounts/contacts/leads), matching the
-- existing $addToSet/$pull usage in friendRoutes. Normalizing into a
-- friendships join table is a future idiomization step.

CREATE TABLE friend_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Polymorphic person ref: User | Lead | Contact | Account (see personUtils.ts).
  -- No FK is possible; existence is enforced in the data layer.
  from_user   uuid NOT NULL,
  to_user     uuid NOT NULL,
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
  lead_id     uuid REFERENCES leads(id)    ON DELETE SET NULL,
  contact_id  uuid REFERENCES contacts(id) ON DELETE SET NULL,
  account_id  uuid REFERENCES accounts(id) ON DELETE SET NULL,
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
  from_user   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
  -- Polymorphic person ref: User | Lead | Contact | Account (see personUtils.ts).
  -- No FK is possible; existence is enforced in the data layer.
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
  -- Polymorphic person ref: User | Lead | Contact | Account (see personUtils.ts).
  -- No FK is possible; existence is enforced in the data layer.
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
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
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
  -- No FK is possible; existence is enforced in the data layer.
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

CREATE TABLE api_key_vault (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
  user_id    uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  -- [{ role: 'user'|'assistant', content }]
  messages   jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_cloud_claw_updated BEFORE UPDATE ON cloud_claw_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
