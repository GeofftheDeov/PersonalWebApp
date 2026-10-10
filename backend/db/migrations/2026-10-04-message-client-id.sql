-- Letters: resending a message is exactly once (#101, spec #58).
--
-- The client gives each message it sends a clientId and sends it again with
-- any resend. A second send with the same (sender, clientId) returns the
-- message already stored instead of storing it twice, so a send whose response
-- was lost (offline, a timeout, a server error after the insert) can be
-- retried safely. See backend/services/threadMessages.ts.
--
-- Additive: a nullable column and a partial unique index. Existing rows, and
-- senders that don't pass a clientId (older clients), are unaffected.

BEGIN;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_id text
  CHECK (client_id IS NULL OR char_length(client_id) <= 64);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_sender_client
  ON messages (sender_id, client_id) WHERE client_id IS NOT NULL;

COMMIT;
