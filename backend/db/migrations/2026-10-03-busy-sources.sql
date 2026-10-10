-- ============================================================================
-- 2026-10-03 — busy sources (GitHub #84, part of #57)
--
-- Which outside calendars a person lets count as busy time, and how fresh the
-- busy_blocks pulled from each one are. busy_blocks itself arrived with
-- 2026-10-01-session-planning.sql; this adds only the switch and the sync
-- bookkeeping beside it:
--
--   * A row means the source is ON for that person. Turning a source off
--     deletes the row and that source's busy_blocks.
--   * synced_from / synced_to: the stretch of time the last successful sync
--     covered. The blocks of that source are exactly what the outside
--     calendar said about that stretch, so a later overlap for a range outside
--     it syncs again (planning/busySources.ts holds the freshness rule).
--   * last_error: why the last sync failed, worded for the owner only. The
--     party never sees it, nor which sources anyone uses.
--
-- 'discord' is allowed now so #85 ("interested" Discord events) needs no
-- migration of its own.
--
-- Additive and idempotent: safe to re-run.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS busy_sources (
  person_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source          text NOT NULL CHECK (source IN ('google','discord')),
  enabled_at      timestamptz NOT NULL DEFAULT now(),
  synced_at       timestamptz,
  synced_from     timestamptz,
  synced_to       timestamptz,
  last_attempt_at timestamptz,
  last_error      text CHECK (char_length(last_error) <= 500),
  PRIMARY KEY (person_id, source),
  CONSTRAINT busy_sources_synced_shape CHECK (
    (synced_at IS NULL) = (synced_from IS NULL) AND
    (synced_at IS NULL) = (synced_to IS NULL) AND
    (synced_to IS NULL OR synced_to > synced_from))
);

COMMIT;
