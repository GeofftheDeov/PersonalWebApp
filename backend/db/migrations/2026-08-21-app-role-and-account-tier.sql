-- ============================================================================
-- 2026-08-21 — app_role / account_tier split and their source maps
--
-- GitHub #28 · Paperclip MUR-321 · map MUR-314 · plan UNIFIED_ACCOUNT_PLAN.md §2.2
--
-- #28 exists because users.role conflates the Salesforce Profile with app
-- authorization. Phase 1 split that into sf_profile (SF-owned mirror) and
-- app_role (app-owned gate). This migration finishes the job and adds the
-- second axis the board asked for on 2026-08-21: an entitlement tier.
--
-- The two axes are deliberately NOT the same column:
--   app_role      — CAN YOU DO IT.   Gates the admin portal and
--                   getAuthorizedCampaignIds. Values: user | admin.
--   account_tier  — WHAT HAVE YOU PAID FOR. Gates supporter-only surface.
--                   Values: free | member | patron.
-- Collapsing them would repeat the exact bug #28 was opened to fix: a tier
-- change would then be able to move somebody's admin access.
--
-- APPLIED: Neon dev branch br-lucky-mud-ajmpdx8u, 2026-08-21. 11 statements,
-- all successful.
-- ============================================================================

BEGIN;

-- ------------------------------------------------------- the tier axis
ALTER TABLE accounts
  ADD COLUMN account_tier text NOT NULL DEFAULT 'free'
    CHECK (account_tier IN ('free','member','patron')),
  ADD COLUMN account_tier_source text NOT NULL DEFAULT 'sf'
    CHECK (account_tier_source IN ('sf','manual'));

COMMENT ON COLUMN accounts.account_tier IS
  'Entitlement tier. free = Lead, no relationship yet. member = Contact, known to the site but has not funded it. patron = Account, has donated to keep it running. NOT an authorization column - see app_role.';
COMMENT ON COLUMN accounts.account_tier_source IS
  'sf = the nightly merge derives this from sf_object. manual = set by hand and the merge must not touch it. Same contract as app_role_source.';

-- --------------------------------------------- Salesforce Profile -> app_role
-- A table, not an inline string comparison: Salesforce admins add Profiles and
-- this will grow. Anything NOT listed here resolves to 'user' — default deny,
-- so a new Profile appearing in the org can never grant admin by accident.
CREATE TABLE sf_profile_role_map (
  sf_profile text PRIMARY KEY,
  app_role   text NOT NULL CHECK (app_role IN ('user','admin')),
  note       text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_sf_profile_role_map_updated BEFORE UPDATE ON sf_profile_role_map
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO sf_profile_role_map (sf_profile, app_role, note) VALUES
  ('System Administrator', 'admin',
   'The only Profile in the org with an assigned User (board, 2026-08-21). Profile exists only on the Salesforce User object, so this map can only ever affect User-sourced accounts.');

-- ------------------------------------------------ sObject -> account_tier
-- Also a table rather than a constant: the tier policy is expected to move.
-- The board intends to revisit where Contacts sit as the paid tiers develop,
-- and that should be an UPDATE, not a deploy.
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
  ('Contact', 'member', 'Known to the site but has not funded it. The middle rung, defined 2026-08-21.'),
  ('Account', 'patron', 'Has donated to keep the site running.'),
  ('User',    'patron', 'Salesforce User - staff. Treated as patron so a tier gate never locks out an operator.');

COMMIT;

-- ============================================================================
-- How the nightly merge applies these (Phase 3, GitHub #35)
--
--   -- app_role: only ever touches User-sourced accounts, and only while the
--   -- app has not been overridden by hand.
--   UPDATE accounts a
--      SET app_role = coalesce(m.app_role, 'user')
--     FROM account_source_links l
--     LEFT JOIN sf_profile_role_map m ON m.sf_profile = a.sf_profile
--    WHERE l.account_id = a.id
--      AND l.source_table = 'sf_users'
--      AND a.app_role_source = 'sf';
--
--   -- account_tier: derived from provenance, same override contract.
--   UPDATE accounts a
--      SET account_tier = t.account_tier
--     FROM sf_object_tier_map t
--    WHERE t.sf_object = a.sf_object
--      AND a.account_tier_source = 'sf';
--
-- Setting either column by hand means setting its *_source to 'manual' in the
-- same statement. That is what makes a grant survive the nightly merge.
-- ============================================================================

-- ============================================================================
-- Rollback:
--   BEGIN;
--     DROP TABLE IF EXISTS sf_object_tier_map;
--     DROP TABLE IF EXISTS sf_profile_role_map;
--     ALTER TABLE accounts DROP COLUMN IF EXISTS account_tier_source;
--     ALTER TABLE accounts DROP COLUMN IF EXISTS account_tier;
--   COMMIT;
-- ============================================================================
