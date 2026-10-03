/**
 * Session planning (#57), ticket #89: passing the torch. Seam 1, the HTTP API.
 *
 * Mounts the real planning (with fake integrations), campaign, membership and
 * tabletop routers and drives them over HTTP with real JWTs against a
 * throwaway database loaded from db/schema.sql. Checks what's visible from
 * outside: responses, rows, bell notifications, Table Talk posts and bus events.
 *
 *   permanent    POST   /api/campaigns/:id/torch                { to, from? }
 *   one session  POST   /api/planning/sessions/:sessionId/torch { to }
 *                DELETE /api/planning/sessions/:sessionId/torch
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-torch-pass-api.ts
 */
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import pool from "../db/index.js";
import { bus } from "../events/index.js";
import { buildPlanningRouter } from "../routes/planningRoutes.js";
import campaignRoutes from "../routes/campaignRoutes.js";
import campaignMemberRoutes from "../routes/campaignMemberRoutes.js";
import tabletopRoutes from "../routes/tabletopRoutes.js";
import { createPlanner } from "../planning/planner.js";
import type { ExternalEvents } from "../planning/externalEvents.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
    console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
    process.exit(2);
}

const SECRET = process.env.JWT_SECRET || "your-secret-key-change-this";
const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
    const d = typeof detail === "string" ? detail : JSON.stringify(detail);
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !d ? "" : `\n          ${d}`}`);
    ok ? pass++ : fail++;
}

const fakeEvents: ExternalEvents = {
    async publishSession() {
        return { discordEventId: null, googleEventId: null, googleCalendarLink: "https://calendar.google.com/fake", warnings: [] };
    },
};

async function main() {
    const app = express();
    app.use(express.json());
    app.use("/api/campaigns", campaignRoutes);
    app.use("/api/campaign-members", campaignMemberRoutes);
    app.use("/api/tabletop", tabletopRoutes);
    app.use("/api/planning", buildPlanningRouter(createPlanner({ events: fakeEvents, now: () => new Date() })));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const passes: any[] = [];
    bus.subscribe("campaign.torch_passed", (payload: any) => { passes.push(payload); });
    // The in-memory bus hands events over on a later tick.
    const settle = () => new Promise((r) => setTimeout(r, 50));

    const tag = crypto.randomBytes(4).toString("hex");
    const who: Record<string, { id: string; token: string }> = {};
    let cid = "";

    const call = async (method: string, path: string, as?: string, body?: unknown) => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (as) headers.authorization = `Bearer ${who[as].token}`;
        const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        return { status: res.status, json };
    };
    const P = (sessionId: string, action = "") => `/api/planning/sessions/${sessionId}${action ? `/${action}` : ""}`;
    const passSession = (as: string, sessionId: string, to: unknown) => call("POST", P(sessionId, "torch"), as, { to });
    const clearSession = (as: string, sessionId: string) => call("DELETE", P(sessionId, "torch"), as);
    const passCampaign = (as: string, body: unknown) => call("POST", `/api/campaigns/${cid}/torch`, as, body);
    const override = async (sessionId: string) =>
        (await pool.query(`SELECT gm_override_id FROM game_sessions WHERE id = $1`, [sessionId])).rows[0].gm_override_id;
    const statuses = async () => {
        const { rows } = await pool.query(`SELECT person_id, status FROM campaign_members WHERE campaign_id = $1`, [cid]);
        const out: Record<string, string> = {};
        for (const name of ["gm", "p1", "p2", "p3"]) out[name] = rows.find((r) => r.person_id === who[name].id)?.status;
        return out;
    };
    const owner = async () => (await pool.query(`SELECT owner_id FROM campaigns WHERE id = $1`, [cid])).rows[0].owner_id;
    const notes = async (person: string, like: string) => (await pool.query(
        `SELECT title FROM notifications WHERE user_id = $1 AND title LIKE $2`, [who[person].id, like])).rows;
    const talk = async () => (await pool.query(
        `SELECT body FROM messages WHERE campaign_id = $1 AND sender_id = 'system' ORDER BY created_at`, [cid])).rows.map((r) => r.body);

    const t0 = Math.ceil((Date.now() + 7 * DAY) / HOUR) * HOUR;
    const slot = (dayOffset: number) => ({
        start: new Date(t0 + dayOffset * DAY).toISOString(), end: new Date(t0 + dayOffset * DAY + 4 * HOUR).toISOString(),
    });
    const kickoff = async (title: string) => (await call("POST", `/api/planning/campaigns/${cid}/kickoff`, "gm",
        { title, isOnline: true })).json.session.id as string;

    try {
        for (const name of ["gm", "p1", "p2", "p3", "outsider", "admin"]) {
            const email = `t89-${name}-${tag}@example.test`;
            const { rows: [r] } = await pool.query(
                `INSERT INTO accounts (id, handle, email, first_name, app_role, app_role_source)
                 VALUES (gen_random_uuid(), $1, $2, $3, $4, 'manual') RETURNING id`,
                [`${name}_${tag}`, email, name, name === "admin" ? "admin" : "user"]);
            who[name] = { id: r.id, token: jwt.sign({ id: r.id, email }, SECRET, { expiresIn: "1h" }) };
        }
        // The GM created the campaign, so they own it too.
        const { rows: [camp] } = await pool.query(
            `INSERT INTO campaigns (title, owner_id, gm_title) VALUES ('Torchlight ${tag}', $1, 'Host') RETURNING id`, [who.gm.id]);
        cid = camp.id;
        for (const [i, [name, status]] of ([["gm", "Game Master"], ["p1", "Player"], ["p2", "Player"], ["p3", "Player"]] as const).entries()) {
            await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, first_name, status, joined_at) VALUES ($1, $2, $3, $4, $5)`,
                [cid, who[name].id, name, status, new Date(Date.UTC(2026, 0, 1 + i))]);
        }
        const sA = await kickoff("Session A");
        const sB = await kickoff("Session B");
        const oneOff = await call("POST", "/api/tabletop/sessions", "gm",
            { title: "One-shot", campaign: cid, date: slot(9).start, endDate: slot(9).end });
        const sC = oneOff.json._id as string;

        console.log("\n#89 — passing the torch for one session\n");

        // ── who may pass it ─────────────────────────────────────────────────
        const byPlayer = await passSession("p1", sA, who.p2.id);
        check("a player can't pass the torch, and is told who can (the GM title)",
            byPlayer.status === 403 && /Only the Host/.test(byPlayer.json?.error), byPlayer);
        check("someone outside the party can't either (403)", (await passSession("outsider", sA, who.p2.id)).status === 403);
        check("the torch goes to someone in the party (400)", (await passSession("gm", sA, who.outsider.id)).status === 400);
        check("...named by their id (400)", (await passSession("gm", sA, "not-a-person")).status === 400);
        check("...who isn't already the Host (400)", (await passSession("gm", sA, who.gm.id)).status === 400);
        check("an unknown session is a 404", (await passSession("gm", crypto.randomUUID(), who.p2.id)).status === 404);
        await settle();
        check("refused passes change nothing and publish nothing", (await override(sA)) === null && passes.length === 0, passes);

        // ── passing it ──────────────────────────────────────────────────────
        const passed = await passSession("gm", sA, who.p2.id);
        check("the GM passes Session A to a player",
            passed.status === 200 && passed.json.session.gmOverride?.id === who.p2.id && passed.json.session.gmOverride?.name === `p2_${tag}` &&
                (await override(sA)) === who.p2.id, passed);
        await settle();
        check("the pass publishes campaign.torch_passed (session scope)",
            passes.length === 1 && passes[0].scope === "session" && passes[0].campaignId === cid && passes[0].sessionId === sA &&
                passes[0].byId === who.gm.id && passes[0].fromId === null && passes[0].toId === who.p2.id, passes);
        check("the stand-in hears about it on their bell", (await notes("p2", '%the Host for "Session A"%')).length === 1);
        check("ownership doesn't move", (await owner()) === who.gm.id);

        // ── the stand-in's view ─────────────────────────────────────────────
        const board = await call("GET", `/api/planning/campaigns/${cid}`, "p2");
        const cardA = board.json?.planning?.find((p: any) => p.session.id === sA);
        const cardB = board.json?.planning?.find((p: any) => p.session.id === sB);
        check("on the Notice Board, the stand-in is the Host of Session A, and can't pass it on",
            cardA?.viewer.isGameMaster === true && cardA?.viewer.canPassTorch === false && cardA?.session.gmOverride?.id === who.p2.id, cardA);
        check("...but not of Session B, and can't start planning",
            cardB?.viewer.isGameMaster === false && board.json?.canPlan === false, board.json);
        const gmView = (await call("GET", P(sA), "gm")).json;
        check("the GM's view of the same card lets them pass it or take it back, and names the campaign's GMs",
            gmView.viewer.canPassTorch === true && JSON.stringify(gmView.campaign.gameMasterIds) === JSON.stringify([who.gm.id]), gmView);

        // ── full GM control of that session ─────────────────────────────────
        // (PUT replaces the editable fields, as the session page's edit form sends them all.)
        const shortA = await call("POST", P(sA, "shortlist"), "p2", { options: [slot(1), slot(2)] });
        check("the stand-in shortlists nights on their session", shortA.status === 200 && shortA.json.night?.status === "open", shortA);
        const advA = await call("POST", P(sA, "advance"), "p2");
        check("...and moves the vote forward", advA.status === 200 && advA.json.night.closedReason === "gm_advanced", advA);
        const editA = await call("PUT", `/api/tabletop/sessions/${sA}`, "p2", { title: "Session A, renamed", isOnline: true });
        check("...and edits it", editA.status === 200 && editA.json.title === "Session A, renamed", editA);

        // ── and nothing else ────────────────────────────────────────────────
        check("on another session, shortlisting is a 403",
            (await call("POST", P(sB, "shortlist"), "p2", { options: [slot(1), slot(2)] })).status === 403);
        check("...cancelling is a 403", (await call("POST", P(sB, "cancel"), "p2")).status === 403);
        check("...editing is a 403", (await call("PUT", `/api/tabletop/sessions/${sC}`, "p2", { title: "Mine now" })).status === 403);
        check("starting planning is a 403",
            (await call("POST", `/api/planning/campaigns/${cid}/kickoff`, "p2", { title: "Mine", isOnline: true })).status === 403);
        check("campaign settings are a 403", (await call("PATCH", `/api/campaigns/${cid}/settings`, "p2", { gmTitle: "Me" })).status === 403);
        check("adding members is a 403",
            (await call("POST", "/api/campaign-members", "p2", { campaign: cid, person: who.outsider.id })).status === 403);
        check("passing Session A on to someone else is a 403", (await passSession("p2", sA, who.p3.id)).status === 403);
        check("passing the torch permanently is a 403", (await passCampaign("p2", { to: who.p3.id })).status === 403);
        check("after all that, the stand-in's membership is unchanged", (await statuses()).p2 === "Player");

        // ── taking it back ──────────────────────────────────────────────────
        passes.length = 0;
        check("a player can't clear the stand-in (403)", (await clearSession("p1", sA)).status === 403);
        const cleared = await clearSession("gm", sA);
        check("the GM clears the one-session pass",
            cleared.status === 200 && cleared.json.session.gmOverride === null && (await override(sA)) === null, cleared);
        await settle();
        check("...which publishes campaign.torch_passed with no one holding it",
            passes.length === 1 && passes[0].sessionId === sA && passes[0].fromId === who.p2.id && passes[0].toId === null, passes);
        check("the former stand-in loses control of the session", (await call("POST", P(sA, "cancel"), "p2")).status === 403);
        const again = await clearSession("gm", sA);
        await settle();
        check("clearing when no one is standing in is a no-op (200, no event)", again.status === 200 && passes.length === 1, passes);

        // ── a stand-in can step down, cancel, and run a scheduled session ───
        await passSession("gm", sB, who.p3.id);
        check("a stand-in can hand the session back", (await clearSession("p3", sB)).status === 200 && (await override(sB)) === null);
        await passSession("gm", sB, who.p3.id);
        const cancelB = await call("POST", P(sB, "cancel"), "p3");
        check("a stand-in can cancel their session", cancelB.status === 200 && cancelB.json.session.status === "cancelled", cancelB);
        check("a cancelled session can't change hands (409)", (await passSession("gm", sB, who.p1.id)).status === 409);
        check("...or have its stand-in cleared (409)", (await clearSession("gm", sB)).status === 409 && (await override(sB)) === who.p3.id);
        const passC = await passSession("admin", sC, who.p1.id);
        check("an admin can pass the torch, here on a scheduled one-off", passC.status === 200 && (await override(sC)) === who.p1.id, passC);
        const readC = await call("GET", `/api/tabletop/sessions/${sC}`, "p3");
        check("the session itself names its stand-in for the party", readC.status === 200 && readC.json.gmOverride === who.p1.id, readC);
        check("the stand-in can edit that scheduled session",
            (await call("PUT", `/api/tabletop/sessions/${sC}`, "p1",
                { title: "One-shot, retitled", date: slot(9).start, endDate: slot(9).end, isOnline: false })).status === 200);
        check("passing an already-passed session hands it to the new person",
            (await passSession("gm", sC, who.p2.id)).status === 200 && (await override(sC)) === who.p2.id);

        // A stand-in who leaves the party loses the session with their seat.
        const sE = await kickoff("Session E");
        await passSession("gm", sE, who.p3.id);
        const { rows: [p3Seat] } = await pool.query(
            `DELETE FROM campaign_members WHERE campaign_id = $1 AND person_id = $2 RETURNING *`, [cid, who.p3.id]);
        check("a stand-in removed from the party can't edit their session (403)",
            (await call("PUT", `/api/tabletop/sessions/${sE}`, "p3", { title: "Still mine", isOnline: true })).status === 403);
        check("...or run its planning (403)", (await call("POST", P(sE, "shortlist"), "p3", { options: [slot(1), slot(2)] })).status === 403);
        await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, first_name, status, joined_at) VALUES ($1, $2, $3, $4, $5)`,
            [cid, who.p3.id, p3Seat.first_name, p3Seat.status, p3Seat.joined_at]);
        check("...and gets it back if they rejoin while it's still theirs",
            (await call("POST", P(sE, "shortlist"), "p3", { options: [slot(1), slot(2)] })).status === 200);
        await call("POST", P(sE, "cancel"), "gm");

        console.log("\n#89 — passing the torch permanently\n");

        passes.length = 0;
        const permByPlayer = await passCampaign("p1", { to: who.p2.id });
        check("a player can't pass the torch, and is told who can",
            permByPlayer.status === 403 && /Only the Host/.test(permByPlayer.json?.error), permByPlayer);
        check("nor can someone outside the party", (await passCampaign("outsider", { to: who.p2.id })).status === 403);
        check("nor a one-session stand-in", (await passCampaign("p2", { to: who.p3.id })).status === 403);
        check("the new Host must be in the party (400)", (await passCampaign("gm", { to: who.outsider.id })).status === 400);
        check("...and must be named (400)", (await passCampaign("gm", {})).status === 400);
        check("...and can't already be the Host (400)", (await passCampaign("gm", { to: who.gm.id })).status === 400);
        check("an unknown campaign is a 404",
            (await call("POST", `/api/campaigns/${crypto.randomUUID()}/torch`, "gm", { to: who.p1.id })).status === 404);
        await settle();
        const unchanged = await statuses();
        check("refused passes change nothing and publish nothing",
            JSON.stringify(unchanged) === JSON.stringify({ gm: "Game Master", p1: "Player", p2: "Player", p3: "Player" }) &&
                passes.length === 0, { unchanged, passes });

        const perm = await passCampaign("gm", { to: who.p1.id });
        const after = await statuses();
        check("the GM passes the torch: their statuses swap",
            perm.status === 200 && after.p1 === "Game Master" && after.gm === "Player" && after.p2 === "Player", { perm, after });
        check("the response names the new Host and the unchanged owner",
            JSON.stringify(perm.json?.gameMasterIds) === JSON.stringify([who.p1.id]) && perm.json?.owner === who.gm.id, perm);
        check("ownership stays with the creator", (await owner()) === who.gm.id);
        await settle();
        check("the pass publishes campaign.torch_passed (campaign scope)",
            passes.length === 1 && passes[0].scope === "campaign" && passes[0].sessionId === null && passes[0].byId === who.gm.id &&
                passes[0].fromId === who.gm.id && passes[0].toId === who.p1.id, passes);
        check("the new Host hears about it on their bell", (await notes("p1", "%the Host of Torchlight%")).length === 1);
        check("...and the party in Table Talk", (await talk()).some((b) => /p1_\w+ is the Host now/.test(b)), await talk());

        // ── owner-only settings still belong to the owner ───────────────────
        check("the owner, now a plain player, still changes campaign settings",
            (await call("PATCH", `/api/campaigns/${cid}/settings`, "gm", { gmTitle: "Host" })).status === 200);
        check("the new Host, who isn't the owner, can't (403)",
            (await call("PATCH", `/api/campaigns/${cid}/settings`, "p1", { gmTitle: "Overlord" })).status === 403);

        // ── the role moved with it ──────────────────────────────────────────
        check("the old GM can no longer pass the torch (403)", (await passCampaign("gm", { to: who.p3.id })).status === 403);
        check("...or start planning (403)",
            (await call("POST", `/api/planning/campaigns/${cid}/kickoff`, "gm", { title: "x", isOnline: true })).status === 403);
        check("the new Host can start planning",
            (await call("POST", `/api/planning/campaigns/${cid}/kickoff`, "p1", { title: "Session D", isOnline: true })).status === 200);
        check("...and pass a session", (await passSession("p1", sA, who.p3.id)).status === 200);

        // ── an admin passing it ─────────────────────────────────────────────
        const byAdmin = await passCampaign("admin", { to: who.p2.id });
        const afterAdmin = await statuses();
        check("an admin passes it: the campaign's only Host steps down",
            byAdmin.status === 200 && afterAdmin.p2 === "Game Master" && afterAdmin.p1 === "Player", { byAdmin, afterAdmin });
        await pool.query(`UPDATE campaign_members SET status = 'Game Master' WHERE campaign_id = $1 AND person_id = $2`, [cid, who.p3.id]);
        check("with two Hosts, an admin must say who steps down (400)", (await passCampaign("admin", { to: who.gm.id })).status === 400);
        check("...and that person must be a Host (400)",
            (await passCampaign("admin", { to: who.gm.id, from: who.p1.id })).status === 400);
        const named = await passCampaign("admin", { to: who.gm.id, from: who.p3.id });
        const afterNamed = await statuses();
        check("...and then only they step down",
            named.status === 200 && afterNamed.gm === "Game Master" && afterNamed.p3 === "Player" && afterNamed.p2 === "Game Master",
            { named, afterNamed });
        check("through all of it, the owner never changed", (await owner()) === who.gm.id);
    } finally {
        const ids = Object.values(who).map((p) => p.id);
        if (cid) await pool.query(`DELETE FROM campaigns WHERE id = $1`, [cid]);
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
