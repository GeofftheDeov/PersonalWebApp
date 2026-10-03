/**
 * Quests (#90, part of #57), seam 1: the HTTP API.
 *
 * Mounts the real quest router -- built with an injected clock -- and drives it
 * over HTTP with real JWTs against a throwaway database loaded from
 * db/schema.sql. Checks what's visible from outside: responses, rows, bell
 * notifications and bus events.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-quests-api.ts
 */
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import pool from "../db/index.js";
import { bus } from "../events/index.js";
import { buildQuestRouter } from "../routes/questRoutes.js";
import { createQuests } from "../planning/quests.js";

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

// The clock the quest module reads "upcoming" against: a fixed instant, so a
// session an hour in the "past" is past however long the run takes.
const NOW = new Date(Math.ceil((Date.now() + DAY) / HOUR) * HOUR);

async function main() {
    const app = express();
    app.use(express.json());
    app.use("/api/quests", buildQuestRouter(createQuests({ now: () => NOW })));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const events: { name: string; payload: any }[] = [];
    for (const name of ["quest.assigned", "quest.completed"] as const) {
        bus.subscribe(name, (payload: any) => { events.push({ name, payload }); });
    }
    const flush = () => new Promise((r) => setImmediate(r));

    const tag = crypto.randomBytes(4).toString("hex");
    const who: Record<string, { id: string; token: string }> = {};
    const campaigns: string[] = [];

    const call = async (method: string, path: string, as?: string, body?: unknown) => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (as) headers.authorization = `Bearer ${who[as].token}`;
        const res = await fetch(`${base}/api/quests${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        return { status: res.status, json };
    };
    const create = (as: string, sessionId: string, body: unknown) => call("POST", `/sessions/${sessionId}`, as, body);
    const ofSession = (as: string, sessionId: string) => call("GET", `/sessions/${sessionId}`, as);
    const mine = (as: string, qs = "") => call("GET", `/mine${qs}`, as);
    const done = (as: string, questId: string) => call("POST", `/${questId}/done`, as);
    const edit = (as: string, questId: string, body: unknown) => call("PATCH", `/${questId}`, as, body);
    const row = async (id: string) => (await pool.query(`SELECT * FROM session_tasks WHERE id = $1`, [id])).rows[0];
    const bells = async (person: string, questId: string) => (await pool.query(
        `SELECT title, link FROM notifications WHERE user_id = $1 AND meta->>'questId' = $2`, [who[person].id, questId])).rows;
    const eventsFor = (questId: string) => events.filter((e) => e.payload.questId === questId);

    const at = (offsetMs: number) => new Date(+NOW + offsetMs);
    const session = async (campaignId: string, title: string, fields: { date: Date | null; status?: string; stage?: string | null; endDate?: Date }) => {
        const { rows: [s] } = await pool.query(
            `INSERT INTO game_sessions (title, campaign_id, date, end_date, status, planning_stage)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [title, campaignId, fields.date, fields.endDate ?? null, fields.status ?? "scheduled", fields.stage ?? null]);
        return s.id as string;
    };

    try {
        for (const name of ["gm", "p1", "p2", "outsider", "admin", "gm2"]) {
            const email = `quest-${name}-${tag}@example.test`;
            const { rows: [r] } = await pool.query(
                `INSERT INTO accounts (id, handle, email, app_role, app_role_source) VALUES (gen_random_uuid(), $1, $2, $3, 'manual') RETURNING id`,
                [`${name}_${tag}`, email, name === "admin" ? "admin" : "user"]);
            who[name] = { id: r.id, token: jwt.sign({ id: r.id, email }, SECRET, { expiresIn: "1h" }) };
        }
        const campaign = async (title: string, gmTitle: string, members: [string, string][]) => {
            const { rows: [c] } = await pool.query(
                `INSERT INTO campaigns (title, owner_id, gm_title) VALUES ($1, $2, $3) RETURNING id`, [title, who[members[0][0]].id, gmTitle]);
            campaigns.push(c.id);
            for (const [i, [name, status]] of members.entries()) {
                await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, status, joined_at) VALUES ($1, $2, $3, $4)`,
                    [c.id, who[name].id, status, new Date(Date.UTC(2026, 0, 1 + i))]);
            }
            return c.id as string;
        };
        const ashen = await campaign("Ashen Crown", "Host", [["gm", "Game Master"], ["p1", "Player"], ["p2", "Player"]]);
        const tides = await campaign("Sunken Tides", "Dungeon Master", [["gm2", "Game Master"], ["p1", "Player"]]);

        const s1 = await session(ashen, "Session 14", { date: at(3 * DAY), endDate: at(3 * DAY + 4 * HOUR) });
        const s2 = await session(tides, "Tides 3", { date: at(2 * DAY) });
        const sPlanning = await session(ashen, "Session 15", { date: null, status: "planning", stage: "night" });
        const sPast = await session(ashen, "Session 13", { date: at(-2 * DAY), endDate: at(-2 * DAY + 4 * HOUR) });
        const sCancelled = await session(ashen, "Session 12", { date: at(5 * DAY), status: "cancelled" });
        const s3 = await session(ashen, "Session 16", { date: at(10 * DAY) });

        console.log("\n#90 — quests\n");

        // ── creating ────────────────────────────────────────────────────────
        const notGm = await create("p1", s1, { title: "Print the handout", assigneeId: who.p2.id });
        check("a player can't create a quest, and is told who can (the GM title)",
            notGm.status === 403 && /Host/.test(notGm.json?.error), notGm);
        check("someone outside the party can't either (403)",
            (await create("outsider", s1, { title: "Snacks", assigneeId: who.p1.id })).status === 403);
        check("assigning someone outside the party is rejected (400)",
            (await create("gm", s1, { title: "Snacks", assigneeId: who.outsider.id })).status === 400);
        check("...including a party member of another campaign (400)",
            (await create("gm", s1, { title: "Snacks", assigneeId: who.gm2.id })).status === 400);
        check("an assignee that isn't an id is a 400",
            (await create("gm", s1, { title: "Snacks", assigneeId: "nobody" })).status === 400);
        check("a custom quest needs an assignee (400)", (await create("gm", s1, { title: "Snacks" })).status === 400);
        check("a title is required (400)", (await create("gm", s1, { title: "   ", assigneeId: who.p1.id })).status === 400);
        check("titles are capped at 120 characters (400)",
            (await create("gm", s1, { title: "x".repeat(121), assigneeId: who.p1.id })).status === 400);
        check("a due time that isn't a date is a 400",
            (await create("gm", s1, { title: "Snacks", assigneeId: who.p1.id, dueAt: "soonish" })).status === 400);
        check("an unknown session is a 404",
            (await create("gm", crypto.randomUUID(), { title: "Snacks", assigneeId: who.p1.id })).status === 404 &&
                (await create("gm", "not-a-uuid", { title: "Snacks", assigneeId: who.p1.id })).status === 404);
        check("a cancelled session takes no new quests (409)",
            (await create("gm", sCancelled, { title: "Snacks", assigneeId: who.p1.id })).status === 409);

        const handout = await create("gm", s1, { title: "  Print the handout ", notes: "Two copies, colour.", assigneeId: who.p1.id });
        const qHandout = handout.json?.id;
        check("the GM creates a custom quest for a party member; it's due at the session's start",
            handout.status === 201 && handout.json.kind === "custom" && handout.json.status === "open" &&
                handout.json.title === "Print the handout" && handout.json.notes === "Two copies, colour." &&
                handout.json.assignee?.id === who.p1.id && handout.json.assignee?.name === `p1_${tag}` &&
                handout.json.dueAt === at(3 * DAY).toISOString() && handout.json.session?.id === s1 &&
                handout.json.session?.campaign?.title === "Ashen Crown", handout.json);
        const stored = await row(qHandout);
        check("the row records who created it, with no reminders yet",
            stored?.created_by === who.gm.id && stored?.reminder_offsets?.length === 0 && stored?.completed_at === null, stored);
        await flush();
        check("creating publishes quest.assigned",
            eventsFor(qHandout).map((e) => e.name).join() === "quest.assigned" &&
                eventsFor(qHandout)[0].payload.assigneeId === who.p1.id && eventsFor(qHandout)[0].payload.previousAssigneeId === null &&
                eventsFor(qHandout)[0].payload.assignedBy === who.gm.id && eventsFor(qHandout)[0].payload.sessionId === s1 &&
                eventsFor(qHandout)[0].payload.campaignId === ashen && eventsFor(qHandout)[0].payload.kind === "custom", eventsFor(qHandout));
        const bell = await bells("p1", qHandout);
        check("the assignee gets a bell notification linking to the session's quests",
            bell.length === 1 && bell[0].link === `/game-night/sessions/${s1}#quests`, bell);

        const map = await create("gm", s1, { title: "Bring the battle map", assigneeId: who.p2.id, dueAt: at(3 * DAY - 2 * HOUR).toISOString() });
        check("an explicit due time is kept", map.status === 201 && map.json.dueAt === at(3 * DAY - 2 * HOUR).toISOString(), map.json);
        const own = await create("gm", s1, { title: "Prep the encounter", assigneeId: who.gm.id });
        check("the GM can give a quest to themselves, without a bell for it",
            own.status === 201 && (await bells("gm", own.json.id)).length === 0);
        const byAdmin = await create("admin", s1, { title: "Book the room", assigneeId: who.p2.id });
        check("an admin outside the party can create one", byAdmin.status === 201, byAdmin);

        await pool.query(`UPDATE game_sessions SET gm_override_id = $2 WHERE id = $1`, [s3, who.p2.id]);
        const byStandIn = await create("p2", s3, { title: "Bring dice", assigneeId: who.p1.id });
        check("a session's stand-in GM can create quests on that session", byStandIn.status === 201, byStandIn);
        check("...and on that session only", (await create("p2", s1, { title: "Bring dice", assigneeId: who.p1.id })).status === 403);

        const planningQuest = await create("gm", sPlanning, { title: "Read the recap", assigneeId: who.p1.id });
        check("a quest on a session still being planned has no due time yet",
            planningQuest.status === 201 && planningQuest.json.dueAt === null, planningQuest.json);
        const tidesQuest = await create("gm2", s2, { title: "Bring snacks", assigneeId: who.p1.id });
        const pastQuest = await create("gm", sPast, { title: "Write the recap", assigneeId: who.p1.id });
        check("quests on other campaigns' and past sessions can be created too", tidesQuest.status === 201 && pastQuest.status === 201);

        // ── a session's quests ──────────────────────────────────────────────
        const asP2 = await ofSession("p2", s1);
        check("a party member sees every quest on the session, as a player",
            asP2.status === 200 && asP2.json.quests.length === 4 && asP2.json.viewer.isGameMaster === false &&
                asP2.json.gmTitle === "Host" && asP2.json.party.length === 3 && asP2.json.session.id === s1, asP2.json);
        check("they're ordered by due time",
            asP2.json.quests.map((q: any) => q.title)[0] === "Bring the battle map", asP2.json.quests.map((q: any) => q.title));
        check("someone outside the party can't see them (403)", (await ofSession("outsider", s1)).status === 403);
        check("the GM sees them as the GM", (await ofSession("gm", s1)).json?.viewer?.isGameMaster === true);
        check("an unknown session is a 404", (await ofSession("gm", crypto.randomUUID())).status === 404);

        // ── my quests (the Quest Log) ───────────────────────────────────────
        const log = await mine("p1");
        const logTitles = log.json?.quests?.map((q: any) => q.title);
        check("my quests span sessions and campaigns: open, for upcoming sessions, soonest first, planning last",
            log.status === 200 && logTitles?.join("|") === ["Bring snacks", "Print the handout", "Bring dice", "Read the recap"].join("|"), logTitles);
        check("each carries its session and campaign",
            log.json?.quests?.[0]?.session?.title === "Tides 3" && log.json.quests[0].session.campaign.title === "Sunken Tides", log.json?.quests?.[0]);
        check("someone else's quests aren't in my log", !(await mine("p2")).json.quests.some((q: any) => q.assignee?.id !== who.p2.id));
        const all = await mine("p1", "?scope=all");
        check("?scope=all includes past sessions' quests",
            all.status === 200 && all.json.quests.some((q: any) => q.id === pastQuest.json.id), all.json?.quests?.map((q: any) => q.title));
        check("an unknown scope is a 400", (await mine("p1", "?scope=everything")).status === 400);
        check("signing in is required", (await call("GET", "/mine")).status === 401);

        // ── reassigning ─────────────────────────────────────────────────────
        check("a player can't reassign a quest (403)", (await edit("p1", qHandout, { assigneeId: who.p2.id })).status === 403);
        check("reassigning outside the party is rejected (400)", (await edit("gm", qHandout, { assigneeId: who.outsider.id })).status === 400);
        check("a custom quest can't be left without an owner (400)", (await edit("gm", qHandout, { assigneeId: null })).status === 400);
        const moved = await edit("gm", qHandout, { assigneeId: who.p2.id });
        await flush();
        const assigned = eventsFor(qHandout).filter((e) => e.name === "quest.assigned");
        check("the GM reassigns it; quest.assigned names the new and previous owners",
            moved.status === 200 && moved.json.assignee.id === who.p2.id && assigned.length === 2 &&
                assigned[1].payload.assigneeId === who.p2.id && assigned[1].payload.previousAssigneeId === who.p1.id, { moved: moved.json, assigned });
        check("it leaves the old owner's Quest Log and joins the new one's",
            !(await mine("p1")).json.quests.some((q: any) => q.id === qHandout) && (await mine("p2")).json.quests.some((q: any) => q.id === qHandout));
        const retitled = await edit("gm", qHandout, { title: "Print two handouts" });
        await flush();
        check("editing without changing the owner doesn't publish quest.assigned",
            retitled.status === 200 && retitled.json.title === "Print two handouts" &&
                eventsFor(qHandout).filter((e) => e.name === "quest.assigned").length === 2);

        // ── marking done ────────────────────────────────────────────────────
        check("another party member can't mark it done (403)", (await done("p1", qHandout)).status === 403);
        check("someone outside the party can't either (403)", (await done("outsider", qHandout)).status === 403);
        check("an unknown quest is a 404", (await done("p2", crypto.randomUUID())).status === 404);
        const finished = await done("p2", qHandout);
        await flush();
        check("its owner marks it done",
            finished.status === 200 && finished.json.status === "done" && finished.json.completedAt !== null, finished.json);
        check("marking done publishes quest.completed",
            eventsFor(qHandout).filter((e) => e.name === "quest.completed").length === 1 &&
                eventsFor(qHandout).find((e) => e.name === "quest.completed")!.payload.completedBy === who.p2.id);
        check("a done quest leaves the Quest Log", !(await mine("p2")).json.quests.some((q: any) => q.id === qHandout));
        const again = await done("p2", qHandout);
        await flush();
        check("marking it done again is harmless, and publishes nothing new",
            again.status === 200 && again.json.status === "done" &&
                eventsFor(qHandout).filter((e) => e.name === "quest.completed").length === 1);
        check("a done quest can't be reassigned (409)", (await edit("gm", qHandout, { assigneeId: who.p1.id })).status === 409);
        const byGm = await done("gm", map.json.id);
        check("the GM can mark someone else's quest done", byGm.status === 200 && byGm.json.status === "done");
        const byStandInDone = await done("p2", byStandIn.json.id);
        check("so can the session's stand-in GM", byStandInDone.status === 200);

        await pool.query(`UPDATE session_tasks SET status = 'cancelled' WHERE id = $1`, [own.json.id]);
        check("a cancelled quest can't be marked done (409)", (await done("gm", own.json.id)).status === 409);

        // ── the Almanac ─────────────────────────────────────────────────────
        const range = `?start=${encodeURIComponent(at(-7 * DAY).toISOString())}&end=${encodeURIComponent(at(30 * DAY).toISOString())}`;
        const almanac = await call("GET", `/almanac${range}`, "p1");
        const byId = Object.fromEntries((almanac.json?.sessions ?? []).map((s: any) => [s.id, s]));
        check("the Almanac lists my sessions across campaigns in the range, with dates, not cancelled or undated ones",
            almanac.status === 200 && byId[s1] && byId[s2] && byId[sPast] && byId[s3] && !byId[sCancelled] && !byId[sPlanning] &&
                byId[s1].date === at(3 * DAY).toISOString() && byId[s2].campaign.title === "Sunken Tides", almanac.json);
        check("each session carries my quests on it, done ones included",
            byId[s2]?.quests?.map((q: any) => q.title).join() === "Bring snacks" &&
                byId[s3]?.quests?.map((q: any) => `${q.title}:${q.status}`).join() === "Bring dice:done" &&
                byId[s1]?.quests?.length === 0, { s1: byId[s1], s3: byId[s3] });
        check("someone outside the party sees none of it",
            !((await call("GET", `/almanac${range}`, "outsider")).json?.sessions ?? []).some((s: any) => s.id === s1));
        check("a range that isn't dates is a 400", (await call("GET", `/almanac?start=nope&end=nope`, "p1")).status === 400);
    } finally {
        const ids = Object.values(who).map((p) => p.id);
        if (campaigns.length) await pool.query(`DELETE FROM campaigns WHERE id = ANY($1)`, [campaigns]);
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
