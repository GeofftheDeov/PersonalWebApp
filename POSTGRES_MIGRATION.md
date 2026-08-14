# MongoDB → Postgres (Neon) Migration Plan

## Why

The dev ECS service has now corrupted its MongoDB WiredTiger data directory on EFS twice (v3 dbpath was itself the fix for the previous corruption — commit `0900310d`). MongoDB's storage engine and EFS's file-locking semantics are a bad combination, and the data model is relational in shape anyway: 21 distinct entities, ObjectId refs used as foreign keys, almost no aggregation pipelines.

Decision (2026-07-20): move **everything** to PostgreSQL on **Neon** (serverless free tier), accessed via **raw SQL with node-postgres** (`pg`). Dev data starts fresh — the corrupted v3 directory is abandoned.

## What was decided

| Decision | Choice | Notes |
|---|---|---|
| Hosting | Neon free tier | $0 for dev-scale; autosuspends when idle; pure Postgres over TLS, reachable from ECS without VPC changes. Neon branching can later give prod/dev DB branches. |
| Data layer | `pg` (node-postgres), raw SQL | No ORM. Pool + query/transaction helpers in `backend/db/index.ts`. |
| Scope | All 21 models | Document-shaped payloads become `jsonb` (Alpaca positions, CloudClaw messages, session ready-checks, notification meta). |
| Existing dev data | Discarded | Fresh seed in dev; v3 EFS data dir is corrupt. |

## Deliverables in this repo

- `backend/db/schema.sql` — full DDL for all tables, indexes, CHECK constraints, and `updated_at` triggers.
- `backend/db/index.ts` — `pg` pool, `query()` helper, `withTransaction()` helper.
- This plan.

## Schema mapping notes

- **IDs**: `uuid` PKs (`gen_random_uuid()`), replacing ObjectIds.
- **Person tables**: `users`, `accounts`, `contacts`, `leads` map 1:1 from mongoose. The cross-collection `friends: [ObjectId]` arrays become the polymorphic `friendships` table (`person_kind`/`friend_kind` discriminators; no FK possible — enforce in the data layer).
- **`sessions`** is named `game_sessions` (avoids collision with auth/session terminology and the SQL keyword-adjacent name).
- **Duplicates**: `Campaign.sync.ts` and `Session.sync.ts` are byte-for-byte duplicates of `Campaign.ts`/`Session.ts` — delete them during the port.
- **Enums** → CHECK constraints; **`Mixed`/embedded docs** → `jsonb`; **`[String]`** → `text[]`.
- **Mongoose indexes** are all replicated (messages by campaign/dmKey + created_at DESC, notification bell/dedupe indexes, api_key_vault unique (user_id, provider), etc.).

### Hook logic that must move to the service layer

Mongoose middleware does real work today; the equivalent must be called explicitly by repositories/services after the port:

1. **bcrypt hashing** on password set/change (`users`, `accounts`, `contacts`, `leads`) — including the "already a bcrypt hash" guard from `Account.ts`.
2. **`user_number` / `user_digit` generation** (random 4-digit + prefixed timestamp: `ADM-`/`ACC-`/`CON-`/`LD-`).
3. **Salesforce sync** post-create for Leads (`createLeadInSalesforce`) and Accounts (`createLeadFromAccount`), writing back `sf_*` fields. Keep these async/background (`setImmediate` pattern in `Lead.ts`).
4. **Message validation**: requires `campaign_id` or `dm_key` — now a table CHECK constraint, but keep the friendly app-layer error.

## Status (2026-07-20): Phases 1–2 implemented

The port is done and verified (typecheck + 19-case functional smoke test against an embedded Postgres). What shipped differs from the original Phase 1 sketch in one deliberate way: instead of hand-rewriting ~380 call sites across 20 route files, `backend/db/model.ts` provides a **mongoose-compatible model layer over parameterized SQL** (no ORM dependency — it's node-postgres underneath). Routes kept their existing `find/findOne/save/populate` call sites; mongoose itself is gone. Idiomizing hot paths to plain SQL via `query()`/`withTransaction()` remains the incremental follow-up.

Implementation notes:

- `friends` stayed as a `uuid[]` column on all four person tables (not a join table) to match `$addToSet`/`$pull` usage; normalizing is future work.
- All 21 models rewritten as `defineModel` table maps in `backend/models/`; hooks (bcrypt, userNumber/userDigit, Salesforce background sync) live in model `preSave`/`postSave` and `models/_shared.ts`.
- `mongoose.startSession()` → `startSession()` from `db/model.ts` (pg transactions); `mongoose.Types.ObjectId.isValid` → `isUuid`.
- The `/db` admin browser now enumerates a model registry instead of raw Mongo collections — field names stay camelCase and hooks still apply.
- `.sync.ts` duplicates and the retired MongoDB dev scripts are stubbed with deprecation notices (file deletion was restricted in-session) — **safe to delete by hand**, along with `routes/dbRoutes.ts.bak`.
- Task definition: mongodb container + mongodb-data EFS volume removed; `DATABASE_URL` and `VAULT_TOKEN` injected from Secrets Manager (`personal-web-app/dev/*`).
- docker-compose: `postgres:16` with `schema.sql` auto-applied on first boot; local `DATABASE_URL` wired. Update `backend/.env` (gitignored) by hand: remove `MONGO_URI`, add `DATABASE_URL`.
- Behavioral nuances vs mongoose worth remembering: `findByIdAndUpdate`/`findOneAndUpdate` always return the *post*-update doc (as if `new: true`); `select()`-narrowed docs refuse `.save()`; unknown filter fields throw instead of silently matching nothing.

## Phases

### Phase 0 — Provision (manual, ~15 min)
1. Create a Neon project (region: AWS us-east-2 to minimize latency to ECS).
2. Create database `personal_web_app`; apply `backend/db/schema.sql` via `psql`.
3. Put the connection string in Secrets Manager (`personal-web-app/dev/DATABASE_URL`) and reference it via `secrets`/`valueFrom` in `.aws/dev-task-definition.json` (same pattern as MUR-182 keys). Remember the CI comment: do not also list it under `environment`.

### Phase 1 — Data layer port
1. `npm i pg` (and `@types/pg`); keep mongoose installed until cutover.
2. For each model, create a repository module (`backend/repositories/*.ts`) exposing the functions routes actually use (find/create/update/delete + the specific queries in routes/services).
3. Reimplement hook logic (above) in services; wire multi-step writes (friend accept → friendship insert + notification) in `withTransaction`.
4. Port routes/services domain-by-domain: auth/users → social (friends/messages/notifications) → tabletop → CRM/tasks → trading/CloudClaw.

### Phase 2 — Cutover
1. Remove `mongoose` imports, delete `backend/models/`, remove MONGO_* env vars.
2. Task definition: delete the `mongodb` container and the `mongodb-data` EFS volume/mount; add `DATABASE_URL` secret. (Keep the `obsidian-vault` EFS volume — unrelated.)
3. `docker-compose.yml`: replace the mongo service with `postgres:16` for local dev.
4. Deploy dev; smoke-test auth, friends, messaging, campaign flows.

### Phase 3 — Cleanup
1. Delete the mongo data from EFS (`dev-mongo5-data-v*` dirs) once stable.
2. Apply the same change to the prod/backend task definition when ready; write a one-off Mongo→Postgres data migration script for prod data at that point (dev needed none).
3. Watch Neon free-tier limits (storage ~0.5 GB, compute hours). Upgrade or move to RDS later if the app outgrows it — it's standard Postgres either way.

## Also worth fixing (found during the 503 investigation)

- `VAULT_TOKEN` for `GeofftheDeov/obsidian-vault` is invalid/expired — backend git pull fails on boot and runs with cached vault data.
