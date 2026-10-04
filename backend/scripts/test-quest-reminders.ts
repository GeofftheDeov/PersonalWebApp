/**
 * Quest reminders (#91, part of #57).
 *
 * Seam 1, the HTTP API: the quest owner sets reminder offsets
 * (PUT /api/quests/:id/reminders), and nobody else can.
 *
 * Seam 2, the reminder job: runQuestReminders(db, now, { sendEmail }) driven
 * with an injected clock that this script moves forward, and a stubbed email
 * sender, so nothing real is sent. The planner runs for real (with the
 * integrations fake installed) so a night that is confirmed, moved or
 * cancelled reaches the quests through the bus exactly as it does in the app.
 *
 * Checks what's visible from outside: responses, quest rows, sent-reminder
 * rows, bell notifications and the emails handed to the stub.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-quest-reminders.ts
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
// The job must never reach a real mail server from here, whatever the shell has set.
delete process.env.EMAIL_PASS;
delete process.env.REDIS_URL;

const { default: pool } = await import("../db/index.js");
const { default: questRoutes } = await import("../routes/questRoutes.js");   // registers the due-time subscriber
const { default: tabletopRoutes } = await import("../routes/tabletopRoutes.js");
const { buildPlanningRouter } = await import("../routes/planningRoutes.js");
const { createPlanner } = await import("../planning/planner.js");
const { runQuestReminders } = await import("../planning/questReminders.js");
const { getQuestReminderQueue } = await import("../jobs/queues.js");
const { startWorkers } = await import("../jobs/workers.js");
const { createFakeIntegrations } = await import("../testing/fakeIntegrations.js");

const SECRET = process.env.JWT_SECRET || "your-secret-key-change-this";
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
    const d = typeof detail === "string" ? detail : JSON.stringify(detail);
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !d ? "" : `\n          ${d}`}`);
    ok ? pass++ : fail++;
}

async function main() {
    const uninstall = createFakeIntegrations().install();

    const app = express();
    app.use(express.json());
    app.use("/api/quests", questRoutes);
    app.use("/api/tabletop", tabletopRoutes);
    app.use("/api/planning", buildPlanningRouter(createPlanner()));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const tag = crypto.randomBytes(4).toString("hex");
    const who: Record<string, { id: string; token: string; email: string }> = {};
    const call = async (method: string, path: string, as?: string, body?: unknown) => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (as) headers.authorization = `Bearer ${who[as].token}`;
        const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        return { status: res.status, json };
    };
    const P = (sid: string, action = "") => `/api/planning/sessions/${sid}${action ? `/${action}` : ""}`;
    const setReminders = (as: string, questId: string, offsets: unknown) =>
        call("PUT", `/api/quests/${questId}/reminders`, as, { offsets });
    const quest = async (id: string) => (await pool.query(`SELECT * FROM session_tasks WHERE id = $1`, [id])).rows[0];
    const sentRows = async (id: string) => (await pool.query(
        `SELECT offset_minutes, due_at FROM session_task_reminders WHERE task_id = $1 ORDER BY sent_at, offset_minutes DESC`, [id])).rows;
    const bell = async (person: string, questId: string) => (await pool.query(
        `SELECT title, body, link, count FROM notifications
          WHERE user_id = $1 AND source_key = $2`, [who[person].id, `quest-reminder:${questId}`])).rows;

    // The email stub, and the job at a chosen instant.
    const emails: { to: string; subject: string; text: string; html: string }[] = [];
    let emailFails = false;
    // Only this run's people: a rerun against the same database finds earlier runs' quests too.
    const stubEmail = async (m: any) => {
        if (emailFails) throw new Error("SMTP down");
        if (Object.values(who).some((w) => w.email === m.to)) emails.push(m);
    };
    const ours = new Set<string>();
    const runAt = async (at: number) => {
        const r = await runQuestReminders(pool, new Date(at), { sendEmail: stubEmail });
        return r.sent.filter((s) => ours.has(s.questId));
    };
    /** Runs the job every `step` from `from` to `to` inclusive; every send it made, in order. */
    const sweep = async (from: number, to: number, step = 15 * MIN) => {
        const all: { at: number; questId: string; offsetMinutes: number }[] = [];
        for (let at = from; at <= to; at += step) {
            for (const s of await runAt(at)) all.push({ at, questId: s.questId, offsetMinutes: s.offsetMinutes });
        }
        return all;
    };
    /** Waits for a bus subscriber's work to land. */
    const until = async (cond: () => Promise<boolean>, ms = 3000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 25)); }
        return cond();
    };

    try {
        for (const name of ["gm", "p1", "p2", "outsider"]) {
            const email = `remind-${name}-${tag}@example.test`;
            const { rows: [r] } = await pool.query(
                `INSERT INTO accounts (id, handle, email, app_role, app_role_source) VALUES (gen_random_uuid(), $1, $2, 'user', 'manual') RETURNING id`,
                [`${name}_${tag}`, email]);
            who[name] = { id: r.id, token: jwt.sign({ id: r.id, email }, SECRET, { expiresIn: "1h" }), email };
        }
        // p1's reminders state times in p1's own zone (from their regular availability); p2 has none, so UTC.
        await pool.query(`INSERT INTO availability_windows (person_id, weekday, start_time, end_time, time_zone)
                          VALUES ($1, 6, '17:00', '23:00', 'America/Chicago')`, [who.p1.id]);
        const { rows: [camp] } = await pool.query(
            `INSERT INTO campaigns (title, owner_id, gm_title) VALUES ('Ashen Crown', $1, 'Host') RETURNING id`, [who.gm.id]);
        const campaignId = camp.id as string;
        for (const [i, [name, status]] of ([["gm", "Game Master"], ["p1", "Player"], ["p2", "Player"]] as const).entries()) {
            await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, status, joined_at) VALUES ($1, $2, $3, $4)`,
                [campaignId, who[name].id, status, new Date(Date.UTC(2026, 0, 1 + i))]);
        }

        const t0 = Math.ceil((Date.now() + 7 * DAY) / HOUR) * HOUR;
        const slot = (day: number, hours = 4) => ({
            start: new Date(t0 + day * DAY).toISOString(), end: new Date(t0 + day * DAY + hours * HOUR).toISOString(),
        });
        /** Kicks off an online session and has the whole party vote one night in: it's then scheduled. */
        const plan = async (title: string, night: { start: string; end: string }, other: { start: string; end: string }) => {
            const sid = (await call("POST", `/api/planning/campaigns/${campaignId}/kickoff`, "gm", { title, isOnline: true })).json.session.id as string;
            return { sid, confirm: () => voteIn(sid, "shortlist", night, other) };
        };
        const voteIn = async (sid: string, how: "shortlist" | "reopen", night: { start: string }, other: { start: string; end: string }) => {
            const st = (await call("POST", P(sid, how), "gm", { options: [night, other] })).json;
            const id = st.night.options.find((o: any) => o.start === night.start).id;
            let last: any = null;
            for (const p of ["gm", "p1", "p2"]) last = await call("POST", P(sid, "vote"), p, { optionIds: [id] });
            return last.json;
        };
        const addQuest = async (sid: string, assignee: string, title: string, dueAt?: string) => {
            const r = await call("POST", `/api/quests/sessions/${sid}`, "gm", { title, assigneeId: who[assignee].id, dueAt });
            if (r.status !== 201) throw new Error(`creating "${title}" failed: ${JSON.stringify(r)}`);
            ours.add(r.json.id);
            return r.json.id as string;
        };

        console.log("\n#91 — quest reminders\n");

        // ── due times follow the night when it's first confirmed ────────────
        console.log("  a quest added while the night is being voted on");
        const A = slot(0), Aalt = slot(1);
        const s1 = await plan("Session 14", A, Aalt);
        const qHandout = await addQuest(s1.sid, "p1", "Print the handout");
        check("a quest added while the night is being voted on has no due time yet", (await quest(qHandout)).due_at === null);
        const confirmed = await s1.confirm();
        check("the party votes a night in: the session is scheduled", confirmed?.session?.status === "scheduled", confirmed?.session);
        check("...and the quest is now due at the session's start (moved by the bus event, not the job)",
            await until(async () => +((await quest(qHandout)).due_at ?? 0) === Date.parse(A.start)), (await quest(qHandout)).due_at);

        // ── setting offsets ─────────────────────────────────────────────────
        console.log("\n  setting reminder offsets");
        check("the GM isn't the owner, so can't choose the owner's reminders (403)",
            (await setReminders("gm", qHandout, [120])).status === 403);
        check("nor can another player (403)", (await setReminders("p2", qHandout, [120])).status === 403);
        check("nor someone outside the party (403)", (await setReminders("outsider", qHandout, [120])).status === 403);
        check("signed out is a 401", (await call("PUT", `/api/quests/${qHandout}/reminders`, undefined, { offsets: [120] })).status === 401);
        for (const [what, offsets] of [["not a list", 120], ["zero minutes", [0]], ["more than two weeks", [20161]],
            ["fractional minutes", [90.5]], ["a string", ["120"]], ["six reminders", [10, 20, 30, 40, 50, 60]]] as const) {
            check(`${what} is refused (400)`, (await setReminders("p1", qHandout, offsets)).status === 400);
        }
        check("an unknown quest is a 404", (await setReminders("p1", crypto.randomUUID(), [60])).status === 404);
        const set = await setReminders("p1", qHandout, [120, 1440, 120]);
        check("the owner sets \"the day before\" and \"2 hours before\": stored once each, earliest first",
            set.status === 200 && set.json.reminderOffsets.join() === "1440,120" && set.json.remindersSent.length === 0, set.json);
        check("...and that's what the Quest Log returns",
            (await call("GET", "/api/quests/mine", "p1")).json.quests.find((q: any) => q.id === qHandout)?.reminderOffsets.join() === "1440,120");

        // ── each offset fires exactly once ──────────────────────────────────
        console.log("\n  the job, with the clock moving forward");
        const due1 = Date.parse(A.start);
        const early = await sweep(due1 - 3 * DAY, due1 - 24 * HOUR - MIN);
        check("nothing is sent before the first reminder comes round", early.filter((s) => s.questId === qHandout).length === 0, early);
        const sends = await sweep(due1 - 24 * HOUR, due1 + 2 * HOUR, 5 * MIN);
        const mine = sends.filter((s) => s.questId === qHandout);
        check("stepping five minutes at a time through the last day: each offset fires exactly once, at its time",
            mine.length === 2 &&
                mine[0].offsetMinutes === 1440 && mine[0].at === due1 - 24 * HOUR &&
                mine[1].offsetMinutes === 120 && mine[1].at === due1 - 2 * HOUR, mine);
        const rows = await sentRows(qHandout);
        check("...recorded once per offset against the due time",
            rows.length === 2 && rows.every((r) => +r.due_at === due1), rows);
        const handoutMails = emails.filter((e) => e.subject.includes("Print the handout"));
        check("...each one emailed to the owner (through the stub)",
            handoutMails.length === 2 && handoutMails.every((e) => e.to === who.p1.email), handoutMails.map((e) => e.to));
        check("...the email says what's due and links to the quest",
            /due in 1 day|due in 24 hours/.test(handoutMails[0]?.subject ?? "") && /due in 2 hours/.test(handoutMails[1]?.subject ?? "") &&
                handoutMails[0].text.includes(`/game-night/sessions/${s1.sid}#quests`) && handoutMails[0].html.includes("Session 14"),
            handoutMails.map((e) => e.subject));
        const b = await bell("p1", qHandout);
        check("...and rung the owner's bell (one entry, raised twice while unread)",
            b.length === 1 && b[0].count === 2 && b[0].title === "Reminder: Print the handout" &&
                b[0].link === `/game-night/sessions/${s1.sid}#quests`, b);
        check("...stating the due time in the owner's own time zone",
            /C[DS]T/.test(b[0]?.body ?? "") && b[0].body.includes('"Session 14", Ashen Crown'), b[0]?.body);
        check("no one else's bell rang", (await bell("gm", qHandout)).length === 0 && (await bell("p2", qHandout)).length === 0);
        check("the quest shows which reminders have gone out",
            (await call("GET", `/api/quests/sessions/${s1.sid}`, "p1")).json.quests.find((q: any) => q.id === qHandout)?.remindersSent.join() === "1440,120");

        // Two workers at the same instant: one send.
        const qRace = await addQuest(s1.sid, "p2", "Bring dice", new Date(due1 + 2 * DAY).toISOString());
        await setReminders("p2", qRace, [60]);
        const raceAt = due1 + 2 * DAY - 30 * MIN;
        const [r1, r2] = await Promise.all([runAt(raceAt), runAt(raceAt)]);
        check("two runs at the same moment send the reminder once between them",
            [...r1, ...r2].filter((s) => s.questId === qRace).length === 1 && (await sentRows(qRace)).length === 1);

        // Catching up: only the latest of the offsets that have passed.
        console.log("\n  catching up");
        const qLate = await addQuest(s1.sid, "p2", "Bake bread", new Date(due1 + 3 * DAY).toISOString());
        await setReminders("p2", qLate, [10080, 1440, 60]);
        const late = await sweep(due1 + 3 * DAY - 3 * HOUR, due1 + 3 * DAY + HOUR, 5 * MIN);
        const lateSends = late.filter((s) => s.questId === qLate);
        check("offsets that had all passed when they were set send once, as the latest of them, not as a burst",
            lateSends.length === 2 && lateSends[0].offsetMinutes === 1440 && lateSends[0].at === due1 + 3 * DAY - 3 * HOUR &&
                lateSends[1].offsetMinutes === 60, lateSends);

        // An email that fails doesn't repeat every minute.
        const qMailDown = await addQuest(s1.sid, "p2", "Snacks", new Date(due1 + 4 * DAY).toISOString());
        await setReminders("p2", qMailDown, [60]);
        emailFails = true;
        const down = (await sweep(due1 + 4 * DAY - HOUR, due1 + 4 * DAY - 30 * MIN, 5 * MIN)).filter((s) => s.questId === qMailDown);
        emailFails = false;
        check("an email that fails is logged, the bell still rings, and it isn't retried every run",
            down.length === 1 && (await bell("p2", qMailDown)).length === 1 && (await sentRows(qMailDown)).length === 1, down);

        // ── done ────────────────────────────────────────────────────────────
        console.log("\n  done quests");
        const qDone = await addQuest(s1.sid, "p2", "Clear the table", new Date(due1 + 5 * DAY).toISOString());
        await setReminders("p2", qDone, [1440, 60]);
        const beforeDone = (await sweep(due1 + 4 * DAY, due1 + 4 * DAY + HOUR, 5 * MIN)).filter((s) => s.questId === qDone);
        check("the day-before reminder goes out", beforeDone.length === 1 && beforeDone[0].offsetMinutes === 1440, beforeDone);
        check("the owner marks the quest done", (await call("POST", `/api/quests/${qDone}/done`, "p2")).status === 200);
        const afterDone = (await sweep(due1 + 4 * DAY + HOUR, due1 + 5 * DAY + HOUR, 5 * MIN)).filter((s) => s.questId === qDone);
        check("...and nothing more is sent for it", afterDone.length === 0 && (await sentRows(qDone)).length === 1, afterDone);
        check("a done quest's reminders can't be changed (409)", (await setReminders("p2", qDone, [30])).status === 409);

        // ── reassigning ─────────────────────────────────────────────────────
        const qPass = await addQuest(s1.sid, "p1", "Battle map", new Date(due1 + 6 * DAY).toISOString());
        await setReminders("p1", qPass, [120]);
        const handed = await call("PATCH", `/api/quests/${qPass}`, "gm", { assigneeId: who.p2.id });
        check("reassigning a quest drops the old owner's reminder choices", handed.json?.reminderOffsets?.length === 0, handed.json);
        const afterHand = (await sweep(due1 + 6 * DAY - 3 * HOUR, due1 + 6 * DAY, 15 * MIN)).filter((s) => s.questId === qPass);
        check("...so nobody is reminded until the new owner chooses", afterHand.length === 0, afterHand);

        // ── the night moves ─────────────────────────────────────────────────
        console.log("\n  the night moves");
        const B = slot(10), Balt = slot(11), Bnew = slot(13), Bnew2 = slot(14);
        const s2 = await plan("Session 15", B, Balt);
        await s2.confirm();
        const dueB = Date.parse(B.start);
        const qMap = await addQuest(s2.sid, "p1", "Paint minis", new Date(dueB - HOUR).toISOString());
        await setReminders("p1", qMap, [120]);
        const first = (await sweep(dueB - 4 * HOUR, dueB, 5 * MIN)).filter((s) => s.questId === qMap);
        check("a quest due an hour before the night reminds 2 hours before that, once",
            first.length === 1 && first[0].at === dueB - 3 * HOUR, first);

        const moved = await voteIn(s2.sid, "reopen", Bnew, Bnew2);
        check("the GM changes the night and the party votes a new one in",
            moved?.session?.status === "scheduled" && Date.parse(moved?.session?.date) === Date.parse(Bnew.start), moved?.session);
        const newDue = Date.parse(Bnew.start) - HOUR;
        check("...the quest's due time moves with it, still an hour before (moved by planning.night_moved)",
            await until(async () => +(await quest(qMap)).due_at === newDue), (await quest(qMap)).due_at);
        const afterMove = (await sweep(dueB - 4 * HOUR, Date.parse(Bnew.start), 15 * MIN)).filter((s) => s.questId === qMap);
        check("...the reminder re-arms and fires once at the new time, and never again at the old one",
            afterMove.length === 1 && afterMove[0].at === newDue - 2 * HOUR, afterMove);
        check("...both sends recorded, one per due time", (await sentRows(qMap)).map((r) => +r.due_at).join() === `${dueB - HOUR},${newDue}`);

        // Editing the session's date directly (the session form) moves due times too.
        const editedStart = Date.parse(Bnew.start) + DAY;
        // The session form sends the whole session, as here.
        const edit = await call("PUT", `/api/tabletop/sessions/${s2.sid}`, "gm", {
            title: "Session 15", isOnline: true, date: new Date(editedStart).toISOString(), endDate: new Date(editedStart + 4 * HOUR).toISOString(),
        });
        check("editing the session's start moves its quests' due times straight away",
            edit.status === 200 && +(await quest(qMap)).due_at === editedStart - HOUR, { status: edit.status, body: edit.json, due: (await quest(qMap)).due_at });
        const afterEdit = (await sweep(editedStart - 4 * HOUR, editedStart, 15 * MIN)).filter((s) => s.questId === qMap);
        check("...and the reminder fires once at the edited time", afterEdit.length === 1 && afterEdit[0].at === editedStart - 3 * HOUR, afterEdit);

        // Run twice, delivered twice: a move shifts a quest once.
        const { followSessionStarts } = await import("../planning/questReminders.js");
        await followSessionStarts(pool, s2.sid);
        await followSessionStarts(pool);
        check("following the session's start again (a redelivered event, the job) doesn't shift the quest again",
            +(await quest(qMap)).due_at === editedStart - HOUR);

        // A small move after a reminder went out doesn't send it again.
        const E = slot(40), Ealt = slot(41);
        const s5 = await plan("Session 18", E, Ealt);
        await s5.confirm();
        const dueE = Date.parse(E.start);
        const qNudge = await addQuest(s5.sid, "p1", "Sharpen pencils");
        await setReminders("p1", qNudge, [1440, 30]);
        const dayBefore = (await sweep(dueE - 25 * HOUR, dueE - 22 * HOUR, 15 * MIN)).filter((s) => s.questId === qNudge);
        check("\"the day before\" goes out", dayBefore.length === 1 && dayBefore[0].offsetMinutes === 1440, dayBefore);
        // The next afternoon, the start is pushed back half an hour.
        const nudgedAt = dueE - 2 * HOUR, nudged = dueE + 30 * MIN;
        await pool.query(`UPDATE game_sessions SET date = $2, end_date = $3 WHERE id = $1`, [s5.sid, new Date(nudged), new Date(nudged + 4 * HOUR)]);
        const { followSessionStarts: follow } = await import("../planning/questReminders.js");
        await follow(pool, s5.sid, new Date(nudgedAt));
        const afterNudge = (await sweep(nudgedAt, nudged, 5 * MIN)).filter((s) => s.questId === qNudge);
        check("after the night is pushed back half an hour, \"the day before\" isn't sent again; 30 minutes before still is",
            afterNudge.length === 1 && afterNudge[0].offsetMinutes === 30 && afterNudge[0].at === nudged - 30 * MIN, afterNudge);
        check("...and the quest shows both as sent for the new due time",
            (await call("GET", `/api/quests/sessions/${s5.sid}`, "p1")).json.quests.find((q: any) => q.id === qNudge)?.remindersSent.join() === "1440,30");

        // ── cancelled ───────────────────────────────────────────────────────
        console.log("\n  cancelled sessions");
        const C = slot(20), Calt = slot(21);
        const s3 = await plan("Session 16", C, Calt);
        await s3.confirm();
        const dueC = Date.parse(C.start);
        const qCancel = await addQuest(s3.sid, "p1", "Book the room");
        await setReminders("p1", qCancel, [60]);
        const reopened = await call("POST", P(s3.sid, "reopen"), "gm", { options: [slot(22), slot(23)] });
        check("the GM starts changing the night (the session is being planned again, keeping its old date)",
            reopened.json?.session?.status === "planning", reopened.json?.session);
        const cancelled = await call("POST", P(s3.sid, "cancel"), "gm");
        check("...then cancels the session: its quest is cancelled",
            cancelled.status === 200 && (await quest(qCancel)).status === "cancelled", cancelled.json?.session);
        const afterCancel = (await sweep(dueC - 2 * HOUR, dueC, 15 * MIN)).filter((s) => s.questId === qCancel);
        check("...and its reminder never fires", afterCancel.length === 0 && (await sentRows(qCancel)).length === 0, afterCancel);

        // Even if a quest were left open, a cancelled session sends nothing.
        const D = slot(30), Dalt = slot(31);
        const s4 = await plan("Session 17", D, Dalt);
        await s4.confirm();
        const qOrphan = await addQuest(s4.sid, "p1", "Wrangle the cat");
        await setReminders("p1", qOrphan, [60]);
        await pool.query(`UPDATE game_sessions SET status = 'cancelled' WHERE id = $1`, [s4.sid]);
        const orphan = (await sweep(Date.parse(D.start) - 2 * HOUR, Date.parse(D.start), 15 * MIN)).filter((s) => s.questId === qOrphan);
        check("an open quest on a cancelled session is never reminded either", orphan.length === 0, orphan);

        // ── Redis ───────────────────────────────────────────────────────────
        console.log("\n  without Redis");
        check("with REDIS_URL unset there's no reminder queue, like the other BullMQ jobs", getQuestReminderQueue() === null);
        const stop = startWorkers();
        await stop();
        check("...and starting the workers is a no-op", true);
    } finally {
        uninstall();
        server.close();
        await pool.end();
    }

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
