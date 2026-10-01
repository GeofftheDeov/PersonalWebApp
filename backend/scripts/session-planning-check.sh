#!/usr/bin/env bash
# Session planning (#57) migration check. Builds two throwaway databases on a
# local Postgres and runs scripts/test-session-planning-migration.ts:
#
#   pwa_sp_migrated  schema.sql as of BASE_REF (before the migration); the test
#                    seeds it, migrates it twice and checks the backfill
#   pwa_sp_fresh     the current schema.sql, in one shot
#
# BASE_REF is pinned to the commit the migration was written against (main at
# 7db3be63, PR #74) rather than a moving ref: once this lands, HEAD and
# origin/main both contain the change, and a "before" database built from them
# would have nothing to migrate -- and would pass.
#
#   bash scripts/session-planning-check.sh [<git-ref-for-pre-migration-schema>]
#
# Needs psql and a local Postgres that accepts the postgres user without a
# password (trust auth), on PGPORT (default 5433). Set PSQL if psql is not on
# PATH, e.g. PSQL="/c/Program Files/PostgreSQL/18/bin/psql.exe".
set -euo pipefail

BASE_REF="${1:-7db3be63}"
PSQL="${PSQL:-psql}"
PGPORT="${PGPORT:-5433}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # backend/
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pg() { "$PSQL" -h 127.0.0.1 -p "$PGPORT" -U postgres -q -v ON_ERROR_STOP=1 "$@"; }

git -C "$HERE/.." show "$BASE_REF:backend/db/schema.sql" > "$TMP/schema-before.sql"

for db in pwa_sp_migrated pwa_sp_fresh; do
  pg -d postgres -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db"
done
pg -d pwa_sp_migrated -f "$TMP/schema-before.sql"
pg -d pwa_sp_fresh    -f "$HERE/db/schema.sql"

cd "$HERE"
MIGRATED_URL="postgresql://postgres@127.0.0.1:$PGPORT/pwa_sp_migrated" \
FRESH_URL="postgresql://postgres@127.0.0.1:$PGPORT/pwa_sp_fresh" \
  npx tsx scripts/test-session-planning-migration.ts
