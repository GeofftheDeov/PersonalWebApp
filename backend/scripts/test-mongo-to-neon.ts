/**
 * Test for the prod Mongo -> Neon load (#49) against the committed fixture dump.
 *
 * The fixture (scripts/mongo-to-neon/fixture-dump) was written by the July
 * build's own Mongoose models and dumped with a real mongodump — see
 * seed-prod-era-fixture.ts — so its shapes are production's, not a guess.
 *
 * Needs three empty databases built from db/schema.sql. scripts/mongo-to-neon/check.sh
 * builds them and runs this:
 *
 *   M2N_A=postgresql://…/m2n_a M2N_B=…/m2n_b M2N_C=…/m2n_c npx tsx scripts/test-mongo-to-neon.ts
 *
 * What it proves, against local Postgres only (Neon is unreachable from where
 * this was written): the load is complete, deterministic, all-or-nothing, and
 * refuses the wrong target. What it CANNOT prove: that production's dump has no
 * shape this fixture lacks. That is what the profile and --dry-run steps against
 * the real dump are for.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import pg from "pg";
import { idFor, load, MAPS, plan, readDump, TARGET_TABLES } from "./mongo-to-neon.js";

const DUMP = "scripts/mongo-to-neon/fixture-dump/personal_web_app";
const [A, B, C] = [process.env.M2N_A, process.env.M2N_B, process.env.M2N_C];
if (!A || !B || !C) { console.error("Set M2N_A, M2N_B, M2N_C to three empty release-schema databases."); process.exit(2); }

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
    ok ? pass++ : fail++;
}

/** Run the CLI the way a person would. Returns exit code and combined output. */
function cli(url: string, ...args: string[]): { code: number; out: string } {
    try {
        const out = execFileSync("npx", ["tsx", "scripts/mongo-to-neon.ts", ...args, "--report", "/tmp/m2n-test-report.json", DUMP],
            { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { code: 0, out };
    } catch (e: any) {
        return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
}

const db = (url: string) => new pg.Client({ connectionString: url });
async function q(url: string, sql: string, params: any[] = []) {
    const c = db(url); await c.connect();
    try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}

/** Every target table, every row, in id order — the whole load as one hash. */
async function fingerprint(url: string): Promise<string> {
    const h = createHash("sha256");
    for (const t of TARGET_TABLES) {
        const rows = await q(url, `SELECT to_jsonb(t) AS r FROM ${t} t ORDER BY id`);
        h.update(t);
        for (const r of rows) h.update(JSON.stringify(r.r));
    }
    return h.digest("hex");
}

const dump = readDump(DUMP);
const hex = (coll: string, pred: (d: any) => boolean) => dump[coll].find(pred)._id.toHexString();
const byEmail = (coll: string, e: string) => hex(coll, (d) => (d.email ?? "").toLowerCase() === e);

console.log("\n=== refusals (nothing may be written) ===");
{
    const r = cli(A, "--dry-run");
    check("refuses an unacknowledged unmapped collection", r.code === 1 && /Collections no model owns: migrations/.test(r.out), r.out.slice(-400));
    check("refuses unacknowledged data loss (a Lead's API key)", /cannot exist in the release schema/.test(r.out));
    check("…and wrote nothing", (await q(A, "SELECT count(*)::int n FROM sf_users"))[0].n === 0);
}

console.log("\n=== the load ===");
const ACK = ["--allow-unmapped", "--accept-data-loss"];
{
    const dry = cli(A, "--dry-run", ...ACK);
    check("dry run passes", dry.code === 0 && /Dry run passed/.test(dry.out), dry.out.slice(-600));
    check("dry run leaves nothing behind", (await q(A, "SELECT count(*)::int n FROM messages"))[0].n === 0);

    const app = cli(A, "--apply", ...ACK, "--batch", "100");   // 283 messages: three batches
    check("apply commits", app.code === 0 && /Committed/.test(app.out), app.out.slice(-600));
    check("every collection reconciles (source = inserted + excluded)", !/does not reconcile/.test(app.out));
}

const report = JSON.parse((await import("node:fs")).readFileSync("/tmp/m2n-test-report.json", "utf8"));
for (const m of MAPS) {
    const src = report.sourceCounts[m.collection] ?? 0;
    const exc = report.excluded.filter((e: any) => e.collection === m.collection).length;
    const [{ n }] = await q(A, `SELECT count(*)::int n FROM ${m.table}`);
    if (src !== n + exc) check(`${m.collection} -> ${m.table} count`, false, `source ${src}, rows ${n}, excluded ${exc}`);
}
check("row counts match the dump for all 21 tables", true);

console.log("\n=== ids ===");
{
    const admin = byEmail("users", "geoff.admin@example.test");
    const [row] = await q(A, "SELECT id FROM sf_users WHERE lower(email) = 'geoff.admin@example.test'");
    check("id = uuidv5(ObjectId) (deterministic, documented namespace)", row?.id === idFor(admin), `${row?.id} vs ${idFor(admin)}`);
    const bad = await q(A, TARGET_TABLES.map((t) => `SELECT '${t}' t, count(*)::int n FROM ${t} WHERE substr(id::text,15,1) <> '5'`).join(" UNION ALL "));
    check("every migrated row id is a v5 uuid (none minted by gen_random_uuid)", bad.every((r: any) => r.n === 0), JSON.stringify(bad.filter((r: any) => r.n)));
}

console.log("\n=== passwords: the #49 acceptance test, at the hash level ===");
{
    const cases: [string, string, string][] = [
        ["sf_users", "geoff.admin@example.test", "Admin-Pass-1!"],
        ["sf_leads", "lena@example.test", "lead-pässwörd-ü"],
        ["sf_contacts", "casey@example.test", "contact-pw-42"],
        ["sf_accounts", "morgan@example.test", "was-a-lead-first"],
        ["sf_users", "legacy.larry@example.test", "legacy-pw"],
    ];
    for (const [t, e, pw] of cases) {
        const [r] = await q(A, `SELECT password FROM ${t} WHERE lower(email) = $1`, [e]);
        check(`${t} ${e} keeps their existing password`, !!r && await bcrypt.compare(pw, r.password));
    }
    const [biz] = await q(A, "SELECT password FROM sf_accounts WHERE email = 'hello@dragondice.test'");
    check("a Salesforce business account with no password stays passwordless", biz && biz.password === null);
}

console.log("\n=== references ===");
{
    // Every DM thread in the dump, found again by the key the APP builds from the
    // two people's new ids — [a, b].sort().join(":") in messageRoutes.
    const threads = new Map<string, number>();
    for (const m of dump.messages) if (m.dmKey) threads.set(m.dmKey, (threads.get(m.dmKey) ?? 0) + 1);
    const flips = [...threads.keys()].filter((k) => { const [a, b] = k.split(":"); return idFor(a) > idFor(b); });
    check("the fixture has DM threads whose order FLIPS under mapping (else the next check proves nothing)",
        flips.length > 0, `${threads.size} threads, none flip — regenerate the fixture`);
    const lost: string[] = [];
    for (const [k, count] of threads) {
        const appKey = k.split(":").map(idFor).sort().join(":");
        const [{ n }] = await q(A, "SELECT count(*)::int n FROM messages WHERE dm_key = $1", [appKey]);
        if (n !== count) lost.push(`${k}: ${count} in Mongo, ${n} found by the app's key`);
    }
    check(`every DM thread (${threads.size}, ${flips.length} flipped) is found by the app's key with every message`,
        lost.length === 0, lost.join("; "));
    const unsorted = await q(A, `SELECT dm_key FROM messages WHERE dm_key IS NOT NULL
                                  AND split_part(dm_key, ':', 1) > split_part(dm_key, ':', 2)`);
    check("no DM key is out of order", unsorted.length === 0);

    const hexLeft = await q(A, `
        SELECT 'notifications' t, id::text FROM notifications WHERE link ~ '[0-9a-f]{24}' OR source_key ~ '[0-9a-f]{24}'
        UNION ALL SELECT 'messages', id::text FROM messages WHERE sender_id ~ '^[0-9a-f]{24}$' OR recipient ~ '^[0-9a-f]{24}$'
        UNION ALL SELECT 'tasks', id::text FROM tasks WHERE owner_id ~ '^[0-9a-f]{24}$'
        UNION ALL SELECT 'game_sessions', id::text FROM game_sessions WHERE ready_check::text ~ '[0-9a-f]{24}'`);
    check("no ObjectId survives in an id-bearing text field", hexLeft.length === 0, JSON.stringify(hexLeft));

    const [meta] = await q(A, "SELECT meta FROM notifications WHERE meta ? 'importBatch'");
    check("a 24-hex string that is NOT an id is left alone", meta?.meta.importBatch === "abcdefabcdefabcdefabcdef");
    check("…while an id nested in the same meta is rewritten", meta?.meta.nested.campaignId === idFor(hex("campaigns", () => true)));

    const [task] = await q(A, "SELECT owner_id FROM tasks WHERE sf_id = '00THs00000TASK001'");
    check("a Salesforce owner id is not mistaken for an ObjectId", task?.owner_id === "005Hs00000OWNER01");

    const [rc] = await q(A, "SELECT ready_check FROM game_sessions WHERE title = 'Into the Mists'");
    const responses = rc?.ready_check?.responses ?? [];
    check("ready-check responses: Mongoose subdocument _ids dropped", responses.length === 3 && responses.every((r: any) => !("_id" in r)));
    check("ready-check responses: playerIds are person uuids",
        responses[0]?.playerId === idFor(byEmail("users", "sam@example.test")));

    const [ghost] = await q(A, "SELECT count(*)::int n FROM sf_accounts WHERE email = 'morgan@example.test'");
    const deleted = report.dangling.find((d: any) => d.collection === "messages" && d.column === "sender_id")?.ref;
    const [samFriends] = await q(A, "SELECT friends FROM sf_users WHERE email = 'sam@example.test'");
    check("a friend who was deleted in Mongo is still in the array (parity, not repair)",
        ghost.n === 1 && !!deleted && samFriends.friends.includes(idFor(deleted)));
}

console.log("\n=== the schema's own ON DELETE rules, applied to already-deleted parents ===");
{
    const exc = report.excluded.map((e: any) => `${e.collection}:${e.reason.startsWith("DATA LOSS") ? "loss" : "cascade"}`).sort();
    check("exactly two rows excluded: a seat in a deleted campaign, and the Lead's API key",
        JSON.stringify(exc) === JSON.stringify(["apikeyvaults:loss", "campaignmembers:cascade"]), JSON.stringify(exc));
    const nulled = report.nulled.map((n: any) => `${n.collection}.${n.column}`).sort();
    check("three references set NULL (deleted lead, deleted dungeon, deleted account)",
        JSON.stringify(nulled) === JSON.stringify(["campaignmembers.lead_id", "characters.dungeon_id", "opportunities.account_id"]),
        JSON.stringify(nulled));
    const [ch] = await q(A, "SELECT dungeon_id FROM characters WHERE name = $1", ["Strahd's Rival"]);
    check("…and that is what landed", ch && ch.dungeon_id === null);
}

console.log("\n=== legacy and odd shapes ===");
{
    const larryHex = byEmail("users", "legacy.larry@example.test");
    const [larry] = await q(A, "SELECT created_at, role, is_verified, friends, favorite_games FROM sf_users WHERE id = $1", [idFor(larryHex)]);
    const born = dump.users.find((d: any) => d._id.toHexString() === larryHex)._id.getTimestamp();
    check("no createdAt: taken from the ObjectId, not the time of the load", larry && +larry.created_at === +born);
    check("missing role / isVerified / arrays take the schema defaults",
        larry?.role === "user" && larry?.is_verified === false && larry?.friends.length === 0 && larry?.favorite_games.length === 0);
    check("an unmapped field is reported, not silently dropped", report.unknownFields?.users?.username === 1);
    const [nulls] = await q(A, "SELECT friends, favorite_games FROM sf_contacts WHERE name = 'Null Arrays'");
    check("explicit null arrays become '{}' (the columns are NOT NULL)", nulls && nulls.friends.length === 0 && nulls.favorite_games.length === 0);
    check("the email shared by a User and a Lead is reported", report.sharedEmails.some((s: any) => s.email === "sam@example.test"));
}

console.log("\n=== what it must not touch ===");
{
    const rows = await q(A, `SELECT (SELECT count(*) FROM accounts)::int a, (SELECT count(*) FROM account_source_links)::int l,
                                    (SELECT count(*) FROM person_outbox)::int o, (SELECT count(*) FROM sf_profile_role_map)::int m`);
    check("accounts / links / outbox stay empty — that is Phase 2's job", rows[0].a === 0 && rows[0].l === 0 && rows[0].o === 0);
    check("the role map seed is untouched", rows[0].m === 1);
}

console.log("\n=== determinism: the same dump gives the same database ===");
{
    check("fresh database B loads", cli(B, "--apply", ...ACK).code === 0);
    const fa = await fingerprint(A), fb = await fingerprint(B);
    check("A and B are identical, row for row", fa === fb, `${fa.slice(0, 12)} vs ${fb.slice(0, 12)}`);
    const again = cli(A, "--apply", ...ACK);
    check("a second run into a loaded database is refused without --replace", again.code === 1 && /already hold rows/.test(again.out));
    check("--replace re-runs cleanly", cli(A, "--apply", "--replace", ...ACK).code === 0);
    check("…and produces the identical database again", (await fingerprint(A)) === fa);
}

console.log("\n=== all-or-nothing ===");
{
    // A Lead with no last name violates sf_leads.last_name NOT NULL. Mongoose
    // would not have saved it; a raw write could have. Load into C with it.
    const bad = readDump(DUMP);
    bad.leads[0] = { ...bad.leads[0], lastName: undefined };
    const p = plan(bad);
    const c = db(C); await c.connect();
    await c.query("BEGIN");
    const res = await load(c, p, 50);
    await c.query("ROLLBACK");
    const want = bad.leads[0]._id.toHexString();
    check("the failing row is named, with Postgres's reason",
        res.errors.length === 1 && res.errors[0].id === want && /last_name/.test(res.errors[0].error), JSON.stringify(res.errors));
    check("every other row still went in (the batch was retried row by row)",
        res.inserted.sf_leads === bad.leads.length - 1 && res.inserted.messages === bad.messages.length);
    await c.end();
    check("after rollback, C is empty", (await q(C, "SELECT count(*)::int n FROM sf_leads"))[0].n === 0);
}

console.log("\n=== wrong target ===");
{
    await q(C, "INSERT INTO accounts (id, email) VALUES (gen_random_uuid(), 'x@example.test')");
    const r = cli(C, "--dry-run", ...ACK);
    check("refuses a branch where the Phase 2 backfill has already run", r.code === 1 && /accounts holds 1 rows/.test(r.out));
    await q(C, "DELETE FROM accounts");
    await q(C, "ALTER TABLE campaign_invites RENAME COLUMN from_user TO from_account_id");
    const r2 = cli(C, "--dry-run", ...ACK);
    check("refuses a Phase 3-shaped schema", r2.code === 1 && /not the release \(b18fa67\) schema/.test(r2.out));
    await q(C, "ALTER TABLE campaign_invites RENAME COLUMN from_account_id TO from_user");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
