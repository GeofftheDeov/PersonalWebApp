-- ============================================================================
-- 2026-09-25 — saved list views for the admin table browser (/db, "The Workshop")
--
-- A list view is a named, saved presentation of one table: which columns show
-- and in what order, their widths, the sort, the quick search and the field
-- filters. They live here rather than in localStorage so they follow the admin
-- across browsers and devices.
--
-- Views are shared by every admin rather than owned by one. The portal has one
-- real operator, and keying views to a person id would orphan them the moment
-- that id is remapped (the phase-3 cutover already resolves old token ids to
-- accounts.id). created_by is informational only — no FK, per the person-ref
-- rules in 2026-08-14-drop-person-fks.sql.
--
-- config shape (validated in services/listViews.ts, not here):
--   { columns: [{ key, width, hidden }], sort: [{ key, order }],
--     search: "", filters: [{ key, op, value }] }
--
-- Idempotent: safe to re-run.
--
-- APPLIED: Neon production branch br-autumn-salad-aj8biq1v, 2026-09-26. 4
-- statements in one transaction, all successful. Not yet on dev.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS admin_list_views (
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

-- At most one default view per table.
CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_list_views_default
  ON admin_list_views (collection) WHERE is_default;

DROP TRIGGER IF EXISTS trg_admin_list_views_updated ON admin_list_views;
CREATE TRIGGER trg_admin_list_views_updated BEFORE UPDATE ON admin_list_views
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
