-- Phase 3 (#35), slice 1: rewrite every stored person reference to an accounts.id.
--
-- WHY THIS EXISTS, since #35 does not mention it.
--
-- The Phase 2 merge (#34) collapsed 40 landing rows into 19 accounts. Nineteen
-- rows donated their UUID to the account they won; the other twenty kept ids
-- that are not any accounts.id. Phase 2's assertion was that every reference
-- still RESOLVES -- via accounts.id OR account_source_links.source_id -- and
-- that was the correct bar while the app still read the four landing tables
-- through personUtils' four-way fanout.
--
-- Phase 3 changes what the app reads. `SELECT ... FROM accounts WHERE id = $1`
-- against a merged-away id returns zero rows: no error, no log line, just a
-- friends list one person shorter and a character with no player. So the ids
-- have to be rewritten once, here, before the app cuts over.
--
-- Two of the columns below are in neither #35 nor Phase 2's reference sweep:
--   * game_sessions.ready_check -> responses[].playerId  (a person id in jsonb)
--   * messages.dm_key                                    (sorted "<idA>:<idB>")
-- A stale dm_key is the nastiest of the set: dmKeyFor(newId, otherId) computes
-- a different key, so the existing thread is not wrong, it is simply invisible.
--
-- Idempotent: re-running remaps nothing, because after the first pass no
-- reference matches a non-primary source_id. Safe to run before the app deploy.

BEGIN;

-- Every merged-away source id and the account it belongs to now.
CREATE TEMP TABLE _remap ON COMMIT DROP AS
SELECT l.source_id AS old_id, l.account_id AS new_id
  FROM account_source_links l
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = l.source_id);

CREATE UNIQUE INDEX ON _remap (old_id);

-- ── plain uuid columns ──────────────────────────────────────────────────────
UPDATE friend_requests t SET from_user = r.new_id FROM _remap r WHERE t.from_user = r.old_id;
UPDATE friend_requests t SET to_user   = r.new_id FROM _remap r WHERE t.to_user   = r.old_id;

UPDATE campaign_invites t SET from_user = r.new_id FROM _remap r WHERE t.from_user = r.old_id;
UPDATE campaign_invites t SET to_user   = r.new_id FROM _remap r WHERE t.to_user   = r.old_id;

UPDATE notifications   t SET user_id   = r.new_id FROM _remap r WHERE t.user_id   = r.old_id;
UPDATE characters      t SET player_id = r.new_id FROM _remap r WHERE t.player_id = r.old_id;
UPDATE player_sessions t SET player_id = r.new_id FROM _remap r WHERE t.player_id = r.old_id;

-- ── text columns holding a person id ────────────────────────────────────────
UPDATE messages t SET sender_id = r.new_id::text FROM _remap r WHERE t.sender_id = r.old_id::text;
UPDATE messages t SET recipient = r.new_id::text FROM _remap r WHERE t.recipient = r.old_id::text;

-- dm_key must be re-sorted after substitution, or the pair no longer matches
-- what dmKeyFor() produces at read time.
UPDATE messages t
   SET dm_key = (
        SELECT string_agg(part, ':' ORDER BY part)
          FROM (
            SELECT COALESCE(r2.new_id::text, p.part) AS part
              FROM unnest(string_to_array(t.dm_key, ':')) AS p(part)
              LEFT JOIN _remap r2
                ON p.part ~ '^[0-9a-f-]{36}$' AND r2.old_id = p.part::uuid
          ) mapped
      )
 WHERE t.dm_key IS NOT NULL
   AND EXISTS (
        SELECT 1 FROM unnest(string_to_array(t.dm_key, ':')) AS p(part)
          JOIN _remap r3 ON p.part ~ '^[0-9a-f-]{36}$' AND r3.old_id = p.part::uuid
      );

-- ── uuid[] ──────────────────────────────────────────────────────────────────
-- Substitute, then de-duplicate: a friends array holding both a losing Contact
-- and the Account it merged into would otherwise list the same person twice.
-- Self-references (being friends with your own duplicate) drop out.
UPDATE accounts a
   SET friends = COALESCE((
        SELECT array_agg(DISTINCT mapped)
          FROM (
            SELECT COALESCE(r.new_id, f.val) AS mapped
              FROM unnest(a.friends) AS f(val)
              LEFT JOIN _remap r ON r.old_id = f.val
          ) x
         WHERE mapped <> a.id
       ), '{}'::uuid[])
 WHERE EXISTS (SELECT 1 FROM unnest(a.friends) AS f(val) JOIN _remap r ON r.old_id = f.val);

-- ── jsonb: game_sessions.ready_check.responses[].playerId ───────────────────
UPDATE game_sessions g
   SET ready_check = jsonb_set(
        g.ready_check,
        '{responses}',
        (SELECT COALESCE(jsonb_agg(
                  CASE WHEN r.new_id IS NULL THEN resp.value
                       ELSE jsonb_set(resp.value, '{playerId}', to_jsonb(r.new_id::text))
                  END), '[]'::jsonb)
           FROM jsonb_array_elements(g.ready_check -> 'responses') AS resp(value)
           LEFT JOIN _remap r
             ON (resp.value ->> 'playerId') ~ '^[0-9a-f-]{36}$'
            AND r.old_id = (resp.value ->> 'playerId')::uuid)
      )
 WHERE jsonb_typeof(g.ready_check -> 'responses') = 'array'
   AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(g.ready_check -> 'responses') AS resp(value)
          JOIN _remap r ON (resp.value ->> 'playerId') ~ '^[0-9a-f-]{36}$'
                       AND r.old_id = (resp.value ->> 'playerId')::uuid
      );

-- ── collapses the remap creates ─────────────────────────────────────────────
-- Two ends of a request that merged into one person is a request to yourself.
DELETE FROM friend_requests WHERE from_user = to_user;
DELETE FROM campaign_invites WHERE from_user = to_user;

-- ...and two rows that merged into the same pair are now duplicates. Keep the
-- oldest, so an already-accepted friendship is not replaced by a later pending one.
DELETE FROM friend_requests f USING friend_requests keep
 WHERE least(f.from_user, f.to_user) = least(keep.from_user, keep.to_user)
   AND greatest(f.from_user, f.to_user) = greatest(keep.from_user, keep.to_user)
   AND (keep.created_at, keep.id) < (f.created_at, f.id);

DELETE FROM campaign_invites i USING campaign_invites keep
 WHERE i.campaign_id = keep.campaign_id
   AND i.from_user = keep.from_user AND i.to_user = keep.to_user
   AND (keep.created_at, keep.id) < (i.created_at, i.id);

-- ── assert, loudly ──────────────────────────────────────────────────────────
-- Anything still unresolvable is a person id pointing at a row that never got
-- an account (the excluded test lead, or a row added since the backfill). That
-- is a data question for a human, not something to silently drop.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(site || ':' || n, ', ' ORDER BY site) INTO bad
  FROM (
    SELECT site, count(*)::int AS n FROM (
      SELECT 'friend_requests.from_user' AS site, from_user AS pid FROM friend_requests
      UNION ALL SELECT 'friend_requests.to_user', to_user FROM friend_requests
      UNION ALL SELECT 'campaign_invites.from_user', from_user FROM campaign_invites
      UNION ALL SELECT 'campaign_invites.to_user', to_user FROM campaign_invites
      UNION ALL SELECT 'notifications.user_id', user_id FROM notifications
      UNION ALL SELECT 'characters.player_id', player_id FROM characters
      UNION ALL SELECT 'player_sessions.player_id', player_id FROM player_sessions
      UNION ALL SELECT 'accounts.friends[]', unnest(friends) FROM accounts
    ) refs
    WHERE pid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = refs.pid)
    GROUP BY site
  ) g;

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'phase3 remap: person references still unresolvable -> %', bad;
  END IF;

  SELECT string_agg(site || ':' || n, ', ' ORDER BY site) INTO bad
  FROM (
    SELECT site, count(*)::int AS n FROM (
      SELECT 'messages.sender_id' AS site, sender_id AS pid FROM messages
      UNION ALL SELECT 'messages.recipient', recipient FROM messages WHERE recipient IS NOT NULL
      UNION ALL SELECT 'messages.dm_key', part FROM messages,
             unnest(string_to_array(dm_key, ':')) AS p(part) WHERE dm_key IS NOT NULL
      UNION ALL SELECT 'ready_check.playerId', resp.value ->> 'playerId'
             FROM game_sessions, jsonb_array_elements(ready_check -> 'responses') AS resp(value)
            WHERE jsonb_typeof(ready_check -> 'responses') = 'array'
    ) refs
    WHERE pid IS NOT NULL AND pid <> 'system' AND pid ~ '^[0-9a-f-]{36}$'
      AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id::text = refs.pid)
    GROUP BY site
  ) g;

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'phase3 remap: text/jsonb person references still unresolvable -> %', bad;
  END IF;
END $$;

COMMIT;
