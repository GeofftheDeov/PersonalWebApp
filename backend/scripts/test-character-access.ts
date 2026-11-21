/**
 * Who may create, read and edit a character (#198's access gaps, fixed ahead
 * of the spec). Seam: the HTTP API.
 *
 * Mounts the real tabletop router and drives it over HTTP with real JWTs
 * against a throwaway database loaded from db/schema.sql.
 *
 *   POST /api/tabletop/characters       logged in; the caller plays it (an admin may name another player)
 *   GET  /api/tabletop/characters       your own, plus everyone's in the campaigns you sit in (#235)
 *   GET  /api/tabletop/characters/:id   the player, a friend or campaign-mate of theirs,
 *                                       someone in the character's campaign, or an admin; the
 *                                       campaign's whole row only for its members and admins (#235)
 *   PUT  /api/tabletop/characters/:id   the player or an admin
 *
 * Creating and editing share one check of the fields (#235): a non-blank name,
 * a level from 1 to 20, text for class and game, true or false for fallen.
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

        const made = await call("POST", C(), "owner", { name: "Kestrel Vane", class: "Envoy", level: 3, campaign: shared, sfID: "sf-forged" });
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

        // #235: the player an admin names must be someone (player_id has no foreign key).
        const beforeBad = await count();
        const notAnId = await call("POST", C(), "admin", { name: "Orphan", player: "not-a-uuid" });
        check("an admin naming a player that isn't an id is refused (400)", notAnId.status === 400, notAnId);
        const nobody = await call("POST", C(), "admin", { name: "Orphan", player: crypto.randomUUID() });
        check("an admin naming nobody's id is refused (400)", nobody.status === 400, nobody);
        check("…and neither makes a character", await count() === beforeBad);

        // #235: one rule for a character's fields, creating as editing.
        for (const [what, body] of [
            ["a blank name", { name: "   " }],
            ["a name that isn't text", { name: 7 }],
            ["level 0", { name: "Lowly", level: 0 }],
            ["level 21", { name: "Lofty", level: 21 }],
            ["a level that isn't a number", { name: "Wordy", level: "3" }],
            ["a fractional level", { name: "Halfway", level: 2.5 }],
            ["a class that isn't text", { name: "Odd", class: { a: 1 } }],
            ["fallen that isn't true or false", { name: "Unsure", isDead: "yes" }],
        ] as const) {
            const res = await call("POST", C(), "owner", body);
            check(`creating with ${what} is refused (400)`, res.status === 400 && typeof res.json?.error === "string", res);
        }
        check("…and none of them is made", await count() === beforeBad);
        const trimmed = await call("POST", C(), "owner", { name: "  Wren Ashby  " });
        check("a name is kept without its outer spaces, at level 1 by default",
            trimmed.status === 201 && (await row(trimmed.json._id))?.name === "Wren Ashby" && (await row(trimmed.json._id))?.level === 1, trimmed);

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

        // #235: the campaign's table link and Discord ids stay inside the campaign.
        await pool.query(
            `UPDATE campaigns SET table_link = 'https://table.example/secret', discord_guild_id = 'guild-1', discord_channel_id = 'chan-1' WHERE id = ANY($1)`,
            [[shared, left]]);
        const secret = (c: any) => ["tableLink", "discordGuildId", "discordChannelId", "owner", "description"].filter((k) => c && k in c);
        const asMate = await call("GET", C(kid), "mate");
        check("someone in the campaign reads its whole row", asMate.json?.campaign?.tableLink === "https://table.example/secret", asMate.json?.campaign);
        const asFriend = await call("GET", C(kid), "friend");
        check("a friend outside the campaign gets its name and status only",
            asFriend.json?.campaign?._id === shared && asFriend.json.campaign.title === `Shared ${tag}` && secret(asFriend.json.campaign).length === 0,
            asFriend.json?.campaign);
        const pipAsOwner = await call("GET", C(pipId), "owner");
        check("the player who left the campaign gets its name only too",
            pipAsOwner.json?.campaign?.title === `Left behind ${tag}` && secret(pipAsOwner.json.campaign).length === 0, pipAsOwner.json?.campaign);
        check("an admin reads the whole row", (await call("GET", C(pipId), "admin")).json?.campaign?.tableLink === "https://table.example/secret");
        check("the character says who plays it",
            asFriend.json?.player?._id === who.owner.id && asFriend.json.player.name === `owner_${tag}` && asFriend.json.player.handle === `owner_${tag}`,
            asFriend.json?.player);

        console.log("\nCharacters — listing\n");

        const list = async (as: string) => {
            const res = await call("GET", C(), as);
            return res.status === 200 ? (res.json as any[]) : [];
        };
        const ownerList = await list("owner");
        const names = (l: any[]) => l.map((c) => c.name).sort();
        check("the player's list has their character with no campaign (#235)", names(ownerList).includes("Dr. Ada Marsh"), names(ownerList));
        check("…and theirs in a campaign they've left", names(ownerList).includes("Pip Thistlewick"), names(ownerList));
        check("…and the party's in a campaign they sit in", names(ownerList).includes("Kestrel Vane") && names(ownerList).includes("Brother Odran"));
        check("…but not a stranger's", !names(ownerList).includes("Planted"), names(ownerList));
        const pipListed = ownerList.find((c) => c._id === pipId);
        check("…and the left campaign comes without its table link", pipListed?.campaign?.title === `Left behind ${tag}` && secret(pipListed.campaign).length === 0, pipListed?.campaign);
        const mateList = await list("mate");
        check("a campaign-mate's list has the party's characters but not the player's elsewhere",
            names(mateList).includes("Kestrel Vane") && !names(mateList).includes("Dr. Ada Marsh") && !names(mateList).includes("Pip Thistlewick"), names(mateList));
        check("a stranger's list has only their own", names(await list("stranger")).every((n) => n === "Planted"), names(await list("stranger")));

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

        // #235: editing follows the same rule as creating.
        for (const [what, body] of [
            ["a blank name", { name: "  " }],
            ["no name", { name: null }],
            ["level 0", { level: 0 }],
            ["level 9999", { level: 9999 }],
            ["a level that isn't a number", { level: "abc" }],
            ["no level", { level: null }],
            ["a game that isn't text", { gameType: ["D&D"] }],
            ["fallen that isn't true or false", { isDead: 1 }],
        ] as const) {
            const res = await call("PUT", C(kid), "owner", body);
            check(`editing with ${what} is refused (400)`, res.status === 400 && typeof res.json?.error === "string", res);
        }
        check("…and it's unchanged", (await row(kid))?.name === "Kestrel Vane" && (await row(kid))?.level === 5);
        const forged = await call("PUT", C(kid), "owner", { name: "Kestrel Vane", sfID: "sf-forged" });
        check("fields outside the form aren't written on an edit either", forged.status === 200 && (await row(kid))?.sf_id == null, forged);
        check("an edit's reply is the character as its page reads it",
            forged.json?.player?._id === who.owner.id && forged.json?.campaign?.title === `Elsewhere ${tag}` && secret(forged.json.campaign).length === 0, forged.json);
        await pool.query(`UPDATE characters SET level = 25 WHERE id = $1`, [adaId]);
        const keepLevel = await call("PUT", C(adaId), "owner", { name: "Dr. Ada Marsh", level: 25, class: "Investigator" });
        check("an older level outside 1-20 can be left as it is", keepLevel.status === 200 && (await row(adaId))?.level === 25, keepLevel);

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
