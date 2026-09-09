/**
 * Phase 3 (#35) regression suite.
 *
 * Run against a throwaway local Postgres built from db/schema.sql — Neon is
 * unreachable from a session environment on every port, so a pass here proves
 * LOGIC, never dev data:
 *
 *   DATABASE_URL="postgresql://postgres@127.0.0.1:5433/pwatest" npx tsx scripts/test-phase3.ts
 *
 * Sections map to the agreed slices. Each is expected to fail until its slice
 * lands; a section that passes before its slice is written is a bug in the
 * test, not good news (see the Phase 2 fixture lesson in phase3-fixture.ts).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pool from "../db/index.js";
import { buildFixture, IDS, LOSING_IDS, PASSWORD } from "./phase3-fixture.js";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

/** Apply a Phase 3 migration exactly as it would be applied to dev. */
async function applyMigration(client: any, file: string): Promise<string | null> {
    try {
        await client.query(readFileSync(join(MIGRATIONS, file), "utf8"));
        return null;
    } catch (err: any) {
        // A migration that fails must leave the suite red, not blow it up — the
        // remaining assertions still describe what it should have produced.
        try { await client.query("ROLLBACK"); } catch { /* not in a transaction */ }
        return String(err.message).split("\n")[0];
    }
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(name: string, ok: boolean, detail = "") {
    if (ok) { passed++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`); }
    else { failed++; failures.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** Run a check that may reference not-yet-existing columns; a thrown error is a failure, not a crash. */
async function check(name: string, fn: () => Promise<[boolean, string]>) {
    try {
        const [ok, detail] = await fn();
        assert(name, ok, detail);
    } catch (err: any) {
        assert(name, false, `threw: ${String(err.message).split("\n")[0]}`);
    }
}

function section(title: string) {
    console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

async function main() {
    const client = await pool.connect();
    try {
        await buildFixture(client);
        console.log("Fixture built: 9 landing rows, 4 accounts, 7 links, 3 losing ids.");

        // ── S1: reference remap ──────────────────────────────────────────────
        section("S1 — every person reference is an accounts.id");

        const remapErr = await applyMigration(client, "2026-09-09-phase3-remap-person-refs.sql");
        assert("the remap migration applies", remapErr === null, remapErr ?? "clean");

        // The distinction that matters. Phase 2 asserted references RESOLVE
        // (accounts.id OR account_source_links.source_id). After Phase 3 the app
        // reads accounts directly, so resolving via a link is no longer enough:
        // the id itself has to be an account id.
        await check("no person reference points at a non-primary source id", async () => {
            const { rows } = await client.query(`
                WITH refs AS (
                  SELECT 'friend_requests.from_user' AS site, from_user AS pid FROM friend_requests
                  UNION ALL SELECT 'friend_requests.to_user', to_user FROM friend_requests
                  UNION ALL SELECT 'campaign_invites.from_user', from_user FROM campaign_invites
                  UNION ALL SELECT 'campaign_invites.to_user', to_user FROM campaign_invites
                  UNION ALL SELECT 'notifications.user_id', user_id FROM notifications
                  UNION ALL SELECT 'characters.player_id', player_id FROM characters
                  UNION ALL SELECT 'player_sessions.player_id', player_id FROM player_sessions
                  UNION ALL SELECT 'accounts.friends[]', unnest(friends) FROM accounts
                )
                SELECT r.site, count(*)::int AS n
                  FROM refs r
                 WHERE r.pid IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = r.pid)
                 GROUP BY 1 ORDER BY 1`);
            return [rows.length === 0,
                rows.length === 0 ? "0 dangling"
                    : rows.map((r: any) => `${r.site}:${r.n}`).join(", ")];
        });

        // messages.sender_id was in Phase 2's sweep; messages.recipient was not.
        await check("messages.sender_id and .recipient both resolve to accounts", async () => {
            const { rows } = await client.query(`
                WITH refs AS (
                  SELECT 'sender_id' AS site, sender_id AS pid FROM messages
                  UNION ALL SELECT 'recipient', recipient FROM messages WHERE recipient IS NOT NULL
                )
                SELECT site, count(*)::int AS n FROM refs
                 WHERE pid <> 'system' AND pid ~ '^[0-9a-f-]{36}$'
                   AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id::text = pid)
                 GROUP BY 1 ORDER BY 1`);
            return [rows.length === 0,
                rows.length === 0 ? "0 dangling"
                    : rows.map((r: any) => `${r.site}:${r.n}`).join(", ")];
        });

        await check("the excluded lead is referenced by nothing", async () => {
            const { rows } = await client.query(`
                SELECT count(*)::int AS n FROM (
                  SELECT from_user pid FROM friend_requests UNION ALL SELECT to_user FROM friend_requests
                  UNION ALL SELECT user_id FROM notifications
                  UNION ALL SELECT player_id FROM characters
                  UNION ALL SELECT player_id FROM player_sessions
                  UNION ALL SELECT unnest(friends) FROM accounts
                ) r WHERE r.pid = $1`, [IDS.L2]);
            return [rows[0].n === 0, `${rows[0].n} reference(s)`];
        });

        // A remap that drops rows instead of rewriting them would pass the check
        // above trivially. Count the rows too.
        await check("the remap rewrote rows rather than deleting them", async () => {
            const { rows } = await client.query(`
                SELECT (SELECT count(*) FROM characters)::int AS chars,
                       (SELECT count(*) FROM notifications)::int AS notifs,
                       (SELECT count(*) FROM friend_requests)::int AS reqs,
                       (SELECT count(*) FROM player_sessions)::int AS sess,
                       (SELECT count(*) FROM messages)::int AS msgs,
                       (SELECT count(*) FROM campaign_invites)::int AS invites`);
            const r = rows[0];
            const ok = r.chars === 1 && r.notifs === 1 && r.reqs === 1
                && r.sess === 1 && r.msgs === 3 && r.invites === 1;
            return [ok, JSON.stringify(r)];
        });

        // Group A's three source rows all collapse to one account, so the
        // character (via C1) and the player_session (via A1) must land on the
        // SAME person. This is the check that catches a remap that resolves to
        // the wrong group.
        await check("remapped rows land on the correct account", async () => {
            const { rows } = await client.query(`
                SELECT (SELECT player_id FROM characters LIMIT 1) AS ch,
                       (SELECT player_id FROM player_sessions LIMIT 1) AS ps,
                       (SELECT user_id FROM notifications LIMIT 1) AS nt,
                       (SELECT to_user FROM friend_requests LIMIT 1) AS fr`);
            const r = rows[0];
            const ok = r.ch === IDS.acctA && r.ps === IDS.acctA
                && r.nt === IDS.acctA && r.fr === IDS.acctC;
            return [ok, `character=${r.ch} session=${r.ps} notif=${r.nt} request=${r.fr}`];
        });

        await check("accounts.friends[] holds account ids only", async () => {
            const { rows } = await client.query(
                `SELECT friends FROM accounts WHERE id = $1`, [IDS.acctA]);
            const friends: string[] = rows[0]?.friends ?? [];
            const ok = friends.length === 1 && friends[0] === IDS.acctC;
            return [ok, `friends=[${friends.join(", ")}] (was [${IDS.C2}], a losing Contact)`];
        });

        await check("ready_check.responses[].playerId was remapped in place", async () => {
            const { rows } = await client.query(
                `SELECT jsonb_agg(r.value ->> 'playerId' ORDER BY r.value ->> 'name') AS ids,
                        jsonb_array_length(ready_check -> 'responses') AS n
                   FROM game_sessions, jsonb_array_elements(ready_check -> 'responses') AS r(value)
                  GROUP BY ready_check`);
            const ids: string[] = rows[0]?.ids ?? [];
            const ok = rows[0]?.n === 2 && ids.includes(IDS.acctA) && ids.includes(IDS.acctB)
                && !ids.includes(IDS.C1);
            return [ok, `responses=${rows[0]?.n} playerIds=[${ids.join(", ")}]`];
        });

        await check("dm_key was remapped and re-sorted", async () => {
            const { rows } = await client.query(
                `SELECT dm_key FROM messages WHERE dm_key IS NOT NULL`);
            const expected = [IDS.acctA, IDS.acctB].sort().join(":");
            return [rows.length === 1 && rows[0].dm_key === expected,
                `dm_key=${rows[0]?.dm_key} expected=${expected}`];
        });

        await check("a request whose two ends merged into one person was dropped", async () => {
            const { rows } = await client.query(
                `SELECT count(*)::int AS self FROM friend_requests WHERE from_user = to_user`);
            return [rows[0].self === 0, `${rows[0].self} self-request(s) left`];
        });

        await check("re-running the remap changes nothing", async () => {
            const before = await client.query(
                `SELECT (SELECT count(*) FROM friend_requests)::int a,
                        (SELECT count(*) FROM campaign_invites)::int b,
                        (SELECT md5(string_agg(id::text || friends::text, '|' ORDER BY id))
                           FROM accounts) c`);
            const err = await applyMigration(client, "2026-09-09-phase3-remap-person-refs.sql");
            const after = await client.query(
                `SELECT (SELECT count(*) FROM friend_requests)::int a,
                        (SELECT count(*) FROM campaign_invites)::int b,
                        (SELECT md5(string_agg(id::text || friends::text, '|' ORDER BY id))
                           FROM accounts) c`);
            const same = JSON.stringify(before.rows[0]) === JSON.stringify(after.rows[0]);
            return [err === null && same, err ?? (same ? "identical" : "second run mutated data")];
        });

        await check("resolveAccountId maps old ids, and refuses ids with no account", async () => {
            const { resolveAccountId, resolveAccountIds } = await import("../utils/accountRefs.js");
            const fromLosing = await resolveAccountId(IDS.C1);      // merged away -> Group A
            const fromWinner = await resolveAccountId(IDS.acctB);   // already an account
            const excluded = await resolveAccountId(IDS.L2);        // never graduated
            const batch = await resolveAccountIds([IDS.C2, IDS.acctD, IDS.L2, "not-a-uuid"]);
            const ok = fromLosing === IDS.acctA && fromWinner === IDS.acctB && excluded === null
                && batch.get(IDS.C2) === IDS.acctC && batch.get(IDS.acctD) === IDS.acctD
                && !batch.has(IDS.L2) && batch.size === 2;
            return [ok, `losing->${fromLosing === IDS.acctA ? "account" : fromLosing}, `
                + `winner->${fromWinner === IDS.acctB ? "self" : fromWinner}, `
                + `excluded->${excluded}, batch=${batch.size}`];
        });

        // ── S2: schema additions ─────────────────────────────────────────────
        section("S2 — schema additions");

        const schemaErr = await applyMigration(client, "2026-09-09-phase3-schema-additions.sql");
        assert("the schema migration applies", schemaErr === null, schemaErr ?? "clean");

        await check("every campaign_members row carries a resolvable person_id", async () => {
            const { rows } = await client.query(`
                SELECT count(*) FILTER (WHERE person_id IS NULL)::int AS nulls,
                       count(*) FILTER (WHERE person_id IS NOT NULL
                         AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = person_id))::int AS dangling,
                       count(*)::int AS total
                  FROM campaign_members`);
            const r = rows[0];
            return [r.nulls === 0 && r.dangling === 0 && r.total === 3,
                `${r.total} rows, ${r.nulls} null, ${r.dangling} dangling`];
        });

        // The email-only row is the one campaignRoutes' `else` branch writes for
        // a User. It has no lead/contact/account id, so it can only be resolved
        // by email — the case §3.5 flags and #27 counted as zero on dev today.
        await check("the email-only member row resolved by email", async () => {
            const { rows } = await client.query(
                `SELECT person_id, status FROM campaign_members
                  WHERE lead_id IS NULL AND contact_id IS NULL AND account_id IS NULL`);
            return [rows.length === 1 && rows[0].person_id === IDS.acctA,
                rows.length ? `status=${rows[0].status} person_id=${rows[0].person_id}` : "row missing"];
        });

        await check("campaign_invites carries from_account_id / to_account_id / to_email", async () => {
            const { rows } = await client.query(`
                SELECT column_name FROM information_schema.columns
                 WHERE table_name = 'campaign_invites'
                   AND column_name IN ('from_account_id','to_account_id','to_email','from_user','to_user')
                 ORDER BY 1`);
            const cols = rows.map((r: any) => r.column_name);
            const ok = cols.includes("from_account_id") && cols.includes("to_account_id")
                && cols.includes("to_email")
                && !cols.includes("from_user") && !cols.includes("to_user");
            return [ok, `columns: ${cols.join(", ") || "none"}`];
        });

        await check("an invite may name an email with no account yet", async () => {
            await client.query(
                `INSERT INTO campaign_invites (campaign_id, from_account_id, to_email)
                 VALUES ($1,$2,'newcomer@example.com')`, [IDS.campaign, IDS.acctB]);
            const { rows } = await client.query(
                `SELECT count(*)::int AS n FROM campaign_invites
                  WHERE to_account_id IS NULL AND to_email IS NOT NULL`);
            // ...and may not name neither.
            let rejected = false;
            try {
                await client.query(
                    `INSERT INTO campaign_invites (campaign_id, from_account_id) VALUES ($1,$2)`,
                    [IDS.campaign, IDS.acctB]);
            } catch { rejected = true; }
            return [rows[0].n === 1 && rejected,
                `email-only invites=${rows[0].n}, target CHECK rejects empty=${rejected}`];
        });

        await check("friend_requests, api_key_vault and cloud_claw_sessions FK accounts(id)", async () => {
            const { rows } = await client.query(`
                SELECT c.conrelid::regclass::text AS tbl,
                       c.confrelid::regclass::text AS refs
                  FROM pg_constraint c
                 WHERE c.contype = 'f'
                   AND c.conrelid::regclass::text IN
                       ('friend_requests','api_key_vault','cloud_claw_sessions')
                 ORDER BY 1`);
            const byTable = new Map(rows.map((r: any) => [r.tbl, r.refs]));
            const want = ["friend_requests", "api_key_vault", "cloud_claw_sessions"];
            const ok = want.every((t) => byTable.get(t) === "accounts");
            return [ok, want.map((t) => `${t}->${byTable.get(t) ?? "none"}`).join(", ")];
        });

        await check("a friend request to a non-account is now refused by the database", async () => {
            let rejected = false;
            try {
                await client.query(
                    `INSERT INTO friend_requests (from_user, to_user) VALUES ($1,$2)`,
                    [IDS.acctA, LOSING_IDS[0]]);
            } catch { rejected = true; }
            return [rejected, rejected ? "rejected" : "accepted a dangling id"];
        });

        // ── S3/S4/S5: application cutover ────────────────────────────────────
        section("S3/S4/S5 — application cutover");

        const { findPersonById, findPersonByHandle, findPeopleByEmail, toPublicPerson } =
            await import("../utils/personUtils.js");
        const Account = (await import("../models/Account.js")).default;
        const CampaignMember = (await import("../models/CampaignMember.js")).default;
        const bcrypt = (await import("bcryptjs")).default;

        await check("personUtils resolves against accounts", async () => {
            const byId = await findPersonById(IDS.acctA);
            const byHandle = await findPersonByHandle("GEOFF", "0001");   // case-insensitive
            const byEmail = await findPeopleByEmail(["ashley.early@example.com"]);
            // A merged-away id is NOT a person any more. That is the whole point
            // of the slice-1 remap: nothing in the database still says C1, and
            // anything arriving from outside goes through resolveAccountId first.
            const losing = await findPersonById(IDS.C1);
            const ok = byId?.doc?._id === IDS.acctA
                && byHandle?.doc?._id === IDS.acctA
                && byEmail.length === 1 && byEmail[0].doc._id === IDS.acctD
                && losing === null;
            return [ok, `id=${byId?.doc?._id === IDS.acctA}, handle=${byHandle?.doc?._id === IDS.acctA}, `
                + `email=${byEmail.length}, losing-id=${losing === null ? "not a person" : "STILL RESOLVES"}`];
        });

        await check("no vestigial `type` survives on a resolved person", async () => {
            const person = await findPersonById(IDS.acctA);
            const pub: any = person ? toPublicPerson(person) : {};
            // `type` is gone; sf_object survives as provenance under recordType.
            const ok = person !== null && !("type" in (person as any))
                && pub.recordType === "User";
            return [ok, `type present=${person && "type" in (person as any)}, recordType=${pub.recordType}`];
        });

        await check("login matrix: one query, every source, right answer", async () => {
            // A person merged from each of the four Salesforce objects. Group C
            // has no email on any source row, which is true of most of dev, so
            // it cannot log in at all — that is not a regression, it is the
            // reason #35's four-source login matrix is not satisfiable as
            // written and Group C is asserted to fail here on purpose.
            const cases: Array<[string, string | null, boolean]> = [
                ["User-sourced", "geoffrey.murray.1995@gmail.com", true],
                ["Lead-sourced", "gdrumz@momurrays.com", true],
                ["Contact-sourced", "ashley.early@example.com", true],
                ["Account-sourced (no email anywhere)", null, false],
            ];
            const results: string[] = [];
            let ok = true;
            for (const [label, email, shouldSucceed] of cases) {
                if (email === null) { results.push(`${label}: no email, cannot log in`); continue; }
                const person: any = await Account.findOne({ email });
                const matched = person?.password
                    ? await bcrypt.compare(PASSWORD, person.password) : false;
                if (matched !== shouldSucceed) ok = false;
                results.push(`${label}: ${matched ? "ok" : "FAILED"}`);
            }
            // Case-insensitivity is the citext column, not a regex scan.
            const upper = await Account.findOne({ email: "GEOFFREY.MURRAY.1995@GMAIL.COM" });
            if (upper?._id !== IDS.acctA) ok = false;
            results.push(`mixed-case lookup: ${upper?._id === IDS.acctA ? "ok" : "FAILED"}`);
            return [ok, results.join("; ")];
        });

        await check("identity gates read app_role, never tier or provenance", async () => {
            const { getAuthorizedCampaignIds, isCampaignGameMaster } =
                await import("../utils/gameNightPlannerUtils.js");

            // Admin sees everything.
            const adminScope = await getAuthorizedCampaignIds({ id: IDS.acctA, email: "x" });
            // A patron who is NOT an admin must not: this is the #28 split. Group
            // C is account_tier 'patron' and app_role 'user'.
            const patronScope = await getAuthorizedCampaignIds({ id: IDS.acctC, email: "x" });
            const leadScope = await getAuthorizedCampaignIds({ id: IDS.acctB, email: "x" });

            const adminIsGm = await isCampaignGameMaster({ id: IDS.acctA }, IDS.campaign);
            const patronIsGm = await isCampaignGameMaster({ id: IDS.acctC }, IDS.campaign);

            const ok = adminScope === null
                && Array.isArray(patronScope) && patronScope.length === 1
                && Array.isArray(leadScope) && leadScope.length === 1
                && adminIsGm === true && patronIsGm === false;
            return [ok, `admin=all(${adminScope === null}), patron=${(patronScope as any)?.length} campaign(s), `
                + `lead=${(leadScope as any)?.length}, adminGM=${adminIsGm}, patronGM=${patronIsGm}`];
        });

        await check("a tier change never moves access (#28)", async () => {
            // The whole reason app_role and account_tier are two columns.
            await Account.findByIdAndUpdate(IDS.acctB, { $set: { accountTier: "patron" } });
            const stillNotAdmin = await Account.findById(IDS.acctB).select("appRole accountTier");
            const scope = await (await import("../utils/gameNightPlannerUtils.js"))
                .getAuthorizedCampaignIds({ id: IDS.acctB, email: "x" });
            await Account.findByIdAndUpdate(IDS.acctB, { $set: { accountTier: "free" } });
            const ok = stillNotAdmin?.appRole === "user" && scope !== null;
            return [ok, `promoted to patron -> app_role=${stillNotAdmin?.appRole}, sees all=${scope === null}`];
        });

        await check("the Paperclip gate admits admins and Salesforce users, nobody else", async () => {
            // Mirrors paperclipOnly: app_role = 'admin' OR sf_object = 'User'.
            const allowed = async (id: string) => {
                const p = await Account.findById(id).select("appRole sfObject");
                return Boolean(p && (p.appRole === "admin" || p.sfObject === "User"));
            };
            const admin = await allowed(IDS.acctA);        // admin AND User-sourced
            const lead = await allowed(IDS.acctB);         // neither
            const patron = await allowed(IDS.acctC);       // patron tier, not admin
            const ok = admin === true && lead === false && patron === false;
            return [ok, `admin=${admin}, lead=${lead}, patron(tier only)=${patron}`];
        });

        await check("requireAdmin closes /admin and /db (#43)", async () => {
            const { requireAdmin } = await import("../middleware/auth.js");
            const gate = requireAdmin(false);

            const run = (id: string) => new Promise<number>((resolve) => {
                const res: any = {
                    status(code: number) { this.__code = code; return this; },
                    json() { resolve(this.__code); return this; },
                    send() { resolve(this.__code); return this; },
                };
                gate({ adminUser: { id }, originalUrl: "/db/users" }, res, () => resolve(200));
            });

            const asAdmin = await run(IDS.acctA);
            const asLead = await run(IDS.acctB);     // the repro in #43
            const asPatron = await run(IDS.acctC);   // paid, still not staff
            const ok = asAdmin === 200 && asLead === 403 && asPatron === 403;
            return [ok, `admin=${asAdmin}, ordinary user=${asLead}, patron=${asPatron}`];
        });

        await check("the admin gate rests on the manual pin, and says so", async () => {
            // Every admin gate in the app depends on one row. sf_profile is NULL
            // everywhere, so sf_profile_role_map resolves everyone to 'user';
            // only app_role_source = 'manual' keeps the pin alive through a merge.
            const { rows } = await client.query(
                `SELECT count(*)::int AS admins,
                        count(*) FILTER (WHERE app_role_source = 'manual')::int AS pinned,
                        count(*) FILTER (WHERE sf_profile IS NOT NULL)::int AS with_profile
                   FROM accounts WHERE app_role = 'admin'`);
            const r = rows[0];
            return [r.admins === 1 && r.pinned === 1 && r.with_profile === 0,
                `${r.admins} admin(s), ${r.pinned} pinned manually, ${r.with_profile} derived from sf_profile`];
        });

        await check("campaign membership is one indexed lookup, and complete", async () => {
            // The old four-way OR included an unindexed email match, and the GM
            // row it had to find that way was the email-only one.
            const gm = await CampaignMember.findOne({
                campaign: IDS.campaign, status: "Game Master" });
            const mine = await CampaignMember.find({ person: IDS.acctA });
            const ok = String(gm?.person) === IDS.acctA && mine.length === 1;
            return [ok, `GM person=${gm?.person}, memberships for Geoff=${mine.length}`];
        });

        console.log(`\n${passed} passed, ${failed} failed`);
        if (failures.length) console.log(`Failing: ${failures.join(" · ")}`);
        console.log(`Password for login tests: ${PASSWORD}`);
        process.exitCode = failed ? 1 : 0;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((err) => { console.error(err); process.exit(1); });
