/**
 * Schema parity: does db/schema.sql agree with the Phase 3 migrations?
 *
 * PR #46 resolved a schema.sql conflict by keeping the base branch's side, which
 * silently reverted #42. Two of the three parts landed, so the migration file
 * sat in the repo advertising a fix that schema.sql still contradicted, and the
 * ticket read as closed while the bug still reproduced. That is worse than not
 * landing at all, because the next person has less reason to suspect it.
 *
 * This script makes that class of divergence impossible to miss. It introspects
 * two databases and diffs them:
 *
 *   A  built from the PRE-Phase-3 schema.sql, then migrated forward
 *   B  built from the current schema.sql in one shot
 *
 * They must be identical for every table the cutover touches. Run it via
 * scripts/phase3-check.sh, which builds both.
 *
 *   PARITY_MIGRATED=... PARITY_FRESH=... npx tsx scripts/test-phase3-parity.ts
 */
import pg from "pg";

const TABLES = [
    "accounts", "account_source_links", "person_outbox",
    "campaign_members", "campaign_invites", "friend_requests",
    "api_key_vault", "cloud_claw_sessions",
    "characters", "player_sessions", "notifications", "messages", "game_sessions",
];

const COLUMNS_SQL = `
  SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = ANY($1)
   ORDER BY table_name, column_name`;

const CONSTRAINTS_SQL = `
  SELECT c.conrelid::regclass::text AS table_name,
         c.contype,
         pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public' AND t.relname = ANY($1)
   ORDER BY 1, 2, 3`;

const INDEXES_SQL = `
  SELECT tablename, indexdef FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = ANY($1)
   ORDER BY 1, 2`;

/** Constraint and index names differ harmlessly between the two paths; the shape does not. */
const normalise = (s: string) =>
    s.replace(/^CREATE (UNIQUE )?INDEX \S+ ON/, "CREATE $1INDEX ON")
     .replace(/\s+/g, " ")
     .trim();

async function introspect(url: string) {
    const client = new pg.Client({ connectionString: url, ssl: false });
    await client.connect();
    try {
        const cols = await client.query(COLUMNS_SQL, [TABLES]);
        const cons = await client.query(CONSTRAINTS_SQL, [TABLES]);
        const idx = await client.query(INDEXES_SQL, [TABLES]);
        return {
            columns: cols.rows.map((r) =>
                `${r.table_name}.${r.column_name} ${r.data_type} ` +
                `null=${r.is_nullable} default=${r.column_default ?? "-"}`),
            // Constraint DEFINITIONS are compared, not names: the migration path
            // inherits names from the columns it renamed, the fresh path gets
            // Postgres' own. A difference in definition is the real signal.
            constraints: cons.rows.map((r) => `${r.table_name} [${r.contype}] ${normalise(r.def)}`),
            indexes: idx.rows.map((r) => `${r.tablename} ${normalise(r.indexdef)}`),
        };
    } finally {
        await client.end();
    }
}

function diff(label: string, a: string[], b: string[]): string[] {
    const setA = new Set(a);
    const setB = new Set(b);
    const out: string[] = [];
    for (const x of a) if (!setB.has(x)) out.push(`  migrated only : ${label}: ${x}`);
    for (const x of b) if (!setA.has(x)) out.push(`  schema.sql only: ${label}: ${x}`);
    return out;
}

async function main() {
    const migratedUrl = process.env.PARITY_MIGRATED;
    const freshUrl = process.env.PARITY_FRESH;
    if (!migratedUrl || !freshUrl) {
        console.error("Set PARITY_MIGRATED and PARITY_FRESH to two database URLs.");
        process.exit(2);
    }

    const [migrated, fresh] = await Promise.all([introspect(migratedUrl), introspect(freshUrl)]);

    const problems = [
        ...diff("column", migrated.columns, fresh.columns),
        ...diff("constraint", migrated.constraints, fresh.constraints),
        ...diff("index", migrated.indexes, fresh.indexes),
    ];

    if (problems.length === 0) {
        console.log(`  PASS  schema.sql matches the migrated schema ` +
            `(${migrated.columns.length} columns, ${migrated.constraints.length} constraints, ` +
            `${migrated.indexes.length} indexes across ${TABLES.length} tables)`);
        return;
    }

    console.log(`  FAIL  schema.sql and the migrations disagree — ${problems.length} difference(s):`);
    for (const p of problems) console.log(p);
    console.log("\n  A migration that schema.sql contradicts is the PR #46 failure. Fix schema.sql.");
    process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
