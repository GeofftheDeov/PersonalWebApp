/**
 * Leaving a campaign, and a Game Master removing someone from one, over HTTP.
 *
 *   DELETE /api/campaign-members/:id
 *
 * Mounts the real membership and campaign routers and drives them with real
 * JWTs against a throwaway database loaded from db/schema.sql. Checks what's
 * visible from outside: responses, rows, bell notifications, Table Talk posts
 * and bus events.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-campaign-leave-kick-api.ts
 */
import "./use-test-jwt-secret.js";
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import pool from "../db/index.js";
import { bus } from "../events/index.js";
import campaignRoutes from "../routes/campaignRoutes.js";
import campaignMemberRoutes from "../routes/campaignMemberRoutes.js";
import { signJwt } from "../utils/jwt.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
    console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
    process.exit(2);
}

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
    const d = typeof detail === "string" ? detail : JSON.stringify(detail);
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !d ? "" : `\n          ${d}`}`);
    ok ? pass++ : fail++;
}

async function main() {
    const app = express();
    app.use(express.json());
    app.use("/api/campaigns", campaignRoutes);
    app.use("/api/campaign-members", campaignMemberRoutes);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const removals: any[] = [];
    bus.subscribe("campaign.changed", (p: any) => { if (p.action === "member-removed") removals.push(p); });
    // The in-memory bus hands events over on a later tick.
    const settle = () => new Promise((r) => setTimeout(r, 50));

    const tag = crypto.randomBytes(4).toString("hex");
    const who: Record<string, { id: string; token: string }> = {};
    let cid = "";

    const call = async (method: string, path: string, as: string) => {
        const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${who[as].token}` } });
        return { status: res.status, json: await res.json().catch(() => null) as any };
    };
    const remove = (as: string, memberId: string) => call("DELETE", `/api/campaign-members/${memberId}`, as);
    const memberIds = async (name: string) => (await pool.query(
        `SELECT id FROM campaign_members WHERE campaign_id = $1 AND person_id = $2 ORDER BY created_at`,
        [cid, who[name].id])).rows.map((r) => r.id as string);
    const seat = async (name: string, status: string) => (await pool.query(
        `INSERT INTO campaign_members (campaign_id, person_id, first_name, status) VALUES ($1, $2, $3, $4) RETURNING id`,
        [cid, who[name].id, name, status])).rows[0].id as string;
    const notes = async (name: string) => (await pool.query(
        `SELECT title FROM notifications WHERE user_id = $1 AND title LIKE 'You were removed%'`, [who[name].id])).rows;
    const talk = async () => (await pool.query(
        `SELECT body FROM messages WHERE campaign_id = $1 AND sender_id = 'system' ORDER BY created_at`, [cid])).rows.map((r) => r.body);

    try {
        for (const name of ["gm", "gm2", "p1", "p2", "p3", "p4", "outsider", "admin"]) {
            const email = `leave-${name}-${tag}@example.test`;
            const { rows: [r] } = await pool.query(
                `INSERT INTO accounts (id, handle, email, first_name, app_role, app_role_source)
                 VALUES (gen_random_uuid(), $1, $2, $3, $4, 'manual') RETURNING id`,
                [`${name}_${tag}`, email, name, name === "admin" ? "admin" : "user"]);
            who[name] = { id: r.id, token: signJwt({ id: r.id, email }) };
        }
        const { rows: [camp] } = await pool.query(
            `INSERT INTO campaigns (title, owner_id, gm_title) VALUES ('Exit Wounds ${tag}', $1, 'Host') RETURNING id`, [who.gm.id]);
        cid = camp.id;
        const gmSeat = await seat("gm", "Game Master");
        const p1Seat = await seat("p1", "Player");
        const p2Seat = await seat("p2", "Player");
        await seat("p2", "Player"); // a duplicate row, as some migrated people have
        const p3Seat = await seat("p3", "Player");
        const p4Seat = await seat("p4", "Player");
        // p1 is the stand-in Host of one night still to come, and was of one already played.
        const { rows: [upcoming] } = await pool.query(
            `INSERT INTO game_sessions (title, campaign_id, date, status, gm_override_id)
             VALUES ('Upcoming', $1, now() + interval '7 days', 'scheduled', $2) RETURNING id`, [cid, who.p1.id]);
        const { rows: [played] } = await pool.query(
            `INSERT INTO game_sessions (title, campaign_id, date, status, gm_override_id)
             VALUES ('Played', $1, now() - interval '7 days', 'completed', $2) RETURNING id`, [cid, who.p1.id]);
        const override = async (id: string) =>
            (await pool.query(`SELECT gm_override_id FROM game_sessions WHERE id = $1`, [id])).rows[0].gm_override_id;

        console.log("\nWho may remove whom\n");

        const byPlayer = await remove("p3", p4Seat);
        check("a player can't remove someone else, and is told who can (the GM title)",
            byPlayer.status === 403 && /Only the Host/.test(byPlayer.json?.error), byPlayer);
        check("nor can someone outside the party", (await remove("outsider", p4Seat)).status === 403);
        check("an unknown member is a 404", (await remove("gm", crypto.randomUUID())).status === 404);
        check("...and so is one that isn't an id", (await remove("gm", "not-an-id")).status === 404);
        await settle();
        check("refused removals change nothing and publish nothing",
            (await memberIds("p4")).length === 1 && removals.length === 0, removals);

        console.log("\nLeaving\n");

        const left = await remove("p1", p1Seat);
        check("a player leaves", left.status === 200 && left.json.left === true && left.json.personId === who.p1.id, left);
        check("their seat is gone", (await memberIds("p1")).length === 0);
        await settle();
        check("leaving publishes campaign.changed (member-removed)",
            removals.some((p) => p.campaignId === cid && p.personId === who.p1.id), removals);
        check("Table Talk says they left", (await talk()).includes(`**p1_${tag} left the party.**`), await talk());
        check("nobody rings their own bell to say they left", (await notes("p1")).length === 0);
        check("their stand-in night still to come no longer names them its Host", (await override(upcoming.id)) === null);
        check("...but the night already played keeps its history", (await override(played.id)) === who.p1.id);
        const after = await call("GET", `/api/campaigns/${cid}/members`, "p1");
        check("they can't read the party any more", after.status === 403, after);

        const dupLeft = await remove("p2", p2Seat);
        check("someone with two seats leaves both at once", dupLeft.status === 200 && (await memberIds("p2")).length === 0, dupLeft);

        console.log("\nRemoving someone\n");

        removals.length = 0;
        const kicked = await remove("gm", p3Seat);
        check("the GM removes a player", kicked.status === 200 && kicked.json.left === false, kicked);
        check("their seat is gone", (await memberIds("p3")).length === 0);
        await settle();
        check("removing publishes campaign.changed (member-removed)",
            removals.some((p) => p.campaignId === cid && p.personId === who.p3.id), removals);
        check("their bell says so", (await notes("p3")).length === 1, await notes("p3"));
        check("Table Talk says they were removed", (await talk()).includes(`**p3_${tag} was removed from the party.**`), await talk());

        console.log("\nThe Game Masters\n");

        const gm2Seat = await seat("gm2", "Game Master");
        const coGm = await remove("gm", gm2Seat);
        check("a GM can't remove another GM", coGm.status === 403 && /admin/.test(coGm.json?.error), coGm);
        const byAdmin = await remove("admin", gm2Seat);
        check("an admin can", byAdmin.status === 200 && (await memberIds("gm2")).length === 0, byAdmin);

        const lastGm = await remove("gm", gmSeat);
        check("the last GM can't leave while there's a party, and is told to pass the torch",
            lastGm.status === 409 && /pass the torch/.test(lastGm.json?.error) && (await memberIds("gm")).length === 1, lastGm);
        const adminLastGm = await remove("admin", gmSeat);
        check("nor can an admin remove them", adminLastGm.status === 409 && (await memberIds("gm")).length === 1, adminLastGm);

        const coGm2 = await seat("gm2", "Game Master");
        const withCo = await remove("gm", gmSeat);
        check("with another GM in the party, a GM can leave", withCo.status === 200 && (await memberIds("gm")).length === 0, withCo);
        check("ownership doesn't move when the owner leaves",
            (await pool.query(`SELECT owner_id FROM campaigns WHERE id = $1`, [cid])).rows[0].owner_id === who.gm.id);

        const p4Left = await remove("p4", p4Seat);
        check("the last player leaves", p4Left.status === 200, p4Left);
        const alone = await remove("gm2", coGm2);
        check("a GM alone in the party can leave too", alone.status === 200 && (await memberIds("gm2")).length === 0, alone);
    } finally {
        server.close();
        if (cid) await pool.query(`DELETE FROM campaigns WHERE id = $1`, [cid]);
        if (Object.keys(who).length) {
            await pool.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [Object.values(who).map((w) => w.id)]);
        }
    }

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    await pool.end();
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
