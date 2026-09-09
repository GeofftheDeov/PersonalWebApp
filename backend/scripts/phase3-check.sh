#!/usr/bin/env bash
# Phase 3 (#35) full check. Builds two throwaway Postgres databases and runs
# both suites against them:
#
#   pwa_migrated  pre-Phase-3 schema.sql  ->  fixture  ->  Phase 3 migrations
#   pwa_fresh     current schema.sql, in one shot
#
# The first proves the migrations do what they claim. The second, compared
# against the first, proves schema.sql says the same thing they do — the check
# that PR #46 did not have.
#
# Neon is unreachable from any session environment (403 at the egress gateway on
# every port; no DNS on the desktop shell), so this proves LOGIC ONLY. Anything
# depending on real dev rows has to be run against dev by hand.
#
# The first database must start from the schema DEV ACTUALLY HAS, so the ref
# below is the branch point, not HEAD -- once the Phase 3 schema.sql is
# committed, HEAD already contains the change and the "migration path" would be
# migrating a database that never needed migrating. Override for a different base.
#
#   bash scripts/phase3-check.sh [<git-ref-for-pre-phase3-schema>]
set -euo pipefail

BASE_REF="${1:-origin/dev}"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGPORT="${PGPORT:-5433}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # backend/

command -v "$PGBIN/psql" >/dev/null || { echo "No Postgres at $PGBIN"; exit 2; }

psql_as() { su pgtest -c "$PGBIN/psql -h /tmp -p $PGPORT -U postgres $*"; }

# Pre-Phase-3 schema, so the migration path starts where dev actually is.
git -C "$HERE/.." show "$BASE_REF:backend/db/schema.sql" > /tmp/schema-pre-phase3.sql
cp "$HERE/db/schema.sql" /tmp/schema-current.sql
chmod 644 /tmp/schema-pre-phase3.sql /tmp/schema-current.sql

for db in pwa_migrated pwa_fresh; do
  su pgtest -c "$PGBIN/dropdb -h /tmp -p $PGPORT -U postgres --if-exists $db"
  su pgtest -c "$PGBIN/createdb -h /tmp -p $PGPORT -U postgres $db"
done

psql_as "-q -v ON_ERROR_STOP=1 -d pwa_migrated -f /tmp/schema-pre-phase3.sql"
psql_as "-q -v ON_ERROR_STOP=1 -d pwa_fresh    -f /tmp/schema-current.sql"

echo "=== Phase 3 suite (migration path) ==="
cd "$HERE"
status=0
DATABASE_URL="postgresql://postgres@127.0.0.1:$PGPORT/pwa_migrated" npx tsx scripts/test-phase3.ts \
  || status=$?

echo
echo "=== schema.sql parity ==="
PARITY_MIGRATED="postgresql://postgres@127.0.0.1:$PGPORT/pwa_migrated" \
PARITY_FRESH="postgresql://postgres@127.0.0.1:$PGPORT/pwa_fresh" \
  npx tsx scripts/test-phase3-parity.ts || status=1

exit $status
