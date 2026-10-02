/**
 * Session planning (#57), seam 1 for the night step: the HTTP API.
 *
 * Mounts the real planning, campaign and tabletop routers -- the planner built
 * with a fake ExternalEvents that records what it was asked to publish -- and
 * drives them over HTTP with real JWTs against a throwaway database loaded
 * from db/schema.sql. Checks what's visible from outside: responses, rows,
 * bell notifications, Table Talk posts, bus events and calls to the fake.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-planning-api.ts
 */
import express from "express";
import type { AddressInfo } from "net";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import pool from "../db/index.js";
import { bus } from "../events/index.js";
import { buildPlanningRouter } from "../routes/planningRoutes.js";
import campaignRoutes from "../routes/campaignRoutes.js";
import tabletopRoutes from "../routes/tabletopRoutes.js";
import { createPlanner } from "../planning/planner.js";
import type { ExternalEvents, PublishSessionInput } from "../planning/externalEvents.js";
import { runReadyCheckSweep } from "../utils/readyCheck.js";

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

// ── the fake integrations ───────────────────────────────────────────────────
const published: PublishSessionInput[] = [];
let fakeWarnings: string[] = [];
const fakeEvents: ExternalEvents = {
    async publishSession(input) {
        published.push(input);
        return {
            discordEventId: input.discord ? `discord-${published.length}` : null,
            googleEventId: `google-${published.length}`,
            googleCalendarLink: `https://calendar.google.com/fake/${published.length}`,
            warnings: fakeWarnings,
        };
    },
};

async function main() {
    const app = express();
    app.use(express.json());
    app.use("/api/campaigns", campaignRoutes);
    app.use("/api/tabletop", tabletopRoutes);
    app.use("/api/planning", buildPlanningRouter(createPlanner({ events: fakeEvents, now: () => new Date() })));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const events: { name: string; payload: any }[] = [];
    for (const name of ["planning.stage_changed", "planning.poll_opened", "planning.vote_cast", "planning.poll_closed"] as const) {
        bus.subscribe(name, (payload: any) => { events.push({ name, payload }); });
    }

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
        return { status: res.status, json };
    };
    const P = (sessionId: string, action = "") => `/api/planning/sessions/${sessionId}${action ? `/${action}` : ""}`;
    const notes = async (person: string, sessionId: string) => (await pool.query(
        `SELECT title FROM notifications WHERE user_id = $1 AND meta->>'sessionId' = $2`, [who[person].id, sessionId])).rows;
    const talk = async () => (await pool.query(
        `SELECT body FROM messages WHERE campaign_id = $1 AND sender_id = 'system' ORDER BY created_at`, [campaignId])).rows.map((r) => r.body);
    const session = async (id: string) => (await pool.query(`SELECT * FROM game_sessions WHERE id = $1`, [id])).rows[0];

    // Future times on the hour, a week or more out.
    const t0 = Math.ceil((Date.now() + 7 * DAY) / HOUR) * HOUR;
    const slot = (dayOffset: number, hours = 4) => ({
        start: new Date(t0 + dayOffset * DAY).toISOString(), end: new Date(t0 + dayOffset * DAY + hours * HOUR).toISOString(),
    });
    const optionAt = (state: any, s: { start: string }) => state.night.options.find((o: any) => o.start === s.start).id;

    try {
        for (const name of ["gm", "p1", "p2", "p3", "outsider", "admin"]) {
            const email = `plan-${name}-${tag}@example.test`;
            const { rows: [row] } = await pool.query(
                `INSERT INTO accounts (id, handle, email, app_role, app_role_source) VALUES (gen_random_uuid(), $1, $2, $3, 'manual') RETURNING id`,
                [`${name}_${tag}`, email, name === "admin" ? "admin" : "user"]);
            who[name] = { id: row.id, token: jwt.sign({ id: row.id, email }, SECRET, { expiresIn: "1h" }) };
        }
        const { rows: [camp] } = await pool.query(
            `INSERT INTO campaigns (title, owner_id, discord_guild_id) VALUES ('Ashen Crown', $1, '123456789') RETURNING id`, [who.gm.id]);
        campaignId = camp.id;
        for (const [i, [name, status]] of ([["gm", "Game Master"], ["p1", "Player"], ["p2", "Player"], ["p3", "Player"]] as const).entries()) {
            await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, status, joined_at) VALUES ($1, $2, $3, $4)`,
                [campaignId, who[name].id, status, new Date(Date.UTC(2026, 0, 1 + i))]);
        }
        // The GM's week puts the party's messages in Chicago time.
        await pool.query(`INSERT INTO availability_windows (person_id, weekday, start_time, end_time, time_zone)
                          VALUES ($1, 6, '18:00', '23:00', 'America/Chicago')`, [who.gm.id]);

        console.log("\n#57 — planning the night\n");

        // ── campaign settings ───────────────────────────────────────────────
        const set = (as: string, body: unknown) => call("PATCH", `/api/campaigns/${campaignId}/settings`, as, body);
        const s1 = await set("gm", { quorum: 3, tableLink: " https://foundry.example/game ", gmTitle: "Host" });
        check("the owner sets quorum, table link and GM title",
            s1.status === 200 && s1.json.quorum === 3 && s1.json.tableLink === "https://foundry.example/game" && s1.json.gmTitle === "Host", s1.json);
        check("a player can't change campaign settings (403)", (await set("p1", { quorum: 2 })).status === 403);
        check("an admin can", (await set("admin", { quorum: 3 })).status === 200);
        for (const [what, body] of [["quorum 0", { quorum: 0 }], ["a non-http table link", { tableLink: "javascript:alert(1)" }],
            ["an empty GM title", { gmTitle: "  " }], ["an empty body", {}]] as const) {
            check(`${what} is a 400`, (await set("gm", body)).status === 400);
        }

        // ── kickoff ─────────────────────────────────────────────────────────
        const kick = (as: string, body: unknown) => call("POST", `/api/planning/campaigns/${campaignId}/kickoff`, as, body);
        const notGm = await kick("p1", { title: "Session 14", isOnline: true });
        check("a player can't start planning, and is told who can (the GM title)",
            notGm.status === 403 && /Host/.test(notGm.json.error), notGm.json);
        check("in person isn't offered yet (400)", (await kick("gm", { title: "Session 14", isOnline: false })).status === 400);
        check("a title is required", (await kick("gm", { isOnline: true })).status === 400);
        check("online or in person must be chosen", (await kick("gm", { title: "Session 14" })).status === 400);

        const k = await kick("gm", { title: "Session 14", isOnline: true, agenda: "The Drowned Chapel" });
        const sid = k.json?.session?.id;
        check("the GM kicks off: a planning session on the night step, no date yet",
            k.status === 200 && k.json.session.status === "planning" && k.json.session.stage === "night" &&
                k.json.session.date === null && k.json.viewer.isGameMaster && k.json.quorum === 3, k.json);
        check("the party is notified; the GM who kicked off isn't",
            (await notes("p1", sid)).length === 1 && (await notes("gm", sid)).length === 0);
        check("a Table Talk post announces it", (await talk()).some((b) => /being planned.*Session 14/.test(b)));

        const asPlayer = await call("GET", P(sid), "p1");
        check("a player sees the planning state, as a player", asPlayer.status === 200 && !asPlayer.json.viewer.isGameMaster);
        check("someone outside the party doesn't (403)", (await call("GET", P(sid), "outsider")).status === 403);
        const board = await call("GET", `/api/planning/campaigns/${campaignId}`, "p1");
        check("the Notice Board lists it, and says the player can't plan",
            board.status === 200 && board.json.canPlan === false && board.json.planning.length === 1 && board.json.gmTitle === "Host", board.json);

        // ── shortlist ───────────────────────────────────────────────────────
        const A = slot(0), B = slot(1), C = slot(2);
        check("a player can't shortlist (403)", (await call("POST", P(sid, "shortlist"), "p1", { options: [A, B] })).status === 403);
        check("one time is too few (400)", (await call("POST", P(sid, "shortlist"), "gm", { options: [A] })).status === 400);
        check("five is too many (400)",
            (await call("POST", P(sid, "shortlist"), "gm", { options: [0, 1, 2, 3, 4].map((d) => slot(d)) })).status === 400);
        check("a time in the past is refused (400)", (await call("POST", P(sid, "shortlist"), "gm",
            { options: [A, { start: new Date(Date.now() - DAY).toISOString(), end: new Date(Date.now() - DAY + HOUR).toISOString() }] })).status === 400);

        const sl = await call("POST", P(sid, "shortlist"), "gm", { options: [C, A, B] });
        check("the GM shortlists three times: round 1, quorum 3, the whole party eligible, sorted by time",
            sl.status === 200 && sl.json.night.round === 1 && sl.json.night.status === "open" && sl.json.night.quorum === 3 &&
                sl.json.night.eligibleIds.length === 4 && sl.json.night.options.map((o: any) => o.start).join() === [A, B, C].map((x) => x.start).join(), sl.json.night);
        check("shortlisting again while a vote is open is a 409 (re-shortlist is explicit)",
            (await call("POST", P(sid, "shortlist"), "gm", { options: [A, B] })).status === 409);

        // ── voting ──────────────────────────────────────────────────────────
        const vote = (as: string, opts: { start: string }[]) => call("POST", P(sid, "vote"), as,
            { optionIds: opts.map((o) => optionAt(sl.json, o)) });
        check("someone outside the party can't vote (403)", (await vote("outsider", [A])).status === 403);
        check("an option from somewhere else is a 400",
            (await call("POST", P(sid, "vote"), "p1", { optionIds: [crypto.randomUUID()] })).status === 400);
        await vote("p1", [A, B]);
        await vote("p2", [A]);
        const none = await vote("p3", []);
        check("\"I can't make any of these\" counts as having voted",
            none.status === 200 && none.json.night.voted.length === 3 && none.json.night.status === "open", none.json.night);
        const changed = await vote("p1", [A, C]);
        check("a player can change their votes while the vote is open",
            changed.json.night.options.find((o: any) => o.start === B.start).approvals.length === 0 &&
                changed.json.night.options.find((o: any) => o.start === C.start).approvals.includes(who.p1.id));
        const seenByP3 = (await call("GET", P(sid), "p3")).json.night.options.find((o: any) => o.start === A.start);
        check("everyone in the party sees who voted for what",
            [...seenByP3.approvals].sort().join() === [who.p1.id, who.p2.id].sort().join(), seenByP3);

        const before = published.length;
        const last = await vote("gm", [A, B]);
        const done = await session(sid);
        check("the last vote closes it: A has 3 approvals, meets quorum, wins",
            last.status === 200 && last.json.night.status === "closed" && last.json.night.closedReason === "all_voted" &&
                last.json.night.result === "winner" && last.json.night.winningOptionId === optionAt(sl.json, A), last.json.night);
        check("an online session is then scheduled for that night",
            done.status === "scheduled" && done.planning_stage === null &&
                done.date.toISOString() === A.start && done.end_date.toISOString() === A.end, done);
        const call1 = published[before];
        check("one Discord + Google publish, with the GM's vault, the table link as location, and the linked server",
            published.length === before + 1 && call1.gmIds[0] === who.gm.id && call1.location === "https://foundry.example/game" &&
                call1.discord?.guildId === "123456789" && call1.name === "Ashen Crown: Session 14" &&
                call1.description === "The Drowned Chapel" && call1.start.toISOString() === A.start, call1);
        check("the returned event ids and calendar link are saved on the session",
            done.discord_event_id === `discord-${before + 1}` && done.google_event_id === `google-${before + 1}` &&
                done.google_calendar_link === `https://calendar.google.com/fake/${before + 1}`, done);
        check("the party hears it's on, in the GM's time zone",
            (await notes("p2", sid)).some((n) => /is on: .*(CDT|CST)/.test(n.title)), await notes("p2", sid));
        check("and Table Talk says so", (await talk()).some((b) => /night is set.*Session 14/.test(b)));
        check("voting after the close is a 409", (await vote("p1", [A])).status === 409);
        const evs = events.filter((e) => e.payload.sessionId === sid).map((e) => e.name.replace("planning.", ""));
        check("every step published its bus event",
            evs.join() === ["stage_changed", "poll_opened", "vote_cast", "vote_cast", "vote_cast", "vote_cast", "vote_cast",
                "poll_closed", "stage_changed"].join(), evs);

        // ── a failed round, re-shortlisting, and moving forward ─────────────
        const k2 = await kick("gm", { title: "Session 15", isOnline: true });
        const sid2 = k2.json.session.id;
        const r1 = await call("POST", P(sid2, "shortlist"), "gm", { options: [A, B] });
        await call("POST", P(sid2, "vote"), "p1", { optionIds: [optionAt(r1.json, A)] });
        check("a player can't move the vote forward (403)", (await call("POST", P(sid2, "advance"), "p1")).status === 403);
        const adv = await call("POST", P(sid2, "advance"), "gm");
        check("the GM moves forward; one approval of a needed 3 is no quorum, and the session stays on the night",
            adv.json.night.closedReason === "gm_advanced" && adv.json.night.result === "no_quorum" &&
                adv.json.session.status === "planning" && adv.json.session.stage === "night", adv.json);
        check("the GM is told the round failed", (await pool.query(
            `SELECT 1 FROM notifications WHERE user_id = $1 AND title LIKE 'No night worked%' AND meta->>'sessionId' = $2`,
            [who.gm.id, sid2])).rowCount === 1);
        const r2 = await call("POST", P(sid2, "shortlist"), "gm", { options: [B, C] });
        check("after a failed round the GM shortlists a new round", r2.json.night.round === 2 && r2.json.night.status === "open");
        const r3 = await call("POST", P(sid2, "reshortlist"), "gm", { options: [slot(3), slot(4)] });
        const abandoned = await pool.query(`SELECT closed_reason, result FROM polls WHERE session_id = $1 AND round = 2`, [sid2]);
        check("re-shortlisting an open round abandons it and opens the next",
            r3.json.night.round === 3 && abandoned.rows[0].closed_reason === "gm_reshortlisted" && abandoned.rows[0].result === null, abandoned.rows);

        // ── a tie, broken by the GM ─────────────────────────────────────────
        const k3 = await kick("gm", { title: "Session 16", isOnline: true });
        const sid3 = k3.json.session.id;
        const t = await call("POST", P(sid3, "shortlist"), "gm", { options: [A, B] });
        const both = [optionAt(t.json, A), optionAt(t.json, B)];
        for (const p of ["p1", "p2", "p3"]) await call("POST", P(sid3, "vote"), p, { optionIds: both });
        const tied = await call("POST", P(sid3, "vote"), "gm", { optionIds: both });
        check("four approvals each: closed as a tie between both, still planning",
            tied.json.night.result === "tie" && tied.json.night.tiedOptionIds.sort().join() === both.sort().join() &&
                tied.json.session.status === "planning", tied.json.night);
        check("a player can't break the tie (403)",
            (await call("POST", P(sid3, "tiebreak"), "p1", { optionId: optionAt(t.json, B) })).status === 403);
        check("the GM must pick one of the tied options (400)",
            (await call("POST", P(sid3, "tiebreak"), "gm", { optionId: crypto.randomUUID() })).status === 400);
        fakeWarnings = ["Discord event failed: Missing Permissions"];
        const broken = await call("POST", P(sid3, "tiebreak"), "gm", { optionId: optionAt(t.json, B) });
        fakeWarnings = [];
        check("the GM's pick wins and the session is scheduled for it",
            broken.json.night.result === "winner" && broken.json.session.status === "scheduled" && broken.json.session.date === B.start, broken.json);
        check("an integration warning reaches the GM's bell", (await pool.query(
            `SELECT body FROM notifications WHERE user_id = $1 AND title LIKE '%with a problem' AND meta->>'sessionId' = $2`,
            [who.gm.id, sid3])).rows[0]?.body?.includes("Missing Permissions"));
        check("there's no second tie to break (409)",
            (await call("POST", P(sid3, "tiebreak"), "gm", { optionId: optionAt(t.json, A) })).status === 409);

        // ── a one-session stand-in Game Master ──────────────────────────────
        await pool.query(`UPDATE game_sessions SET gm_override_id = $2 WHERE id = $1`, [sid2, who.p3.id]);
        const standIn = await call("POST", P(sid2, "advance"), "p3");
        check("the session's stand-in GM has GM control of that session",
            standIn.status === 200 && standIn.json.viewer.isGameMaster && standIn.json.night.closedReason === "gm_advanced", standIn.json);
        check("...and of that session only", (await call("POST", P(sid, "advance"), "p3")).status === 403);

        // ── cancelling ──────────────────────────────────────────────────────
        const k4 = await kick("admin", { title: "Session 17", isOnline: true });
        check("an admin can start planning", k4.status === 200);
        const sid4 = k4.json.session.id;
        await call("POST", P(sid4, "shortlist"), "gm", { options: [A, B] });
        await pool.query(`INSERT INTO session_tasks (session_id, assignee_id, kind, title) VALUES ($1, $2, 'custom', 'Print the handout')`,
            [sid4, who.p1.id]);
        check("a player can't cancel (403)", (await call("POST", P(sid4, "cancel"), "p1")).status === 403);
        const cancelled = await call("POST", P(sid4, "cancel"), "gm");
        const quests = await pool.query(`SELECT status FROM session_tasks WHERE session_id = $1`, [sid4]);
        check("cancelling closes the vote, cancels the session and its quests",
            cancelled.json.session.status === "cancelled" && cancelled.json.night.closedReason === "cancelled" &&
                quests.rows.every((q) => q.status === "cancelled"), { session: cancelled.json.session, quests: quests.rows });
        check("a cancelled session can't be voted on or cancelled again",
            (await call("POST", P(sid4, "vote"), "p1", { optionIds: [] })).status === 409 &&
                (await call("POST", P(sid4, "cancel"), "gm")).status === 409);
        check("the Notice Board shows only sessions still being planned",
            (await call("GET", `/api/planning/campaigns/${campaignId}`, "gm")).json.planning.map((s: any) => s.session.id).join() === sid2);

        // ── existing behaviour ──────────────────────────────────────────────
        const oneOff = await call("POST", "/api/tabletop/sessions", "gm",
            { title: "Quick one-shot", campaign: campaignId, date: slot(5).start, endDate: slot(5).end });
        check("a one-off session with a fixed date still skips planning", oneOff.status === 201 && oneOff.json.status === "scheduled", oneOff.json);

        const soon = new Date(Date.now() + 10 * 60 * 1000);
        const { rows: [planningSoon] } = await pool.query(
            `INSERT INTO game_sessions (title, campaign_id, date, status, planning_stage) VALUES ('rc planning', $1, $2, 'planning', 'night') RETURNING id`,
            [campaignId, soon]);
        const { rows: [cancelledSoon] } = await pool.query(
            `INSERT INTO game_sessions (title, campaign_id, date, status) VALUES ('rc cancelled', $1, $2, 'cancelled') RETURNING id`, [campaignId, soon]);
        const { rows: [scheduledSoon] } = await pool.query(
            `INSERT INTO game_sessions (title, campaign_id, date) VALUES ('rc scheduled', $1, $2) RETURNING id`, [campaignId, soon]);
        await runReadyCheckSweep();
        const rc = Object.fromEntries((await pool.query(
            `SELECT id, ready_check FROM game_sessions WHERE id = ANY($1)`, [[planningSoon.id, cancelledSoon.id, scheduledSoon.id]]))
            .rows.map((r) => [r.id, Boolean(r.ready_check?.sentAt)]));
        check("the ready check fires for scheduled sessions only",
            rc[scheduledSoon.id] && !rc[planningSoon.id] && !rc[cancelledSoon.id], rc);
    } finally {
        const ids = Object.values(who).map((p) => p.id);
        if (campaignId) await pool.query(`DELETE FROM campaigns WHERE id = $1`, [campaignId]);
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
