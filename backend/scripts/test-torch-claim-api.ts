/**
 * Claiming the torch, and an admin assigning it, in an admin-managed campaign
 * (no owner) that has no Game Master. The HTTP API, driven with real JWTs
 * against a throwaway database loaded from db/schema.sql.
 *
 *   POST /api/campaigns/:id/torch/claim    a party member, when nobody holds it
 *   POST /api/campaigns/:id/torch { to }   an admin, with nobody stepping down
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-torch-claim-api.ts
 */
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import pool from "../db/index.js";
import { bus } from "../events/index.js";
import campaignRoutes from "../routes/campaignRoutes.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
    console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
    process.exit(2);
}

const SECRET = process.env.JWT_SECRET || "your-secret-key-change-this";

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
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const passes: any[] = [];
    bus.subscribe("campaign.torch_passed", (payload: any) => { passes.push(payload); });
    // The in-memory bus hands events over on a later tick.
    const settle = () => new Promise((r) => setTimeout(r, 50));

    const tag = crypto.randomBytes(4).toString("hex");
    const who: Record<string, { id: string; token: string }> = {};
    const cids: string[] = [];

    const call = async (method: string, path: string, as: string, body?: unknown) => {
        const res = await fetch(`${base}${path}`, {
            method, headers: { "content-type": "application/json", authorization: `Bearer ${who[as].token}` },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        return { status: res.status, json };
    };
    const claim = (as: string, cid: string) => call("POST", `/api/campaigns/${cid}/torch/claim`, as);
    const statuses = async (cid: string) => {
        const { rows } = await pool.query(`SELECT person_id, status FROM campaign_members WHERE campaign_id = $1`, [cid]);
        const out: Record<string, string> = {};
        for (const name of ["p1", "p2", "p3"]) out[name] = rows.find((r) => r.person_id === who[name].id)?.status;
        return out;
    };
    const talk = async (cid: string) => (await pool.query(
        `SELECT body FROM messages WHERE campaign_id = $1 AND sender_id = 'system' ORDER BY created_at`, [cid])).rows.map((r) => r.body);
    // A campaign with p1..p3 as players and no GM; owned by `owner`, or admin-managed when null.
    const campaign = async (owner: string | null) => {
        const { rows: [c] } = await pool.query(
            `INSERT INTO campaigns (title, owner_id, gm_title) VALUES ($1, $2, 'Dungeon Master') RETURNING id`,
            [`Unlit ${tag}`, owner ? who[owner].id : null]);
        cids.push(c.id);
        for (const name of ["p1", "p2", "p3"]) {
            await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, first_name, status) VALUES ($1, $2, $3, 'Player')`,
                [c.id, who[name].id, name]);
        }
        return c.id as string;
    };

    try {
        for (const name of ["p1", "p2", "p3", "outsider", "admin"]) {
            const email = `claim-${name}-${tag}@example.test`;
            const { rows: [r] } = await pool.query(
                `INSERT INTO accounts (id, handle, email, first_name, app_role, app_role_source)
                 VALUES (gen_random_uuid(), $1, $2, $3, $4, 'manual') RETURNING id`,
                [`${name}_${tag}`, email, name, name === "admin" ? "admin" : "user"]);
            who[name] = { id: r.id, token: jwt.sign({ id: r.id, email }, SECRET, { expiresIn: "1h" }) };
        }

        console.log("\nclaiming the torch\n");

        const cid = await campaign(null);
        check("someone outside the party can't claim it (403)", (await claim("outsider", cid)).status === 403);
        check("an unknown campaign is a 404", (await claim("p1", crypto.randomUUID())).status === 404);
        await pool.query(`UPDATE campaign_members SET is_active = false WHERE campaign_id = $1 AND person_id = $2`, [cid, who.p3.id]);
        check("nor can an inactive player (403)", (await claim("p3", cid)).status === 403);
        await settle();
        check("refused claims change nothing and publish nothing",
            Object.values(await statuses(cid)).every((s) => s === "Player") && passes.length === 0, { passes });

        const claimed = await claim("p1", cid);
        const after = await statuses(cid);
        check("a player claims it: they're the GM, and nobody else changes",
            claimed.status === 200 && after.p1 === "Game Master" && after.p2 === "Player", { claimed, after });
        check("the response names them and no owner",
            JSON.stringify(claimed.json?.gameMasterIds) === JSON.stringify([who.p1.id]) && claimed.json?.owner === null, claimed);
        await settle();
        check("the claim publishes campaign.torch_passed from nobody",
            passes.length === 1 && passes[0].scope === "campaign" && passes[0].byId === who.p1.id &&
                passes[0].fromId === null && passes[0].toId === who.p1.id, passes);
        check("the party hears in Table Talk", (await talk(cid)).some((b) => /p1_\w+ has claimed the torch\*\* and is the Dungeon Master/.test(b)), await talk(cid));

        const second = await claim("p2", cid);
        check("once it's held, a second claim is refused and names the role (409)",
            second.status === 409 && /already has a Dungeon Master/.test(second.json?.error), second);
        const again = await claim("p1", cid);
        check("...and the holder is told they already have it (409)", again.status === 409 && /already the/.test(again.json?.error), again);
        check("the holder can now pass it on as usual",
            (await call("POST", `/api/campaigns/${cid}/torch`, "p1", { to: who.p2.id })).status === 200 &&
                (await statuses(cid)).p2 === "Game Master");

        const racing = await campaign(null);
        const [a, b] = await Promise.all([claim("p1", racing), claim("p2", racing)]);
        const raced = Object.values(await statuses(racing)).filter((s) => s === "Game Master").length;
        check("two players claiming at once: exactly one wins",
            [a.status, b.status].sort().join() === "200,409" && raced === 1, { a, b, raced });

        const owned = await campaign("p3");
        const ownedClaim = await claim("p1", owned);
        check("a campaign with an owner can't be claimed, even with no GM (403)",
            ownedClaim.status === 403 && /admin-managed/.test(ownedClaim.json?.error), ownedClaim);

        console.log("\nan admin assigning the torch\n");

        const assigned = await campaign(null);
        const byAdmin = await call("POST", `/api/campaigns/${assigned}/torch`, "admin", { to: who.p2.id });
        const afterAdmin = await statuses(assigned);
        check("an admin outside the party passes it to a player, with nobody stepping down",
            byAdmin.status === 200 && afterAdmin.p2 === "Game Master" && afterAdmin.p1 === "Player" && afterAdmin.p3 === "Player",
            { byAdmin, afterAdmin });
        check("...after which it can't be claimed (409)", (await claim("p1", assigned)).status === 409);
    } finally {
        const ids = Object.values(who).map((p) => p.id);
        if (cids.length) await pool.query(`DELETE FROM campaigns WHERE id = ANY($1)`, [cids]);
        if (ids.length) {
            await pool.query(`DELETE FROM notifications WHERE user_id = ANY($1)`, [ids]);
            await pool.query(`DELETE FROM accounts WHERE id = ANY($1)`, [ids]);
        }
        server.close();
    }

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    await pool.end();
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
