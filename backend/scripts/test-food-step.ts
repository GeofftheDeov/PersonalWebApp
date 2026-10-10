/**
 * The food step of an in-person session (#93, part of #57): potluck and food
 * provided.
 *
 * Covers the kickoff rule (in person needs a food mode), the potluck (the GM,
 * a stand-in GM or an admin seeds slots; anyone in the party claims an open
 * slot, adds their own, or un-claims one they hold; non-GM and outsider
 * rejections), food provided (the owner's one provisioning quest), the GM
 * confirming with slots still unclaimed, the automatic close at session start
 * driven by closeDueFoodSteps() with an injected clock, the ready check still
 * covering a session in the food step, and every claim showing in the
 * claimer's Quest Log ("mine") and on the Almanac.
 *
 * Installs the integrations fake and mounts the real planning and quest
 * routers. Drives them over HTTP with real JWTs against a throwaway database
 * loaded from db/schema.sql; the party's bells and Table Talk posts come from
 * planning/announcements.ts reacting to the bus, as in server.ts.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-food-step.ts
 */
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import jwt from "jsonwebtoken";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
    console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
    process.exit(2);
}
process.env.VAULT_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

const { default: pool } = await import("../db/index.js");
const { bus } = await import("../events/index.js");
const { buildPlanningRouter } = await import("../routes/planningRoutes.js");
const { buildQuestRouter } = await import("../routes/questRoutes.js");
const { createPlanner, closeDueFoodSteps } = await import("../planning/planner.js");
const { createQuests } = await import("../planning/quests.js");
const { startPlanningAnnouncements } = await import("../planning/announcements.js");
const { createFakeIntegrations } = await import("../testing/fakeIntegrations.js");
const { default: Session } = await import("../models/Session.js");
const { readyCheckDueFilter } = await import("../utils/readyCheck.js");

const SECRET = process.env.JWT_SECRET || "your-secret-key-change-this";
const MINUTE = 60 * 1000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
    const d = typeof detail === "string" ? detail : JSON.stringify(detail);
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !d ? "" : `\n          ${d}`}`);
    ok ? pass++ : fail++;
}

async function main() {
    const fake = createFakeIntegrations();
    const uninstall = fake.install();

    const app = express();
    app.use(express.json());
    app.use("/api/planning", buildPlanningRouter(createPlanner()));
    app.use("/api/quests", buildQuestRouter(createQuests()));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const events: { name: string; payload: any }[] = [];
    for (const name of ["planning.stage_changed", "quest.assigned"] as const) {
        bus.subscribe(name, (payload: any) => { events.push({ name, payload }); });
    }
    const eventsFor = (sid: string, name: string, from = 0) =>
        events.slice(from).filter((e) => e.name === name && e.payload.sessionId === sid).map((e) => e.payload);
    const announcer = startPlanningAnnouncements();
    /** Lets the in-memory bus deliver what's been published. */
    const settle = () => announcer.idle();

    const tag = crypto.randomBytes(4).toString("hex");
    const who: Record<string, { id: string; token: string }> = {};
    let campaignId = "";

    const call = async (method: string, path: string, as?: string, body?: unknown) => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (as) headers.authorization = `Bearer ${who[as].token}`;
        const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        return { status: res.status, json, text };
    };
    const P = (sid: string, action = "") => `/api/planning/sessions/${sid}${action ? `/${action}` : ""}`;
    const row = async (id: string) => (await pool.query(`SELECT * FROM game_sessions WHERE id = $1`, [id])).rows[0];
    const foodRows = async (sid: string) => (await pool.query(
        `SELECT * FROM session_tasks WHERE session_id = $1 AND kind = 'food' ORDER BY created_at, id`, [sid])).rows;
    const talk = async () => (await settle(), await pool.query(
        `SELECT body FROM messages WHERE campaign_id = $1 AND sender_id = 'system' ORDER BY created_at`, [campaignId])).rows.map((r) => r.body);
    const bell = async (person: string, like: string) => (await settle(), await pool.query(
        `SELECT title FROM notifications WHERE user_id = $1 AND title LIKE $2`, [who[person].id, like])).rows;
    const mine = async (person: string) => (await call("GET", "/api/quests/mine", person)).json.quests as any[];
    const slotId = (state: any, title: string) => state.food?.quests.find((q: any) => q.title === title)?.id as string;
    /** Polls until `probe` returns something (a bus subscriber elsewhere is still working), or gives up with null. */
    const waitFor = async <T,>(probe: () => Promise<T | null>, ms = 3000): Promise<T | null> => {
        for (const until = Date.now() + ms; Date.now() < until;) {
            const got = await probe();
            if (got) return got;
            await new Promise((r) => setTimeout(r, 50));
        }
        return null;
    };

    const t0 = Math.ceil((Date.now() + 7 * DAY) / HOUR) * HOUR;
    const slot = (dayOffset: number, hours = 4) => ({
        start: new Date(t0 + dayOffset * DAY).toISOString(), end: new Date(t0 + dayOffset * DAY + hours * HOUR).toISOString(),
    });
    const party = ["gm", "p1", "p2", "p3"];
    const kick = (as: string, body: Record<string, unknown>) =>
        call("POST", `/api/planning/campaigns/${campaignId}/kickoff`, as, { title: "Untitled", ...body });

    /** Kicks off in person, then the whole party picks `night` and the recent venue: the session lands on the food step. */
    const toVenueStep = async (title: string, night: { start: string; end: string }, food: Record<string, unknown>) => {
        const k = await kick("gm", { title, isOnline: false, ...food });
        const sid = k.json.session.id as string;
        const sl = (await call("POST", P(sid, "shortlist"), "gm", { options: [night, slot(30)] })).json;
        const opt = sl.night.options.find((o: any) => o.start === night.start).id;
        let last: any = null;
        for (const p of party) last = await call("POST", P(sid, "vote"), p, { optionIds: [opt] });
        return { sid, state: last.json };
    };
    const toFoodStep = async (title: string, night: { start: string; end: string }, food: Record<string, unknown>) => {
        const { sid, state } = await toVenueStep(title, night, food);
        const opt = state.venue.options[0].id;
        let last: any = null;
        for (const p of party) last = await call("POST", P(sid, "vote"), p, { optionIds: [opt] });
        return { sid, state: last.json };
    };

    try {
        for (const name of ["gm", "p1", "p2", "p3", "outsider", "admin"]) {
            const email = `food-${name}-${tag}@example.test`;
            const { rows: [acct] } = await pool.query(
                `INSERT INTO accounts (id, handle, email, app_role, app_role_source) VALUES (gen_random_uuid(), $1, $2, $3, 'manual') RETURNING id`,
                [`${name}_${tag}`, email, name === "admin" ? "admin" : "user"]);
            who[name] = { id: acct.id, token: jwt.sign({ id: acct.id, email }, SECRET, { expiresIn: "1h" }) };
        }
        const { rows: [camp] } = await pool.query(
            `INSERT INTO campaigns (title, owner_id, quorum, gm_title) VALUES ('Hollow Vale', $1, 3, 'Keeper') RETURNING id`, [who.gm.id]);
        campaignId = camp.id;
        for (const [i, [name, status]] of ([["gm", "Game Master"], ["p1", "Player"], ["p2", "Player"], ["p3", "Player"]] as const).entries()) {
            await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, status, joined_at) VALUES ($1, $2, $3, $4)`,
                [campaignId, who[name].id, status, new Date(Date.UTC(2026, 0, 1 + i))]);
        }
        // A store the campaign used recently, so the venue vote opens with it (and it has no host).
        await pool.query(`INSERT INTO venues (campaign_id, name, kind, address, last_used_at) VALUES ($1, 'Hearthside Games', 'store', '12 Market St', now())`,
            [campaignId]);

        console.log("\n#93 — the food step: potluck and food provided\n");

        // ── kickoff ─────────────────────────────────────────────────────────
        console.log("  kickoff");
        check("in person without a food mode is a 400", (await kick("gm", { isOnline: false })).status === 400);
        check("...and so is an explicit null", (await kick("gm", { isOnline: false, foodMode: null })).status === 400);
        check("online still needs none", (await kick("gm", { title: "Online one", isOnline: true })).status === 200);
        await pool.query(`DELETE FROM game_sessions WHERE campaign_id = $1`, [campaignId]);

        // ── potluck: seed, claim, un-claim, add, GM confirms ───────────────
        console.log("\n  potluck");
        const A = slot(0);
        const { sid: sid1, state: f1 } = await toFoodStep("Feast of Lanterns", A, { foodMode: "potluck" });
        check("the session reaches the food step with an empty potluck",
            f1.session.stage === "food" && f1.food?.mode === "potluck" && f1.food.quests.length === 0, f1.food ?? f1.session);

        check("a player can't seed slots (403)", (await call("POST", P(sid1, "food/seed"), "p1", { titles: ["Main"] })).status === 403);
        check("nor can someone outside the party (403)",
            (await call("POST", P(sid1, "food/seed"), "outsider", { titles: ["Main"] })).status === 403);
        check("...neither made a slot", (await foodRows(sid1)).length === 0);
        check("seeding needs at least one title (400)", (await call("POST", P(sid1, "food/seed"), "gm", { titles: [] })).status === 400);
        check("...and no blank ones (400)", (await call("POST", P(sid1, "food/seed"), "gm", { titles: ["Main", "  "] })).status === 400);
        check("...nor the same one twice (400)", (await call("POST", P(sid1, "food/seed"), "gm", { titles: ["Main", "main"] })).status === 400);

        let mark = events.length;
        const seeded = await call("POST", P(sid1, "food/seed"), "gm", { titles: ["Main", "Snacks", "Drinks"] });
        const rows1 = await foodRows(sid1);
        check("the Keeper seeds Main, Snacks and Drinks: three open, unclaimed slots, in that order",
            seeded.status === 200 && seeded.json.food.quests.map((q: any) => `${q.title}:${q.assignee === null}`).join() ===
                "Main:true,Snacks:true,Drinks:true", seeded.json?.food ?? seeded.json);
        check("...each is a food quest, due at the session's start, made by the Keeper",
            rows1.length === 3 && rows1.every((r) => r.kind === "food" && r.status === "open" && r.assignee_id === null &&
                +r.due_at === +new Date(A.start) && r.created_by === who.gm.id), rows1);
        await settle();
        check("...published as three unassigned quests",
            eventsFor(sid1, "quest.assigned", mark).length === 3 &&
                eventsFor(sid1, "quest.assigned", mark).every((e) => e.assigneeId === null && e.kind === "food" && e.assignedBy === who.gm.id),
            eventsFor(sid1, "quest.assigned", mark));
        check("seeding a slot that already exists is a 409",
            (await call("POST", P(sid1, "food/seed"), "gm", { titles: ["Dessert", "DRINKS"] })).status === 409);
        check("...and nothing from that request was added", (await foodRows(sid1)).length === 3);

        const main = slotId(seeded.json, "Main"), snacks = slotId(seeded.json, "Snacks"), drinks = slotId(seeded.json, "Drinks");
        mark = events.length;
        const cl = await call("POST", P(sid1, `food/${main}/claim`), "p1");
        check("a player claims Main: it's theirs",
            cl.status === 200 && cl.json.food.quests.find((q: any) => q.id === main)?.assignee?.id === who.p1.id, cl.json?.food ?? cl.json);
        await settle();
        const claimEvt = eventsFor(sid1, "quest.assigned", mark)[0];
        check("...published: assigned to them, by them, from nobody",
            claimEvt?.assigneeId === who.p1.id && claimEvt.previousAssigneeId === null && claimEvt.assignedBy === who.p1.id, claimEvt);
        check("...no bell for claiming your own slot", (await bell("p1", "New quest:%")).length === 0);
        check("...it's in their Quest Log", (await mine("p1")).some((q) => q.id === main && q.kind === "food" && q.title === "Main"));
        check("someone else can't claim a claimed slot (409)", (await call("POST", P(sid1, `food/${main}/claim`), "p2")).status === 409);
        check("someone outside the party can't claim (403)", (await call("POST", P(sid1, `food/${snacks}/claim`), "outsider")).status === 403);
        check("a slot from another session isn't found here (404)",
            (await call("POST", P(sid1, `food/${crypto.randomUUID()}/claim`), "p2")).status === 404);

        check("a player can't un-claim someone else's slot (403)", (await call("POST", P(sid1, `food/${main}/unclaim`), "p3")).status === 403);
        mark = events.length;
        const un = await call("POST", P(sid1, `food/${main}/unclaim`), "p1");
        check("the claimer un-claims Main: it's open again",
            un.status === 200 && un.json.food.quests.find((q: any) => q.id === main)?.assignee === null &&
                (await foodRows(sid1)).find((r) => r.id === main)?.assignee_id === null, un.json?.food ?? un.json);
        await settle();
        const unEvt = eventsFor(sid1, "quest.assigned", mark)[0];
        check("...published: unassigned, previously theirs",
            unEvt?.assigneeId === null && unEvt.previousAssigneeId === who.p1.id && unEvt.assignedBy === who.p1.id, unEvt);
        check("...and gone from their Quest Log", !(await mine("p1")).some((q) => q.id === main));
        check("un-claiming an open slot is a 409", (await call("POST", P(sid1, `food/${main}/unclaim`), "p1")).status === 409);

        mark = events.length;
        const add = await call("POST", P(sid1, "food/add"), "p2", { title: "Dessert" });
        const dessert = slotId(add.json, "Dessert");
        check("a player adds their own slot, Dessert: it's theirs from the start",
            add.status === 200 && add.json.food.quests.find((q: any) => q.id === dessert)?.assignee?.id === who.p2.id, add.json?.food ?? add.json);
        check("...made by them", (await foodRows(sid1)).find((r) => r.id === dessert)?.created_by === who.p2.id);
        await settle();
        check("...published", eventsFor(sid1, "quest.assigned", mark)[0]?.assigneeId === who.p2.id);
        check("...in their Quest Log", (await mine("p2")).some((q) => q.id === dessert));
        check("adding a slot that's already there is a 409 (claim it instead)",
            (await call("POST", P(sid1, "food/add"), "p3", { title: " drinks " })).status === 409);
        check("adding needs a title (400)", (await call("POST", P(sid1, "food/add"), "p3", { title: "" })).status === 400);
        check("someone outside the party can't add one (403)",
            (await call("POST", P(sid1, "food/add"), "outsider", { title: "Crisps" })).status === 403);

        await call("POST", P(sid1, `food/${main}/claim`), "p3");
        await call("POST", P(sid1, `food/${drinks}/claim`), "p2");
        const before = await call("GET", P(sid1), "p1");
        check("the party sees who brings what; Snacks is the one left unclaimed",
            before.json.food.quests.map((q: any) => `${q.title}:${q.assignee?.id ?? "-"}`).join() ===
                `Main:${who.p3.id},Snacks:-,Drinks:${who.p2.id},Dessert:${who.p2.id}`, before.json.food);

        check("a player can't confirm the food (403)", (await call("POST", P(sid1, "confirm-food"), "p1")).status === 403);
        check("nor can someone outside the party (403)", (await call("POST", P(sid1, "confirm-food"), "outsider")).status === 403);
        mark = events.length;
        const talkBefore = (await talk()).length;
        const cf = await call("POST", P(sid1, "confirm-food"), "gm");
        check("the Keeper confirms with Snacks still unclaimed: the session is scheduled anyway",
            cf.status === 200 && cf.json.session.status === "scheduled" && cf.json.session.stage === null, cf.json?.session ?? cf.json);
        check("...Snacks stays an open, unclaimed slot", (await foodRows(sid1)).find((r) => r.id === snacks)?.assignee_id === null);
        await settle();
        check("...published as scheduled, by the Keeper",
            eventsFor(sid1, "planning.stage_changed", mark).map((e) => `${e.status}/${e.stage}/${e.actorId === who.gm.id}`).join() === "scheduled/null/true");
        check("...the party hears it's on", (await talk()).slice(talkBefore).some((b) => /"Feast of Lanterns" is scheduled/.test(b)));
        check("once the food step is over, claiming is a 409", (await call("POST", P(sid1, `food/${snacks}/claim`), "p1")).status === 409);
        check("...and so is seeding", (await call("POST", P(sid1, "food/seed"), "gm", { titles: ["Ice"] })).status === 409);
        const alm = await call("GET", `/api/quests/almanac?start=${new Date(t0 - DAY).toISOString()}&end=${new Date(t0 + DAY).toISOString()}`, "p3");
        check("the claim is on the claimer's Almanac, next to the session",
            alm.json.sessions.find((s: any) => s.id === sid1)?.quests.some((q: any) => q.id === main), alm.json);

        // ── food provided ───────────────────────────────────────────────────
        console.log("\n  food provided");
        const B = slot(2);
        mark = events.length;
        const { sid: sid2, state: f2 } = await toFoodStep("Harvest Moot", B, { foodMode: "provided", foodOwnerId: who.p2.id });
        const prov = await foodRows(sid2);
        check("on reaching the food step, the food owner gets one provisioning quest",
            prov.length === 1 && prov[0].assignee_id === who.p2.id && prov[0].title === "Provide the food" && prov[0].status === "open" &&
                +prov[0].due_at === +new Date(B.start) && prov[0].created_by === null, prov);
        check("...shown on the Notice Board", f2.food?.mode === "provided" && f2.food.ownerId === who.p2.id &&
            f2.food.quests.length === 1 && f2.food.quests[0].assignee?.id === who.p2.id, f2.food);
        await settle();
        const provEvt = eventsFor(sid2, "quest.assigned", mark);
        check("...published as assigned by the app", provEvt.length === 1 && provEvt[0].assigneeId === who.p2.id && provEvt[0].assignedBy === null, provEvt);
        check("...the owner is belled", (await bell("p2", "New quest: Provide the food")).length === 1);
        check("...and it's in their Quest Log", (await mine("p2")).some((q) => q.id === prov[0].id));
        check("there's no potluck to seed (409)", (await call("POST", P(sid2, "food/seed"), "gm", { titles: ["Main"] })).status === 409);
        check("...nor to add to (409)", (await call("POST", P(sid2, "food/add"), "p1", { title: "Crisps" })).status === 409);
        check("...and the provisioning quest can't be claimed (409)", (await call("POST", P(sid2, `food/${prov[0].id}/claim`), "p1")).status === 409);
        const cf2 = await call("POST", P(sid2, "confirm-food"), "gm");
        check("the Keeper confirms: scheduled, the owner's quest still open",
            cf2.json.session.status === "scheduled" && (await foodRows(sid2))[0].status === "open", cf2.json?.session);

        // ── combined with #87 and #91: changing the night moves the food quest ──
        console.log("\n  changing the night afterwards (#87 + #91)");
        const E = slot(12);
        const reopened = await call("POST", P(sid2, "reopen"), "gm", { options: [E, slot(13)] });
        check("the Keeper reopens the night of the scheduled in-person session",
            reopened.status === 200 && reopened.json.session.status === "planning" && reopened.json.session.stage === "night", reopened.json);
        const dueReopened = await Session.find(readyCheckDueFilter(new Date(+new Date(B.start) - 20 * MINUTE)))
            .then((rows: any[]) => rows.map((r) => String(r._id)));
        check("...while its night is re-decided it gets no ready check (#93's filter: food step or scheduled only)",
            !dueReopened.includes(sid2), dueReopened);
        const optE = reopened.json.night.options.find((o: any) => o.start === E.start).id;
        for (const p of party) await call("POST", P(sid2, "vote"), p, { optionIds: [optE] });
        check("...the new night is confirmed and the session is scheduled again",
            (await row(sid2)).status === "scheduled" && (await row(sid2)).date.toISOString() === E.start);
        const movedProv = await waitFor(async () => {
            const [q] = await foodRows(sid2);
            return +q.due_at === +new Date(E.start) ? q : null;
        });
        check("...and #91 moves the provisioning quest's due time to the new night",
            movedProv !== null && +movedProv.due_anchor === +new Date(E.start), await foodRows(sid2));

        // ── the automatic close at session start (injected clock) ──────────
        console.log("\n  the automatic close at session start");
        const C = slot(4), startC = new Date(C.start);
        const { sid: sid3 } = await toFoodStep("Lantern Watch", C, { foodMode: "potluck" });
        // A one-session torch pass: the stand-in GM seeds; an admin can too.
        await pool.query(`UPDATE game_sessions SET gm_override_id = $2 WHERE id = $1`, [sid3, who.p3.id]);
        const standIn = await call("POST", P(sid3, "food/seed"), "p3", { titles: ["Main", "Drinks"] });
        check("the session's stand-in GM can seed slots", standIn.status === 200 && standIn.json.food.quests.length === 2, standIn.json);
        const adminSeed = await call("POST", P(sid3, "food/seed"), "admin", { titles: ["Snacks"] });
        check("...and so can an admin", adminSeed.status === 200 && adminSeed.json.food.quests.length === 3, adminSeed.json);
        await call("POST", P(sid3, `food/${slotId(adminSeed.json, "Main")}/claim`), "p1");
        // Another session whose start has passed, but still on the venue step: not the sweep's business.
        const { sid: sid4 } = await toVenueStep("Stalled Venue", slot(5), { foodMode: "potluck" });
        await pool.query(`UPDATE game_sessions SET date = $2 WHERE id = $1`, [sid4, new Date(+startC - HOUR)]);

        const dueAt = (now: Date) => Session.find(readyCheckDueFilter(now)).then((rows: any[]) => rows.map((r) => String(r._id)));
        const due = await dueAt(new Date(+startC - 20 * MINUTE));
        check("the ready check covers a session still in the food step (T-30 window)", due.includes(sid3), due);
        const dueVenue = await dueAt(new Date(+startC - HOUR - 20 * MINUTE));
        check("...but not one still choosing its venue", !dueVenue.includes(sid4), dueVenue);

        mark = events.length;
        const talkBeforeClose = (await talk()).length;
        const early = await closeDueFoodSteps(pool, new Date(+startC - MINUTE));
        check("a minute before the start, the sweep closes nothing", early.closed.length === 0 && (await row(sid3)).planning_stage === "food", early);
        const atStart = await closeDueFoodSteps(pool, startC);
        const r3 = await row(sid3);
        check("at the start, it closes the food step: the session is scheduled",
            atStart.closed.join() === sid3 && r3.status === "scheduled" && r3.planning_stage === null, { atStart, r3 });
        check("...the stalled venue session is left alone", (await row(sid4)).planning_stage === "venue");
        await settle();
        const autoEvt = eventsFor(sid3, "planning.stage_changed", mark);
        check("...published as scheduled, closed by the session's start",
            autoEvt.length === 1 && autoEvt[0].status === "scheduled" && autoEvt[0].stage === null &&
                autoEvt[0].closedBy === "session_start" && autoEvt[0].actorId === undefined, autoEvt);
        check("...without a Table Talk post (the session is already starting)", (await talk()).length === talkBeforeClose);
        const r3food = await foodRows(sid3);
        check("...unclaimed slots stay open and unclaimed; the claim stays with its claimer",
            r3food.filter((r) => r.assignee_id === null).length === 2 && r3food.find((r) => r.title === "Main")?.assignee_id === who.p1.id, r3food);
        mark = events.length;
        const again = await closeDueFoodSteps(pool, new Date(+startC + 5 * MINUTE));
        await settle();
        check("running it again closes nothing and publishes nothing (idempotent)",
            again.closed.length === 0 && eventsFor(sid3, "planning.stage_changed", mark).length === 0, again);
        check("the GM confirming after the automatic close is a 409", (await call("POST", P(sid3, "confirm-food"), "gm")).status === 409);
        const dueAfter = await dueAt(new Date(+startC - 20 * MINUTE));
        check("...and the ready check still covers it, now scheduled", dueAfter.includes(sid3), dueAfter);

        // ── combined with #89: a one-session stand-in runs the venue and food steps ──
        console.log("\n  a one-session stand-in GM (#89) runs the in-person steps");
        const F = slot(20);
        const k5 = await kick("gm", { title: "Torchlit Supper", isOnline: false, foodMode: "potluck" });
        const sid5 = k5.json.session.id as string;
        const passed = await call("POST", P(sid5, "torch"), "gm", { to: who.p1.id });
        check("the Keeper passes this session's torch to a player", passed.status === 200 && passed.json.session.gmOverride?.id === who.p1.id, passed.json);
        const sl5 = await call("POST", P(sid5, "shortlist"), "p1", { options: [F, slot(21)] });
        check("...the stand-in shortlists the nights", sl5.status === 200 && sl5.json.night?.options.length === 2, sl5.json);
        const optF = sl5.json.night.options.find((o: any) => o.start === F.start).id;
        let v5: any = null;
        for (const p of party) v5 = await call("POST", P(sid5, "vote"), p, { optionIds: [optF] });
        check("...the night is confirmed and the venue vote opens", v5.json.session.stage === "venue" && v5.json.venue?.options.length >= 1, v5.json?.session);
        await call("POST", P(sid5, "vote"), "p2", { optionIds: [v5.json.venue.options[0].id] });
        const adv5 = await call("POST", P(sid5, "advance"), "p1");
        check("...the stand-in force-advances the venue vote into the food step",
            adv5.status === 200 && adv5.json.session.stage === "food", adv5.json?.session ?? adv5.json);
        await pool.query(`DELETE FROM campaign_members WHERE campaign_id = $1 AND person_id = $2`, [campaignId, who.p1.id]);
        check("...a stand-in who has left the party can't seed the potluck (#89: stand-ins count only while seated)",
            (await call("POST", P(sid5, "food/seed"), "p1", { titles: ["Pie"] })).status === 403);
        check("...nor confirm the food (403)", (await call("POST", P(sid5, "confirm-food"), "p1")).status === 403);
        await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, status, joined_at) VALUES ($1, $2, 'Player', $3)`,
            [campaignId, who.p1.id, new Date(Date.UTC(2026, 0, 2))]);
        const seed5 = await call("POST", P(sid5, "food/seed"), "p1", { titles: ["Pie", "Cider"] });
        check("...back in the party, the stand-in seeds the potluck", seed5.status === 200 && seed5.json.food.quests.length === 2, seed5.json);
        const cf5 = await call("POST", P(sid5, "confirm-food"), "p1");
        check("...and confirms the food: scheduled", cf5.status === 200 && cf5.json.session.status === "scheduled", cf5.json?.session ?? cf5.json);
    } finally {
        await announcer.idle();
        announcer.stop();
        uninstall();
        const ids = Object.values(who).map((p) => p.id);
        if (campaignId) {
            await pool.query(`DELETE FROM game_sessions WHERE campaign_id = $1`, [campaignId]);
            await pool.query(`DELETE FROM campaigns WHERE id = $1`, [campaignId]);
        }
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
