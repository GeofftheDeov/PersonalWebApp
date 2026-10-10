/**
 * Session planning (#57), ticket #80: campaign owner, GM title and table link.
 * Seam 1, the HTTP API.
 *
 * Mounts the real campaign, membership, tabletop, availability and user routers
 * and drives them over HTTP with real JWTs against a throwaway database loaded
 * from db/schema.sql. Checks what's visible from outside: responses, rows and
 * bus events.
 *
 * The owner backfill is a migration, not an endpoint, so it is checked by
 * scripts/test-session-planning-migration.ts (run through
 * scripts/session-planning-check.sh): earliest Game Master, and NULL with none.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-campaign-settings-api.ts
 */
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import pool from "../db/index.js";
import { bus } from "../events/index.js";
import campaignRoutes from "../routes/campaignRoutes.js";
import campaignMemberRoutes from "../routes/campaignMemberRoutes.js";
import tabletopRoutes from "../routes/tabletopRoutes.js";
import availabilityRoutes from "../routes/availabilityRoutes.js";
import userRoutes from "../routes/userRoutes.js";

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
    app.use("/api/campaign-members", campaignMemberRoutes);
    app.use("/api/tabletop", tabletopRoutes);
    app.use("/api/availability", availabilityRoutes);
    app.use("/api/users", userRoutes);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const changed: { campaignId: string; action: string }[] = [];
    bus.subscribe("campaign.changed", (payload: any) => { changed.push(payload); });
    // The in-memory bus hands events over on a later tick.
    const settle = () => new Promise((r) => setTimeout(r, 50));

    const tag = crypto.randomBytes(4).toString("hex");
    const who: Record<string, { id: string; token: string }> = {};
    const campaignIds: string[] = [];

    const call = async (method: string, path: string, as?: string, body?: unknown) => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (as) headers.authorization = `Bearer ${who[as].token}`;
        const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        return { status: res.status, json };
    };
    const row = async (id: string) => (await pool.query(`SELECT * FROM campaigns WHERE id = $1`, [id])).rows[0];
    const create = async (as: string, extra: Record<string, unknown> = {}) => {
        const res = await call("POST", "/api/campaigns", as,
            { title: `Campaign ${tag}`, description: "d", status: "Not Started", startDate: "2026-10-01", ...extra });
        if (res.json?.campaign?.id) campaignIds.push(res.json.campaign.id);
        return res;
    };

    try {
        for (const name of ["creator", "gm", "player", "outsider", "admin"]) {
            const email = `t80-${name}-${tag}@example.test`;
            const { rows: [r] } = await pool.query(
                `INSERT INTO accounts (id, handle, email, first_name, app_role, app_role_source)
                 VALUES (gen_random_uuid(), $1, $2, $3, $4, 'manual') RETURNING id`,
                [`${name}_${tag}`, email, name, name === "admin" ? "admin" : "user"]);
            who[name] = { id: r.id, token: jwt.sign({ id: r.id, email }, SECRET, { expiresIn: "1h" }) };
        }

        console.log("\n#80 — campaign owner, GM title and table link\n");

        // ── creating a campaign ─────────────────────────────────────────────
        const plain = await create("creator");
        const plainRow = await row(plain.json.campaign.id);
        check("creating a campaign records the creator as its owner",
            plain.status === 201 && plainRow.owner_id === who.creator.id, plainRow);
        check("with no GM title given, it defaults to \"Dungeon Master\"",
            plainRow.gm_title === "Dungeon Master" && plain.json.campaign.gmTitle === "Dungeon Master", plain.json);
        check("the response names the owner", plain.json.campaign.owner === who.creator.id, plain.json);
        const blank = await create("creator", { gmTitle: "   " });
        check("a blank GM title (an untouched form field) also means the default",
            blank.status === 201 && (await row(blank.json.campaign.id)).gm_title === "Dungeon Master", blank.json);

        const titled = await create("creator", { gmTitle: "  Keeper  " });
        const cid = titled.json?.campaign?.id;
        check("the creator can set the GM title at creation (trimmed)",
            titled.status === 201 && (await row(cid)).gm_title === "Keeper" && titled.json.campaign.gmTitle === "Keeper", titled.json);
        check("a GM title over 40 characters is a 400",
            (await create("creator", { gmTitle: "x".repeat(41) })).status === 400);
        check("a GM title that isn't text is a 400", (await create("creator", { gmTitle: 7 })).status === 400);
        check("a campaign created with a bad GM title isn't saved",
            (await pool.query(`SELECT count(*)::int AS n FROM campaigns WHERE owner_id = $1`, [who.creator.id])).rows[0].n === 3);
        await settle();
        check("creating publishes campaign.changed (created)",
            changed.some((e) => e.campaignId === cid && e.action === "created"), changed);

        const fetched = await call("GET", `/api/campaigns/${cid}`, "creator");
        check("the campaign reads back its owner, GM title and table link",
            fetched.json.owner === who.creator.id && fetched.json.gmTitle === "Keeper" && "tableLink" in fetched.json, fetched.json);

        // ── the GM is not the owner ─────────────────────────────────────────
        // The creator hands the Game Master role to someone else and stays on
        // as a player. Ownership doesn't move with the role.
        const { rows: [creatorMember] } = await pool.query(
            `SELECT id FROM campaign_members WHERE campaign_id = $1 AND person_id = $2`, [cid, who.creator.id]);
        const addGm = await call("POST", "/api/campaign-members", "creator",
            { campaign: cid, person: who.gm.id, status: "Game Master", firstName: "gm" });
        const addPlayer = await call("POST", "/api/campaign-members", "creator",
            { campaign: cid, person: who.player.id, status: "Player", firstName: "player" });
        const demote = await call("PUT", `/api/campaign-members/${creatorMember.id}`, "gm", { status: "Player" });
        check("the Game Master role moves to someone else",
            addGm.status === 201 && addPlayer.status === 201 && demote.status === 200, [addGm.json, addPlayer.json, demote.json]);
        check("...and the campaign's owner doesn't change", (await row(cid)).owner_id === who.creator.id);

        // ── settings: owner (or admin) only ─────────────────────────────────
        const set = (as: string, body: unknown, id = cid) => call("PATCH", `/api/campaigns/${id}/settings`, as, body);
        changed.length = 0;
        const s1 = await set("creator", { gmTitle: "Host", tableLink: "https://foundry.example/t80" });
        check("the owner, now a plain player, can change the GM title and table link",
            s1.status === 200 && s1.json.gmTitle === "Host" && s1.json.tableLink === "https://foundry.example/t80", s1.json);
        await settle();
        check("the update publishes campaign.changed (updated)",
            changed.length === 1 && changed[0].campaignId === cid && changed[0].action === "updated", changed);

        changed.length = 0;
        const asGm = await set("gm", { gmTitle: "Overlord" });
        check("the Game Master, who isn't the owner, gets a 403", asGm.status === 403, asGm.json);
        check("a plain party member gets a 403", (await set("player", { tableLink: "https://evil.example" })).status === 403);
        check("someone outside the party gets a 403", (await set("outsider", { gmTitle: "Nope" })).status === 403);
        const after = await row(cid);
        await settle();
        check("refused updates change nothing and publish nothing",
            after.gm_title === "Host" && after.table_link === "https://foundry.example/t80" && changed.length === 0, { after, changed });
        check("an admin can change them", (await set("admin", { gmTitle: "Host" })).status === 200);
        check("the owner can clear the table link",
            (await set("creator", { tableLink: "" })).json.tableLink === null);
        await set("creator", { tableLink: "https://foundry.example/t80" });

        // A campaign with no owner (none backfilled) is admin-managed.
        const { rows: [orphan] } = await pool.query(
            `INSERT INTO campaigns (title) VALUES ('Orphan ${tag}') RETURNING id`);
        campaignIds.push(orphan.id);
        await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, status) VALUES ($1, $2, 'Game Master')`,
            [orphan.id, who.gm.id]);
        check("with no owner, even its Game Master gets a 403", (await set("gm", { gmTitle: "Mine" }, orphan.id)).status === 403);
        check("...and an admin can manage it", (await set("admin", { gmTitle: "Referee" }, orphan.id)).status === 200);

        // ── the GM title wherever the role is named ─────────────────────────
        const noSession = await call("POST", "/api/tabletop/sessions", "player", { title: "x", campaign: cid, date: "2026-12-01T00:00:00Z" });
        check("a player refused a GM action is told who can do it, by the GM title",
            noSession.status === 403 && /Only the Host can/.test(noSession.json.error), noSession.json);
        const noMember = await call("POST", "/api/campaign-members", "player", { campaign: cid, person: who.outsider.id });
        check("...adding members too", noMember.status === 403 && /Only the Host can/.test(noMember.json.error), noMember.json);
        const noOverlap = await call("GET", `/api/availability/campaigns/${cid}`, "player");
        check("...and the party's availability",
            noOverlap.status === 403 && /Only the Host can/.test(noOverlap.json.error), noOverlap.json);

        const profile = await call("GET", `/api/users/players/${who.gm.id}`, "player");
        const shared = profile.json?.sharedCampaigns?.find((c: any) => String(c._id) === cid);
        check("a profile's shared campaigns carry each campaign's GM title",
            profile.status === 200 && shared?.isGameMaster === true && shared?.gmTitle === "Host", profile.json);

        // ── the table link on sessions ──────────────────────────────────────
        const online = await call("POST", "/api/tabletop/sessions", "gm",
            { title: "Online night", campaign: cid, date: "2026-12-01T00:00:00Z", isOnline: true });
        const read = await call("GET", `/api/tabletop/sessions/${online.json?._id}`, "player");
        check("a party member reading an online session gets the campaign's table link",
            read.status === 200 && read.json.isOnline === true && read.json.campaign?.tableLink === "https://foundry.example/t80", read.json);
    } finally {
        const ids = Object.values(who).map((p) => p.id);
        if (campaignIds.length) await pool.query(`DELETE FROM campaigns WHERE id = ANY($1)`, [campaignIds]);
        if (ids.length) {
            await pool.query(`DELETE FROM campaigns WHERE owner_id = ANY($1)`, [ids]);
            await pool.query(`DELETE FROM accounts WHERE id = ANY($1)`, [ids]);
        }
        server.close();
    }

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    await pool.end();
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
