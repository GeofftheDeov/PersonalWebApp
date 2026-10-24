-- Letters: attachments (#104, spec #58).
--
-- A message can carry images (jpeg, png, webp, gif) and PDFs, with or without
-- text. The browser uploads each file straight to S3 with a presigned PUT; the
-- server first records which key it issued, to whom, for which thread, and a
-- send may only attach keys issued to that sender for that thread. See
-- backend/services/attachments.ts.
--
-- Additive: a new table, and a column whose default covers existing rows.
-- `body` stays NOT NULL; a message with only attachments stores ''.

BEGIN;

-- Each upload URL handed out. The object's name, type and size are what the
-- server checked and signed, so a message's attachment metadata comes from
-- here, never from the send request.
CREATE TABLE IF NOT EXISTS message_attachment_uploads (
  key          text PRIMARY KEY,
  thread_key   text NOT NULL,
  sender_id    text NOT NULL,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  content_type text NOT NULL,
  size         integer NOT NULL CHECK (size > 0),
  width        integer CHECK (width IS NULL OR width > 0),
  height       integer CHECK (height IS NULL OR height > 0),
  issued_at    timestamptz NOT NULL DEFAULT now()
);

-- [{ key, name, size, contentType, width?, height? }], in the order sent.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(attachments) = 'array');

COMMIT;
