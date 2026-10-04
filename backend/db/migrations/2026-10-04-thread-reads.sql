-- Letters read state (#100, spec #58).
--
-- How far each person has read each thread, so the thread list can show unread
-- counts. thread_key is `campaign:<campaign id>` or `dm:<dm_key>` (see
-- backend/services/threads.ts). A thread's unread count is the messages after
-- last_read_at that someone else sent. Only your own position is tracked.
--
-- Additive: a new table, no change to existing rows. The "latest message per
-- thread" indexes the list query needs, messages (campaign_id, created_at) and
-- messages (dm_key, created_at), already exist.

BEGIN;

CREATE TABLE IF NOT EXISTS thread_reads (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id            uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  thread_key           text NOT NULL,
  last_read_at         timestamptz NOT NULL,
  last_read_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT thread_reads_person_thread UNIQUE (person_id, thread_key)
);

COMMIT;
