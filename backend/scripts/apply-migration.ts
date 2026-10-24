/**
 * Apply the SQL migrations in db/migrations/ that a database has not had yet.
 *
 * Each database records what it has had in a `schema_migrations` table, so
 * there is nothing to choose by hand: the script finds the pending files and
 * runs them in order. CI does this on every deploy (dev-aws-workflow.yml,
 * backend-aws-workflow.yml) and dry-runs it on a copy of prod for every PR
 * (neon-branches.yml), so running it yourself is only for looking around.
 *
 *   # 1. What has this database had, and what would run? Changes nothing.
 *   npx tsx scripts/apply-migration.ts
 *
 *   # 2. Run every pending file and every assertion against the real data,
 *   #    then roll back. Changes nothing.
 *   npx tsx scripts/apply-migration.ts --dry-run
 *
 *   # 3. The same, and commit.
 *   npx tsx scripts/apply-migration.ts --apply
 *
 *   # Start a new migration: creates db/migrations/<next number>__<name>.sql.
 *   npx tsx scripts/apply-migration.ts --new add-widget-colour
 *
 * Naming: NNNN__kebab-name.sql. The number is the order; the double underscore
 * separates it from the name. Two files may not share a number, which is how
 * two branches that both took the next one get caught (at the PR's dry-run,
 * which checks out the PR merged into its base).
 *
 * The date-named files from before this scheme (LEGACY) keep their names and
 * sort before every numbered file. No new date-named file is accepted.
 *
 * All pending files run in ONE transaction, in order, under an advisory lock
 * so two deploys cannot interleave. Each file carries its own BEGIN/COMMIT so
 * it can also be pasted into a SQL editor; this script strips those and wraps
 * the lot, so a failure anywhere — including an assertion RAISE in the last
 * file — leaves the database exactly as it was. That also means no statement
 * that refuses to run inside a transaction (CREATE INDEX CONCURRENTLY, VACUUM).
 *
 * Files run a few minutes before the code that ships with them goes live, so
 * the running code must cope with the new schema: add, don't rename or drop
 * in the same release the code stops using something.
 *
 * An applied file is checksummed. Editing it afterwards is refused: change the
 * schema with a new file instead.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pool from "../db/index.js";

const DIR = fileURLToPath(new URL("../db/migrations/", import.meta.url));
const NUMBERED = /^(\d{4})__([a-z0-9]+(?:-[a-z0-9]+)*)\.sql$/;

/** Every date-named file there is or will be. They sort before the numbered ones. */
const LEGACY = [
    "2026-08-14-drop-person-fks.sql",
    "2026-08-21-app-role-and-account-tier.sql",
    "2026-08-21-phase1-sf-rename-and-accounts.sql",
    "2026-09-09-phase3-remap-person-refs.sql",
    "2026-09-09-phase3-schema-additions.sql",
    "2026-09-24-phase3-merge-support.sql",
    "2026-09-24-phase3-person-outbox-trigger.sql",
    "2026-09-25-admin-list-views.sql",
    "2026-09-26-agent-runs.sql",
    "2026-10-01-session-planning.sql",
    "2026-10-03-busy-sources.sql",
    "2026-10-03-quest-reminders.sql",
    "2026-10-04-message-client-id.sql",
    "2026-10-04-thread-reads.sql",
];

/**
 * What a database that has never been tracked is taken to have had already:
 * the Phase 1-3 migrations, live on prod and dev since 2026-09-28 and not safe
 * to run twice. The later legacy files are idempotent ("safe to re-run"), so
 * they are not assumed — they run once more, as no-ops where already applied.
 */
const BASELINE = LEGACY.slice(0, LEGACY.indexOf("2026-09-24-phase3-person-outbox-trigger.sql") + 1);

const args = process.argv.slice(2);
const mode = args.includes("--apply") ? "apply"
    : args.includes("--dry-run") ? "dry-run"
    : args.includes("--new") ? "new"
    : "status";

function die(msg: string): never {
    // An ::error:: line becomes an annotation on the workflow run in GitHub.
    console.error(process.env.GITHUB_ACTIONS ? `::error::${msg.replace(/\n/g, "%0A")}` : `\n  ✗ ${msg}\n`);
    process.exit(1);
}

interface Migration { name: string; sql: string; checksum: string }

/** Every file in db/migrations/, in the order they run. Refuses anything misnamed or duplicated. */
function loadMigrations(): Migration[] {
    const names = readdirSync(DIR).filter((f) => f.endsWith(".sql"));
    const numbered: string[] = [];
    const seen = new Map<string, string>();
    for (const name of names) {
        if (LEGACY.includes(name)) continue;
        const m = NUMBERED.exec(name);
        if (!m) die(`db/migrations/${name}: name it NNNN__kebab-name.sql (e.g. 0007__add-widget-colour.sql). ` +
            `Run "npx tsx scripts/apply-migration.ts --new <name>" to get the next number.`);
        const other = seen.get(m[1]);
        if (other) die(`${other} and ${name} share the number ${m[1]}. Renumber the newer one ` +
            `to the next free number.`);
        seen.set(m[1], name);
        numbered.push(name);
    }
    numbered.sort();
    const ordered = [...LEGACY.filter((n) => names.includes(n)), ...numbered];
    return ordered.map((name) => {
        // Line endings and a BOM are the checkout's, not the migration's: a file
        // checked out with CRLF on Windows is the same migration CI hashed with LF.
        const sql = readFileSync(join(DIR, name), "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
        return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    });
}

/** Strip exactly one leading BEGIN; and one trailing COMMIT; — refuse anything else. */
function bodyOf(m: Migration): string {
    const begins = m.sql.match(/^BEGIN;\s*$/gm) ?? [];
    const commits = m.sql.match(/^COMMIT;\s*$/gm) ?? [];
    if (begins.length !== 1 || commits.length !== 1) {
        die(`${m.name} must contain exactly one top-level "BEGIN;" line and one "COMMIT;" line ` +
            `(found ${begins.length} and ${commits.length}). Refusing to guess where its transaction is.`);
    }
    return m.sql.replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, "");
}

function newMigration(name: string | undefined) {
    if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
        die(`Give the new migration a kebab-case name: --new add-widget-colour`);
    }
    const last = loadMigrations().map((m) => NUMBERED.exec(m.name)?.[1]).filter(Boolean).map(Number);
    const file = `${String(Math.max(0, ...last) + 1).padStart(4, "0")}__${name}.sql`;
    writeFileSync(join(DIR, file),
        `-- What this changes and why (GitHub #…).\n--\n` +
        `-- Runs in one transaction with any other pending migration, a few minutes\n` +
        `-- before the code that ships with it is live.\n\nBEGIN;\n\n\n\nCOMMIT;\n`);
    console.log(`\n  Created db/migrations/${file}\n`);
}

/** Endpoint + database from the URL, never the credentials. */
function describeTarget(url: string) {
    try {
        const u = new URL(url);
        // Neon hosts look like ep-<name>-<id>[-pooler].<region>.aws.neon.tech. The
        // ep-… part identifies the BRANCH.
        const local = /^(127\.|localhost$|\[?::1\]?$)/.test(u.hostname);
        return { endpoint: local ? `${u.hostname} (local database)` : u.hostname.split(".")[0], database: u.pathname.replace(/^\//, "") };
    } catch {
        die("DATABASE_URL is not a valid URL.");
    }
}

interface Applied { name: string; checksum: string }

async function readApplied(client: any): Promise<Applied[] | null> {
    const { rows: [t] } = await client.query(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS tracked`);
    if (!t.tracked) return null;
    return (await client.query(`SELECT name, checksum FROM schema_migrations`)).rows;
}

/**
 * Which files are pending, given what the database recorded (null: never
 * tracked, so the BASELINE is assumed). Refuses a recorded file whose contents
 * have changed since.
 */
function plan(files: Migration[], applied: Applied[] | null) {
    const recorded = new Map((applied ?? files.filter((f) => BASELINE.includes(f.name)))
        .map((a) => [a.name, a.checksum]));
    for (const f of files) {
        const sum = recorded.get(f.name);
        if (sum && sum !== f.checksum) {
            die(`${f.name} has changed since it was applied to this database. Applied migrations are ` +
                `history: put the change in a new migration (--new <name>) and restore this file.`);
        }
    }
    const pending = files.filter((f) => !recorded.has(f.name));
    const missing = [...recorded.keys()].filter((n) => !files.some((f) => f.name === n));
    // A numbered file pending below the highest applied one: another branch's
    // migration was promoted first. Fine when they touch different things.
    const highest = Math.max(0, ...[...recorded.keys()].map((n) => Number(NUMBERED.exec(n)?.[1] ?? 0)));
    const outOfOrder = pending.filter((f) => Number(NUMBERED.exec(f.name)?.[1] ?? Infinity) < highest);
    return { pending, missing, outOfOrder };
}

async function adminCount(client: any): Promise<number | null> {
    try {
        return (await client.query(`SELECT count(*)::int AS n FROM accounts WHERE app_role = 'admin'`)).rows[0].n;
    } catch {
        return null;   // no accounts table (an empty local database)
    }
}

async function main() {
    if (mode === "new") return newMigration(args[args.indexOf("--new") + 1]);

    // Read and check every file before touching the database: a misnamed or
    // duplicate file fails the same way with or without one.
    const files = loadMigrations();

    const url = process.env.DATABASE_URL;
    if (!url) die("Set DATABASE_URL first. In PowerShell:  $env:DATABASE_URL = \"postgresql://…\"");
    const target = describeTarget(url);
    console.log(`\n  Branch    ${target.endpoint}`);
    console.log(`  Database  ${target.database}`);
    console.log(`  Mode      ${mode}`);

    const client = await pool.connect();
    try {
        if (mode === "status") {
            const applied = await readApplied(client);
            const { pending, missing, outOfOrder } = plan(files, applied);
            console.log(applied
                ? `  Applied   ${applied.length} migration(s) recorded`
                : `  Applied   not tracked yet: the first --apply records the ${BASELINE.length} Phase 1-3 files as already applied`);
            report(pending, missing, outOfOrder);
            console.log(`\n  Nothing changed.${pending.length ? " Next: --dry-run, then --apply." : ""}\n`);
            return;
        }

        await client.query("BEGIN");
        // Held to the end of the transaction: a second deploy waits here, then
        // finds nothing left to do.
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('schema_migrations'))`);

        const applied = await readApplied(client);
        const { pending, missing, outOfOrder } = plan(files, applied);
        report(pending, missing, outOfOrder);

        if (!applied) {
            await client.query(`
                CREATE TABLE schema_migrations (
                  name       text PRIMARY KEY,
                  checksum   text NOT NULL,
                  applied_at timestamptz NOT NULL DEFAULT now(),
                  -- true: recorded when tracking began, not run by this script
                  baselined  boolean NOT NULL DEFAULT false
                )`);
            for (const f of files.filter((f) => BASELINE.includes(f.name))) {
                await client.query(`INSERT INTO schema_migrations (name, checksum, baselined) VALUES ($1, $2, true)`,
                    [f.name, f.checksum]);
            }
            console.log(`\n  Tracking  started: recorded ${BASELINE.length} Phase 1-3 files as already applied`);
        }

        const adminsBefore = await adminCount(client);
        if (pending.length) console.log();
        for (const f of pending) {
            const body = bodyOf(f);
            process.stdout.write(`  Running   ${f.name} … `);
            try {
                await client.query(body);
                await client.query(`INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)`, [f.name, f.checksum]);
                console.log("ok");
            } catch (err: any) {
                console.log("FAILED");
                await client.query("ROLLBACK");
                // The migrations' assertions RAISE with the offending rows named. That
                // message is the useful part — print it whole.
                die(`${f.name}: ${err.message}\n\nRolled back. The database is exactly as it was.`);
            }
        }

        // The one condition worth refusing a commit over: an admin gate that
        // nobody can pass locks the owner out of /admin with no way back in
        // through the UI.
        const adminsAfter = await adminCount(client);
        if (adminsBefore && !adminsAfter) {
            await client.query("ROLLBACK");
            die("No account would have app_role = 'admin' afterwards. Rolled back rather than lock you out.");
        }

        if (mode === "apply") {
            await client.query("COMMIT");
            console.log(`\n  ✓ Committed ${pending.length} migration(s).\n`);
        } else {
            await client.query("ROLLBACK");
            console.log(`\n  ✓ Dry run passed. Rolled back — nothing changed.\n`);
        }
    } finally {
        client.release();
        await pool.end();
    }
}

function report(pending: Migration[], missing: string[], outOfOrder: Migration[]) {
    console.log(`  Pending   ${pending.length ? pending.map((f) => f.name).join("  ->  ") : "none"}`);
    for (const n of missing) {
        console.log(`  Note      ${n} is recorded as applied here but is not in this checkout (reverted, or from another branch).`);
    }
    for (const f of outOfOrder) {
        console.log(`  Note      ${f.name} runs after a higher-numbered migration (another branch's was promoted first).`);
    }
}

main().catch((err) => { console.error(err); process.exit(1); });
