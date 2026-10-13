# PersonalWebApp

## Pull requests

`dev` is the PR target: open every PR against `dev` (`gh pr create --base dev`), even though `main` is the repo's default branch. Pushes to `dev` deploy the dev environment, where changes get tested before they reach prod. A PR into `main` is a promotion, opened only when the user explicitly asks for one.

Cut the branch from `main` (the worktree default). CI rebases `dev` onto `main` after every prod deploy, so `dev` is `main` plus a few commits: a `main`-based branch shows a clean diff against `dev`, and the same branch can later be promoted to `main` carrying only its own commits.

## Backend tests

Run the `backend/scripts/test-*.ts` suites with `npm test` from `backend/` (after `npm ci` in a fresh worktree). Don't set up Postgres yourself: `scripts/run-tests.ts` keeps a private cluster on 127.0.0.1:5439 (initdb'd and started on demand) and gives each suite a fresh database cloned from `db/schema.sql`. To run some suites, name them: `npm test -- person-refs threads`. For a scratch database to work against by hand, `npm test -- --url` prints one. `--list` shows the suites that need more than a database (Redis, CSVs, several databases), each with its header's command. A new suite joins `npm test` when its header documents `DATABASE_URL=… npx tsx scripts/test-<name>.ts`.
