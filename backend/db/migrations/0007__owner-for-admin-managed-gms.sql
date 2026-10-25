-- An admin-managed campaign (no owner) that has a Game Master is owned by them
-- (PR #193). From this release a claim or a pass into an ownerless campaign
-- sets its owner; this catches the ones that got a Game Master before that,
-- through an admin's pass or an owner's account being deleted (owner_id is
-- ON DELETE SET NULL).
--
-- The same rule 2026-10-01-session-planning.sql backfilled with: the earliest
-- Game Master. Data only. The code running before this release reads owner_id
-- the same way, so it copes. Re-running it changes nothing.

BEGIN;

UPDATE campaigns c
   SET owner_id = gm.person_id
  FROM (SELECT DISTINCT ON (campaign_id) campaign_id, person_id
          FROM campaign_members
         WHERE status = 'Game Master' AND person_id IS NOT NULL AND is_active
         ORDER BY campaign_id, joined_at NULLS LAST, created_at, id) gm
 WHERE c.id = gm.campaign_id
   AND c.owner_id IS NULL;

COMMIT;
