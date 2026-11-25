-- Adventurers get art and their full sheet (#273, #274; spec #198).
--
-- character_art: one row per piece of art, its S3 object under
-- character-art/<characterId>/. A character points at the piece that is its
-- portrait (portrait_art_id), cleared if that piece goes.
--
-- The full sheet: a link to wherever it lives (sheet_url) and/or an uploaded
-- copy (a PDF or picture under character-sheets/<characterId>/) with the name,
-- type and size it was uploaded with.
--
-- Only additions: the running code reads none of these columns, so they can
-- land before it. Re-running changes nothing.

BEGIN;

CREATE TABLE IF NOT EXISTS character_art (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  file_key     text NOT NULL UNIQUE,
  position     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_character_art_character ON character_art (character_id, position);

ALTER TABLE characters
  ADD COLUMN IF NOT EXISTS portrait_art_id uuid REFERENCES character_art(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sheet_url  text CHECK (sheet_url IS NULL OR char_length(sheet_url) <= 2000),
  ADD COLUMN IF NOT EXISTS sheet_key  text,
  ADD COLUMN IF NOT EXISTS sheet_name text CHECK (sheet_name IS NULL OR char_length(sheet_name) <= 200),
  ADD COLUMN IF NOT EXISTS sheet_type text,
  ADD COLUMN IF NOT EXISTS sheet_size integer;

COMMIT;
