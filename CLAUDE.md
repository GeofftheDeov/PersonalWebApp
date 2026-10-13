# PersonalWebApp

## Backend tests

Run the `backend/scripts/test-*.ts` suites with `npm test` from `backend/` (after `npm ci` in a fresh worktree). Don't set up Postgres yourself: `scripts/run-tests.ts` keeps a private cluster on 127.0.0.1:5439 (initdb'd and started on demand) and gives each suite a fresh database cloned from `db/schema.sql`. To run some suites, name them: `npm test -- person-refs threads`. For a scratch database to work against by hand, `npm test -- --url` prints one. `--list` shows the suites that need more than a database (Redis, CSVs, several databases), each with its header's command. A new suite joins `npm test` when its header documents `DATABASE_URL=… npx tsx scripts/test-<name>.ts`.

## Pull requests

`dev` is the PR target: open every PR against `dev` (`gh pr create --base dev`), even though `main` is the repo's default branch. Pushes to `dev` deploy the dev environment, where changes get tested before they reach prod. A PR into `main` is a promotion, opened only when the user explicitly asks for one.

Cut the branch from `main` (the worktree default). CI rebases `dev` onto `main` after every prod deploy, so `dev` is `main` plus a few commits: a `main`-based branch shows a clean diff against `dev`, and the same branch can later be promoted to `main` carrying only its own commits.

## Schema migrations

Start a migration with `npx tsx scripts/apply-migration.ts --new <kebab-name>` (in `backend/`). It creates `db/migrations/NNNN__<kebab-name>.sql` with the next number. The number sets the order, and the double underscore separates it from the name. Don't add date-named files: the runner refuses them.

Nobody applies migrations by hand. Every PR dry-runs the pending ones against a Neon copy of prod, and the dev and prod deploys dry-run then apply them before the new code starts (`schema_migrations` records what each database has had). So:

- Wrap each file in one `BEGIN;` / `COMMIT;`. All pending files run in one transaction, so nothing that refuses one (`CREATE INDEX CONCURRENTLY`).
- The migration is live a few minutes before its code, so the running code must cope with it: add now, and rename or drop in a later release.
- Never edit a migration once it has been merged. The runner checksums applied files and stops the deploy; write a new one instead.
- Also update `db/schema.sql`, which the `scripts/test-*.ts` databases are built from.
