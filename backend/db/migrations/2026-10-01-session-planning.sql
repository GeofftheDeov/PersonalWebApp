-- ============================================================================
-- 2026-10-01 — session planning (GitHub #57)
--
-- Additive schema for planning a session before its night is fixed: regular
-- availability, the night and venue votes, venues, quests (session tasks) and
-- their reminders, and the campaign settings that drive them (owner, GM title,
-- quorum, table link, banner). Nothing existing changes meaning:
--
--   * Every existing game_sessions row is a session whose date was fixed up
--     front, so it is 'scheduled' -- the new column's default -- and the
--     one-off "add session" path keeps writing exactly that.
--   * game_sessions.date loses NOT NULL, because a session being planned has
--     no night yet. game_sessions_date_required keeps it mandatory for every
--     status except planning and cancelled.
--   * campaigns.owner_id is a new concept, separate from Game Master: it is
--     who controls the banner and the GM title, and it does not move when the
--     torch passes. It backfills to the campaign's earliest Game Master, or
--     stays NULL (admin-managed) when there is none.
--
-- Person references point at accounts(id) with real foreign keys, as
-- everything has since Phase 3 (#35) unified the person tables.
--
-- Deviations from the issue's schema list, each for a reason the issue implies:
--   * poll_ballots: approval voting has to be able to record "I can't make any
--     of these". A ballot row says a person has voted; poll_votes says what
--     they approved. "Closes when everyone has voted" counts ballots.
--   * polls.eligible_ids / polls.quorum: "the eligible voters are the party at
--     the moment the poll opened", and the quorum is resolved at the same
--     moment, so a member joining mid-vote or a settings change can't move the
--     goalposts of a vote already running.
--   * polls.result: 'winner' | 'tie' (closed, waiting on the GM) | 'no_quorum'
--     (the round failed and the GM re-shortlists).
--   * session_task_reminders.due_at: the due time a reminder was sent for, so
--     moving the night re-arms reminders instead of silently suppressing them.
--   * session_tasks.notes: the prototype's quest description line.
--
-- Columns are named starts_at / ends_at rather than start / end (END is a
-- reserved word).
--
-- Apply BEFORE deploying the code that ships with it: creating a campaign now
-- writes owner_id.
--
-- Idempotent: safe to re-run.
-- ============================================================================

BEGIN;

-- ── campaigns: settings ─────────────────────────────────────────────────────
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS owner_id   uuid REFERENCES accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS gm_title   text NOT NULL DEFAULT 'Dungeon Master'
                                        CHECK (char_length(btrim(gm_title)) BETWEEN 1 AND 40),
  -- NULL means "the whole party".
  ADD COLUMN IF NOT EXISTS quorum     integer CHECK (quorum >= 1),
  ADD COLUMN IF NOT EXISTS table_link text CHECK (char_length(table_link) <= 500),
  ADD COLUMN IF NOT EXISTS banner_key text;

-- The earliest Game Master. joined_at is NULL on no rows today, but sort it
-- last rather than first should one appear.
UPDATE campaigns c
   SET owner_id = gm.person_id
  FROM (SELECT DISTINCT ON (campaign_id) campaign_id, person_id
          FROM campaign_members
         WHERE status = 'Game Master' AND person_id IS NOT NULL
         ORDER BY campaign_id, joined_at NULLS LAST, created_at, id) gm
 WHERE c.id = gm.campaign_id
   AND c.owner_id IS NULL;

-- ── venues ──────────────────────────────────────────────────────────────────
-- Created before game_sessions gains venue_id, which references it.
CREATE TABLE IF NOT EXISTS venues (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  -- Returned only to party members, and only while the venue is on a shortlist
  -- or confirmed for a session (#57, story 39).
  address      text CHECK (char_length(address) <= 300),
  kind         text NOT NULL DEFAULT 'other' CHECK (kind IN ('home','store','other')),
  host_id      uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_by   uuid REFERENCES accounts(id) ON DELETE SET NULL,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_venues_campaign ON venues (campaign_id, last_used_at DESC NULLS LAST);

-- ── game_sessions: planning ─────────────────────────────────────────────────
ALTER TABLE game_sessions
  ADD COLUMN IF NOT EXISTS status         text NOT NULL DEFAULT 'scheduled'
                                            CHECK (status IN ('planning','scheduled','cancelled','completed')),
  -- Which step a planning session is on. Kickoff is the transition that
  -- creates the session, not a stage it rests in.
  ADD COLUMN IF NOT EXISTS planning_stage text CHECK (planning_stage IN ('night','venue','food')),
  ADD COLUMN IF NOT EXISTS food_mode      text CHECK (food_mode IN ('potluck','provided')),
  ADD COLUMN IF NOT EXISTS food_owner_id  uuid REFERENCES accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS host_id        uuid REFERENCES accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS venue_id       uuid REFERENCES venues(id) ON DELETE SET NULL,
  -- A one-session torch pass: this person is the Game Master of this session
  -- only. A permanent pass swaps campaign_members.status instead.
  ADD COLUMN IF NOT EXISTS gm_override_id uuid REFERENCES accounts(id) ON DELETE SET NULL;

ALTER TABLE game_sessions ALTER COLUMN date DROP NOT NULL;

ALTER TABLE game_sessions DROP CONSTRAINT IF EXISTS game_sessions_stage_matches_status;
ALTER TABLE game_sessions ADD CONSTRAINT game_sessions_stage_matches_status
  CHECK ((status = 'planning') = (planning_stage IS NOT NULL));

ALTER TABLE game_sessions DROP CONSTRAINT IF EXISTS game_sessions_date_required;
ALTER TABLE game_sessions ADD CONSTRAINT game_sessions_date_required
  CHECK (date IS NOT NULL OR status IN ('planning','cancelled'));

-- ── regular availability ────────────────────────────────────────────────────
-- A weekly window in the person's own time zone. end_time earlier than
-- start_time means the window crosses midnight ("Fri 9 pm – 1 am" is weekday
-- 5, 21:00, 01:00). Weekday follows JS getDay() and Postgres EXTRACT(dow):
-- 0 = Sunday.
CREATE TABLE IF NOT EXISTS availability_windows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time  time NOT NULL CHECK (start_time < '24:00'),
  end_time    time NOT NULL CHECK (end_time < '24:00'),
  -- IANA name, e.g. America/Chicago. Validated by the app, which has to agree
  -- with it about what the name means anyway.
  time_zone   text NOT NULL CHECK (char_length(time_zone) BETWEEN 1 AND 64),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_windows_nonempty CHECK (start_time <> end_time)
);
CREATE INDEX IF NOT EXISTS idx_availability_windows_person ON availability_windows (person_id);

-- A one-off change to the regular schedule: "out Oct 17" (unavailable) or
-- "free this Tuesday only" (available).
CREATE TABLE IF NOT EXISTS availability_exceptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('unavailable','available')),
  note        text CHECK (char_length(note) <= 200),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_exceptions_range CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_availability_exceptions_person ON availability_exceptions (person_id, starts_at);

-- Time pulled from an external calendar that counts as unavailable. There is
-- deliberately no title column: the party sees free / busy and nothing more,
-- and what is never stored can never leak (#57, story 9).
CREATE TABLE IF NOT EXISTS busy_blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source      text NOT NULL CHECK (source IN ('google','discord')),
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  -- Discord scheduled-event id. Google free/busy returns bare intervals.
  external_id text,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT busy_blocks_range CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_busy_blocks_person ON busy_blocks (person_id, starts_at);

-- ── polls (the night vote and the venue vote) ───────────────────────────────
CREATE TABLE IF NOT EXISTS polls (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        uuid NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('night','venue')),
  round             integer NOT NULL DEFAULT 1 CHECK (round >= 1),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  -- The party at the moment the poll opened, and (night only) the quorum
  -- resolved against it.
  eligible_ids      uuid[] NOT NULL DEFAULT '{}',
  quorum            integer CHECK (quorum >= 1),
  result            text CHECK (result IN ('winner','tie','no_quorum')),
  closed_reason     text CHECK (closed_reason IN ('all_voted','gm_advanced','gm_reshortlisted','cancelled')),
  winning_option_id uuid,
  opened_at         timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz,
  CONSTRAINT polls_round_unique UNIQUE (session_id, kind, round),
  CONSTRAINT polls_closed_shape CHECK (
    (status = 'open') = (closed_reason IS NULL) AND
    (status = 'open') = (closed_at IS NULL) AND
    (result IS NULL OR status = 'closed') AND
    ((result IS NOT DISTINCT FROM 'winner') = (winning_option_id IS NOT NULL)))
);
-- One vote at a time per session.
CREATE UNIQUE INDEX IF NOT EXISTS ux_polls_one_open ON polls (session_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS poll_options (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id      uuid NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  -- A night option is a time; a venue option is a venue. Never both.
  starts_at    timestamptz,
  ends_at      timestamptz,
  venue_id     uuid REFERENCES venues(id),
  suggested_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Lets poll_votes prove an option belongs to the poll it is voted in.
  CONSTRAINT poll_options_id_poll_key UNIQUE (id, poll_id),
  CONSTRAINT poll_options_shape CHECK (
    (venue_id IS NULL AND starts_at IS NOT NULL AND ends_at > starts_at) OR
    (venue_id IS NOT NULL AND starts_at IS NULL AND ends_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options (poll_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_poll_options_venue ON poll_options (poll_id, venue_id)
  WHERE venue_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_poll_options_night ON poll_options (poll_id, starts_at, ends_at)
  WHERE venue_id IS NULL;

ALTER TABLE polls DROP CONSTRAINT IF EXISTS polls_winning_option_fkey;
ALTER TABLE polls ADD CONSTRAINT polls_winning_option_fkey
  FOREIGN KEY (winning_option_id) REFERENCES poll_options(id);

-- One row per person who has voted, even if they approved nothing.
CREATE TABLE IF NOT EXISTS poll_ballots (
  poll_id    uuid NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  person_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  cast_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, person_id)
);

-- What each ballot approved (night) or chose (venue: exactly one, enforced
-- by the poll module).
CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id    uuid NOT NULL,
  option_id  uuid NOT NULL,
  person_id  uuid NOT NULL,
  PRIMARY KEY (option_id, person_id),
  CONSTRAINT poll_votes_option_fkey FOREIGN KEY (option_id, poll_id)
    REFERENCES poll_options (id, poll_id) ON DELETE CASCADE,
  CONSTRAINT poll_votes_ballot_fkey FOREIGN KEY (poll_id, person_id)
    REFERENCES poll_ballots (poll_id, person_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes (poll_id, person_id);

-- ── quests (session tasks) and their reminders ──────────────────────────────
CREATE TABLE IF NOT EXISTS session_tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  -- NULL is an unclaimed potluck slot. Every other kind is created with an
  -- assignee; the quest module enforces that, since a CHECK here would make
  -- deleting an account fail on its ON DELETE SET NULL.
  assignee_id      uuid REFERENCES accounts(id) ON DELETE SET NULL,
  kind             text NOT NULL CHECK (kind IN ('host_prep','food','custom')),
  title            text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  notes            text CHECK (char_length(notes) <= 1000),
  -- Follows the session's start. NULL while the night is still being voted on.
  due_at           timestamptz,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  -- Minutes before due_at, chosen by whoever owns the quest. At most five, and
  -- none more than two weeks out.
  reminder_offsets integer[] NOT NULL DEFAULT '{}'
                     CHECK (cardinality(reminder_offsets) <= 5
                            AND 0 <= ALL (reminder_offsets)
                            AND 20160 >= ALL (reminder_offsets)),
  created_by       uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_session_tasks_session  ON session_tasks (session_id);
CREATE INDEX IF NOT EXISTS idx_session_tasks_assignee ON session_tasks (assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_session_tasks_due      ON session_tasks (due_at) WHERE status = 'open';

-- A reminder that has been sent. The key includes the due time it was sent
-- for: sending is INSERT ... ON CONFLICT DO NOTHING, so each offset fires
-- exactly once per due time, and moving the night re-arms it.
CREATE TABLE IF NOT EXISTS session_task_reminders (
  task_id        uuid NOT NULL REFERENCES session_tasks(id) ON DELETE CASCADE,
  offset_minutes integer NOT NULL,
  due_at         timestamptz NOT NULL,
  sent_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, offset_minutes, due_at)
);

COMMIT;
