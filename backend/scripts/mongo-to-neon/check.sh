#!/usr/bin/env bash
# #49 check: build three throwaway databases from the release schema.sql and
# run scripts/test-mongo-to-neon.ts against the committed fixture dump.
#
# Local Postgres only. Neon is unreachable from the environment this was
# written in, so this proves the LOGIC; the real dump's profile and --dry-run
# against a Neon branch prove the data.
#
#   bash scripts/mongo-to-neon/check.sh
set -euo pipefail

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGPORT="${PGPORT:-5433}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # backend/

cp "$HERE/db/schema.sql" /tmp/m2n-schema.sql
chmod 644 /tmp/m2n-schema.sql
for db in m2n_a m2n_b m2n_c; do
  su pgtest -c "$PGBIN/dropdb -h /tmp -p $PGPORT -U postgres --if-exists $db"
  su pgtest -c "$PGBIN/createdb -h /tmp -p $PGPORT -U postgres $db"
  su pgtest -c "$PGBIN/psql -q -v ON_ERROR_STOP=1 -h /tmp -p $PGPORT -U postgres -d $db -f /tmp/m2n-schema.sql"
done

cd "$HERE"
U="postgresql://postgres@127.0.0.1:$PGPORT"
M2N_A="$U/m2n_a" M2N_B="$U/m2n_b" M2N_C="$U/m2n_c" npx tsx scripts/test-mongo-to-neon.ts
