/**
 * Apply SQL migrations without psql.
 *
 * Uses the repo's own `pg` driver and db/index.ts's TLS handling, so it needs
 * nothing that `npm install` in backend/ hasn't already provided. It is also the
 * same mechanism scripts/test-phase3.ts applies migrations with — sending each
 * file as one simple-protocol query — so what runs here is what was tested.
 * (psql is not a given on Windows: the PostgreSQL installer does not put it on
 * PATH, and the Neon SQL editor's statement handling is not something this repo
 * controls.)
 *
 *   # 1. See where you are pointed and what state it is in. Changes nothing.
 *   npx tsx scripts/apply-migration.ts db/migrations/A.sql db/migrations/B.sql
 *
 *   # 2. Run every file and every assertion against the real data, then roll
 *   #    back. The honest answer to "would this work on dev?". Changes nothing.
 *   npx tsx scripts/apply-migration.ts --dry-run db/migrations/A.sql db/migrations/B.sql
 *
 *   # 3. The same, and commit.
 *   npx tsx scripts/apply-migration.ts --apply db/migrations/A.sql db/migrations/B.sql
 *
 * All files run in ONE transaction, in the order given. Each migration file
 * carries its own BEGIN/COMMIT so it can also be run alone; this script strips
 * those and wraps the lot, so a failure anywhere — including an assertion
 * RAISE in the last file — leaves the database exactly as it was.
 */
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import pool from "../db/index.js";

const args = process.argv.slice(2);
const mode = args.includes("--apply") ? "apply" : args.includes("--dry-run") ? "dry-run" : "check";
const files = args.filter((a) => !a.startsWith("--"));

function die(msg: string): never {
    console.error(`\n  ✗ ${msg}\n`);
    process.exit(1);
}

/** Endpoint + database from the URL, never the credentials. */
function describeTarget(url: string) {
    try {
        const u = new URL(url);
        // Neon hosts look like ep-<name>-<id>[-pooler].<region>.aws.neon.tech. The
        // ep-… part identifies the BRANCH: match it against the branch you mean in
        // the Neon console before applying anything.
        const local = /^(127\.|localhost$|\[?::1\]?$)/.test(u.hostname);
        const endpoint = local ? "(local database)" : u.hostname.split(".")[0];
        return { host: u.hostname, endpoint, database: u.pathname.replace(/^\//, "") };
    } catch {
        die("DATABASE_URL is not a valid URL.");
    }
}

/** Strip exactly one leading BEGIN; and one trailing COMMIT; — refuse anything else. */
function bodyOf(file: string, sql: string): string {
    const begins = sql.match(/^BEGIN;\s*$/gm) ?? [];
    const commits = sql.match(/^COMMIT;\s*$/gm) ?? [];
    if (begins.length !== 1 || commits.length !== 1) {
        die(`${basename(file)} must contain exactly one top-level "BEGIN;" line and one "COMMIT;" line ` +
            `(found ${begins.length} and ${commits.length}). Refusing to guess where its transaction is.`);
    }
    return sql.replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, "");
}

async function snapshot(client: any) {
    const q = async (sql: string) => {
        try { return (await client.query(sql)).rows; } catch (e: any) { return [{ error: e.message }]; }
    };
    const [inv] = await q(`
        SELECT bool_or(column_name = 'from_account_id') AS invites_reshaped,
               bool_or(column_name = 'from_user')       AS invites_legacy
          FROM information_schema.columns WHERE table_name = 'campaign_invites'`);
    const [mem] = await q(`
        SELECT count(*) > 0 AS has_person_id FROM information_schema.columns
         WHERE table_name = 'campaign_members' AND column_name = 'person_id'`);
    const [acc] = await q(`SELECT count(*)::int AS accounts FROM accounts`);
    const admins = await q(`
        SELECT email, app_role, app_role_source FROM accounts WHERE app_role = 'admin'`);
    const [dangling] = await q(`
        WITH refs AS (
          SELECT from_user AS pid FROM friend_requests UNION ALL SELECT to_user FROM friend_requests
          UNION ALL SELECT user_id FROM notifications
          UNION ALL SELECT player_id FROM characters
          UNION ALL SELECT player_id FROM player_sessions
          UNION ALL SELECT unnest(friends) FROM accounts)
        SELECT count(*)::int AS n FROM refs r
         WHERE pid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = r.pid)`);
    return { inv, mem, acc, admins, dangling };
}

function report(label: string, s: any) {
    console.log(`\n  ${label}`);
    console.log(`    accounts rows                         ${s.acc?.accounts ?? s.acc?.error}`);
    console.log(`    person refs that are not an account   ${s.dangling?.n ?? s.dangling?.error}` +
        `   (the remap drives this to 0)`);
    console.log(`    campaign_members.person_id exists     ${s.mem?.has_person_id}`);
    console.log(`    campaign_invites reshaped             ${s.inv?.invites_reshaped ? "yes" : "no (still from_user/to_user)"}`);
    const admins = (s.admins ?? []).filter((a: any) => !a.error);
    console.log(`    admins                                ${admins.length
        ? admins.map((a: any) => `${a.email} (${a.app_role_source})`).join(", ")
        : "NONE — every admin gate would lock everybody out"}`);
}

async function main() {
    const url = process.env.DATABASE_URL;
    if (!url) die("Set DATABASE_URL first. In PowerShell:  $env:DATABASE_URL = \"postgresql://…\"");
    if (!files.length) die("Name at least one migration file, in the order to apply them.");

    const target = describeTarget(url);
    const sources = files.map((f) => {
        const path = resolve(f);
        let sql: string;
        try { sql = readFileSync(path, "utf8"); } catch { die(`Cannot read ${f}`); }
        return { name: basename(path), body: bodyOf(f, sql) };
    });

    console.log(`\n  Target    ${target.host}`);
    console.log(`  Branch    ${target.endpoint}   <- match this against the Neon console before --apply`);
    console.log(`  Database  ${target.database}`);
    console.log(`  Mode      ${mode}`);
    console.log(`  Files     ${sources.map((s) => s.name).join("  ->  ")}`);

    const client = await pool.connect();
    try {
        const before = await snapshot(client);
        report("Before", before);

        if (mode === "check") {
            if (before.inv?.invites_reshaped) {
                console.log("\n  Note: campaign_invites is already reshaped — the schema migration looks applied.");
            }
            console.log("\n  Nothing changed. Next: --dry-run to test against this data, then --apply.\n");
            return;
        }

        if (before.inv?.invites_reshaped && sources.some((s) => /schema-additions/.test(s.name))) {
            die("campaign_invites already has from_account_id: the schema migration has been applied " +
                "here already, and re-running it would fail on the column rename. Nothing changed.");
        }

        await client.query("BEGIN");
        for (const s of sources) {
            process.stdout.write(`\n  Running   ${s.name} … `);
            try {
                await client.query(s.body);
                console.log("ok");
            } catch (err: any) {
                console.log("FAILED");
                await client.query("ROLLBACK");
                // The migrations' assertions RAISE with the offending rows named. That
                // message is the useful part — print it whole.
                die(`${s.name}: ${err.message}\n\n  Rolled back. The database is exactly as it was.`);
            }
        }

        const after = await snapshot(client);
        report(mode === "apply" ? "After (about to commit)" : "After (inside the transaction — about to roll back)", after);

        if (mode === "apply") {
            // The one condition worth refusing a commit over: an admin gate that
            // nobody can pass locks the owner out of /admin with no way back in
            // through the UI.
            const admins = (after.admins ?? []).filter((a: any) => !a.error);
            if (!admins.length) {
                await client.query("ROLLBACK");
                die("No account would have app_role = 'admin' afterwards. Rolled back rather than lock you out.");
            }
            await client.query("COMMIT");
            console.log("\n  ✓ Committed.\n");
        } else {
            await client.query("ROLLBACK");
            console.log("\n  ✓ Dry run passed. Rolled back — nothing changed. Re-run with --apply to commit.\n");
        }
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((err) => { console.error(err); process.exit(1); });
