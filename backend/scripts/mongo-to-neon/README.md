# Prod Mongo → Neon `production` (#49)

The data half of the platform cutover (#45). Production runs the July build
(4ca0afec) on a Mongo sidecar. The parity release (this branch, cut from b18fa67)
runs on Postgres. Nothing else moves the data: the Salesforce sync would assign
`SF_IMPORT_*` placeholder passwords and lock everyone out, and nine tables
(friends, chat, notifications, invites, …) exist only in Mongo.

| File | What it is |
|---|---|
| `../mongo-to-neon.ts` | The load. Reads a `mongodump` directory and writes the release schema. |
| `../test-mongo-to-neon.ts` + `check.sh` | 46 checks against the fixture on local Postgres. |
| `fixture-dump/` | The fixture: written through the July build's own Mongoose models, dumped with a real `mongodump`. |
| `seed-prod-era-fixture.ts` | How the fixture was made (run from a 4ca0afec checkout). |
| `rehearse-app-parity.ts` | Logs in as each persona on BOTH builds (July on Mongo, release on the migrated Postgres) and compares what each person sees. |

## What the load does

- **Ids.** Every ObjectId becomes `uuidv5(hex, 9c87b100-6902-445f-a65e-558e34b8a9f4)`. The same dump always gives the same database, so a dry run predicts the real run and a failed run can be re-run.
- **Person rows** land in `sf_users` / `sf_accounts` / `sf_contacts` / `sf_leads`, which is what the release build reads. The unified `accounts` table stays empty; filling it is the Phase 2 backfill (#34), a later, reversible step.
- **Passwords** are copied hash for hash. Nobody's password changes.
- **Ids inside text** are rewritten: DM keys (then re-sorted, because uuid order is not ObjectId order), message sender and recipient, notification links, source keys and meta, ready-check player ids, task owners. A 24-hex string that is not an id is left alone.
- **References to deleted documents** follow the schema's own `ON DELETE` rule: a CASCADE column excludes the row, a SET NULL column becomes NULL. Person references with no FK (friends, DMs, requests, characters) are kept: they dangled in Mongo, and they dangle the same way here. That's parity; the load doesn't repair anything.
- **It refuses** to run against anything that is not the release schema, a branch where `accounts` has rows, target tables that already hold rows (without `--replace`), collections no model owns (without `--allow-unmapped`), and rows the release schema cannot hold (without `--accept-data-loss`).
- **All or nothing.** One transaction. If any row fails, Postgres gives the reason for each failing row by id, and the whole load rolls back.

## Proven, and not proven

Proven, on local Postgres 16 against the fixture:

- the load is complete, deterministic and all-or-nothing, and every refusal fires;
- every persona (User, Lead with a non-ASCII password, Contact, converted Account, legacy User) logs in with their existing password;
- through the release build, each persona sees what they saw through the July build. Every remaining difference is a code change between the builds, not data.

Proven on Neon (2026-09-25, branch `rehearsal-49-mongo-to-neon`, Postgres 18):

- the three Phase 1 migrations apply cleanly to `production`'s real schema;
- the result matches `schema.sql`: 303 columns identical, and 119 constraints and indexes with an identical hash.

Not proven, and only the real dump can prove it:

- that production's data has no shape the fixture lacks. That is what the profile and `--dry-run` steps are for;
- the load itself against Neon over the network. Its first run there is the `--dry-run` in step 4.

## Runbook

**0. Decide about what's already on `production`.** As of 2026-09-25 it holds about 74 rows that the Salesforce sync put there before dev branched off in August: 16 accounts, 18 contacts, 2 leads, 1 user, 5 campaigns, 27 members and 5 sessions. They are not prod's data (Mongo is), and the load refuses a non-empty target. Decided (2026-09-25): use `--replace`, which truncates the target tables inside the same transaction, after taking a Neon branch of `production` as the undo.

**1. Dump, as late as possible.** The dump has to come from the running prod task: the Mongo sidecar lives inside it, so scaling the service down would stop Mongo too. Checked on 2026-09-25:

- the prod service has ECS Exec enabled;
- in the live task definition (`:79`) Mongo runs **without auth** (`MONGO_URI` is plain env, and the `mongodb` container has no secrets). The auth setup in the repo's task definition was never deployed.

Stream the archive out as base64 through ECS Exec. You need the AWS CLI plus the Session Manager plugin. This has not been tried yet.

    aws ecs execute-command --cluster artistic-hippopotamus-hw7oq2 --task <prod-task-id> \
      --container mongodb --interactive \
      --command "sh -c 'mongodump --db personal_web_app --archive --gzip --quiet | base64 -w0'" > pwa.b64

Strip the Session Manager banner lines from `pwa.b64`, then `base64 -d` it into `pwa.archive.gz`. Everything written to prod after this moment is lost at cutover, so do it at a quiet hour. The cutover deploy itself (#45) takes about 45 minutes of image builds. Keep this dump: together with task definition `:79` and the untouched EFS volume, it is the rollback.

**2. Verify the dump.** Restore it into a local `mongo:5.0` (Docker Desktop), which also shows it is readable, and re-dump in directory form. The load reads directories, not `--archive`:

    docker run -d --name pwa-mongo -p 27017:27017 mongo:5.0
    mongorestore --gzip --archive=pwa.archive.gz
    mongodump --db personal_web_app --out ./dump

**3. Profile.** No database needed; nothing is written.

    npx tsx scripts/mongo-to-neon.ts ./dump/personal_web_app

Read every section of the output:

- `does not reconcile` must never appear.
- `DATA LOSS` rows need a decision before anything goes further.
- `NOT MIGRATED` collections and fields need a decision too.
- Dangling references are expected. The Lead → Account conversion deletes Leads.
- Shared emails are expected, and the Phase 2 merge will have to adjudicate them.

**4. Rehearse on a Neon branch.** Branch `production`, apply the three Phase 1 migrations in this order:

1. `2026-08-14-drop-person-fks`
2. `2026-08-21-phase1-sf-rename-and-accounts`
3. `2026-08-21-app-role-and-account-tier`

Then:

    $env:DATABASE_URL = "<branch connection string>"
    npx tsx scripts/mongo-to-neon.ts --dry-run --replace ./dump/personal_web_app
    npx tsx scripts/mongo-to-neon.ts --apply   --replace ./dump/personal_web_app

Run `--apply` twice. The second run must give the identical database (#49).

**5. Acceptance (#49).**

- Counts reconcile.
- The reference report is reviewed.
- One person from each of the four source tables logs in with their existing password against the migrated branch.

**6. Production.** Repeat step 4 against `production` itself, at cutover time, from the frozen dump. After that, the ECS cutover (#45 part 3) keeps prod's existing `JWT_SECRET` and `VAULT_ENCRYPTION_KEY`.
