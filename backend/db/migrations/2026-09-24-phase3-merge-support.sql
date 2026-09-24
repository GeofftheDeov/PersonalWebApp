-- Phase 3 (#35), slice 6c: two small tables the nightly merge needs and neither
-- #35 nor plan §2.8 provides.
--
-- 1. account_merge_exclusions
--
--    Plan §2.8 step 3: "unlinked rows -> create account + primary link". Taken
--    literally, the first nightly merge would give JOHNNY SILVERHAND an account,
--    because he is the one landing row the Phase 2 backfill deliberately left
--    unlinked (#27: a test lead that never graduates). The adjudication that
--    excluded him lived only in a CSV the backfill read once. This makes it
--    durable: a landing row listed here is never linked and never gets an
--    account, however many times the merge runs.
--
-- 2. person_sync_runs
--
--    A ledger of pipeline runs, for two reasons. The admin UI needs "when did
--    this last run, and what happened". And the merge needs one fact from it —
--    when the last merge finished — to resolve shared fields correctly:
--
--    Plan §2.6 says name/first_name/last_name/phone are last-writer-wins by
--    comparing accounts.updated_at with sf_last_synced_at. That does not hold
--    up: set_updated_at bumps updated_at on EVERY write, so accepting a friend
--    request would make the app "win" that person's phone number; and three of
--    the four landing tables record no modification time at all to compare
--    against. The question last-writer-wins is really asking is "does the app
--    hold a change to this field that Salesforce has not seen yet?", and the
--    outbox answers it exactly, per field. The app wins while its change is
--    pending, in flight or failed — or was pushed AFTER THE LAST PULL of that
--    Salesforce object. Until Salesforce's records have been pulled again, the
--    landing table cannot reflect the push, and letting it win would revert the
--    app's value until the following pull restored it. Pulls arrive through our
--    own POST /api/sync/salesforce, so they are recorded here too.
--
--    (A first draft used "pushed since the last merge". That flickers: two
--    manual runs between Salesforce pulls revert and then restore the value.)

BEGIN;

CREATE TABLE IF NOT EXISTS account_merge_exclusions (
  source_table text NOT NULL
    CHECK (source_table IN ('sf_users','sf_leads','sf_contacts','sf_accounts')),
  source_id    uuid NOT NULL,
  reason       text NOT NULL,
  excluded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_table, source_id)
);

-- #27's one exclusion, identified by both halves of what the adjudication
-- recorded (id prefix and email) so it cannot catch a different row. On a
-- database without that row — prod, or a test fixture — this inserts nothing.
INSERT INTO account_merge_exclusions (source_table, source_id, reason)
SELECT 'sf_leads', l.id, 'Test lead, excluded by the #27 merge adjudication (MUR-320)'
  FROM sf_leads l
 WHERE lower(l.email) = 'name@example.com'
   AND l.id::text LIKE '2576df7b%'
   AND NOT EXISTS (SELECT 1 FROM account_source_links s
                    WHERE s.source_table = 'sf_leads' AND s.source_id = l.id)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS person_sync_runs (
  id          bigserial PRIMARY KEY,
  step        text NOT NULL CHECK (step IN ('drain','pull','merge')),
  sf_object   text,          -- pull only: which object's records landed
  trigger     text NOT NULL DEFAULT 'schedule'
                CHECK (trigger IN ('schedule','manual','salesforce')),
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  ok          boolean NOT NULL,
  result      jsonb,
  error       text
);
CREATE INDEX IF NOT EXISTS idx_person_sync_runs_step
  ON person_sync_runs (step, finished_at DESC);

COMMIT;
