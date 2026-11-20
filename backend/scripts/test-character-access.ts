/**
 * Who may create, read and edit a character (#198's access gaps, fixed ahead
 * of the spec). Seam: the HTTP API.
 *
 * Mounts the real tabletop router and drives it over HTTP with real JWTs
 * against a throwaway database loaded from db/schema.sql.
 *
 *   POST /api/tabletop/characters       logged in; the caller plays it (an admin may name another player)
 *   GET  /api/tabletop/characters/:id   the player, a friend or campaign-mate of theirs,
 *                                       someone in the character's campaign, or an admin
 *   PUT  /api/tabletop/characters/:id   the player or an admin
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-character-access.ts
 */
import "./use-test-jwt-secret.js";
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import pool from "../db/index.js";
import tabletopRoutes from "../routes/tabletopRoutes.js";
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
    app.use("/api/tabletop", tabletopRoutes);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const tag = crypto.randomBytes(4).toString("hex");
    const who: Record<string, { id: string; token: string }> = {};

    const call = async (method: string, path: string, as?: string, body?: unknown) => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (as) headers.authorization = `Bearer ${who[as].token}`;
        const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        return { status: res.status, json };
    };
    const C = (id = "") => `/api/tabletop/characters${id ? `/${id}` : ""}`;
    const row = async (id: string) =>
        (await pool.query(`SELECT name, player_id, campaign_id, level, sf_id FROM characters WHERE id = $1`, [id])).rows[0];
    const count = async () => Number((await pool.query(`SELECT count(*) FROM characters`)).rows[0].count);

    try {
        // owner plays the characters; mate shares the campaign; partyOnly is in the
        // character's campaign but the owner left it; friend shares no campaign;
        // stranger has no tie at all.
        for (const name of ["owner", "mate", "partyOnly", "friend", "stranger", "admin"]) {
            const email = `chars-${name}-${tag}@example.test`;
            const { rows: [r] } = await pool.query(
                `INSERT INTO accounts (id, handle, email, first_name, app_role, app_role_source)
                 VALUES (gen_random_uuid(), $1, $2, $3, $4, 'manual') RETURNING id`,
                [`${name}_${tag}`, email, name, name === "admin" ? "admin" : "user"]);
            who[name] = { id: r.id, token: signJwt({ id: r.id, email }, { expiresIn: "1h" }) };
        }
        await pool.query(`UPDATE accounts SET friends = ARRAY[$2::uuid] WHERE id = $1`, [who.friend.id, who.owner.id]);
        const camp = async (title: string) =>
            (await pool.query(`INSERT INTO campaigns (title) VALUES ($1) RETURNING id`, [`${title} ${tag}`])).rows[0].id as string;
        const join = (cid: string, name: string, isActive = true) => pool.query(
            `INSERT INTO campaign_members (campaign_id, person_id, first_name, status, is_active) VALUES ($1, $2, $3, 'Player', $4)`,
            [cid, who[name].id, name, isActive]);
        const shared = await camp("Shared");
        const left = await camp("Left behind");
        const elsewhere = await camp("Elsewhere");
        await join(shared, "owner"); await join(shared, "mate");
        await join(left, "owner", false); await join(left, "partyOnly");
        await join(elsewhere, "stranger");

        console.log("\nCharacters — creating\n");

        const before = await count();
        const anon = await call("POST", C(), undefined, { name: "Nobody", player: who.owner.id });
        check("creating without logging in is refused (401)", anon.status === 401, anon);
        check("…and adds no character", await count() === before);

        const made = await call("POST", C(), "owner", { name: "Kestrel Vane", class: "Envoy", level: 3, campaign: shared, sfId: "sf-forged" });
        check("a player creates a character (201)", made.status === 201, made);
        const kid = made.json?._id as string;
        const kRow = kid ? await row(kid) : null;
        check("…which they play", kRow?.player_id === who.owner.id, kRow);
        check("…in the campaign they asked for", kRow?.campaign_id === shared, kRow);
        check("…and fields outside the form aren't written", kRow?.sf_id == null, kRow);

        const forOther = await call("POST", C(), "stranger", { name: "Planted", player: who.owner.id });
        check("naming another player makes the caller the player", forOther.status === 201 && (await row(forOther.json._id))?.player_id === who.stranger.id, forOther);

        const intoOther = await call("POST", C(), "stranger", { name: "Gatecrasher", campaign: shared });
        check("creating into a campaign you're not in is refused (403)", intoOther.status === 403, intoOther);

        const byAdmin = await call("POST", C(), "admin", { name: "Brother Odran", player: who.owner.id, campaign: shared });
        check("an admin may create one for another player", byAdmin.status === 201 && (await row(byAdmin.json._id))?.player_id === who.owner.id, byAdmin);

        const loose = await call("POST", C(), "owner", { name: "Dr. Ada Marsh", campaign: "" });
        check("a character needs no campaign", loose.status === 201 && (await row(loose.json._id))?.campaign_id === null, loose);
        const adaId = loose.json?._id as string;

        const { rows: [oldRow] } = await pool.query(
            `INSERT INTO characters (name, player_id, campaign_id) VALUES ('Pip Thistlewick', $1, $2) RETURNING id`, [who.owner.id, left]);
        const pipId = oldRow.id as string;

        console.log("\nCharacters — reading\n");

        const read = async (as: string, id: string) => (await call("GET", C(id), as)).status;
        check("the player reads their character", await read("owner", kid) === 200);
        check("a campaign-mate of the player reads it", await read("mate", kid) === 200);
        check("a friend of the player reads it", await read("friend", kid) === 200);
        check("a campaign-mate reads the player's character with no campaign", await read("mate", adaId) === 200);
        check("someone in the character's campaign reads it after the player left", await read("partyOnly", pipId) === 200);
        check("an admin reads it", await read("admin", kid) === 200);
        check("a stranger is refused (403)", await read("stranger", kid) === 403);
        check("a stranger is refused one with no campaign too", await read("stranger", adaId) === 403);
        check("a missing character is 404", await read("owner", crypto.randomUUID()) === 404);
        check("reading without logging in is refused (401)", (await call("GET", C(kid))).status === 401);

        console.log("\nCharacters — editing\n");

        const own = await call("PUT", C(kid), "owner", { name: "Kestrel Vane", class: "Envoy", level: 4, gameType: "Starfinder", campaign: shared, isDead: false });
        check("the player edits their character", own.status === 200 && (await row(kid))?.level === 4, own);

        for (const as of ["mate", "friend", "stranger"]) {
            const res = await call("PUT", C(kid), as, { name: "Defaced", level: 20 });
            check(`a ${as} can't edit it (403)`, res.status === 403, res);
        }
        check("…and it's unchanged", (await row(kid))?.name === "Kestrel Vane" && (await row(kid))?.level === 4);

        const moveAway = await call("PUT", C(kid), "owner", { name: "Kestrel Vane", campaign: elsewhere });
        check("the player can't move it into a campaign they're not in (403)", moveAway.status === 403, moveAway);
        check("…and it stays put", (await row(kid))?.campaign_id === shared);

        const clear = await call("PUT", C(adaId), "owner", { name: "Dr. Ada Marsh", campaign: "", level: 2 });
        check("an empty campaign leaves it with none", clear.status === 200 && (await row(adaId))?.campaign_id === null, clear);

        const keepLeft = await call("PUT", C(pipId), "owner", { name: "Pip Thistlewick", campaign: left, isDead: true });
        check("the player may keep it in a campaign they've since left", keepLeft.status === 200, keepLeft);

        const admin = await call("PUT", C(kid), "admin", { name: "Kestrel Vane", level: 5, campaign: elsewhere });
        check("an admin edits it, into any campaign", admin.status === 200 && (await row(kid))?.campaign_id === elsewhere, admin);

        check("editing without logging in is refused (401)", (await call("PUT", C(kid), undefined, { name: "x" })).status === 401);
        check("editing a missing character is 404", (await call("PUT", C(crypto.randomUUID()), "owner", { name: "x" })).status === 404);
    } finally {
        server.close();
        await pool.end();
    }

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
